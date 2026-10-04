// Runs the full flow against a real Postgres (DATABASE_URL). No external services are contacted:
// the webhook target is a local HTTP server started by the test.
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { createServer, Server } from 'http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { hmacSign, randomToken, sha256 } from '../src/common/crypto';
import { buildLicenceText, LicenceText, SAMPLE_LICENCE } from '../src/documents/licence/testing';
import { buildTd1, SAMPLE, Td1Fields } from '../src/documents/mrz/testing';
import { OCR_PROVIDER, OcrProvider, OcrUnavailableError } from '../src/ocr/ocr-provider';
import { FACE_PROVIDER, FaceComparison, FaceProvider, FaceUnavailableError } from '../src/face/face-provider';
import { LIVENESS_PROVIDER, LivenessProvider, LivenessResult, LivenessUnavailableError } from '../src/liveness/liveness-provider';
import { execFile } from 'child_process';
import { UploadClient, VerifyApiError, VerifyClient, constructWebhookEvent } from '../sdk/src';
import { OutboxService } from '../src/webhooks/outbox.service';
import { WebhookDispatcher } from '../src/webhooks/dispatcher';
import { RetentionService } from '../src/retention/retention.service';
import { reencryptAll } from '../src/storage/reencrypt';
import { KeyUnavailableError, StorageService } from '../src/storage/storage.service';
import { encrypt as legacyEncrypt } from '../src/common/crypto';
import { hashPassword } from '../src/review/password';
import { VerificationWorker } from '../src/verification/verification.worker';

