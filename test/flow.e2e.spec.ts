// Runs the full flow against a real Postgres (DATABASE_URL). No external services are contacted:
// the webhook target is a local HTTP server started by the test.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { createServer, Server } from 'http';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { hmacSign, randomToken, sha256 } from '../src/common/crypto';

const storageDir = mkdtempSync(join(tmpdir(), 'verify-e2e-'));
process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.STORAGE_LOCAL_DIR = storageDir;
process.env.PUBLIC_BASE_URL = 'http://verify.test';

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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
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
    expect(submitted.body.status).toBe('NEEDS_REVIEW');

    // Session is closed to further uploads
    await request(http)
      .post(`/v1/upload/${token}/SELFIE`)
      .attach('file', PNG, { filename: 'again.png' })
      .expect(410);

    const done = await request(http).get(`/v1/sessions/${id}`).set(auth()).expect(200);
    expect(done.body.status).toBe('NEEDS_REVIEW');

    // Webhook is sent after the response, so wait for it to arrive
    await waitFor(() => hooks.length >= 1);

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
    expect(row?.status).toBe('NEEDS_REVIEW');
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
});
