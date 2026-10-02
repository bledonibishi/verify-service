// Runs the full flow against a real Postgres (DATABASE_URL). No external services are contacted:
// the webhook target is a local HTTP server started by the test.
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { createServer, Server } from 'http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { hmacSign, randomToken, sha256 } from '../src/common/crypto';
import { buildTd1, SAMPLE, Td1Fields } from '../src/documents/mrz/testing';
import { OCR_PROVIDER, OcrProvider, OcrUnavailableError } from '../src/ocr/ocr-provider';
import { FACE_PROVIDER, FaceComparison, FaceProvider, FaceUnavailableError } from '../src/face/face-provider';
import { LIVENESS_PROVIDER, LivenessProvider, LivenessResult, LivenessUnavailableError } from '../src/liveness/liveness-provider';
import { hashPassword } from '../src/review/password';
import { VerificationWorker } from '../src/verification/verification.worker';

// Fake OCR: tests set `ocrImpl`. Nothing here touches a real OCR engine.
let ocrImpl: () => Promise<{ text: string }> = async () => ({ text: '' });
let ocrCalls = 0;
const fakeOcr: OcrProvider = {
  name: 'fake',
  readText: async () => {
    ocrCalls++;
    return ocrImpl();
  },
};
// Fake face provider: tests set `faceImpl`. AWS is never contacted.
const goodFace = async (): Promise<FaceComparison> => ({ status: 'compared', similarity: 95 });
let faceImpl: () => Promise<FaceComparison> = goodFace;
let faceCalls = 0;
let lastSelfie: Buffer | undefined;
const fakeFace: FaceProvider = {
  name: 'fake-face',
  compare: async (_id, selfie) => {
    faceCalls++;
    lastSelfie = selfie;
    return faceImpl();
  },
};
// Fake liveness provider: tests set `liveImpl` / `createImpl`.
const goodLive = async (): Promise<LivenessResult> => ({ status: 'live', confidence: 97, referenceImage: Buffer.from('ref-from-challenge') });
let liveImpl: () => Promise<LivenessResult> = goodLive;
let liveCalls = 0;
let sessionCounter = 0;
let createImpl: () => Promise<{ providerSessionId: string }> = async () => ({ providerSessionId: `live-${++sessionCounter}` });
const fakeLiveness: LivenessProvider = {
  name: 'fake-live',
  createSession: () => createImpl(),
  getResult: async () => {
    liveCalls++;
    return liveImpl();
  },
};
const mrzText = (f: Partial<Td1Fields> = {}) => buildTd1({ ...SAMPLE, ...f }).join('\n');

const storageDir = mkdtempSync(join(tmpdir(), 'verify-e2e-'));
process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.STORAGE_LOCAL_DIR = storageDir;
process.env.PUBLIC_BASE_URL = 'http://verify.test';
process.env.VERIFICATION_RETRY_BASE_MS = '10';
process.env.THROTTLE_LIMIT = '100000';
process.env.LOGIN_RATE_LIMIT = '100000';
process.env.VERIFICATION_POLL_MS = '50';

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-image-body'),
]);