// Fake OCR: tests set `ocrImpl`. Nothing here touches a real OCR engine.
let ocrImpl: () => Promise<{ text: string }> = async () => ({ text: '' });
let ocrCalls = 0;
// Printed-text reads (driving licence) are scripted separately from MRZ reads.
let licenceImpl: () => Promise<{ text: string }> = async () => ({ text: '' });
let licenceCalls = 0;
const fakeOcr: OcrProvider = {
  name: 'fake',
  readText: async (_image, options) => {
    if (options?.mode === 'text') {
      licenceCalls++;
      return licenceImpl();
    }
    ocrCalls++;
    return ocrImpl();
  },
};
const licenceText = (f: Partial<LicenceText> = {}) => buildLicenceText({ ...SAMPLE_LICENCE, ...f });
// Fake face provider: tests set `faceImpl`. AWS is never contacted.
const goodFace = async (): Promise<FaceComparison> => ({ status: 'compared', similarity: 95 });
let faceImpl: () => Promise<FaceComparison> = goodFace;
let faceCalls = 0;
let lastSelfie: Buffer | undefined;
let faceName = 'fake-face';
const fakeFace: FaceProvider = {
  get name() {
    return faceName;
  },
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
let liveName = 'fake-live';
const fakeLiveness: LivenessProvider = {
  get name() {
    return liveName;
  },
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
      licenceImpl = async () => ({ text: '' });
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

    describe('driving licence', () => {
      beforeEach(() => {
        ocrImpl = async () => ({ text: mrzText() });
        licenceImpl = async () => ({ text: licenceText() });
      });

      /** A session that asks for a licence, with every upload and the liveness challenge done. */
      async function licenceSession(ref: string, o: { omit?: string[]; require?: boolean } = {}) {
        const created = await request(http())
          .post('/v1/sessions')
          .set(auth())
          .send({ externalRef: ref, firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15', requireDrivingLicence: o.require ?? true })
          .expect(201);
        const token = created.body.uploadToken as string;
        for (const kind of ['ID_FRONT', 'ID_BACK', 'SELFIE', 'LICENCE_FRONT', 'LICENCE_BACK']) {
          if (o.omit?.includes(kind)) continue;
          await request(http()).post(`/v1/upload/${token}/${kind}`).attach('file', PNG, { filename: 'a.png' }).expect(204);
        }
        await request(http()).post(`/v1/upload/${token}/liveness`).expect(200);
        return { token, id: created.body.id as string, create: created.body };
      }
      const submitAndSettle = async (s: { token: string; id: string }) => {
        await request(http()).post(`/v1/upload/${s.token}/submit`).expect(200);
        return settled(s.id);
      };

      it('lets a session ask for a licence, and rejects a non-boolean flag', async () => {
        const s = await licenceSession('lic-create');
        expect(s.create.requireDrivingLicence).toBe(true);
        expect((await request(http()).get(`/v1/sessions/${s.id}`).set(auth()).expect(200)).body.requireDrivingLicence).toBe(true);
        await request(http()).post('/v1/sessions').set(auth()).send({ externalRef: 'x', requireDrivingLicence: 'yes' }).expect(400);
        const plain = await request(http()).post('/v1/sessions').set(auth()).send({ externalRef: 'plain' }).expect(201);
        expect(plain.body.requireDrivingLicence).toBe(false);
      });

      it('requires ID_BACK and LICENCE_FRONT to submit, but only for sessions that asked for one', async () => {
        const noLicence = await licenceSession('lic-missing-front', { omit: ['LICENCE_FRONT'] });
        const r1 = await request(http()).post(`/v1/upload/${noLicence.token}/submit`).expect(400);
        expect(r1.body.message).toContain('LICENCE_FRONT');
        const noBack = await licenceSession('lic-missing-idback', { omit: ['ID_BACK'] });
        await request(http()).post(`/v1/upload/${noBack.token}/submit`).expect(400);
        // The licence back is optional (it is stored for reviewers, never read)
        const noLicBack = await licenceSession('lic-no-back', { omit: ['LICENCE_BACK'] });
        await request(http()).post(`/v1/upload/${noLicBack.token}/submit`).expect(200);
        // A session that did not ask needs none of it
        const plain = await licenceSession('lic-not-asked', { require: false, omit: ['LICENCE_FRONT', 'LICENCE_BACK', 'ID_BACK'] });
        await request(http()).post(`/v1/upload/${plain.token}/submit`).expect(200);
      });

      it('approves only when the licence is read and matches the ID, and reports flags, not values', async () => {
        await setAutoApprove(true);
        const s = await licenceSession('lic-ok');
        const body = await submitAndSettle(s);
        expect(body.status).toBe('APPROVED');
        expect(body.verification.licence).toEqual({
          found: true,
          fields: ['1', '2', '3', '4a', '4b', '4d', '5', '9'],
          expired: false,
          datesValid: true,
          repaired: false,
          crossCheck: { personalNumber: 'match', surname: 'match', givenNames: 'match', birthDate: 'match' },
        });
        expect(body.verification.issues).toEqual([]);
        // Nothing printed on the licence (or the ID) reaches the API response, the database or the audit log
        const row = await prisma.verificationResult.findUnique({ where: { sessionId: s.id } });
        const logs = await prisma.auditLog.findMany({ where: { sessionId: s.id } });
        const events = await prisma.webhookEvent.findMany({ where: { sessionId: s.id } });
        const dump = JSON.stringify([body, row, logs, events]);
        // Includes the ISO date of birth: the tenant's request is not part of any of these outputs
        for (const secret of ['TESTI', 'DEMA', '1000000001', 'DL1234567', 'PRISHTINE', '15.05.1990', '1990-05-15', '2022-03-12', '2032-03-12']) {
          expect(dump).not.toContain(secret);
        }
      });

      it('keeps a clean licence in NEEDS_REVIEW when auto-approve is off, and includes it in the webhook', async () => {
        const s = await licenceSession('lic-off');
        const body = await submitAndSettle(s);
        expect(body.status).toBe('NEEDS_REVIEW');
        expect(body.verification.licence.found).toBe(true);
        await waitFor(() => hooksFor(hooks, s.id).length >= 1);
        expect(hooksFor(hooks, s.id)[0].b.verification.licence).toMatchObject({ found: true, crossCheck: { personalNumber: 'match' } });
      });

      it.each([
        ['a different personal number', { personalNumber: '1000000002' }, 'LICENCE_PERSONAL_NUMBER_MISMATCH', 'personalNumber'],
        ['a different surname', { surname: 'OTHER' }, 'LICENCE_SURNAME_MISMATCH', 'surname'],
        ['different given names', { givenNames: 'OTHER' }, 'LICENCE_GIVEN_NAMES_MISMATCH', 'givenNames'],
        ['a different date of birth', { birth: '16.05.1990' }, 'LICENCE_BIRTH_DATE_MISMATCH', 'birthDate'],
      ] as const)('sends %s to review even with auto-approve on', async (_n, over, code, key) => {
        await setAutoApprove(true);
        licenceImpl = async () => ({ text: licenceText(over) });
        const body = await submitAndSettle(await licenceSession(`lic-${code}`));
        expect(body.status).toBe('NEEDS_REVIEW');
        expect(body.verification.issues).toEqual([code]);
        expect(body.verification.licence.crossCheck[key]).toBe('mismatch');
      });

      it('sends an expired, implausible or partly read licence to review', async () => {
        await setAutoApprove(true);
        for (const [text, code] of [
          [licenceText({ issue: '12.03.2010', expiry: '12.03.2020' }), 'LICENCE_EXPIRED'],
          [licenceText({ issue: '12.03.2022', expiry: '12.03.2062' }), 'LICENCE_DATES_IMPLAUSIBLE'],
          ['1. TESTI\n2. DEMA\n4d. 1000000001', 'LICENCE_FIELDS_INCOMPLETE'],
          ['nothing legible', 'LICENCE_NOT_READABLE'],
          [licenceText({ personalNumber: '1OOOOOOOO1' }), 'LICENCE_OCR_REPAIRED'],
        ] as const) {
          licenceImpl = async () => ({ text });
          const body = await submitAndSettle(await licenceSession(`lic-${code}`));
          expect(body.status).toBe('NEEDS_REVIEW');
          expect(body.verification.issues).toContain(code);
        }
      });

      it('cannot cross-check against an ID it could not read, and never approves', async () => {
        await setAutoApprove(true);
        ocrImpl = async () => ({ text: 'no machine readable zone' });
        const body = await submitAndSettle(await licenceSession('lic-no-id'));
        expect(body.status).toBe('NEEDS_REVIEW');
        expect(body.verification.issues).toEqual(expect.arrayContaining(['MRZ_NOT_FOUND', 'LICENCE_CROSSCHECK_UNAVAILABLE']));
        expect(body.verification.licence.crossCheck).toEqual({ personalNumber: 'unavailable', surname: 'unavailable', givenNames: 'unavailable', birthDate: 'unavailable' });
      });

      it('hands over without retrying when no OCR engine is installed for the licence', async () => {
        await setAutoApprove(true);
        const before = licenceCalls;
        licenceImpl = async () => {
          throw new OcrUnavailableError('missing');
        };
        const body = await submitAndSettle(await licenceSession('lic-no-engine'));
        expect(body.status).toBe('NEEDS_REVIEW');
        expect(body.verification.issues).toContain('OCR_UNAVAILABLE');
        expect(body.verification.licence).toMatchObject({ found: false, fields: [] });
        expect(licenceCalls - before).toBe(1);
      });

      it('retries a transient licence OCR failure', async () => {
        let n = 0;
        licenceImpl = async () => {
          if (++n < 2) throw new Error('flaky');
          return { text: licenceText() };
        };
        const body = await submitAndSettle(await licenceSession('lic-flaky'));
        expect(body.verification.licence.found).toBe(true);
        expect(n).toBe(2);
      });

      it('does not take a licence from a session that did not ask for one', async () => {
        await setAutoApprove(true);
        const before = licenceCalls;
        const s = await licenceSession('lic-unrequested', { require: false, omit: ['LICENCE_FRONT', 'LICENCE_BACK'] });
        for (const kind of ['LICENCE_FRONT', 'LICENCE_BACK']) {
          const r = await request(http()).post(`/v1/upload/${s.token}/${kind}`).attach('file', PNG, { filename: 'a.png' }).expect(400);
          expect(r.body.message).toContain('does not take a driving licence');
        }
        // Nothing was stored, and the session is processed exactly as if no licence existed
        expect(await prisma.document.count({ where: { sessionId: s.id, kind: { in: ['LICENCE_FRONT', 'LICENCE_BACK'] } } })).toBe(0);
        const body = await submitAndSettle(s);
        expect(body.status).toBe('APPROVED');
        expect(body.verification.licence).toBeNull();
        expect(licenceCalls - before).toBe(0);
      });

      it('still records that a licence was required when the pipeline gives up', async () => {
        await setAutoApprove(true);
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        licenceImpl = async () => {
          throw new Error('always broken');
        };
        const s = await licenceSession('lic-pipeline-error');
        try {
          const body = await submitAndSettle(s);
          expect(body.status).toBe('NEEDS_REVIEW');
          expect(body.verification.issues).toEqual(expect.arrayContaining(['PIPELINE_ERROR', 'LICENCE_NOT_CHECKED']));
          expect(body.verification.licence).toMatchObject({ found: false, fields: [] }); // not null: a licence was required
          expect(body.requireDrivingLicence).toBe(true);
        } finally {
          warn.mockRestore();
        }
      });

      it('stores the licence images with the other documents and erases them all together', async () => {
        const s = await licenceSession('lic-docs');
        await submitAndSettle(s);
        const dir = join(storageDir, (await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).tenantId, s.id);
        expect(readdirSync(dir)).toHaveLength(5); // ID front/back, selfie, licence front/back
        expect(await prisma.document.findMany({ where: { sessionId: s.id }, select: { kind: true } })).toEqual(
          expect.arrayContaining([{ kind: 'LICENCE_FRONT' }, { kind: 'LICENCE_BACK' }]),
        );
        await request(http()).delete(`/v1/sessions/${s.id}`).set(auth()).expect(204);
        expect(readdirSync(dir)).toHaveLength(0);
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
      // Decided a few seconds ago: Node's clock and the database's can differ by milliseconds, and a decision
      // stamped at exactly "now" can look like the future to Postgres
      const c = await withDocs(tZero, 'win-0', 0.0001);
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
    type Step = { status?: number; hang?: boolean; location?: string; endless?: boolean };

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
          if (step.endless) {
            // A reply that never ends: reading it to the end would hang until the timeout
            res.statusCode = step.status ?? 200;
            const iv = setInterval(() => res.write('x'.repeat(65_536)), 5);
            res.on('close', () => clearInterval(iv));
            return;
          }
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


    it('does not read the receiver’s reply, so an endless one costs nothing', async () => {
      const rx = await receiver([{ status: 200, endless: true }]);
      try {
        const t = await mk('endless', rx.url);
        const id = (await queue(t, await mkSession(t, 'big')))!;
        const started = Date.now();
        void dispatcher.wake();
        await until(async () => (await eventOf(id)).status === 'DELIVERED', 3000);
        expect(Date.now() - started).toBeLessThan(900); // well inside the 1 s timeout: nothing waited for the body
        expect(rx.calls).toHaveLength(1);
      } finally {
        await rx.close();
      }
    });

    it('fences by claim, so a stale delivery cannot overwrite a replay that reuses its attempt number', async () => {
      const rx = await receiver([{ hang: true }, { status: 500 }, { status: 500 }, { hang: true }, { status: 200 }]);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      try {
        const t = await mk('claimfence', rx.url);
        const id = (await queue(t, await mkSession(t, 'cf')))!;
        void dispatcher.wake();
        await until(async () => rx.calls.length >= 1); // claim 1 (attempt 1) is stuck on the hanging request
        const staleEnds = rx.calls[0].at + 1150; // its 1 s timeout, plus a margin
        await prisma.webhookEvent.update({ where: { id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
        void dispatcher.wake(); // claims 2 and 3 fail with 500, so the event is FAILED
        await until(async () => (await eventOf(id)).status === 'FAILED');
        await new Promise((r) => setTimeout(r, 400)); // leave room: the stale claim must end while claim 4 is still in flight
        await request(http()).post(`/v1/webhook-events/${id}/retry`).set(t.h).expect(202);
        await until(async () => rx.calls.length >= 4); // claim 4 is in flight with attempts reset to 1, the stale claim's number
        expect(await eventOf(id)).toMatchObject({ attempts: 1, claims: 4 });
        while (Date.now() < staleEnds) await new Promise((r) => setTimeout(r, 25));
        // The stale claim has now timed out and tried to record its failure. It must not have touched the live claim.
        const row = await eventOf(id);
        expect(row.claims).toBe(4);
        expect(row.lockedUntil).not.toBeNull(); // still leased to claim 4
        await until(async () => (await eventOf(id)).status === 'DELIVERED', 5000);
      } finally {
        jest.restoreAllMocks();
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
          for (const inherited of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
            await request(http()).get(`/v1/webhook-events?status=${inherited}`).set(a.h).expect(400);
          }
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
        // An old event that failed again recently (a replay) keeps its full window; failedAt, not createdAt, counts
        const replayedRecently = await mkEv({ status: 'FAILED', createdAt: days(60), failedAt: days(2) });
        const failedLongAgo = await mkEv({ status: 'FAILED', createdAt: days(60), failedAt: days(40) });
        const report = await retention.run();
        expect(report.webhookEventsDeleted).toBeGreaterThanOrEqual(3);
        const left = await prisma.webhookEvent.findMany({ where: { id: { in: [oldDelivered.id, newDelivered.id, oldFailed.id, newFailed.id, pending.id, replayedRecently.id, failedLongAgo.id] } } });
        expect(left.map((e) => e.id).sort()).toEqual([newDelivered.id, newFailed.id, pending.id, replayedRecently.id].sort());
        await prisma.webhookEvent.deleteMany({ where: { id: { in: [pending.id, replayedRecently.id] } } });
      });

      it('keeps a decided session until its webhook has left the queue, even with a zero-day window', async () => {
        const t = await mk('zero', 'http://127.0.0.1:9/never');
        await prisma.tenant.update({ where: { id: t.id }, data: { documentRetentionDays: 0, recordRetentionDays: 0 } });
        const sid = await mkSession(t, 'zero');
        await prisma.session.update({ where: { id: sid }, data: { status: 'APPROVED', decidedAt: days(1) } });
        const ev = await prisma.webhookEvent.create({ data: { tenantId: t.id, sessionId: sid, type: 't', body: '{}', status: 'PENDING', nextAttemptAt: new Date(Date.now() + 3600_000) } });
        await retention.run();
        expect(await prisma.session.count({ where: { id: sid } })).toBe(1); // still there: its event is undelivered
        expect(await prisma.webhookEvent.count({ where: { id: ev.id } })).toBe(1);
        await prisma.webhookEvent.update({ where: { id: ev.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
        await retention.run();
        expect(await prisma.session.count({ where: { id: sid } })).toBe(0); // delivered: the window applies
      });

      it('still erases a session on explicit request while its webhook is pending', async () => {
        const t = await mk('dsr', 'http://127.0.0.1:9/never');
        const sid = await mkSession(t, 'dsr');
        await prisma.webhookEvent.create({ data: { tenantId: t.id, sessionId: sid, type: 't', body: '{}', status: 'PENDING', nextAttemptAt: new Date(Date.now() + 3600_000) } });
        await request(http()).delete(`/v1/sessions/${sid}`).set(t.h).expect(204);
        expect(await prisma.webhookEvent.count({ where: { sessionId: sid } })).toBe(0);
      });
    });
  });

  const baseUrl = () => `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  describe('hosted page, upload API and client SDK', () => {
    const http = () => app.getHttpServer();
    const create = async (extra: object = {}) => (await request(http()).post('/v1/sessions').set(auth()).send({ externalRef: `h-${randomToken(4)}`, ...extra }).expect(201)).body;

    describe('the hosted page', () => {
      it('serves a page with no inline script, a strict CSP and no framing', async () => {
        const page = await request(http()).get('/verify').expect(200);
        const csp = page.headers['content-security-policy'];
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("script-src 'self'");
        expect(csp).toContain("style-src 'self'");
        expect(csp).toContain("connect-src 'self'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).not.toContain('unsafe');
        expect(page.headers['x-frame-options']).toBe('DENY');
        expect(page.headers['referrer-policy']).toBe('no-referrer');
        expect(page.headers['cache-control']).toBe('no-store');
        expect(page.headers['permissions-policy']).toContain('camera=(self)');
        expect(page.text).not.toMatch(/<script(?![^>]*\bsrc=)/i);
        expect(page.text).not.toMatch(/\son\w+=|style=/i);
        const js = await request(http()).get('/verify/app.js').expect(200);
        expect(js.headers['content-type']).toContain('javascript');
        expect(js.text).not.toMatch(/innerHTML|outerHTML|document\.write|eval\(/);
        expect((await request(http()).get('/verify/app.css').expect(200)).headers['content-type']).toContain('text/css');
      });

      it('lets only configured origins embed it', async () => {
        const original = process.env.HOSTED_FRAME_ANCESTORS;
        try {
          process.env.HOSTED_FRAME_ANCESTORS = 'https://app.example.com https://*.evil.test javascript:alert(1) *';
          const csp = (await request(http()).get('/verify').expect(200)).headers['content-security-policy'];
          expect(csp).toContain('frame-ancestors https://app.example.com');
          expect(csp).not.toMatch(/evil|javascript|\*/);
          process.env.HOSTED_FRAME_ANCESTORS = '* https://x.test;script-src';
          const closed = await request(http()).get('/verify').expect(200);
          expect(closed.headers['content-security-policy']).toContain("frame-ancestors 'none'");
          expect(closed.headers['content-security-policy']).not.toContain('x.test');
        } finally {
          if (original === undefined) delete process.env.HOSTED_FRAME_ANCESTORS;
          else process.env.HOSTED_FRAME_ANCESTORS = original;
        }
      });

      it('hands out a hosted URL whose token is in the fragment, never in the path or query', async () => {
        const created = await create();
        expect(created.hostedUrl).toBe(`http://verify.test/verify#${created.uploadToken}`);
        const [beforeFragment] = (created.hostedUrl as string).split('#');
        expect(beforeFragment).not.toContain(created.uploadToken);
      });
    });

    describe('GET /v1/upload/:token', () => {
      it('describes what to ask for, without any personal data', async () => {
        const plain = await create({ externalRef: 'customer-ref-4711', firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15' });
        const res = await request(http()).get(`/v1/upload/${plain.uploadToken}`).expect(200);
        expect(res.body).toMatchObject({
          status: 'PENDING',
          requireDrivingLicence: false,
          uploaded: [],
          steps: [
            { kind: 'ID_FRONT', required: true },
            { kind: 'ID_BACK', required: false },
            { kind: 'SELFIE', required: true },
          ],
        });
        expect(typeof res.body.liveness).toBe('boolean');
        const dump = JSON.stringify(res.body);
        for (const secret of ['Dema', 'Testi', '1990', 'customer-ref-4711', plain.id]) expect(dump).not.toContain(secret);
      });

      it('asks for the licence when the session requires one, and shows progress', async () => {
        const lic = await create({ requireDrivingLicence: true });
        await request(http()).post(`/v1/upload/${lic.uploadToken}/ID_FRONT`).attach('file', PNG, { filename: 'a.png' }).expect(204);
        const res = await request(http()).get(`/v1/upload/${lic.uploadToken}`).expect(200);
        expect(res.body.steps.map((x: { kind: string; required: boolean }) => `${x.kind}:${x.required}`)).toEqual([
          'ID_FRONT:true', 'ID_BACK:true', 'LICENCE_FRONT:true', 'LICENCE_BACK:false', 'SELFIE:true',
        ]);
        expect(res.body.uploaded).toEqual(['ID_FRONT']);
      });

      it('answers 404 for an unknown token and 410 once the link is used or expired', async () => {
        await request(http()).get('/v1/upload/not-a-real-token').expect(404);
        const used = await create();
        for (const kind of ['ID_FRONT', 'SELFIE']) await request(http()).post(`/v1/upload/${used.uploadToken}/${kind}`).attach('file', PNG, { filename: 'a.png' }).expect(204);
        await request(http()).post(`/v1/upload/${used.uploadToken}/submit`).expect(200);
        const submitted = await request(http()).get(`/v1/upload/${used.uploadToken}`).expect(410);
        // A machine-readable reason, so a client can thank the user instead of calling a used link dead
        expect(submitted.body).toMatchObject({ statusCode: 410, code: 'session_submitted' });
        const again = await request(http()).post(`/v1/upload/${used.uploadToken}/submit`).expect(410);
        expect(again.body.code).toBe('session_submitted');
        const old = await create();
        await prisma.session.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        const expired = await request(http()).get(`/v1/upload/${old.uploadToken}`).expect(410);
        expect(expired.body).toMatchObject({ code: 'session_expired', message: 'Session expired' });
        // Once expiry has been recorded, it is still "expired", not "submitted"
        const afterRecord = await request(http()).get(`/v1/upload/${old.uploadToken}`).expect(410);
        expect(afterRecord.body.code).toBe('session_expired');
        expect((await request(http()).post(`/v1/upload/${old.uploadToken}/SELFIE`).attach('file', PNG, { filename: 'a.png' }).expect(410)).body.code).toBe('session_expired');
      });
    });

    describe('CORS', () => {
      it('lets browsers call the upload endpoints from any origin, without credentials', async () => {
        const pre = await request(http()).options('/v1/upload/sometoken/ID_FRONT').set('Origin', 'https://shop.example').set('Access-Control-Request-Method', 'POST').expect(204);
        expect(pre.headers['access-control-allow-origin']).toBe('*');
        expect(pre.headers['access-control-allow-methods']).toContain('POST');
        expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
        const created = await create();
        const get = await request(http()).get(`/v1/upload/${created.uploadToken}`).set('Origin', 'https://shop.example').expect(200);
        expect(get.headers['access-control-allow-origin']).toBe('*');
        const error = await request(http()).get('/v1/upload/unknown').set('Origin', 'https://shop.example').expect(404);
        expect(error.headers['access-control-allow-origin']).toBe('*'); // so the browser can read the error
      });

      it('gives nothing else CORS: not the API-key endpoints, not the review API', async () => {
        for (const path of ['/v1/sessions', '/review/api/me', '/v1/webhook-events']) {
          const res = await request(http()).options(path).set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
          expect(res.headers['access-control-allow-origin']).toBeUndefined();
          const get = await request(http()).get(path).set('Origin', 'https://evil.example');
          expect(get.headers['access-control-allow-origin']).toBeUndefined();
        }
      });
    });

    describe('client SDK against the running service', () => {
      beforeEach(() => {
        ocrImpl = async () => ({ text: mrzText() });
      });

      it('runs the whole flow: create, upload from the browser client, submit, read the result, verify the webhook', async () => {
        const server = new VerifyClient({ apiKey: apiKey, baseUrl: baseUrl() });
        const created = await server.sessions.create({ externalRef: `sdk-${randomToken(4)}`, firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15' });
        expect(created).toMatchObject({ status: 'PENDING', requireDrivingLicence: false });
        expect(created.hostedUrl).toContain('/verify#');

        // The browser side holds only the token
        const browser = new UploadClient({ baseUrl: baseUrl(), token: created.uploadToken });
        const info = await browser.getSession();
        expect(info.steps.map((x) => x.kind)).toEqual(['ID_FRONT', 'ID_BACK', 'SELFIE']);
        for (const step of info.steps) await browser.upload(step.kind, new Blob([PNG], { type: 'image/png' }));
        expect((await browser.getSession()).uploaded.sort()).toEqual(['ID_BACK', 'ID_FRONT', 'SELFIE']);
        await expect(browser.submit()).resolves.toEqual({ status: 'PROCESSING' });
        // The link is used up
        await expect(browser.getSession()).rejects.toMatchObject({ status: 410 });
        await expect(browser.upload('SELFIE', new Blob([PNG]))).rejects.toMatchObject({ status: 410 });

        let session = await server.sessions.get(created.id);
        for (let i = 0; i < 200 && session.status === 'PROCESSING'; i++) {
          await new Promise((r) => setTimeout(r, 25));
          session = await server.sessions.get(created.id);
        }
        expect(session.status).toBe('NEEDS_REVIEW');
        expect(session.verification?.mrz).toMatchObject({ found: true, valid: true });
        expect(session.verification?.identity).toEqual({ surname: 'match', givenNames: 'match', birthDate: 'match' });

        // The webhook the service sent verifies with the SDK helper, and only with the right secret
        await waitFor(() => hooksFor(hooks, created.id).length >= 1);
        const hook = hooksFor(hooks, created.id)[0].h;
        const event = constructWebhookEvent({ payload: hook.body, signatureHeader: hook.signature, secret: webhookSecret });
        expect(event).toMatchObject({ sessionId: created.id, status: 'NEEDS_REVIEW', verification: { mrz: { found: true } } });
        expect(() => constructWebhookEvent({ payload: hook.body, signatureHeader: hook.signature, secret: 'whsec_wrong' })).toThrow();
        expect(() => constructWebhookEvent({ payload: hook.body.replace('NEEDS_REVIEW', 'APPROVED'), signatureHeader: hook.signature, secret: webhookSecret })).toThrow();

        await server.sessions.delete(created.id);
        await expect(server.sessions.get(created.id)).rejects.toMatchObject({ status: 404, isNotFound: true });
      });

      it('maps service errors to typed exceptions', async () => {
        const server = new VerifyClient({ apiKey: apiKey, baseUrl: baseUrl() });
        await expect(server.sessions.create({ externalRef: 'x', birthDate: 'tomorrow' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('birthDate') });
        await expect(new VerifyClient({ apiKey: 'vk_wrong', baseUrl: baseUrl() }).sessions.get(randomUUID())).rejects.toMatchObject({ status: 401 });
        const err = await server.sessions.evidence(randomUUID()).catch((e) => e);
        expect(err).toBeInstanceOf(VerifyApiError);
        expect(err.status).toBe(403); // evidence export is off for this tenant
        await expect(new UploadClient({ baseUrl: baseUrl(), token: 'nope' }).getSession()).rejects.toMatchObject({ status: 404 });
        // A non-image is refused by the service, and the SDK says so
        const created = await server.sessions.create({ externalRef: `sdk-bad-${randomToken(4)}` });
        await expect(new UploadClient({ baseUrl: baseUrl(), token: created.uploadToken }).upload('ID_FRONT', new Blob(['%PDF-1.7']))).rejects.toMatchObject({ status: 400 });
        await server.sessions.delete(created.id);
      });

      it('reads and replays webhook events, tenant-scoped', async () => {
        const server = new VerifyClient({ apiKey: apiKey, baseUrl: baseUrl() });
        const events = await server.webhookEvents.list('DELIVERED');
        expect(Array.isArray(events)).toBe(true);
        expect(JSON.stringify(events)).not.toMatch(/body|secret/i);
        await expect(server.webhookEvents.retry(randomUUID())).rejects.toMatchObject({ status: 404 });
      });
    });
  });

  describe('usage metering and monthly caps', () => {
    const http = () => app.getHttpServer();
    const suffix = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
    type U = { id: string; key: string; h: { Authorization: string } };
    const monthNow = () => new Date().toISOString().slice(0, 7);

    async function mk(name: string, extra: object = {}): Promise<U> {
      const key = `vk_${name}_${suffix}`;
      const t = await prisma.tenant.create({ data: { name: `usage-${name}-${suffix}`, apiKeyHash: sha256(key), webhookSecret: `whsec_${name}`, ...extra } });
      return { id: t.id, key, h: { Authorization: `Bearer ${key}` } };
    }

    beforeEach(() => {
      ocrImpl = async () => ({ text: mrzText() });
      faceImpl = goodFace;
      liveImpl = goodLive;
      licenceImpl = async () => ({ text: licenceText() });
      faceName = 'fake-face';
      liveName = 'fake-live';
    });

    /** Runs a verification to completion for a tenant. */
    async function completed(t: U, ref: string, o: { licence?: boolean; liveness?: boolean; back?: boolean } = {}) {
      const created = await request(http()).post('/v1/sessions').set(t.h).send({ externalRef: ref, firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15', requireDrivingLicence: o.licence ?? false }).expect(201);
      const token = created.body.uploadToken as string;
      const kinds = ['ID_FRONT', 'SELFIE', ...(o.back === false ? [] : ['ID_BACK']), ...(o.licence ? ['LICENCE_FRONT'] : [])];
      for (const kind of kinds) await request(http()).post(`/v1/upload/${token}/${kind}`).attach('file', PNG, { filename: 'a.png' }).expect(204);
      if (o.liveness !== false) await request(http()).post(`/v1/upload/${token}/liveness`).expect(200);
      await request(http()).post(`/v1/upload/${token}/submit`).expect(200);
      for (let i = 0; i < 200; i++) {
        const row = await prisma.session.findUnique({ where: { id: created.body.id } });
        if (row && row.status !== 'PROCESSING') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      return created.body.id as string;
    }
    const eventsOf = (sessionId: string) => prisma.usageEvent.findMany({ where: { sessionId } });

    describe('what is recorded', () => {
      it('writes exactly one event per completed verification, with the features that ran', async () => {
        const t = await mk('flags', { autoApprove: true });
        const auto = await completed(t, 'a');
        expect(await eventsOf(auto)).toEqual([expect.objectContaining({ tenantId: t.id, kind: 'verification', quantity: 1, billable: true, nonBillableReason: null, face: true, liveness: true, licence: false, autoDecided: true })]);

        const noLive = await completed(t, 'b', { liveness: false });
        expect((await eventsOf(noLive))[0]).toMatchObject({ face: true, liveness: false, autoDecided: false }); // no liveness: sent to review

        const lic = await completed(t, 'c', { licence: true });
        expect((await eventsOf(lic))[0]).toMatchObject({ licence: true, face: true, liveness: true, autoDecided: true });
      });

      it('counts a verification sent to review as completed, and a later reviewer decision adds nothing', async () => {
        const t = await mk('review'); // auto-approve off
        const id = await completed(t, 'r');
        expect((await prisma.session.findUnique({ where: { id } }))?.status).toBe('NEEDS_REVIEW');
        expect(await eventsOf(id)).toHaveLength(1);
        await prisma.session.update({ where: { id }, data: { status: 'APPROVED', decidedAt: new Date() } }); // as if a reviewer decided
        expect(await eventsOf(id)).toHaveLength(1);
      });

      it('records our own failures as not billable, with the reason', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        try {
          const t = await mk('failures');
          ocrImpl = async () => { throw new Error('always broken'); };
          const gaveUp = await completed(t, 'f1');
          expect((await eventsOf(gaveUp))[0]).toMatchObject({ billable: false, nonBillableReason: 'pipeline_error', face: false, liveness: false });
          ocrImpl = async () => { throw new OcrUnavailableError('no engine'); };
          const noEngine = await completed(t, 'f2');
          expect((await eventsOf(noEngine))[0]).toMatchObject({ billable: false, nonBillableReason: 'ocr_unavailable' });
          const u = (await request(http()).get('/v1/usage').set(t.h).expect(200)).body;
          expect(u.verifications).toMatchObject({ billable: 0, nonBillable: 2, net: 0, nonBillableByReason: { pipeline_error: 1, ocr_unavailable: 1 } });
        } finally {
          warn.mockRestore();
        }
      });

      it('does not bill a face-match or liveness outage, but does bill a provider that is deliberately off', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        try {
          const t = await mk('outages');
          faceImpl = async () => { throw new FaceUnavailableError('credentials rejected'); };
          expect((await eventsOf(await completed(t, 'face-down')))[0]).toMatchObject({ billable: false, nonBillableReason: 'face_unavailable' });
          faceImpl = goodFace;
          liveImpl = async () => { throw new LivenessUnavailableError('provider down'); };
          expect((await eventsOf(await completed(t, 'live-down')))[0]).toMatchObject({ billable: false, nonBillableReason: 'liveness_unavailable' });
          liveImpl = goodLive;

          // "none" means the tenant chose not to have it: nothing failed, so it is billed like any other verification
          faceName = 'none';
          faceImpl = async () => { throw new FaceUnavailableError('face matching is not configured'); };
          expect((await eventsOf(await completed(t, 'face-off')))[0]).toMatchObject({ billable: true, nonBillableReason: null, face: false });
          faceName = 'fake-face';
          faceImpl = goodFace;
          liveName = 'none';
          liveImpl = async () => { throw new LivenessUnavailableError('liveness is not configured'); };
          expect((await eventsOf(await completed(t, 'live-off')))[0]).toMatchObject({ billable: true, liveness: false });

          const u = (await request(http()).get('/v1/usage').set(t.h).expect(200)).body;
          expect(u.verifications).toMatchObject({ billable: 2, nonBillable: 2, nonBillableByReason: { face_unavailable: 1, liveness_unavailable: 1 } });
        } finally {
          warn.mockRestore();
        }
      });

      it('writes nothing for sessions that were never submitted or that expired', async () => {
        const t = await mk('unused');
        const open = (await request(http()).post('/v1/sessions').set(t.h).send({ externalRef: 'x' }).expect(201)).body;
        const old = (await request(http()).post('/v1/sessions').set(t.h).send({ externalRef: 'y' }).expect(201)).body;
        await prisma.session.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        await request(http()).get(`/v1/upload/${old.uploadToken}`).expect(410);
        expect(await prisma.usageEvent.count({ where: { tenantId: t.id } })).toBe(0);
        expect(open.id).toBeDefined();
      });

      it('survives erasing the person: the invoice trail stays, the personal data goes', async () => {
        const t = await mk('erase');
        const id = await completed(t, 'erase-me');
        await request(http()).delete(`/v1/sessions/${id}`).set(t.h).expect(204);
        expect(await prisma.session.count({ where: { id } })).toBe(0);
        expect(await eventsOf(id)).toHaveLength(1); // usage has no foreign key to the session
        expect((await request(http()).get('/v1/usage').set(t.h).expect(200)).body.verifications.billable).toBe(1);
      });

      it('counts a session once even when several workers process it', async () => {
        const t = await mk('race');
        ocrImpl = async () => {
          await new Promise((r) => setTimeout(r, 40));
          return { text: mrzText() };
        };
        const id = await completed(t, 'race');
        await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
        expect(await eventsOf(id)).toHaveLength(1);
        // And the database itself refuses a second one
        await expect(prisma.usageEvent.create({ data: { tenantId: t.id, sessionId: id, kind: 'verification', occurredAt: new Date() } })).rejects.toThrow();
      });

      it('holds ids, times and booleans only: no name, reference or date of birth', async () => {
        const t = await mk('pii');
        const id = await completed(t, 'customer-ref-9001');
        const dump = JSON.stringify([await eventsOf(id), (await request(http()).get('/v1/usage/events').set(t.h).expect(200)).body, (await request(http()).get('/v1/usage').set(t.h).expect(200)).body]);
        for (const secret of ['Dema', 'Testi', 'customer-ref-9001', '1990', '1000000001', 'DL1234567']) expect(dump).not.toContain(secret);
      });
    });

    describe('GET /v1/usage', () => {
      it('summarises the month, defaulting to the current one, and nothing for other months', async () => {
        const t = await mk('totals', { autoApprove: true });
        await completed(t, 'a');
        await completed(t, 'b', { liveness: false });
        await completed(t, 'c', { licence: true });
        const res = (await request(http()).get('/v1/usage').set(t.h).expect(200)).body;
        expect(res.month).toBe(monthNow());
        expect(res.verifications).toEqual({ billable: 3, nonBillable: 0, nonBillableByReason: {}, adjustments: 0, net: 3 });
        expect(res.features).toEqual({ face: 3, liveness: 2, licence: 1, autoDecided: 2 });
        expect(res.cap).toMatchObject({ limit: null, softLimitPercent: 80 });
        const past = (await request(http()).get('/v1/usage?month=2020-01').set(t.h).expect(200)).body;
        expect(past.verifications.net).toBe(0);
        expect(past.cap.committed).toBeNull();
      });

      it('validates the month, and needs an API key', async () => {
        const t = await mk('validate');
        for (const bad of ['2026-13', 'october', '2026-1', '1999-01', '2026-10-01']) await request(http()).get(`/v1/usage?month=${bad}`).set(t.h).expect(400);
        await request(http()).get('/v1/usage').expect(401);
        await request(http()).get('/v1/usage/events').expect(401);
        await request(http()).get('/v1/usage/events?cursor=not-a-uuid').set(t.h).expect(400);
      });

      it('never shows another tenant’s usage', async () => {
        const a = await mk('iso-a');
        const b = await mk('iso-b');
        const id = await completed(a, 'a-only');
        expect((await request(http()).get('/v1/usage').set(b.h).expect(200)).body.verifications.net).toBe(0);
        const events = (await request(http()).get('/v1/usage/events').set(b.h).expect(200)).body;
        expect(events.items).toEqual([]);
        expect(JSON.stringify(events)).not.toContain(id);
        expect((await request(http()).get('/v1/usage/events').set(a.h).expect(200)).body.items.map((e: { sessionId: string }) => e.sessionId)).toContain(id);
      });

      it('assigns events to the UTC month of the decision, to the second', async () => {
        const t = await mk('boundary');
        const at = (iso: string) => prisma.usageEvent.create({ data: { tenantId: t.id, kind: 'verification', sessionId: randomUUID(), occurredAt: new Date(iso) } });
        await at('2025-09-30T23:59:59.999Z');
        await at('2025-10-01T00:00:00.000Z');
        await at('2025-10-31T23:59:59.999Z');
        await at('2025-11-01T00:00:00.000Z');
        const count = async (m: string) => (await request(http()).get(`/v1/usage?month=${m}`).set(t.h).expect(200)).body.verifications.billable;
        expect([await count('2025-09'), await count('2025-10'), await count('2025-11')]).toEqual([1, 2, 1]);
      });

      it('applies adjustments and reports them separately from billable usage', async () => {
        const t = await mk('adjust');
        const at = new Date('2025-03-01T12:00:00Z');
        await prisma.usageEvent.createMany({
          data: [
            ...Array.from({ length: 5 }, () => ({ tenantId: t.id, kind: 'verification', sessionId: randomUUID(), occurredAt: new Date('2025-03-10T10:00:00Z') })),
            { tenantId: t.id, kind: 'adjustment', occurredAt: at, quantity: -2, note: 'credit for a disputed batch' },
            { tenantId: t.id, kind: 'adjustment', occurredAt: at, quantity: 1, note: 'missed one' },
          ],
        });
        const res = (await request(http()).get('/v1/usage?month=2025-03').set(t.h).expect(200)).body;
        expect(res.verifications).toMatchObject({ billable: 5, adjustments: -1, net: 4 });
        const events = (await request(http()).get('/v1/usage/events?month=2025-03').set(t.h).expect(200)).body.items;
        expect(events.filter((e: { kind: string }) => e.kind === 'adjustment').map((e: { note: string }) => e.note).sort()).toEqual(['credit for a disputed batch', 'missed one']);
      });

      it('accepts a cursor only for the tenant and month it came from', async () => {
        const a = await mk('cursor-a');
        const b = await mk('cursor-b');
        const mkEvents = (t: U, y: number, mo: number, n: number) =>
          prisma.usageEvent.createMany({ data: Array.from({ length: n }, (_, i) => ({ tenantId: t.id, kind: 'verification', sessionId: randomUUID(), occurredAt: new Date(Date.UTC(y, mo, 1, 0, 0, i)) })) });
        await mkEvents(a, 2025, 0, 105); // January: two pages
        await mkEvents(a, 2025, 1, 3); // February
        await mkEvents(b, 2025, 0, 3);
        const jan = (await request(http()).get('/v1/usage/events?month=2025-01').set(a.h).expect(200)).body;
        const cursor = jan.nextCursor as string;
        expect(cursor).toBeTruthy();
        // The same cursor against another month, or from another tenant, is refused instead of returning a short page
        await request(http()).get(`/v1/usage/events?month=2025-02&cursor=${cursor}`).set(a.h).expect(400);
        await request(http()).get(`/v1/usage/events?month=2025-01&cursor=${cursor}`).set(b.h).expect(400);
        await request(http()).get(`/v1/usage/events?cursor=${cursor}`).set(a.h).expect(400); // current month
        await request(http()).get(`/v1/usage/events?month=2025-01&cursor=${randomUUID()}`).set(a.h).expect(400); // unknown id
        await request(http()).get(`/v1/usage/events?month=2025-01&cursor=${cursor}`).set(a.h).expect(200); // the right one still works
      });

      it('pages through the events, oldest first, 100 at a time', async () => {
        const t = await mk('paging');
        await prisma.usageEvent.createMany({
          data: Array.from({ length: 105 }, (_, i) => ({ tenantId: t.id, kind: 'verification', sessionId: randomUUID(), occurredAt: new Date(Date.UTC(2025, 5, 1, 0, 0, i)) })),
        });
        const first = (await request(http()).get('/v1/usage/events?month=2025-06').set(t.h).expect(200)).body;
        expect(first.items).toHaveLength(100);
        expect(first.nextCursor).not.toBeNull();
        const second = (await request(http()).get(`/v1/usage/events?month=2025-06&cursor=${first.nextCursor}`).set(t.h).expect(200)).body;
        expect(second.items).toHaveLength(5);
        expect(second.nextCursor).toBeNull();
        const times = [...first.items, ...second.items].map((e: { occurredAt: string }) => e.occurredAt);
        expect([...times].sort()).toEqual(times); // in order, no overlap
        expect(new Set([...first.items, ...second.items].map((e: { id: string }) => e.id)).size).toBe(105);
      });
    });

    describe('monthly cap', () => {
      const create = (t: U, ref = 'x') => request(http()).post('/v1/sessions').set(t.h).send({ externalRef: ref });

      it('lets sessions through up to the cap, then answers 429 with a clear code', async () => {
        const t = await mk('cap2', { monthlyVerificationCap: 2 });
        await create(t, '1').expect(201);
        await create(t, '2').expect(201);
        const blocked = await create(t, '3').expect(429);
        expect(blocked.body).toMatchObject({ code: 'monthly_cap_reached', limit: 2, message: 'Monthly verification limit reached' });
        // It is a different 429 from the rate limiter's
        expect(blocked.body.code).toBeDefined();
      });

      it('counts sessions in flight, completed verifications, but not expired sessions or our own failures', async () => {
        const t = await mk('capcount', { monthlyVerificationCap: 2 });
        const done = await completed(t, 'done'); // a billable usage event now
        const open = (await create(t, 'open').expect(201)).body; // one in flight
        await create(t, 'blocked').expect(429);
        // The in-flight session expires: its capacity comes back
        await prisma.session.update({ where: { id: open.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        await create(t, 'now-fits').expect(201);
        await create(t, 'blocked-again').expect(429);
        // A failure of ours is not billed, so it does not use the cap either
        const n = await mk('capfail', { monthlyVerificationCap: 1 });
        await prisma.usageEvent.create({ data: { tenantId: n.id, kind: 'verification', sessionId: randomUUID(), occurredAt: new Date(), billable: false, nonBillableReason: 'pipeline_error' } });
        await create(n, 'fits').expect(201);
        expect(done).toBeDefined();
      });

      it('holds under parallel requests: exactly the cap gets through', async () => {
        const t = await mk('cappar', { monthlyVerificationCap: 3 });
        const results = await Promise.all(Array.from({ length: 12 }, (_, i) => create(t, `p${i}`)));
        expect(results.filter((r) => r.status === 201)).toHaveLength(3);
        expect(results.filter((r) => r.status === 429)).toHaveLength(9);
        expect(await prisma.session.count({ where: { tenantId: t.id } })).toBe(3);
      });

      it('is per tenant, is off by default, and a change applies immediately', async () => {
        const capped = await mk('capiso-a', { monthlyVerificationCap: 1 });
        const free = await mk('capiso-b');
        await create(capped, '1').expect(201);
        await create(capped, '2').expect(429);
        for (let i = 0; i < 5; i++) await create(free, `f${i}`).expect(201);
        await prisma.tenant.update({ where: { id: capped.id }, data: { monthlyVerificationCap: 5 } });
        await create(capped, '3').expect(201);
        await prisma.tenant.update({ where: { id: free.id }, data: { monthlyVerificationCap: 1 } });
        await create(free, 'now-blocked').expect(429);
      });

      it('shows the cap and what is left in the usage summary', async () => {
        const t = await mk('capview', { monthlyVerificationCap: 4, softLimitPercent: 50 });
        await create(t, '1').expect(201);
        await create(t, '2').expect(201);
        const u = (await request(http()).get('/v1/usage').set(t.h).expect(200)).body;
        expect(u.cap).toEqual({ limit: 4, softLimitPercent: 50, committed: 2, remaining: 2 });
      });

      it('warns once a month when usage reaches the soft limit', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        try {
          const t = await mk('soft', { monthlyVerificationCap: 10, softLimitPercent: 50 });
          const hits = () => warn.mock.calls.filter((c) => String(c[0]).includes(t.id) && String(c[0]).includes('monthly verifications')).length;
          for (let i = 1; i <= 4; i++) await create(t, `s${i}`).expect(201);
          expect(hits()).toBe(0);
          await create(t, 's5').expect(201); // the 5th is 50% of 10
          expect(hits()).toBe(1);
          await create(t, 's6').expect(201);
          await create(t, 's7').expect(201);
          expect(hits()).toBe(1); // not again this month
          expect((await prisma.tenant.findUnique({ where: { id: t.id } }))?.softLimitNotifiedMonth).toBe(monthNow());
          await prisma.tenant.update({ where: { id: t.id }, data: { softLimitNotifiedMonth: '2020-01' } }); // as if a new month began
          await create(t, 's8').expect(201);
          expect(hits()).toBe(2);
          expect(JSON.stringify(warn.mock.calls)).not.toMatch(/s5|customer|Dema/); // no reference or personal data
        } finally {
          warn.mockRestore();
        }
      });
    });

    describe('operator tools', () => {
      const run = (script: string, args: string[]) =>
        new Promise<{ code: number; out: string; err: string }>((resolve) => {
          execFile('node', ['-r', 'ts-node/register', script, ...args], { env: process.env, cwd: process.cwd(), timeout: 60_000 }, (error, out, err) =>
            resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out, err }),
          );
        });

      it('records a credit and reports it in the CSV, with every tenant listed', async () => {
        const t = await mk('cli');
        const idle = await mk('cli-idle');
        await prisma.usageEvent.createMany({ data: Array.from({ length: 4 }, () => ({ tenantId: t.id, kind: 'verification', sessionId: randomUUID(), occurredAt: new Date('2024-05-10T10:00:00Z') })) });
        const adjust = await run('scripts/usage-adjust.ts', [t.id, '2024-05', '-3', 'credit', 'for', 'disputed', 'batch']);
        expect(adjust.code).toBe(0);
        const report = await run('scripts/usage-report.ts', ['2024-05']);
        expect(report.code).toBe(0);
        const rows = report.out.trim().split('\n').map((l) => l.split(','));
        expect(rows[0].slice(0, 7)).toEqual(['month', 'tenant_id', 'tenant_name', 'billable', 'non_billable', 'adjustments', 'net_billable']);
        const mine = rows.find((r) => r[1] === t.id)!;
        expect(mine.slice(3, 7)).toEqual(['4', '0', '-3', '1']);
        expect(rows.find((r) => r[1] === idle.id)!.slice(3, 7)).toEqual(['0', '0', '0', '0']); // present with zeros
        const one = await run('scripts/usage-report.ts', ['2024-05', t.id]);
        expect(one.out.trim().split('\n')).toHaveLength(2);
        const events = (await request(http()).get('/v1/usage/events?month=2024-05').set(t.h).expect(200)).body.items;
        expect(events.find((e: { kind: string }) => e.kind === 'adjustment')).toMatchObject({ quantity: -3, note: 'credit for disputed batch' });
      }, 120_000);

      it('refuses bad input without touching anything', async () => {
        const t = await mk('cli-bad');
        for (const args of [[t.id, '2024-13', '-1', 'reason'], [t.id, '2024-05', '0', 'reason'], [t.id, '2024-05', 'abc', 'reason'], [t.id, '2024-05', '-1', 'x'], [t.id, '2024-05', '-1'], ['00000000-0000-4000-8000-000000000000', '2024-05', '-1', 'reason']]) {
          expect((await run('scripts/usage-adjust.ts', args)).code).toBe(1);
        }
        expect((await run('scripts/usage-report.ts', ['nope'])).code).toBe(1);
        expect(await prisma.usageEvent.count({ where: { tenantId: t.id } })).toBe(0);
      }, 120_000);
    });

    it('is available through the SDK', async () => {
      const t = await mk('sdk', { autoApprove: true });
      await completed(t, 'sdk');
      const client = new VerifyClient({ apiKey: t.key, baseUrl: baseUrl() });
      const summary = await client.usage.get();
      expect(summary.verifications.net).toBe(1);
      const page = await client.usage.events(summary.month);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
      await expect(client.usage.get('2026-99')).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('document encryption', () => {
    const http = () => app.getHttpServer();
    const suffix = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
    let t: { id: string; h: { Authorization: string } };
    const files = (sessionId: string) => {
      const dir = join(storageDir, t.id, sessionId);
      try {
        return readdirSync(dir).map((f) => join(dir, f));
      } catch {
        return [];
      }
    };

    beforeAll(async () => {
      const key = `vk_enc_${suffix}`;
      const row = await prisma.tenant.create({ data: { name: `enc-${suffix}`, apiKeyHash: sha256(key), webhookSecret: 'x', evidenceExport: true } });
      t = { id: row.id, h: { Authorization: `Bearer ${key}` } };
    });

    async function session(ref: string) {
      const created = await request(http()).post('/v1/sessions').set(t.h).send({ externalRef: ref }).expect(201);
      const token = created.body.uploadToken as string;
      for (const kind of ['ID_FRONT', 'SELFIE']) await request(http()).post(`/v1/upload/${token}/${kind}`).attach('file', PNG, { filename: 'a.png' }).expect(204);
      return created.body.id as string;
    }
    const docs = (id: string) => prisma.document.findMany({ where: { sessionId: id }, orderBy: { kind: 'asc' } });

    it('writes each upload bound to its own storage key, with nothing readable on disk', async () => {
      const id = await session('bound');
      const [mine] = await docs(id);
      const onDisk = readFileSync(join(storageDir, mine.storageKey));
      expect(onDisk.subarray(0, 4).toString()).toBe('VSE0');
      expect(onDisk.includes(Buffer.from('fake-image-body'))).toBe(false);
      // Moving an object to another key (here: another session's file) must not decrypt
      const other = await session('bound-other');
      const [theirs] = await docs(other);
      const theirPath = join(storageDir, theirs.storageKey);
      const original = readFileSync(theirPath);
      writeFileSync(theirPath, onDisk);
      const storage = app.get(StorageService);
      await expect(storage.get(theirs.storageKey)).rejects.toThrow('failed verification');
      writeFileSync(theirPath, original);
      expect((await storage.get(theirs.storageKey)).includes(Buffer.from('fake-image-body'))).toBe(true);
    });

    it('re-encrypts old-format objects, is safe to repeat, and a dry run changes nothing', async () => {
      const id = await session('legacy');
      const storage = app.get(StorageService);
      const masterKey = Buffer.from(process.env.STORAGE_ENCRYPTION_KEY!, 'base64');
      // Put the objects back in the original format, as if written before binding existed
      for (const d of await docs(id)) {
        const plain = await storage.get(d.storageKey);
        writeFileSync(join(storageDir, d.storageKey), legacyEncrypt(masterKey, plain));
      }
      const before = files(id).map((f) => readFileSync(f).toString('hex'));
      expect(files(id).every((f) => readFileSync(f).subarray(0, 4).toString() !== 'VSE0')).toBe(true);

      const dry = await reencryptAll(prisma, storage, { dryRun: true, tenantId: t.id });
      expect(dry.rewrapped).toBeGreaterThanOrEqual(2);
      expect(files(id).map((f) => readFileSync(f).toString('hex'))).toEqual(before); // nothing was written

      const first = await reencryptAll(prisma, storage, { tenantId: t.id });
      expect(first.failed).toBe(0);
      expect(files(id).every((f) => readFileSync(f).subarray(0, 4).toString() === 'VSE0')).toBe(true);
      for (const d of await docs(id)) expect((await storage.get(d.storageKey)).includes(Buffer.from('fake-image-body'))).toBe(true);
      const again = await reencryptAll(prisma, storage, { tenantId: t.id });
      expect(again.rewrapped).toBe(0); // already current
    });

    it('never writes an object back after the person was erased, even when erasure races it', async () => {
      const storage = app.get(StorageService);
      const masterKey = Buffer.from(process.env.STORAGE_ENCRYPTION_KEY!, 'base64');
      for (let round = 0; round < 6; round++) {
        const id = await session(`race-${round}`);
        for (const d of await docs(id)) writeFileSync(join(storageDir, d.storageKey), legacyEncrypt(masterKey, await storage.get(d.storageKey)));
        await Promise.all([reencryptAll(prisma, storage, { tenantId: t.id }), request(http()).delete(`/v1/sessions/${id}`).set(t.h).expect(204)]);
        expect(await prisma.session.count({ where: { id } })).toBe(0);
        expect(files(id)).toEqual([]); // no resurrected ciphertext
      }
    });

    it('counts a document it cannot re-encrypt as failed, leaves it as it was, and carries on', async () => {
      const id = await session('unreadable');
      const storage = app.get(StorageService);
      const [first, second] = await docs(id);
      writeFileSync(join(storageDir, first.storageKey), Buffer.from('not a valid object at all, just junk bytes here'));
      const damaged = readFileSync(join(storageDir, first.storageKey));
      const masterKey = Buffer.from(process.env.STORAGE_ENCRYPTION_KEY!, 'base64');
      writeFileSync(join(storageDir, second.storageKey), legacyEncrypt(masterKey, Buffer.from('still fine')));
      const report = await reencryptAll(prisma, storage, { tenantId: t.id });
      expect(report.failed).toBeGreaterThanOrEqual(1);
      expect(readFileSync(join(storageDir, first.storageKey)).equals(damaged)).toBe(true);
      expect(readFileSync(join(storageDir, second.storageKey)).subarray(0, 4).toString()).toBe('VSE0'); // the rest went on
    });

    it('answers 503, not a server error, when the key service is unavailable', async () => {
      const id = await session('unavailable');
      const spy = jest.spyOn(StorageService.prototype, 'get').mockRejectedValue(new KeyUnavailableError());
      try {
        const evidence = await request(http()).get(`/v1/sessions/${id}/evidence/documents/SELFIE`).set(t.h).expect(503);
        expect(evidence.body.message).toBe('Document storage is temporarily unavailable');
        expect(JSON.stringify(evidence.body)).not.toMatch(/kms|arn:|AccessDenied/i); // nothing about the key service leaks
      } finally {
        spy.mockRestore();
      }
      await request(http()).get(`/v1/sessions/${id}/evidence/documents/SELFIE`).set(t.h).expect(200); // and it recovers
    });
  });
});
