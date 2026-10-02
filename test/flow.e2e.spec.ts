// Runs the full flow against a real Postgres (DATABASE_URL). No external services are contacted:
// the webhook target is a local HTTP server started by the test.
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
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
import { OutboxService } from '../src/webhooks/outbox.service';
import { WebhookDispatcher } from '../src/webhooks/dispatcher';
import { RetentionService } from '../src/retention/retention.service';
import { StorageService } from '../src/storage/storage.service';
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
process.env.RETENTION_JOB_ENABLED = 'false';
process.env.WEBHOOK_POLL_MS = '50';
process.env.WEBHOOK_MAX_ATTEMPTS = '3';
process.env.WEBHOOK_RETRY_BASE_MS = '1';
process.env.WEBHOOK_TIMEOUT_MS = '1000';
process.env.VERIFICATION_POLL_MS = '50';

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

/** Webhooks received for one session. Deliveries run in parallel, so never rely on arrival order across sessions. */
const hooksFor = <T extends { body: string }>(all: T[], sessionId: string) =>
  all.map((h) => ({ h, b: JSON.parse(h.body) })).filter((x) => x.b.sessionId === sessionId);

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
  let retention: RetentionService;
  let outbox: OutboxService;
  let dispatcher: WebhookDispatcher;

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
    retention = moduleRef.get(RetentionService);
    outbox = moduleRef.get(OutboxService);
    dispatcher = moduleRef.get(WebhookDispatcher);
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
    expect(JSON.parse(hooks[0].body).eventId).toMatch(/^[0-9a-f-]{36}$/);
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
    const { token, id: raceId } = await readySession('race');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app.getHttpServer()).post(`/v1/upload/${token}/submit`)),
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 410)).toHaveLength(4);
    await waitFor(() => hooksFor(hooks, raceId).length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(hooksFor(hooks, raceId)).toHaveLength(1);
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
      const id = await submitted('clean-on');
      expect((await settled(id)).status).toBe('APPROVED');
      await waitFor(() => hooksFor(hooks, id).length >= 1);
      const last = hooksFor(hooks, id)[0].b;
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
        // The provider call is slow, so every request has read the session (no challenge yet)
        // before any of them stores one: a genuine overlap, not a lucky interleaving.
        createImpl = async () => {
          await new Promise((r) => setTimeout(r, 150));
          return { providerSessionId: `live-${++sessionCounter}` };
        };
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
      const res = await request(http()).post(`/review/api/sessions/${id}/decision`).set('Cookie', cookieA).send({ decision: 'APPROVED' }).expect(200);
      expect(res.body).toEqual({ status: 'APPROVED' });
      const row = await prisma.session.findUnique({ where: { id } });
      expect(row).toMatchObject({ status: 'APPROVED', reviewedById: reviewerA, reviewReason: null });
      const log = await prisma.auditLog.findFirst({ where: { sessionId: id, event: 'review.decided' } });
      expect(log?.detail).toEqual({ decision: 'APPROVED', reviewerId: reviewerA, hasReason: false });

      await waitFor(() => hooksFor(hooks, id).some((x) => x.b.status === 'APPROVED'));
      const hook = hooksFor(hooks, id).find((x) => x.b.status === 'APPROVED')!.h;
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
      await post({ decision: 'REJECTED', reason: 'Photo does not match the document' }).expect(200);
      await waitFor(() => hooksFor(hooks, id).some((x) => x.b.status === 'REJECTED'));
      expect(hooksFor(hooks, id).find((x) => x.b.status === 'REJECTED')!.b).toMatchObject({ status: 'REJECTED', review: { reason: 'Photo does not match the document' } });
      const log = await prisma.auditLog.findFirst({ where: { sessionId: id, event: 'review.decided' } });
      // The free-text reason lives on the session, never in the audit log
      expect(JSON.stringify(log?.detail)).not.toContain('Photo');
    });

    it('lets only one of several concurrent decisions through, with one webhook', async () => {
      const id = await needsReview('race-decide');
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
      const decisionHooks = () => hooksFor(hooks, id).filter((x) => x.b.status === 'APPROVED' || x.b.status === 'REJECTED');
      await waitFor(() => decisionHooks().length >= 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(decisionHooks()).toHaveLength(1);
      expect(decisionHooks()[0].b.status).toBe(winner);
      expect(await prisma.webhookEvent.count({ where: { sessionId: id, body: { contains: `"status":"${winner}"` } } })).toBe(1);
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

  describe('retention, deletion and evidence', () => {
    const http = () => app.getHttpServer();
    const suffix = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
    const DAY = 86_400_000;
    const days = (n: number) => new Date(Date.now() - n * DAY);
    type T = { id: string; key: string; h: { Authorization: string } };
    let t1: T; // defaults: documents 30 days, records 1825 days, no evidence export
    let t2: T; // documents kept 90 days
    let t3: T; // evidence export on
    let tZero: T; // documents deleted immediately after the decision

    async function mkTenant(name: string, extra: object = {}): Promise<T> {
      const key = `vk_${name}_${suffix}`;
      const main = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const t = await prisma.tenant.create({
        data: { name: `ret-${name}`, apiKeyHash: sha256(key), webhookUrl: main.webhookUrl, webhookSecret: `whsec_${name}_${suffix}`, ...extra },
      });
      return { id: t.id, key, h: { Authorization: `Bearer ${key}` } };
    }

    /** A session with three real uploads, optionally already decided `decidedDaysAgo` days ago. */
    async function withDocs(t: T, ref: string, decidedDaysAgo: number | null, status: 'APPROVED' | 'REJECTED' | 'NEEDS_REVIEW' | 'PENDING' = 'APPROVED') {
      const created = await request(http()).post('/v1/sessions').set(t.h).send({ externalRef: ref, firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15' }).expect(201);
      const token = created.body.uploadToken as string;
      for (const kind of ['ID_FRONT', 'ID_BACK', 'SELFIE']) {
        await request(http()).post(`/v1/upload/${token}/${kind}`).attach('file', PNG, { filename: 'a.png' }).expect(204);
      }
      const id = created.body.id as string;
      if (status !== 'PENDING') {
        await prisma.session.update({
          where: { id },
          data: { status, ...(decidedDaysAgo !== null ? { decidedAt: days(decidedDaysAgo) } : {}) },
        });
      }
      return { id, token };
    }
    const dir = (t: T, id: string) => join(storageDir, t.id, id);
    const files = (t: T, id: string) => {
      try {
        return readdirSync(dir(t, id));
      } catch {
        return [];
      }
    };
    const exists = async (id: string) => (await prisma.session.count({ where: { id } })) === 1;

    beforeAll(async () => {
      t1 = await mkTenant('t1');
      t2 = await mkTenant('t2', { documentRetentionDays: 90 });
      t3 = await mkTenant('t3', { evidenceExport: true });
      tZero = await mkTenant('tzero', { documentRetentionDays: 0 });
    });
    afterAll(async () => {
      jest.restoreAllMocks();
    });

    it('deletes documents after the tenant’s window but keeps the record', async () => {
      const due = await withDocs(t1, 'due', 31);
      const fresh = await withDocs(t1, 'fresh', 29);
      expect(files(t1, due.id)).toHaveLength(3);
      const report = await retention.run();
      // The report counts images removed (this session alone had three), not sessions
      expect(report.documentsDeleted).toBeGreaterThanOrEqual(3);

      expect(files(t1, due.id)).toHaveLength(0);
      expect(await prisma.document.count({ where: { sessionId: due.id } })).toBe(0);
      const row = await prisma.session.findUnique({ where: { id: due.id } });
      expect(row?.documentsDeletedAt).not.toBeNull();
      expect(row?.documentsManifest).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'SELFIE', sizeBytes: PNG.length, sha256: sha256(PNG) })]));
      expect(row?.status).toBe('APPROVED'); // the decision and record survive
      const log = await prisma.auditLog.findFirst({ where: { sessionId: due.id, event: 'retention.documents_deleted' } });
      expect(log?.detail).toMatchObject({ count: 3 });
      const api = await request(http()).get(`/v1/sessions/${due.id}`).set(t1.h).expect(200);
      expect(api.body).toMatchObject({ status: 'APPROVED', uploaded: [] });
      expect(api.body.documentsDeletedAt).not.toBeNull();

      expect(files(t1, fresh.id)).toHaveLength(3); // not due yet
    });

    it('uses each tenant’s own window', async () => {
      const a = await withDocs(t1, 'win-30', 45); // 30-day tenant: due
      const b = await withDocs(t2, 'win-90', 45); // 90-day tenant: not due
      const c = await withDocs(tZero, 'win-0', 0); // immediate
      await retention.run();
      expect(files(t1, a.id)).toHaveLength(0);
      expect(files(t2, b.id)).toHaveLength(3);
      expect(files(tZero, c.id)).toHaveLength(0);
      // Changing the window applies to existing sessions at the next run
      await prisma.tenant.update({ where: { id: t2.id }, data: { documentRetentionDays: 40 } });
      await retention.run();
      expect(files(t2, b.id)).toHaveLength(0);
    });

    it('never touches a session that has no decision yet, however old', async () => {
      const waiting = await withDocs(t1, 'waiting', null, 'NEEDS_REVIEW');
      await prisma.session.update({ where: { id: waiting.id }, data: { createdAt: days(400) } });
      await retention.run();
      expect(files(t1, waiting.id)).toHaveLength(3);
      expect(await exists(waiting.id)).toBe(true);
    });

    it('deletes the whole record after the record window and leaves a tombstone without personal data', async () => {
      const old = await withDocs(t1, 'old-record', 1900);
      await prisma.verificationResult.create({
        data: { sessionId: old.id, decision: 'APPROVED', autoDecided: false, mrzFound: true, mrzValid: true, ocrRepaired: false, checks: [], issueCodes: [], ocrProvider: 'x' },
      });
      await retention.run();
      expect(await exists(old.id)).toBe(false);
      expect(files(t1, old.id)).toHaveLength(0);
      expect(await prisma.verificationResult.count({ where: { sessionId: old.id } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { sessionId: old.id } })).toBe(0);
      const tomb = await prisma.deletionRecord.findFirst({ where: { sessionId: old.id } });
      expect(tomb).toMatchObject({ tenantId: t1.id, reason: 'retention', documentCount: 3 });
      expect(JSON.stringify(tomb)).not.toMatch(/old-record|Dema|Testi/); // not even the tenant's own reference
      await request(http()).get(`/v1/sessions/${old.id}`).set(t1.h).expect(404);
    });

    it('removes abandoned sessions after the grace period, and nothing else', async () => {
      const gone = await withDocs(t1, 'abandoned', null, 'PENDING');
      const recent = await withDocs(t1, 'recently-expired', null, 'PENDING');
      const live = await withDocs(t1, 'still-open', null, 'PENDING');
      await prisma.session.update({ where: { id: gone.id }, data: { expiresAt: new Date(Date.now() - 25 * 3600_000) } });
      await prisma.session.update({ where: { id: recent.id }, data: { expiresAt: new Date(Date.now() - 3600_000) } });
      await retention.run();
      expect(await exists(gone.id)).toBe(false);
      expect(files(t1, gone.id)).toHaveLength(0);
      expect(await prisma.deletionRecord.count({ where: { sessionId: gone.id, reason: 'abandoned' } })).toBe(1);
      expect(await exists(recent.id)).toBe(true);
      expect(await exists(live.id)).toBe(true);
    });

    it('is safe to run on several instances at once', async () => {
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push((await withDocs(t1, `par-${i}`, 31)).id);
      const reports = await Promise.all([retention.run(), retention.run(), retention.run()]);
      expect(reports.reduce((n, r) => n + r.failed, 0)).toBe(0);
      expect(reports.reduce((n, r) => n + r.documentsDeleted, 0)).toBeGreaterThanOrEqual(4);
      for (const id of ids) {
        expect(await prisma.auditLog.count({ where: { sessionId: id, event: 'retention.documents_deleted' } })).toBe(1);
      }
    });

    it('keeps the rows when a file cannot be deleted, and finishes on the next run', async () => {
      const a = await withDocs(t1, 'fail-a', 31);
      const b = await withDocs(t1, 'fail-b', 31);
      // Only this test's session fails (the run is global, so other leftovers must not matter)
      const real = StorageService.prototype.delete;
      const spy = jest.spyOn(StorageService.prototype, 'delete').mockImplementation(function (this: StorageService, key: string) {
        return key.includes(a.id) ? Promise.reject(new Error('disk offline')) : real.call(this, key);
      });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const first = await retention.run();
      spy.mockRestore();
      expect(first.failed).toBeGreaterThanOrEqual(1);
      // Operators can see which session is still undeleted and why, without any personal data
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('Erasure failed'));
      expect(lines.some((l) => l.includes(a.id) && l.includes('disk offline'))).toBe(true);
      expect(lines.join('\n')).not.toMatch(/Dema|Testi|fail-a/);
      warn.mockRestore();
      // The other session was processed; the failed one still has its rows, files and no deletion stamp
      expect(files(t1, b.id)).toHaveLength(0);
      expect(files(t1, a.id)).toHaveLength(3);
      expect(await prisma.document.count({ where: { sessionId: a.id } })).toBe(3);
      expect((await prisma.session.findUnique({ where: { id: a.id } }))?.documentsDeletedAt).toBeNull();
      const second = await retention.run();
      expect(second.failed).toBe(0);
      expect(files(t1, a.id)).toHaveLength(0);
      expect(await prisma.document.count({ where: { sessionId: a.id } })).toBe(0);
    });

    it('does not let a batch of failing sessions starve newer ones', async () => {
      const bad = [await withDocs(t1, 'stuck-1', 31), await withDocs(t1, 'stuck-2', 31), await withDocs(t1, 'stuck-3', 31)];
      const good = await withDocs(t1, 'newer-ok', 31); // created later, so it is behind the stuck ones
      process.env.RETENTION_BATCH = '2';
      const real = StorageService.prototype.delete;
      const spy = jest.spyOn(StorageService.prototype, 'delete').mockImplementation(function (this: StorageService, key: string) {
        return bad.some((b) => key.includes(b.id)) ? Promise.reject(new Error('stuck')) : real.call(this, key);
      });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      try {
        const report = await retention.run();
        expect(report.failed).toBeGreaterThanOrEqual(3);
        expect(files(t1, good.id)).toHaveLength(0); // reached despite three failures ahead of it with a batch of two
        for (const b of bad) expect(files(t1, b.id)).toHaveLength(3);
      } finally {
        delete process.env.RETENTION_BATCH;
        spy.mockRestore();
        warn.mockRestore();
      }
      const again = await retention.run(); // next run retries the stuck ones
      expect(again.failed).toBe(0);
      for (const b of bad) expect(files(t1, b.id)).toHaveLength(0);
    });

    describe('DELETE /v1/sessions/:id', () => {
      it('erases a session on request, leaves a tombstone, and 404s afterwards', async () => {
        const s = await withDocs(t1, 'erase-me', 3);
        await request(http()).delete(`/v1/sessions/${s.id}`).set(t1.h).expect(204);
        expect(await exists(s.id)).toBe(false);
        expect(files(t1, s.id)).toHaveLength(0);
        expect(await prisma.deletionRecord.findFirst({ where: { sessionId: s.id } })).toMatchObject({ reason: 'tenant_request', documentCount: 3 });
        await request(http()).get(`/v1/sessions/${s.id}`).set(t1.h).expect(404);
        await request(http()).delete(`/v1/sessions/${s.id}`).set(t1.h).expect(404);
        // The upload link died with the session
        await request(http()).post(`/v1/upload/${s.token}/SELFIE`).attach('file', PNG, { filename: 'x.png' }).expect(404);
      });

      it('works for sessions in any state except while the pipeline is reading them', async () => {
        for (const status of ['NEEDS_REVIEW', 'REJECTED'] as const) {
          const s = await withDocs(t1, `erase-${status}`, null, status);
          await request(http()).delete(`/v1/sessions/${s.id}`).set(t1.h).expect(204);
        }
        const open = await withDocs(t1, 'erase-pending', null, 'PENDING');
        await request(http()).delete(`/v1/sessions/${open.id}`).set(t1.h).expect(204);
        const busy = await withDocs(t1, 'erase-busy', null, 'PENDING');
        await prisma.session.update({ where: { id: busy.id }, data: { status: 'PROCESSING' } });
        await request(http()).delete(`/v1/sessions/${busy.id}`).set(t1.h).expect(409);
        expect(await exists(busy.id)).toBe(true);
        expect(files(t1, busy.id)).toHaveLength(3);
      });

      it('cannot reach another tenant’s session, and needs an API key', async () => {
        const s = await withDocs(t1, 'not-yours', 3);
        await request(http()).delete(`/v1/sessions/${s.id}`).set(t2.h).expect(404);
        await request(http()).delete(`/v1/sessions/${s.id}`).expect(401);
        await request(http()).delete('/v1/sessions/not-a-uuid').set(t1.h).expect(400);
        expect(await exists(s.id)).toBe(true);
        expect(files(t1, s.id)).toHaveLength(3);
        expect(await prisma.deletionRecord.count({ where: { sessionId: s.id } })).toBe(0);
      });

      it('leaves no file behind when an upload races the deletion', async () => {
        for (let i = 0; i < 6; i++) {
          const created = await request(http()).post('/v1/sessions').set(t1.h).send({ externalRef: `race-del-${i}` }).expect(201);
          const token = created.body.uploadToken as string;
          const id = created.body.id as string;
          await request(http()).post(`/v1/upload/${token}/ID_FRONT`).attach('file', PNG, { filename: 'a.png' }).expect(204);
          const [del, up] = await Promise.all([
            request(http()).delete(`/v1/sessions/${id}`).set(t1.h),
            request(http()).post(`/v1/upload/${token}/SELFIE`).attach('file', PNG, { filename: 'a.png' }),
          ]);
          expect(del.status).toBe(204);
          expect([204, 404, 410]).toContain(up.status);
          expect(await exists(id)).toBe(false);
          expect(files(t1, id)).toHaveLength(0);
        }
      });
    });

    describe('evidence export', () => {
      it('is refused unless the tenant has it enabled', async () => {
        const s = await withDocs(t1, 'ev-off', 3);
        await request(http()).get(`/v1/sessions/${s.id}/evidence`).set(t1.h).expect(403);
        await request(http()).get(`/v1/sessions/${s.id}/evidence/documents/SELFIE`).set(t1.h).expect(403);
        await request(http()).get(`/v1/sessions/${s.id}/evidence`).expect(401);
        expect(await prisma.auditLog.count({ where: { sessionId: s.id, event: { startsWith: 'evidence.' } } })).toBe(0);
      });

      it('returns a signed bundle with integrity hashes and an audit trail', async () => {
        const s = await withDocs(t3, 'ev-on', 3);
        const reviewer = await prisma.reviewer.create({ data: { tenantId: t3.id, email: `ev-${suffix}@example.test`, passwordHash: 'x' } });
        await prisma.session.update({ where: { id: s.id }, data: { reviewedById: reviewer.id, reviewReason: 'looks right', reviewedAt: days(3) } });
        const res = await request(http()).get(`/v1/sessions/${s.id}/evidence`).set(t3.h).expect(200);
        const sig = String(res.headers['x-evidence-signature']).match(/^t=(\d+),v1=([0-9a-f]+)$/)!;
        expect(sig[2]).toBe(hmacSign(`whsec_t3_${suffix}`, `${sig[1]}.${res.text}`));
        expect(res.body).toMatchObject({
          version: 1,
          session: { id: s.id, status: 'APPROVED', externalRef: 'ev-on' },
          expectedIdentity: { firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15' },
          review: { decision: 'APPROVED', reason: 'looks right', reviewer: `ev-${suffix}@example.test` },
          documentsDeletedAt: null,
        });
        expect(res.body.documents).toHaveLength(3);
        expect(res.body.documents[0]).toMatchObject({ sizeBytes: PNG.length, sha256: sha256(PNG) });
        expect(res.body.auditLog.map((l: { event: string }) => l.event)).toContain('document.uploaded');
        expect(await prisma.auditLog.count({ where: { sessionId: s.id, event: 'evidence.exported' } })).toBe(1);
        // The signed trail includes the export it accompanies
        expect(res.body.auditLog[res.body.auditLog.length - 1].event).toBe('evidence.exported');
      });

      it('reads as gone, not as a server error, when a file was erased but its row survives', async () => {
        const s = await withDocs(t3, 'ev-half', 3);
        for (const f of files(t3, s.id)) rmSync(join(dir(t3, s.id), f));
        await request(http()).get(`/v1/sessions/${s.id}/evidence/documents/SELFIE`).set(t3.h).expect(410);
        expect(await prisma.auditLog.count({ where: { sessionId: s.id, event: 'evidence.document_exported' } })).toBe(0);
        await request(http()).get(`/v1/sessions/${s.id}/evidence`).set(t3.h).expect(200); // the bundle itself still works
      });

      it('never errors when an export races an erasure, in either order', async () => {
        for (let i = 0; i < 8; i++) {
          const s = await withDocs(t3, `ev-race-${i}`, 3);
          const calls: [string, request.Test][] = [
            ['doc', request(http()).get(`/v1/sessions/${s.id}/evidence/documents/SELFIE`).set(t3.h)],
            ['bundle', request(http()).get(`/v1/sessions/${s.id}/evidence`).set(t3.h)],
            ['delete', request(http()).delete(`/v1/sessions/${s.id}`).set(t3.h)],
          ];
          if (i % 2) calls.reverse();
          const results = await Promise.all(calls.map(async ([name, req]) => [name, (await req).status] as const));
          for (const [, status] of results) expect([200, 204, 404, 410]).toContain(status);
          expect(results.find(([n]) => n === 'delete')?.[1]).toBe(204);
          expect(await exists(s.id)).toBe(false);
          expect(files(t3, s.id)).toHaveLength(0);
        }
      });

      it('serves a decrypted document that matches its recorded hash, and audit-logs it', async () => {
        const s = await withDocs(t3, 'ev-doc', 3);
        const res = await request(http()).get(`/v1/sessions/${s.id}/evidence/documents/ID_FRONT`).set(t3.h).buffer(true).parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        }).expect(200);
        expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
        expect(res.headers['x-document-sha256']).toBe(sha256(PNG));
        expect(res.headers['cache-control']).toBe('no-store');
        expect((await prisma.auditLog.findFirst({ where: { sessionId: s.id, event: 'evidence.document_exported' } }))?.detail).toEqual({ kind: 'ID_FRONT' });
        await request(http()).get(`/v1/sessions/${s.id}/evidence/documents/NOPE`).set(t3.h).expect(400);
      });

      it('is scoped to the owning tenant', async () => {
        const s = await withDocs(t3, 'ev-iso', 3);
        const other = await mkTenant('t3b', { evidenceExport: true });
        await request(http()).get(`/v1/sessions/${s.id}/evidence`).set(other.h).expect(404);
        await request(http()).get(`/v1/sessions/${s.id}/evidence/documents/SELFIE`).set(other.h).expect(404);
        expect(await prisma.auditLog.count({ where: { sessionId: s.id, event: { startsWith: 'evidence.' } } })).toBe(0);
      });

      it('still describes the documents after retention deleted them', async () => {
        const s = await withDocs(t3, 'ev-after', 31);
        await retention.run();
        expect(files(t3, s.id)).toHaveLength(0);
        const res = await request(http()).get(`/v1/sessions/${s.id}/evidence`).set(t3.h).expect(200);
        expect(res.body.documentsDeletedAt).not.toBeNull();
        expect(res.body.documents).toHaveLength(3);
        expect(res.body.documents[0].sha256).toBe(sha256(PNG));
        expect(res.body.auditLog.map((l: { event: string }) => l.event)).toContain('retention.documents_deleted');
        await request(http()).get(`/v1/sessions/${s.id}/evidence/documents/SELFIE`).set(t3.h).expect(410);
      });
    });

    it('stamps decidedAt on pipeline approvals and human decisions, so the retention clock starts', async () => {
      ocrImpl = async () => ({ text: mrzText() });
      await prisma.tenant.update({ where: { id: t1.id }, data: { autoApprove: true } });
      try {
        const created = await request(http()).post('/v1/sessions').set(t1.h).send({ externalRef: 'clock', firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15' }).expect(201);
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
        const row = await prisma.session.findUnique({ where: { id: created.body.id } });
        expect(row?.status).toBe('APPROVED');
        expect(row?.decidedAt).not.toBeNull();
      } finally {
        await prisma.tenant.update({ where: { id: t1.id }, data: { autoApprove: false } });
        ocrImpl = async () => ({ text: '' });
      }
    });
  });

  describe('webhook outbox', () => {
    const http = () => app.getHttpServer();
    const suffix = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    type Call = { eventId: string; body: string; signature: string; at: number };
    type Step = { status?: number; hang?: boolean; location?: string };

    /** A local receiver that answers from a script, one step per request (the last step repeats). */
    async function receiver(script: Step[]) {
      const calls: Call[] = [];
      let redirectedHits = 0;
      const sockets = new Set<import('net').Socket>();
      const srv = createServer((req, res) => {
        if (req.url === '/elsewhere') {
          redirectedHits++;
          res.end('should never be reached');
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const step = script[Math.min(calls.length, script.length - 1)];
          calls.push({ eventId: String(req.headers['x-verify-event-id']), body, signature: String(req.headers['x-verify-signature']), at: Date.now() });
          if (step.hang) return; // never answer
          res.statusCode = step.status ?? 200;
          if (step.location) res.setHeader('location', step.location);
          res.end('{"secret":"response body must never be stored"}');
        });
      });
      srv.on('connection', (sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
      });
      await new Promise<void>((r) => srv.listen(0, r));
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`;
      return {
        url,
        calls,
        redirected: () => redirectedHits,
        close: async () => {
          sockets.forEach((s) => s.destroy());
          await new Promise((r) => srv.close(r));
        },
      };
    }

    async function mk(name: string, webhookUrl: string | null) {
      const key = `vk_${name}_${suffix}`;
      const t = await prisma.tenant.create({ data: { name: `wh-${name}`, apiKeyHash: sha256(key), webhookUrl, webhookSecret: `whsec_${name}_${suffix}` } });
      return { id: t.id, secret: `whsec_${name}_${suffix}`, h: { Authorization: `Bearer ${key}` } };
    }
    const mkSession = async (t: { h: { Authorization: string } }, ref: string) =>
      (await request(http()).post('/v1/sessions').set(t.h).send({ externalRef: ref }).expect(201)).body.id as string;
    const queue = async (tenantRow: { id: string }, sessionId: string, status = 'APPROVED') =>
      prisma.$transaction(async (tx) => {
        const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantRow.id } });
        return outbox.enqueue(tx, t, { sessionId, externalRef: 'ref', status });
      });
    const eventOf = (id: string) => prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    const until = async (cond: () => Promise<boolean>, ms = 4000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('condition not reached');
    };

    it('delivers a signed event once and marks it delivered', async () => {
      const rx = await receiver([{ status: 200 }]);
      try {
        const t = await mk('ok', rx.url);
        const id = (await queue(t, await mkSession(t, 'a')))!;
        void dispatcher.wake();
        await until(async () => (await eventOf(id)).status === 'DELIVERED');
        expect(rx.calls).toHaveLength(1);
        const m = rx.calls[0].signature.match(/^t=(\d+),v1=([0-9a-f]+)$/)!;
        expect(m[2]).toBe(hmacSign(t.secret, `${m[1]}.${rx.calls[0].body}`));
        expect(rx.calls[0].eventId).toBe(id);
        expect(JSON.parse(rx.calls[0].body)).toMatchObject({ eventId: id, type: 'session.status_changed', status: 'APPROVED' });
        expect(await eventOf(id)).toMatchObject({ attempts: 1, lastError: null });
      } finally {
        await rx.close();
      }
    });

    it('retries failures with the same event id and identical body, then succeeds', async () => {
      const rx = await receiver([{ status: 500 }, { status: 503 }, { status: 200 }]);
      try {
        const t = await mk('retry', rx.url);
        const id = (await queue(t, await mkSession(t, 'b')))!;
        void dispatcher.wake();
        await until(async () => (await eventOf(id)).status === 'DELIVERED');
        expect(rx.calls).toHaveLength(3);
        expect(new Set(rx.calls.map((c) => c.eventId))).toEqual(new Set([id]));
        expect(new Set(rx.calls.map((c) => c.body)).size).toBe(1); // byte-identical every attempt
        for (const c of rx.calls) {
          const m = c.signature.match(/^t=(\d+),v1=([0-9a-f]+)$/)!;
          expect(m[2]).toBe(hmacSign(t.secret, `${m[1]}.${c.body}`)); // each attempt signed afresh
        }
        expect((await eventOf(id)).attempts).toBe(3);
      } finally {
        await rx.close();
      }
    });

    it('gives up after the maximum attempts, records only a code, and stops calling', async () => {
      const rx = await receiver([{ status: 500 }]);
      try {
        const t = await mk('giveup', rx.url);
        const id = (await queue(t, await mkSession(t, 'c')))!;
        const err = jest.spyOn(Logger.prototype, 'error').mockImplementation();
        void dispatcher.wake();
        await until(async () => (await eventOf(id)).status === 'FAILED');
        await new Promise((r) => setTimeout(r, 300));
        expect(rx.calls).toHaveLength(3); // WEBHOOK_MAX_ATTEMPTS
        const row = await eventOf(id);
        expect(row).toMatchObject({ attempts: 3, lastError: 'http_500' });
        expect(JSON.stringify(row)).not.toContain('response body must never');
        expect(err).toHaveBeenCalledWith(expect.stringContaining(id));
        err.mockRestore();
      } finally {
        await rx.close();
      }
    });

    it('classifies timeouts and connection failures, and does not follow redirects', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      try {
        const hang = await receiver([{ hang: true }]);
        const redirect = await receiver([{ status: 302, location: 'http://127.0.0.1:1/elsewhere' }]);
        const dead = await receiver([{ status: 200 }]);
        const deadUrl = dead.url;
        await dead.close(); // nothing listens there any more
        try {
          const th = await mk('hang', hang.url);
          const tr = await mk('redir', redirect.url);
          const td = await mk('dead', deadUrl);
          const ids = {
            hang: (await queue(th, await mkSession(th, 'h')))!,
            redir: (await queue(tr, await mkSession(tr, 'r')))!,
            dead: (await queue(td, await mkSession(td, 'd')))!,
          };
          void dispatcher.wake();
          await until(async () => (await prisma.webhookEvent.count({ where: { id: { in: Object.values(ids) }, status: 'FAILED' } })) === 3, 9000);
          expect((await eventOf(ids.hang)).lastError).toBe('timeout');
          expect((await eventOf(ids.redir)).lastError).toBe('http_302');
          expect((await eventOf(ids.dead)).lastError).toBe('network');
          expect(redirect.redirected()).toBe(0);
        } finally {
          await hang.close();
          await redirect.close();
        }
      } finally {
        jest.restoreAllMocks();
      }
    });

    it('queues nothing for a tenant without a webhook URL', async () => {
      const t = await mk('nourl', null);
      const sid = await mkSession(t, 'e');
      expect(await queue(t, sid)).toBeNull();
      expect(await prisma.webhookEvent.count({ where: { sessionId: sid } })).toBe(0);
    });

    it('marks an event failed, without retrying, when the tenant removed its URL meanwhile', async () => {
      const rx = await receiver([{ status: 200 }]);
      try {
        const t = await mk('removed', rx.url);
        const id = (await queue(t, await mkSession(t, 'f')))!;
        await prisma.tenant.update({ where: { id: t.id }, data: { webhookUrl: null } });
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        void dispatcher.wake();
        await until(async () => (await eventOf(id)).status === 'FAILED');
        warn.mockRestore();
        expect(await eventOf(id)).toMatchObject({ lastError: 'no_url', attempts: 1 });
        expect(rx.calls).toHaveLength(0);
      } finally {
        await rx.close();
      }
    });

    it('creates the event only if the surrounding transaction commits', async () => {
      const t = await mk('atomic', 'http://127.0.0.1:9/never');
      const sid = await mkSession(t, 'g');
      await expect(
        prisma.$transaction(async (tx) => {
          const row = await tx.tenant.findUniqueOrThrow({ where: { id: t.id } });
          await outbox.enqueue(tx, row, { sessionId: sid, externalRef: 'g', status: 'APPROVED' });
          throw new Error('decision failed after queueing');
        }),
      ).rejects.toThrow('decision failed');
      expect(await prisma.webhookEvent.count({ where: { sessionId: sid } })).toBe(0);
    });

    it('delivers each event exactly once when several dispatchers race', async () => {
      const rx = await receiver([{ status: 200 }]);
      try {
        const t = await mk('race', rx.url);
        const ids: string[] = [];
        for (let i = 0; i < 6; i++) ids.push((await queue(t, await mkSession(t, `race-${i}`)))!);
        await Promise.all(Array.from({ length: 8 }, () => dispatcher.tick()));
        await until(async () => (await prisma.webhookEvent.count({ where: { id: { in: ids }, status: 'DELIVERED' } })) === 6);
        await new Promise((r) => setTimeout(r, 200));
        expect(rx.calls).toHaveLength(6);
        expect(new Set(rx.calls.map((c) => c.eventId)).size).toBe(6);
      } finally {
        await rx.close();
      }
    });

    it('ignores a stale dispatcher whose lease lapsed (fenced)', async () => {
      const rx = await receiver([{ hang: true }, { status: 200 }]);
      try {
        const t = await mk('stale', rx.url);
        const id = (await queue(t, await mkSession(t, 'stale')))!;
        void dispatcher.wake();
        await until(async () => rx.calls.length >= 1); // first dispatcher is now stuck on the hanging request
        await prisma.webhookEvent.update({ where: { id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
        void dispatcher.wake(); // a second claim delivers it
        await until(async () => (await eventOf(id)).status === 'DELIVERED');
        expect(rx.calls.length).toBeGreaterThanOrEqual(2);
        // The first request times out after its lease was taken: it must not requeue or fail the delivered event
        await new Promise((r) => setTimeout(r, 1300));
        expect(await eventOf(id)).toMatchObject({ status: 'DELIVERED', lastError: null, attempts: 2 });
      } finally {
        await rx.close();
      }
    });

    describe('events API', () => {
      it('is tenant-scoped, filterable and needs an API key', async () => {
        const rx = await receiver([{ status: 200 }]);
        try {
          const a = await mk('apia', rx.url);
          const b = await mk('apib', rx.url);
          const idA = (await queue(a, await mkSession(a, 'x')))!;
          await until(async () => (await eventOf(idA)).status === 'DELIVERED');
          const mine = await request(http()).get('/v1/webhook-events').set(a.h).expect(200);
          expect(mine.body.items.map((e: { id: string }) => e.id)).toContain(idA);
          expect(JSON.stringify(mine.body)).not.toMatch(/body|secret|whsec/i);
          const theirs = await request(http()).get('/v1/webhook-events').set(b.h).expect(200);
          expect(theirs.body.items).toHaveLength(0);
          const failedOnly = await request(http()).get('/v1/webhook-events?status=FAILED').set(a.h).expect(200);
          expect(failedOnly.body.items).toHaveLength(0);
          await request(http()).get('/v1/webhook-events?status=BOGUS').set(a.h).expect(400);
          await request(http()).get('/v1/webhook-events').expect(401);
        } finally {
          await rx.close();
        }
      });

      it('replays a failed event, refuses others, and hides other tenants’ events', async () => {
        const script: Step[] = [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 200 }];
        const rx = await receiver(script);
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
        try {
          const a = await mk('replay', rx.url);
          const other = await mk('replay-other', rx.url);
          const id = (await queue(a, await mkSession(a, 'r')))!;
          await request(http()).post(`/v1/webhook-events/${id}/retry`).set(a.h).expect(409); // still pending
          await until(async () => (await eventOf(id)).status === 'FAILED');
          await request(http()).post(`/v1/webhook-events/${id}/retry`).set(other.h).expect(404);
          expect((await eventOf(id)).status).toBe('FAILED');
          await request(http()).post(`/v1/webhook-events/${id}/retry`).set(a.h).expect(202);
          await until(async () => (await eventOf(id)).status === 'DELIVERED');
          await request(http()).post(`/v1/webhook-events/${id}/retry`).set(a.h).expect(409); // delivered: nothing to replay
          await request(http()).post(`/v1/webhook-events/${randomUUID()}/retry`).set(a.h).expect(404);
        } finally {
          jest.restoreAllMocks();
          await rx.close();
        }
      });
    });

    describe('erasure and retention', () => {
      it('erasing a session erases its webhook events', async () => {
        const t = await mk('erase', 'http://127.0.0.1:9/never');
        await prisma.tenant.update({ where: { id: t.id }, data: { evidenceExport: false } });
        const sid = await mkSession(t, 'gone');
        await queue(t, sid);
        expect(await prisma.webhookEvent.count({ where: { sessionId: sid } })).toBe(1);
        await request(http()).delete(`/v1/sessions/${sid}`).set(t.h).expect(204);
        expect(await prisma.webhookEvent.count({ where: { sessionId: sid } })).toBe(0);
      });

      it('purges old delivered and failed events and keeps recent ones', async () => {
        const t = await mk('purge', 'http://127.0.0.1:9/never');
        const sid = await mkSession(t, 'p');
        const mkEv = (data: object) => prisma.webhookEvent.create({ data: { tenantId: t.id, sessionId: sid, type: 't', body: '{}', ...data } });
        const oldDelivered = await mkEv({ status: 'DELIVERED', deliveredAt: days(8) });
        const newDelivered = await mkEv({ status: 'DELIVERED', deliveredAt: days(1) });
        const oldFailed = await mkEv({ status: 'FAILED', createdAt: days(31) });
        const newFailed = await mkEv({ status: 'FAILED', createdAt: days(2) });
        const pending = await mkEv({ status: 'PENDING', nextAttemptAt: days(-1000), createdAt: days(400) });
        const report = await retention.run();
        expect(report.webhookEventsDeleted).toBeGreaterThanOrEqual(2);
        const left = await prisma.webhookEvent.findMany({ where: { id: { in: [oldDelivered.id, newDelivered.id, oldFailed.id, newFailed.id, pending.id] } } });
        expect(left.map((e) => e.id).sort()).toEqual([newDelivered.id, newFailed.id, pending.id].sort());
        await prisma.webhookEvent.delete({ where: { id: pending.id } });
      });
    });
  });
});