describe('verification flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let hookServer: Server;
  const hooks: { signature: string; body: string }[] = [];
  const apiKey = `vk_${randomToken()}`;
  const webhookSecret = `whsec_${randomToken()}`;
  let tenantId: string;
  let worker: VerificationWorker;

  beforeAll(async () => {
    hookServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hooks.push({ signature: String(req.headers['x-verify-signature']), body });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => hookServer.listen(0, r));
    const port = (hookServer.address() as AddressInfo).port;

    prisma = new PrismaClient();
    const tenant = await prisma.tenant.create({
      data: {
        name: 'e2e',
        apiKeyHash: sha256(apiKey),
        webhookUrl: `http://127.0.0.1:${port}/hook`,
        webhookSecret,
      },
    });
    tenantId = tenant.id;

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OCR_PROVIDER)
      .useValue(fakeOcr)
      .overrideProvider(FACE_PROVIDER)
      .useValue(fakeFace)
      .overrideProvider(LIVENESS_PROVIDER)
      .useValue(fakeLiveness)
      .compile();
    worker = moduleRef.get(VerificationWorker);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    // Listen once: otherwise supertest starts and stops the server around each request, and
    // concurrent requests (the race tests) can have it closed underneath them.
    await app.listen(0);
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
    await app.close();
    await new Promise((r) => hookServer.close(r));
    rmSync(storageDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it('rejects calls without a valid API key', async () => {
    await request(app.getHttpServer()).post('/v1/sessions').send({ externalRef: 'u1' }).expect(401);
    await request(app.getHttpServer())
      .post('/v1/sessions')
      .set('Authorization', 'Bearer nope')
      .send({ externalRef: 'u1' })
      .expect(401);
  });

  it('runs create → upload → submit → signed webhook', async () => {
    const http = app.getHttpServer();
    const created = await request(http)
      .post('/v1/sessions')
      .set(auth())
      .send({ externalRef: 'user-42', firstName: 'Arta', lastName: 'Krasniqi', birthDate: '1990-05-17' })
      .expect(201);
    expect(created.body.uploadUrl).toBe(`http://verify.test/v1/upload/${created.body.uploadToken}`);
    const token = created.body.uploadToken as string;
    const id = created.body.id as string;

    // Cannot submit before required documents exist
    await request(http).post(`/v1/upload/${token}/submit`).expect(400);

    // Non-image content is refused even if the client claims it's a PNG
    await request(http)
      .post(`/v1/upload/${token}/ID_FRONT`)
      .attach('file', Buffer.from('%PDF-1.7'), { filename: 'x.png', contentType: 'image/png' })
      .expect(400);

    await request(http)
      .post(`/v1/upload/${token}/ID_FRONT`)
      .attach('file', PNG, { filename: 'front.png' })
      .expect(204);
    await request(http)
      .post(`/v1/upload/${token}/SELFIE`)
      .attach('file', PNG, { filename: 'selfie.png' })
      .expect(204);

    const mid = await request(http).get(`/v1/sessions/${id}`).set(auth()).expect(200);
    expect(mid.body.status).toBe('PENDING');
    expect(mid.body.uploaded.sort()).toEqual(['ID_FRONT', 'SELFIE']);

    const submitted = await request(http).post(`/v1/upload/${token}/submit`).expect(200);
    expect(submitted.body.status).toBe('PROCESSING');

    // Session is closed to further uploads
    await request(http)
      .post(`/v1/upload/${token}/SELFIE`)
      .attach('file', PNG, { filename: 'again.png' })
      .expect(410);

    // No ID_BACK was uploaded, so the pipeline cannot read an MRZ and hands over to a reviewer
    await waitFor(() => hooks.length >= 1);
    const done = await request(http).get(`/v1/sessions/${id}`).set(auth()).expect(200);
    expect(done.body.status).toBe('NEEDS_REVIEW');
    expect(done.body.verification.issues).toEqual(['ID_BACK_MISSING', 'LIVENESS_NOT_PERFORMED']);

    // Webhook is sent after the response, so wait for it to arrive

    // Webhook was delivered with a valid signature
    expect(hooks).toHaveLength(1);
    const match = hooks[0].signature.match(/^t=(\d+),v1=([0-9a-f]+)$/);
    expect(match).not.toBeNull();
    expect(match![2]).toBe(hmacSign(webhookSecret, `${match![1]}.${hooks[0].body}`));
    expect(JSON.parse(hooks[0].body)).toMatchObject({
      type: 'session.status_changed',
      sessionId: id,
      externalRef: 'user-42',
      status: 'NEEDS_REVIEW',
      verification: { mrz: { found: false }, issues: ['ID_BACK_MISSING', 'LIVENESS_NOT_PERFORMED'] },
    });
  });

  it('does not expose another tenant’s sessions', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'other', apiKeyHash: sha256('vk_other'), webhookSecret: 'x' },
    });
    try {
      const created = await request(app.getHttpServer())
        .post('/v1/sessions')
        .set(auth())
        .send({ externalRef: 'u' })
        .expect(201);
      await request(app.getHttpServer())
        .get(`/v1/sessions/${created.body.id}`)
        .set('Authorization', 'Bearer vk_other')
        .expect(404);
    } finally {
      await prisma.tenant.delete({ where: { id: other.id } });
    }
  });

  async function readySession(ref: string) {
    const http = app.getHttpServer();
    const created = await request(http).post('/v1/sessions').set(auth()).send({ externalRef: ref }).expect(201);
    const token = created.body.uploadToken as string;
    for (const kind of ['ID_FRONT', 'SELFIE']) {
      await request(http).post(`/v1/upload/${token}/${kind}`).attach('file', PNG, { filename: 'a.png' }).expect(204);
    }
    return { token, id: created.body.id as string };
  }

  it('lets only one of several concurrent submits through, with one webhook', async () => {
    const before = hooks.length;
    const { token } = await readySession('race');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app.getHttpServer()).post(`/v1/upload/${token}/submit`)),
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 410)).toHaveLength(4);
    await waitFor(() => hooks.length > before);
    await new Promise((r) => setTimeout(r, 200));
    expect(hooks.length - before).toBe(1);
  });

  it('reports an expired session as EXPIRED without anyone touching the link', async () => {
    const { id } = await readySession('expiry');
    await prisma.session.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app.getHttpServer()).get(`/v1/sessions/${id}`).set(auth()).expect(200);
    expect(res.body.status).toBe('EXPIRED');
  });

  it('does not overwrite a submitted session with EXPIRED', async () => {
    const { token, id } = await readySession('late');
    await request(app.getHttpServer()).post(`/v1/upload/${token}/submit`).expect(200);
    await prisma.session.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(app.getHttpServer()).post(`/v1/upload/${token}/SELFIE`).attach('file', PNG, { filename: 'x.png' }).expect(410);
    const row = await prisma.session.findUnique({ where: { id } });
    expect(['PROCESSING', 'NEEDS_REVIEW']).toContain(row?.status);
  });

  it('leaves no stored file behind when an upload is refused', async () => {
    const { token, id } = await readySession('orphan');
    await request(app.getHttpServer()).post(`/v1/upload/${token}/submit`).expect(200);
    const dir = join(storageDir, (await prisma.session.findUnique({ where: { id } }))!.tenantId, id);
    const before = readdirSync(dir).length;
    await request(app.getHttpServer()).post(`/v1/upload/${token}/SELFIE`).attach('file', PNG, { filename: 'x.png' }).expect(410);
    expect(readdirSync(dir).length).toBe(before);
  });

  it('replaces a re-uploaded document and removes the old file', async () => {
    const { token, id } = await readySession('replace');
    const dir = join(storageDir, (await prisma.session.findUnique({ where: { id } }))!.tenantId, id);
    expect(readdirSync(dir)).toHaveLength(2);
    await request(app.getHttpServer()).post(`/v1/upload/${token}/SELFIE`).attach('file', PNG, { filename: 'x.png' }).expect(204);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('rejects unknown tokens', async () => {
    await request(app.getHttpServer())
      .post('/v1/upload/not-a-real-token/SELFIE')
      .attach('file', PNG, { filename: 's.png' })
      .expect(404);
  });

  describe('verification pipeline', () => {
    const http = () => app.getHttpServer();

    async function submitted(
      ref: string,
      identity: { firstName?: string; lastName?: string; birthDate?: string } | null = { firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15' },
      withBack = true,
      withLiveness = true,
    ) {
      const created = await request(http()).post('/v1/sessions').set(auth()).send({ externalRef: ref, ...identity }).expect(201);
      const token = created.body.uploadToken as string;
      const kinds = withBack ? ['ID_FRONT', 'ID_BACK', 'SELFIE'] : ['ID_FRONT', 'SELFIE'];
      for (const kind of kinds) {
        await request(http()).post(`/v1/upload/${token}/${kind}`).attach('file', PNG, { filename: 'a.png' }).expect(204);
      }
      if (withLiveness) await request(http()).post(`/v1/upload/${token}/liveness`).expect(200);
      await request(http()).post(`/v1/upload/${token}/submit`).expect(200);
      return created.body.id as string;
    }

    async function settled(id: string) {
      for (let i = 0; i < 200; i++) {
        const res = await request(http()).get(`/v1/sessions/${id}`).set(auth());
        if (res.body.status !== 'PROCESSING') return res.body;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('session stayed in PROCESSING');
    }

    const setAutoApprove = (autoApprove: boolean) => prisma.tenant.update({ where: { id: tenantId }, data: { autoApprove } });
    const setLivenessMin = (livenessMinConfidence: number) => prisma.tenant.update({ where: { id: tenantId }, data: { livenessMinConfidence } });
    const setThreshold = (faceMatchThreshold: number) => prisma.tenant.update({ where: { id: tenantId }, data: { faceMatchThreshold } });
    afterEach(async () => {
      await setAutoApprove(false);
      await setThreshold(90);
      faceImpl = goodFace;
      liveImpl = goodLive;
      createImpl = async () => ({ providerSessionId: `live-${++sessionCounter}` });
      await setLivenessMin(90);
      ocrImpl = async () => ({ text: '' });
    });

    it('keeps a clean match in NEEDS_REVIEW when auto-approve is off (the default)', async () => {
      ocrImpl = async () => ({ text: mrzText() });
      const body = await settled(await submitted('clean-off'));
      expect(body.status).toBe('NEEDS_REVIEW');
      expect(body.verification).toMatchObject({
        autoDecided: false,
        mrz: { found: true, valid: true, repaired: false },
        identity: { surname: 'match', givenNames: 'match', birthDate: 'match' },
        expired: false,
        issues: [],
      });
    });

    it('approves a clean match when the tenant opted in, and the webhook carries the result', async () => {
      await setAutoApprove(true);
      ocrImpl = async () => ({ text: mrzText() });
      const before = hooks.length;
      const id = await submitted('clean-on');
      expect((await settled(id)).status).toBe('APPROVED');
      await waitFor(() => hooks.length > before);
      const last = JSON.parse(hooks[hooks.length - 1].body);
      expect(last).toMatchObject({ sessionId: id, status: 'APPROVED', verification: { autoDecided: true, issues: [] } });
    });

    it('never stores or returns values read from the card', async () => {
      ocrImpl = async () => ({ text: mrzText() });
      const id = await submitted('no-pii');
      const body = await settled(id);
      const row = await prisma.verificationResult.findUnique({ where: { sessionId: id } });
      const dump = JSON.stringify([body, row]);
      for (const secret of [SAMPLE.personalNumber, SAMPLE.documentNumber, SAMPLE.surname, SAMPLE.givenNames, SAMPLE.birth]) {
        expect(dump).not.toContain(secret);
      }
      const logs = await prisma.auditLog.findMany({ where: { sessionId: id } });
      expect(JSON.stringify(logs)).not.toContain(SAMPLE.surname);
    });

    it.each([
      ['a different surname', { lastName: 'Other' }, 'SURNAME_MISMATCH'],
      ['a different date of birth', { birthDate: '1991-01-01' }, 'BIRTH_DATE_MISMATCH'],
      ['a missing expected identity', null, 'EXPECTED_IDENTITY_MISSING'],
    ])('sends %s to review even with auto-approve on', async (_name, identity, code) => {
      await setAutoApprove(true);
      ocrImpl = async () => ({ text: mrzText() });
      const base = { firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15' };
      const body = await settled(await submitted(`mismatch-${code}`, identity === null ? null : { ...base, ...identity }));
      expect(body.status).toBe('NEEDS_REVIEW');
      expect(body.verification.issues).toContain(code);
    });

    it('sends an expired document to review even with auto-approve on', async () => {
      await setAutoApprove(true);
      ocrImpl = async () => ({ text: mrzText({ expiry: '200131' }) });
      const body = await settled(await submitted('expired'));
      expect(body.status).toBe('NEEDS_REVIEW');
      expect(body.verification.expired).toBe(true);
      expect(body.verification.issues).toContain('DOCUMENT_EXPIRED');
    });

    it('sends unreadable and tampered MRZ text to review', async () => {
      await setAutoApprove(true);
      ocrImpl = async () => ({ text: 'no machine readable zone here' });
      const none = await settled(await submitted('no-mrz'));
      expect(none.status).toBe('NEEDS_REVIEW');
      expect(none.verification.issues).toEqual(['MRZ_NOT_FOUND']);

      const lines = buildTd1(SAMPLE);
      lines[1] = lines[1].slice(0, 5) + '9' + lines[1].slice(6); // breaks the birth-date check digit
      ocrImpl = async () => ({ text: lines.join('\n') });
      const bad = await settled(await submitted('tampered'));
      expect(bad.status).toBe('NEEDS_REVIEW');
      expect(bad.verification.mrz).toMatchObject({ found: true, valid: false });
    });

    it('does not block the submit request on OCR', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      ocrImpl = async () => {
        await gate;
        return { text: mrzText() };
      };
      const id = await submitted('slow'); // submitted() only returns once the HTTP call has
      expect((await request(http()).get(`/v1/sessions/${id}`).set(auth())).body.status).toBe('PROCESSING');
      release();
      expect((await settled(id)).status).toBe('NEEDS_REVIEW');
    });

    it('retries a transient OCR failure, then gives up to a reviewer after three attempts', async () => {
      let n = 0;
      ocrImpl = async () => {
        if (++n < 3) throw new Error('boom');
        return { text: mrzText() };
      };
      expect((await settled(await submitted('flaky'))).verification.mrz.valid).toBe(true);
      expect(n).toBe(3);

      ocrImpl = async () => {
        throw new Error('always');
      };
      const body = await settled(await submitted('broken'));
      expect(body.status).toBe('NEEDS_REVIEW');
      expect(body.verification.issues).toEqual(['PIPELINE_ERROR']);
    });

    it('hands over immediately, without retries, when no OCR engine is installed', async () => {
      const before = ocrCalls;
      ocrImpl = async () => {
        throw new OcrUnavailableError('missing');
      };
      const body = await settled(await submitted('no-engine'));
      expect(body.verification.issues).toEqual(['OCR_UNAVAILABLE']);
      expect(ocrCalls - before).toBe(1);
    });

    it('processes a job exactly once when workers race', async () => {
      ocrImpl = async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { text: mrzText() };
      };
      const before = ocrCalls;
      const id = await submitted('race-workers');
      await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
      await settled(id);
      expect(ocrCalls - before).toBe(1);
      expect(await prisma.verificationResult.count({ where: { sessionId: id } })).toBe(1);
    });

    it('picks up a job whose worker died mid-run', async () => {
      ocrImpl = async () => ({ text: mrzText() });
      const id = await submitted('crashed');
      await settled(id);
      // Simulate a crash: session back in PROCESSING with a RUNNING job whose lease has lapsed.
      await prisma.verificationResult.delete({ where: { sessionId: id } });
      await prisma.session.update({ where: { id }, data: { status: 'PROCESSING' } });
      await prisma.verificationJob.update({
        where: { sessionId: id },
        data: { status: 'RUNNING', lockedUntil: new Date(Date.now() - 1000) },
      });
      await worker.wake();
      expect((await settled(id)).verification).not.toBeNull();
    });

    it('does not let a late worker overwrite a session someone else already decided', async () => {
      const id = await submitted('decided');
      await settled(id);
      await prisma.session.update({ where: { id }, data: { status: 'REJECTED' } });
      await prisma.verificationResult.delete({ where: { sessionId: id } });
      await prisma.verificationJob.update({ where: { sessionId: id }, data: { status: 'QUEUED', runAfter: new Date() } });
      await worker.wake();
      expect((await prisma.session.findUnique({ where: { id } }))?.status).toBe('REJECTED');
      expect(await prisma.verificationResult.count({ where: { sessionId: id } })).toBe(0);
    });

    it('ignores a stale worker whose lease lapsed and was re-claimed (fenced)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let n = 0;
      const before = ocrCalls;
      ocrImpl = async () => {
        if (++n === 1) {
          await gate; // worker A hangs here
          throw new Error('late failure'); // ...and fails after losing its lease
        }
        return { text: mrzText() };
      };
      const id = await submitted('stale');
      await waitFor(() => ocrCalls - before >= 1);
      await prisma.verificationJob.update({ where: { sessionId: id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      void worker.wake(); // worker B re-claims and finishes (A is still blocked, so don't await)
      expect((await settled(id)).verification.mrz.valid).toBe(true);
      release();
      await new Promise((r) => setTimeout(r, 300)); // let A's failure path run
      const job = await prisma.verificationJob.findUnique({ where: { sessionId: id } });
      expect(job).toMatchObject({ status: 'DONE', attempts: 2 }); // A did not requeue B's finished job
      expect(ocrCalls - before).toBe(2);
      expect(await prisma.verificationResult.count({ where: { sessionId: id } })).toBe(1);
    });

    it('does not let one slow OCR call block other sessions', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let n = 0;
      ocrImpl = async () => {
        if (++n === 1) await gate;
        return { text: mrzText() };
      };
      const slow = await submitted('slow-one');
      await waitFor(() => n >= 1);
      const fast = await submitted('fast-one');
      expect((await settled(fast)).status).toBe('NEEDS_REVIEW');
      expect((await request(http()).get(`/v1/sessions/${slow}`).set(auth())).body.status).toBe('PROCESSING');
      release();
      expect((await settled(slow)).status).toBe('NEEDS_REVIEW');
    });

    describe('face match', () => {
      beforeEach(() => {
        ocrImpl = async () => ({ text: mrzText() });
      });

      it('approves only when document and face both pass, and reports the score', async () => {
        await setAutoApprove(true);
        const body = await settled(await submitted('face-ok'));
        expect(body.status).toBe('APPROVED');
        expect(body.verification.face).toEqual({ status: 'match', similarity: 95, provider: 'fake-face', source: 'liveness' });
      });

      it('applies the tenant threshold', async () => {
        await setAutoApprove(true);
        await setThreshold(99);
        const body = await settled(await submitted('face-strict'));
        expect(body.status).toBe('NEEDS_REVIEW');
        expect(body.verification.face).toEqual({ status: 'below_threshold', similarity: 95, provider: 'fake-face', source: 'liveness' });
        expect(body.verification.issues).toEqual(['FACE_BELOW_THRESHOLD']);
      });

      it.each([
        ['no face', { status: 'no_face' } as FaceComparison, 'FACE_NOT_DETECTED'],
        ['several faces', { status: 'multiple_faces' } as FaceComparison, 'FACE_MULTIPLE_FACES'],
        ['an unusable image', { status: 'unusable_image' } as FaceComparison, 'FACE_IMAGE_UNUSABLE'],
        ['a different person', { status: 'compared', similarity: 12 } as FaceComparison, 'FACE_BELOW_THRESHOLD'],
      ])('sends %s to review even with auto-approve on', async (_n, result, code) => {
        await setAutoApprove(true);
        faceImpl = async () => result;
        const body = await settled(await submitted(`face-${code}`));
        expect(body.status).toBe('NEEDS_REVIEW');
        expect(body.verification.issues).toEqual([code]);
      });

      it('goes to review without retrying when face matching is unavailable', async () => {
        await setAutoApprove(true);
        const before = faceCalls;
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        faceImpl = async () => {
          throw new FaceUnavailableError('no credentials');
        };
        const body = await settled(await submitted('face-unavailable'));
        expect(body.status).toBe('NEEDS_REVIEW');
        expect(body.verification.face).toEqual({ status: null, similarity: null, provider: null, source: null });
        expect(body.verification.issues).toEqual(['FACE_UNAVAILABLE']);
        expect(faceCalls - before).toBe(1);
        // A broken deployment must be visible in the logs, without any image or document data
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Face matching unavailable'));
        expect(JSON.stringify(warn.mock.calls)).not.toContain(SAMPLE.surname);
        warn.mockRestore();
      });

      it('retries a transient face failure', async () => {
        let n = 0;
        faceImpl = async () => {
          if (++n < 2) throw new Error('throttled');
          return goodFace();
        };
        expect((await settled(await submitted('face-flaky'))).verification.face.status).toBe('match');
        expect(n).toBe(2);
      });

      it('still checks the face when the ID back is missing', async () => {
        const body = await settled(await submitted('face-noback', undefined, false));
        expect(body.verification.face.status).toBe('match');
        expect(body.verification.issues).toEqual(['ID_BACK_MISSING']);
      });

      it('stores the score and provider but no image data', async () => {
        const id = await submitted('face-row');
        await settled(id);
        const row = await prisma.verificationResult.findUnique({ where: { sessionId: id } });
        expect(row).toMatchObject({ faceStatus: 'match', faceSimilarity: 95, faceProvider: 'fake-face' });
      });
    });

    describe('liveness', () => {
      beforeEach(() => {
        ocrImpl = async () => ({ text: mrzText() });
      });

      const startToken = async (ref: string) => {
        const created = await request(http()).post('/v1/sessions').set(auth()).send({ externalRef: ref }).expect(201);
        return { token: created.body.uploadToken as string, id: created.body.id as string };
      };

      it('starts a challenge, stores only the provider session id, and audit-logs it', async () => {
        const { token, id } = await startToken('live-start');
        const res = await request(http()).post(`/v1/upload/${token}/liveness`).expect(200);
        expect(res.body).toMatchObject({ provider: 'fake-live', sessionId: expect.stringMatching(/^live-/) });
        const row = await prisma.session.findUnique({ where: { id } });
        expect(row?.livenessSessionId).toBe(res.body.sessionId);
        expect((await prisma.auditLog.findMany({ where: { sessionId: id } })).map((l) => l.event)).toContain('liveness.started');
      });

      it('keeps each session’s challenge separate and rejects unknown tokens', async () => {
        const a = await startToken('live-a');
        const b = await startToken('live-b');
        const ra = await request(http()).post(`/v1/upload/${a.token}/liveness`).expect(200);
        const rb = await request(http()).post(`/v1/upload/${b.token}/liveness`).expect(200);
        expect(ra.body.sessionId).not.toBe(rb.body.sessionId);
        expect((await prisma.session.findUnique({ where: { id: a.id } }))?.livenessSessionId).toBe(ra.body.sessionId);
        await request(http()).post('/v1/upload/not-a-token/liveness').expect(404);
      });

      it('answers 501 when no liveness provider is configured', async () => {
        const { token, id } = await startToken('live-off');
        createImpl = async () => {
          throw new LivenessUnavailableError('off');
        };
        await request(http()).post(`/v1/upload/${token}/liveness`).expect(501);
        expect((await prisma.session.findUnique({ where: { id } }))?.livenessSessionId).toBeNull();
      });

      it('lets only one of several concurrent challenge starts win', async () => {
        const { token, id } = await startToken('live-concurrent');
        const results = await Promise.all(
          Array.from({ length: 5 }, () => request(http()).post(`/v1/upload/${token}/liveness`)),
        );
        const winners = results.filter((r) => r.status === 200);
        expect(winners).toHaveLength(1);
        expect(results.filter((r) => r.status === 409)).toHaveLength(4);
        // The id the client was handed is the one that is stored
        expect((await prisma.session.findUnique({ where: { id } }))?.livenessSessionId).toBe(winners[0].body.sessionId);
        // A later, non-racing start replaces it
        const again = await request(http()).post(`/v1/upload/${token}/liveness`).expect(200);
        expect((await prisma.session.findUnique({ where: { id } }))?.livenessSessionId).toBe(again.body.sessionId);
      });

      it('cannot change the challenge after submit, even when racing it', async () => {
        const { token, id } = await startToken('live-late');
        await request(http()).post(`/v1/upload/${token}/liveness`).expect(200);
        const first = (await prisma.session.findUnique({ where: { id } }))?.livenessSessionId;
        for (const kind of ['ID_FRONT', 'SELFIE']) {
          await request(http()).post(`/v1/upload/${token}/${kind}`).attach('file', PNG, { filename: 'a.png' }).expect(204);
        }
        const results = await Promise.all([
          request(http()).post(`/v1/upload/${token}/submit`),
          request(http()).post(`/v1/upload/${token}/liveness`),
          request(http()).post(`/v1/upload/${token}/liveness`),
        ]);
        expect(results[0].status).toBe(200);
        const stored = (await prisma.session.findUnique({ where: { id } }))?.livenessSessionId;
        const wins = results.slice(1).filter((r) => r.status === 200);
        // At most one start wins, and whatever is stored is exactly what that client was given
        expect(wins.length).toBeLessThanOrEqual(1);
        expect(stored).toBe(wins.length ? wins[0].body.sessionId : first);
        await settled(id);
        await request(http()).post(`/v1/upload/${token}/liveness`).expect(410);
        expect((await prisma.session.findUnique({ where: { id } }))?.livenessSessionId).toBe(stored);
      });

      it('approves only with liveness, and reports it', async () => {
        await setAutoApprove(true);
        const body = await settled(await submitted('live-ok'));
        expect(body.status).toBe('APPROVED');
        expect(body.verification.liveness).toEqual({ status: 'live', confidence: 97, provider: 'fake-live' });
      });

      it('sends a session with no liveness challenge to review, even with auto-approve on', async () => {
        await setAutoApprove(true);
        const before = liveCalls;
        const body = await settled(await submitted('live-skipped', undefined, true, false));
        expect(body.status).toBe('NEEDS_REVIEW');
        expect(body.verification.issues).toEqual(['LIVENESS_NOT_PERFORMED']);
        expect(body.verification.liveness).toEqual({ status: null, confidence: null, provider: null });
        expect(liveCalls - before).toBe(0);
      });

      it.each([
        ['a failed challenge', { status: 'not_live', confidence: 8 } as LivenessResult, 'LIVENESS_FAILED'],
        ['an unfinished challenge', { status: 'incomplete', confidence: null } as LivenessResult, 'LIVENESS_INCOMPLETE'],
        ['a verdict below the tenant minimum', { status: 'live', confidence: 80 } as LivenessResult, 'LIVENESS_FAILED'],
      ])('sends %s to review even with auto-approve on', async (_n, result, code) => {
        await setAutoApprove(true);
        liveImpl = async () => result;
        const body = await settled(await submitted(`live-${code}`));
        expect(body.status).toBe('NEEDS_REVIEW');
        expect(body.verification.issues).toEqual([code]);
      });

      it('applies the tenant’s minimum confidence', async () => {
        await setAutoApprove(true);
        await setLivenessMin(99);
        const body = await settled(await submitted('live-strict'));
        expect(body.status).toBe('NEEDS_REVIEW');
        expect(body.verification.liveness).toMatchObject({ status: 'not_live', confidence: 97 });
      });

      it('goes to review without retrying when the provider is unavailable', async () => {
        await setAutoApprove(true);
        const before = liveCalls;
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        liveImpl = async () => {
          throw new LivenessUnavailableError('credentials');
        };
        const body = await settled(await submitted('live-down'));
        expect(body.status).toBe('NEEDS_REVIEW');
        expect(body.verification.issues).toEqual(['LIVENESS_UNAVAILABLE']);
        expect(liveCalls - before).toBe(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Liveness unavailable'));
        warn.mockRestore();
      });

      it('retries a transient liveness failure', async () => {
        let n = 0;
        liveImpl = async () => {
          if (++n < 2) throw new Error('throttled');
          return goodLive();
        };
        expect((await settled(await submitted('live-flaky'))).verification.liveness.status).toBe('live');
        expect(n).toBe(2);
      });

      it('compares the liveness reference image, not the uploaded selfie', async () => {
        const reference = Buffer.from('reference-from-liveness');
        liveImpl = async () => ({ status: 'live', confidence: 97, referenceImage: reference });
        const body = await settled(await submitted('live-ref'));
        expect(lastSelfie).toEqual(reference);
        expect(body.verification.face.source).toBe('liveness');
        const row = await prisma.verificationResult.findFirst({ where: { session: { externalRef: 'live-ref' } } });
        expect(JSON.stringify(row)).not.toContain('reference-from-liveness');
      });

      it('falls back to the uploaded selfie when the provider returns no image', async () => {
        liveImpl = async () => ({ status: 'live', confidence: 97 });
        const body = await settled(await submitted('live-noref'));
        expect(lastSelfie).not.toEqual(Buffer.from('reference-from-liveness'));
        expect(body.verification.face.source).toBe('selfie');
      });

      it('never auto-approves when the live verdict has no challenge image to bind the match to', async () => {
        await setAutoApprove(true);
        liveImpl = async () => ({ status: 'live', confidence: 97 });
        const body = await settled(await submitted('live-unbound'));
        expect(body.status).toBe('NEEDS_REVIEW');
        expect(body.verification.face).toMatchObject({ status: 'match', source: 'selfie' });
        expect(body.verification.issues).toEqual(['FACE_NOT_BOUND_TO_LIVENESS']);
      });
    });

    it('does not expose another tenant’s verification result', async () => {
      ocrImpl = async () => ({ text: mrzText() });
      const id = await submitted('isolation');
      await settled(id);
      const other = await prisma.tenant.create({
        data: { name: 'other-2', apiKeyHash: sha256('vk_other2'), webhookSecret: 'x' },
      });
      try {
        await request(http()).get(`/v1/sessions/${id}`).set('Authorization', 'Bearer vk_other2').expect(404);
      } finally {
        await prisma.tenant.delete({ where: { id: other.id } });
      }
    });
  });

  describe('review UI and API', () => {
    const http = () => app.getHttpServer();
    const PW = 'a-long-test-password-1';
    const suffix = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
    const emailA = `reviewer-a-${suffix}@example.test`;
    const emailB = `reviewer-b-${suffix}@example.test`;
    let tenantB: string;
    let tenantR: string;
    const keyR = `vk_r_${suffix}`;
    const authR = () => ({ Authorization: `Bearer ${keyR}` });
    let reviewerA: string;
    let cookieA: string;
    let cookieB: string;

    const cookieOf = (res: request.Response) => {
      const raw = (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0] ?? '';
      return raw.split(';')[0];
    };
    const setAutoApprove = (autoApprove: boolean) => prisma.tenant.update({ where: { id: tenantR }, data: { autoApprove } });
    const login = (email: string, password = PW) => request(http()).post('/review/api/login').send({ email, password });

    async function needsReview(ref: string) {
      const created = await request(http()).post('/v1/sessions').set(authR()).send({ externalRef: ref, firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15' }).expect(201);
      const token = created.body.uploadToken as string;
      for (const kind of ['ID_FRONT', 'ID_BACK', 'SELFIE']) {
        await request(http()).post(`/v1/upload/${token}/${kind}`).attach('file', PNG, { filename: 'a.png' }).expect(204);
      }
      await request(http()).post(`/v1/upload/${token}/liveness`).expect(200);
      await request(http()).post(`/v1/upload/${token}/submit`).expect(200);
      for (let i = 0; i < 200; i++) {
        const row = await prisma.session.findUnique({ where: { id: created.body.id } });
        if (row && row.status !== 'PROCESSING') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      return created.body.id as string;
    }

    beforeAll(async () => {
      ocrImpl = async () => ({ text: mrzText() });
      // A fresh tenant per run, so the queue only holds this run's sessions
      const main = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      tenantR = (
        await prisma.tenant.create({
          data: { name: 'review-tests', apiKeyHash: sha256(keyR), webhookUrl: main.webhookUrl, webhookSecret: main.webhookSecret },
        })
      ).id;
      const b = await prisma.tenant.create({ data: { name: 'tenant-b', apiKeyHash: sha256(`vk_b_${suffix}`), webhookSecret: 'x' } });
      tenantB = b.id;
      const passwordHash = await hashPassword(PW);
      reviewerA = (await prisma.reviewer.create({ data: { tenantId: tenantR, email: emailA, name: 'Reviewer A', passwordHash } })).id;
      await prisma.reviewer.create({ data: { tenantId: tenantB, email: emailB, passwordHash } });
      const [ra, rb] = await Promise.all([login(emailA).expect(200), login(emailB).expect(200)]);
      cookieA = cookieOf(ra);
      cookieB = cookieOf(rb);
    });

    afterAll(async () => {
      ocrImpl = async () => ({ text: '' });
      await prisma.tenant.delete({ where: { id: tenantB } }).catch(() => undefined);
    });

    it('serves a UI with no inline script and a strict CSP', async () => {
      const page = await request(http()).get('/review').expect(200);
      expect(page.headers['content-security-policy']).toContain("default-src 'none'");
      expect(page.headers['content-security-policy']).toContain("script-src 'self'");
      expect(page.headers['x-frame-options']).toBe('DENY');
      expect(page.text).not.toMatch(/<script(?![^>]*\bsrc=)/i);
      expect(page.text).not.toMatch(/\son\w+=/i);
      const js = await request(http()).get('/review/app.js').expect(200);
      expect(js.headers['content-type']).toContain('javascript');
      expect(js.text).not.toMatch(/innerHTML|document\.write|eval\(/);
      await request(http()).get('/review/app.css').expect(200);
    });

    it('requires a signed-in reviewer for every API route', async () => {
      const id = '00000000-0000-4000-8000-000000000000';
      for (const [method, path] of [
        ['get', '/review/api/me'],
        ['get', '/review/api/sessions'],
        ['get', `/review/api/sessions/${id}`],
        ['get', `/review/api/sessions/${id}/documents/SELFIE`],
        ['post', `/review/api/sessions/${id}/decision`],
        ['post', '/review/api/logout'],
      ] as const) {
        await request(http())[method](path).expect(401);
      }
      await request(http()).get('/review/api/me').set('Cookie', 'vr_session=forged').expect(401);
      // Malformed percent escapes are just an invalid cookie, never a server error
      for (const bad of ['vr_session=%', 'vr_session=%E0%A4%A', 'vr_session=%zz']) {
        await request(http()).get('/review/api/me').set('Cookie', bad).expect(401);
        await request(http()).post('/review/api/logout').set('Cookie', bad).expect(401);
      }
      // An API key is not a review login
      await request(http()).get('/review/api/sessions').set(authR()).expect(401);
    });

    it('sets a hardened cookie and never echoes secrets', async () => {
      const res = await login(emailA).expect(200);
      const raw = (res.headers['set-cookie'] as unknown as string[])[0];
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Strict/i);
      expect(raw).toMatch(/Path=\/review/);
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash|token/i);
      const me = await request(http()).get('/review/api/me').set('Cookie', cookieOf(res)).expect(200);
      expect(me.body).toEqual({ email: emailA, name: 'Reviewer A' });
    });

    it('stores only a hash of the session token and a scrypt password hash', async () => {
      const row = await prisma.reviewer.findUnique({ where: { email: emailA } });
      expect(row?.passwordHash.startsWith('scrypt$')).toBe(true);
      expect(row?.passwordHash).not.toContain(PW);
      const token = decodeURIComponent(cookieA.split('=')[1]);
      expect(await prisma.reviewerSession.count({ where: { tokenHash: sha256(token) } })).toBe(1);
      expect(await prisma.reviewerSession.count({ where: { tokenHash: token } })).toBe(0);
    });

    it('gives the same generic error for unknown, wrong-password and disabled accounts', async () => {
      const disabled = `disabled-${suffix}@example.test`;
      await prisma.reviewer.create({ data: { tenantId, email: disabled, passwordHash: await hashPassword(PW), disabled: true } });
      const bodies = await Promise.all([
        login(`nobody-${suffix}@example.test`).expect(401),
        login(emailA, 'wrong-password-123').expect(401),
        login(disabled).expect(401),
      ]);
      expect(new Set(bodies.map((r) => JSON.stringify(r.body))).size).toBe(1);
      expect(bodies[0].body.message).toBe('Invalid email or password');
      expect(bodies.every((r) => !r.headers['set-cookie'])).toBe(true);
    });

    it('locks an account after repeated failures, even for the right password', async () => {
      const email = `lock-${suffix}@example.test`;
      await prisma.reviewer.create({ data: { tenantId, email, passwordHash: await hashPassword(PW) } });
      for (let i = 0; i < 5; i++) await login(email, 'wrong-password-123').expect(401);
      const locked = await login(email).expect(401);
      expect(locked.body.message).toBe('Invalid email or password');
      expect((await prisma.reviewer.findUnique({ where: { email } }))?.lockedUntil).not.toBeNull();
      await prisma.reviewer.update({ where: { email }, data: { lockedUntil: null } });
      await login(email).expect(200);
    });

    it('counts failures atomically: parallel wrong guesses still lock the account', async () => {
      const email = `parallel-${suffix}@example.test`;
      await prisma.reviewer.create({ data: { tenantId, email, passwordHash: await hashPassword(PW) } });
      await Promise.all(Array.from({ length: 5 }, () => login(email, 'wrong-password-123').expect(401)));
      expect((await prisma.reviewer.findUnique({ where: { email } }))?.lockedUntil).not.toBeNull();
    });

    it('approves with a blank reason treated as no reason', async () => {
      const id = await needsReview('blank-reason');
      await request(http()).post(`/review/api/sessions/${id}/decision`).set('Cookie', cookieA).send({ decision: 'APPROVED', reason: '   ' }).expect(200);
      expect((await prisma.session.findUnique({ where: { id } }))?.reviewReason).toBeNull();
    });

    it('refuses cross-origin logins and decisions', async () => {
      await login(emailA).set('Origin', 'https://evil.example').expect(403);
      const id = await needsReview('csrf');
      await request(http()).post(`/review/api/sessions/${id}/decision`).set('Cookie', cookieA).set('Origin', 'https://evil.example').send({ decision: 'APPROVED' }).expect(403);
      expect((await prisma.session.findUnique({ where: { id } }))?.status).toBe('NEEDS_REVIEW');
      // Same-origin requests carry an Origin that matches the host
      await request(http()).get('/review/api/me').set('Cookie', cookieA).expect(200);
    });

    it('shows each reviewer only their own tenant’s queue, details and documents', async () => {
      const id = await needsReview('isolation-queue');
      const mine = await request(http()).get('/review/api/sessions').set('Cookie', cookieA).expect(200);
      expect(mine.body.items.map((i: { id: string }) => i.id)).toContain(id);
      const theirs = await request(http()).get('/review/api/sessions').set('Cookie', cookieB).expect(200);
      expect(theirs.body.items.map((i: { id: string }) => i.id)).not.toContain(id);

      await request(http()).get(`/review/api/sessions/${id}`).set('Cookie', cookieB).expect(404);
      await request(http()).get(`/review/api/sessions/${id}/documents/SELFIE`).set('Cookie', cookieB).expect(404);
      await request(http()).post(`/review/api/sessions/${id}/decision`).set('Cookie', cookieB).send({ decision: 'APPROVED' }).expect(404);
      expect((await prisma.session.findUnique({ where: { id } }))?.status).toBe('NEEDS_REVIEW');
      expect(await prisma.auditLog.count({ where: { sessionId: id, event: { startsWith: 'review.' } } })).toBe(0);
    });

    it('lists only sessions waiting for review, oldest first, with pagination', async () => {
      const ids = [await needsReview('page-1'), await needsReview('page-2')];
      const page1 = await request(http()).get('/review/api/sessions').set('Cookie', cookieA).expect(200);
      const order = page1.body.items.map((i: { id: string }) => i.id);
      expect(order.indexOf(ids[0])).toBeLessThan(order.indexOf(ids[1]));
      await request(http()).get('/review/api/sessions?cursor=not-a-uuid').set('Cookie', cookieA).expect(400);
      await setAutoApprove(true);
      const auto = await needsReview('auto-approved'); // approved by the pipeline: must not be queued
      await setAutoApprove(false);
      const all = await request(http()).get('/review/api/sessions').set('Cookie', cookieA).expect(200);
      expect(all.body.items.map((i: { id: string }) => i.id)).not.toContain(auto);
    });

    it('shows the reviewer the expected data and check results', async () => {
      const id = await needsReview('detail');
      const res = await request(http()).get(`/review/api/sessions/${id}`).set('Cookie', cookieA).expect(200);
      expect(res.body).toMatchObject({
        id,
        status: 'NEEDS_REVIEW',
        expected: { firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15' },
        documents: expect.arrayContaining(['ID_FRONT', 'ID_BACK', 'SELFIE']),
        verification: { mrz: { found: true, valid: true } },
        review: null,
      });
    });

    it('decrypts documents on the fly, never writing them to disk, and audit-logs the view', async () => {
      const id = await needsReview('docs');
      const clear = 'fake-image-body';
      const scan = () => {
        const walk = (dir: string): string[] =>
          readdirSync(dir).flatMap((n) => {
            const f = join(dir, n);
            return statSync(f).isDirectory() ? walk(f) : [f];
          });
        return walk(storageDir).filter((f) => readFileSync(f).includes(Buffer.from(clear)));
      };
      expect(scan()).toEqual([]);
      const res = await request(http()).get(`/review/api/sessions/${id}/documents/SELFIE`).set('Cookie', cookieA).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-type']).toContain('image/png');
      expect(scan()).toEqual([]);
      const log = await prisma.auditLog.findFirst({ where: { sessionId: id, event: 'review.document_viewed' } });
      expect(log?.detail).toEqual({ kind: 'SELFIE', reviewerId: reviewerA });
      await request(http()).get(`/review/api/sessions/${id}/documents/NOT_A_KIND`).set('Cookie', cookieA).expect(400);
    });

    it('approves with an audit trail, a signed webhook and the decision visible to the tenant', async () => {
      const id = await needsReview('approve');
      const before = hooks.length;
      const res = await request(http()).post(`/review/api/sessions/${id}/decision`).set('Cookie', cookieA).send({ decision: 'APPROVED' }).expect(200);
      expect(res.body).toEqual({ status: 'APPROVED' });
      const row = await prisma.session.findUnique({ where: { id } });
      expect(row).toMatchObject({ status: 'APPROVED', reviewedById: reviewerA, reviewReason: null });
      const log = await prisma.auditLog.findFirst({ where: { sessionId: id, event: 'review.decided' } });
      expect(log?.detail).toEqual({ decision: 'APPROVED', reviewerId: reviewerA, hasReason: false });

      await waitFor(() => hooks.length > before);
      const hook = hooks[hooks.length - 1];
      const m = hook.signature.match(/^t=(\d+),v1=([0-9a-f]+)$/)!;
      expect(m[2]).toBe(hmacSign(webhookSecret, `${m[1]}.${hook.body}`));
      expect(JSON.parse(hook.body)).toMatchObject({ sessionId: id, status: 'APPROVED', review: { decision: 'APPROVED', reason: null }, verification: { mrz: { found: true } } });

      const api = await request(http()).get(`/v1/sessions/${id}`).set(authR()).expect(200);
      expect(api.body.status).toBe('APPROVED');
      expect(api.body.review).toMatchObject({ decision: 'APPROVED', reason: null });
      // The reviewer's identity is not shared with the tenant's API
      expect(JSON.stringify(api.body)).not.toContain(reviewerA);
    });

    it('requires a reason to reject, stores it, and tells the tenant', async () => {
      const id = await needsReview('reject');
      const post = (body: object) => request(http()).post(`/review/api/sessions/${id}/decision`).set('Cookie', cookieA).send(body);
      await post({ decision: 'REJECTED' }).expect(400);
      await post({ decision: 'REJECTED', reason: '  ' }).expect(400);
      await post({ decision: 'MAYBE' }).expect(400);
      await post({ decision: 'APPROVED', extra: 1 }).expect(400);
      // Padding can't satisfy the minimum: the trimmed reason is what counts
      await post({ decision: 'REJECTED', reason: '  x ' }).expect(400);
      await post({ decision: 'REJECTED', reason: ' ab  ' }).expect(400);
      await post({ decision: 'REJECTED', reason: 'x'.repeat(501) }).expect(400);
      expect((await prisma.session.findUnique({ where: { id } }))?.status).toBe('NEEDS_REVIEW');
      const before = hooks.length;
      await post({ decision: 'REJECTED', reason: 'Photo does not match the document' }).expect(200);
      await waitFor(() => hooks.length > before);
      expect(JSON.parse(hooks[hooks.length - 1].body)).toMatchObject({ status: 'REJECTED', review: { reason: 'Photo does not match the document' } });
      const log = await prisma.auditLog.findFirst({ where: { sessionId: id, event: 'review.decided' } });
      // The free-text reason lives on the session, never in the audit log
      expect(JSON.stringify(log?.detail)).not.toContain('Photo');
    });

    it('lets only one of several concurrent decisions through, with one webhook', async () => {
      const id = await needsReview('race-decide');
      const before = hooks.length;
      const results = await Promise.all(
        ['APPROVED', 'REJECTED', 'APPROVED', 'REJECTED'].map((decision) =>
          request(http()).post(`/review/api/sessions/${id}/decision`).set('Cookie', cookieA).send({ decision, reason: 'because' }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
      const winner = results.find((r) => r.status === 200)!.body.status;
      expect((await prisma.session.findUnique({ where: { id } }))?.status).toBe(winner);
      expect(await prisma.auditLog.count({ where: { sessionId: id, event: 'review.decided' } })).toBe(1);
      await waitFor(() => hooks.length > before);
      await new Promise((r) => setTimeout(r, 200));
      expect(hooks.length - before).toBe(1);
    });

    it('refuses decisions on sessions that are not waiting for review', async () => {
      await setAutoApprove(true);
      const auto = await needsReview('auto-then-decide');
      await setAutoApprove(false);
      expect((await prisma.session.findUnique({ where: { id: auto } }))?.status).toBe('APPROVED');
      await request(http()).post(`/review/api/sessions/${auto}/decision`).set('Cookie', cookieA).send({ decision: 'REJECTED', reason: 'changed my mind' }).expect(409);
      expect((await prisma.session.findUnique({ where: { id: auto } }))?.status).toBe('APPROVED');
      const pending = await request(http()).post('/v1/sessions').set(authR()).send({ externalRef: 'still-pending' }).expect(201);
      await request(http()).post(`/review/api/sessions/${pending.body.id}/decision`).set('Cookie', cookieA).send({ decision: 'APPROVED' }).expect(409);
    });

    it('ends access on logout, expiry, idle timeout and disabling', async () => {
      const mk = async (email: string) => {
        await prisma.reviewer.upsert({ where: { email }, update: {}, create: { tenantId, email, passwordHash: await hashPassword(PW) } });
        const res = await login(email).expect(200);
        return { cookie: cookieOf(res), token: decodeURIComponent(cookieOf(res).split('=')[1]) };
      };
      const out = await mk(`logout-${suffix}@example.test`);
      await request(http()).post('/review/api/logout').set('Cookie', out.cookie).expect(204);
      await request(http()).get('/review/api/me').set('Cookie', out.cookie).expect(401);

      const exp = await mk(`expiry-${suffix}@example.test`);
      await prisma.reviewerSession.update({ where: { tokenHash: sha256(exp.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await request(http()).get('/review/api/me').set('Cookie', exp.cookie).expect(401);

      const idle = await mk(`idle-${suffix}@example.test`);
      await prisma.reviewerSession.update({ where: { tokenHash: sha256(idle.token) }, data: { lastSeenAt: new Date(Date.now() - 2 * 3600_000) } });
      await request(http()).get('/review/api/me').set('Cookie', idle.cookie).expect(401);

      const dis = await mk(`disable-${suffix}@example.test`);
      await request(http()).get('/review/api/me').set('Cookie', dis.cookie).expect(200);
      await prisma.reviewer.update({ where: { email: `disable-${suffix}@example.test` }, data: { disabled: true } });
      await request(http()).get('/review/api/me').set('Cookie', dis.cookie).expect(401);
    });

    it('rate-limits login attempts per IP', async () => {
      const normal = process.env.LOGIN_RATE_LIMIT;
      process.env.LOGIN_RATE_LIMIT = '2';
      try {
        const codes: number[] = [];
        for (let i = 0; i < 6; i++) codes.push((await login(`nobody-${suffix}@example.test`, 'x')).status);
        expect(codes).toContain(429);
      } finally {
        process.env.LOGIN_RATE_LIMIT = normal;
      }
    });
  });
});
