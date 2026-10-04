import { createHmac } from 'crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'http';
import { AddressInfo } from 'net';
import { UploadClient, VerifyApiError, VerifyClient, VerifyNetworkError, WebhookSignatureError } from '../src';

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer, n: number) => void;

/** A scripted local API: no network beyond this machine. */
async function api(handler: Handler) {
  const seen: { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      handler(req, res, body, seen.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

describe('VerifyClient', () => {
  it('requires an API key and a base URL', () => {
    expect(() => new VerifyClient({ apiKey: '', baseUrl: 'http://x' })).toThrow('apiKey');
    expect(() => new VerifyClient({ apiKey: 'k', baseUrl: '' })).toThrow('baseUrl');
  });

  it('creates a session with the key and JSON body, and does not retry a create', async () => {
    const s = await api((_req, res, _b, n) => (n === 1 ? json(res, 500, { message: 'boom' }) : json(res, 201, { id: 'x' })));
    const c = new VerifyClient({ apiKey: 'vk_secret', baseUrl: s.url + '/' }); // trailing slash is fine
    await expect(c.sessions.create({ externalRef: 'u1', requireDrivingLicence: true })).rejects.toMatchObject({ status: 500 });
    expect(s.seen).toHaveLength(1); // a repeat could have created a second session
    expect(s.seen[0].headers.authorization).toBe('Bearer vk_secret');
    expect(s.seen[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(s.seen[0].body.toString())).toEqual({ externalRef: 'u1', requireDrivingLicence: true });
    expect(s.seen[0].url).toBe('/v1/sessions');
    await s.close();
  });

  it('retries reads on 503, 429 and a dropped connection, then succeeds', async () => {
    const s = await api((req, res, _b, n) => {
      if (n === 1) return json(res, 503, { message: 'busy' });
      if (n === 2) return json(res, 429, { message: 'slow down' });
      if (n === 3) return void req.socket.destroy();
      return json(res, 200, { id: 'abc', status: 'APPROVED' });
    });
    const c = new VerifyClient({ apiKey: 'k', baseUrl: s.url, maxRetries: 3 });
    await expect(c.sessions.get('abc')).resolves.toMatchObject({ id: 'abc' });
    expect(s.seen).toHaveLength(4);
    await s.close();
  });

  it('gives up after the retries and reports the last answer', async () => {
    const s = await api((_r, res) => json(res, 503, { message: 'still busy' }));
    await expect(new VerifyClient({ apiKey: 'k', baseUrl: s.url, maxRetries: 1 }).sessions.get('abc')).rejects.toMatchObject({ status: 503, message: 'still busy' });
    expect(s.seen).toHaveLength(2);
    await s.close();
  });

  it('does not retry client errors, and exposes them readably', async () => {
    const s = await api((_r, res, _b, n) => (n === 1 ? json(res, 404, { message: 'Session not found' }) : json(res, 400, { message: ['externalRef must be a string', 'birthDate must be YYYY-MM-DD'] })));
    const c = new VerifyClient({ apiKey: 'k', baseUrl: s.url });
    const nf = await c.sessions.get('missing').catch((e) => e);
    expect(nf).toBeInstanceOf(VerifyApiError);
    expect(nf).toMatchObject({ status: 404, message: 'Session not found', isNotFound: true });
    const bad = await c.sessions.create({ externalRef: 'x' }).catch((e) => e);
    expect(bad.message).toBe('externalRef must be a string; birthDate must be YYYY-MM-DD');
    expect(s.seen).toHaveLength(2);
    await s.close();
  });

  it('turns a dead server or a timeout into VerifyNetworkError', async () => {
    const dead = await api((_r, res) => res.end());
    const url = dead.url;
    await dead.close();
    await expect(new VerifyClient({ apiKey: 'k', baseUrl: url, maxRetries: 0 }).sessions.get('x')).rejects.toBeInstanceOf(VerifyNetworkError);
    const hang = await api(() => undefined);
    await expect(new VerifyClient({ apiKey: 'k', baseUrl: hang.url, timeoutMs: 150, maxRetries: 0 }).sessions.get('x')).rejects.toBeInstanceOf(VerifyNetworkError);
    await hang.close();
  });

  it('refuses redirects, so the API key is never sent somewhere else', async () => {
    const other = await api((_r, res) => json(res, 200, { id: 'leaked' }));
    const s = await api((_r, res) => res.writeHead(302, { location: other.url + '/steal' }).end());
    await expect(new VerifyClient({ apiKey: 'vk_secret', baseUrl: s.url, maxRetries: 0 }).sessions.get('x')).rejects.toBeInstanceOf(VerifyNetworkError);
    expect(other.seen).toHaveLength(0);
    await s.close();
    await other.close();
  });

  it('escapes ids so a crafted value cannot reach another path', async () => {
    const s = await api((_r, res) => json(res, 200, {}));
    await new VerifyClient({ apiKey: 'k', baseUrl: s.url }).sessions.get('../webhook-events?status=FAILED');
    expect(s.seen[0].url).toBe('/v1/sessions/..%2Fwebhook-events%3Fstatus%3DFAILED');
    await s.close();
  });

  it('deletes a session', async () => {
    const s = await api((_r, res) => res.writeHead(204).end());
    await expect(new VerifyClient({ apiKey: 'k', baseUrl: s.url }).sessions.delete('abc')).resolves.toBeUndefined();
    expect(s.seen[0]).toMatchObject({ method: 'DELETE', url: '/v1/sessions/abc' });
    await s.close();
  });

  describe('evidence', () => {
    const secret = 'whsec_evidence';
    const bundle = JSON.stringify({ version: 1, session: { id: 'abc' }, auditLog: [] });
    const signed = (body: string, key = secret, at = Math.floor(Date.now() / 1000)) => `t=${at},v1=${createHmac('sha256', key).update(`${at}.${body}`).digest('hex')}`;

    it('returns the parsed bundle plus the raw text and signature, verified when a secret is configured', async () => {
      const s = await api((_r, res) => res.writeHead(200, { 'content-type': 'application/json', 'x-evidence-signature': signed(bundle) }).end(bundle));
      const r = await new VerifyClient({ apiKey: 'k', baseUrl: s.url, webhookSecret: secret }).sessions.evidence('abc');
      expect(r.bundle).toMatchObject({ version: 1 });
      expect(r.raw).toBe(bundle);
      await s.close();
    });

    it('refuses a bundle whose signature does not verify', async () => {
      const s = await api((_r, res) => res.writeHead(200, { 'x-evidence-signature': signed(bundle, 'whsec_attacker') }).end(bundle));
      await expect(new VerifyClient({ apiKey: 'k', baseUrl: s.url, webhookSecret: secret }).sessions.evidence('abc')).rejects.toBeInstanceOf(WebhookSignatureError);
      await s.close();
    });

    it('returns a document with its content type and hash', async () => {
      const s = await api((_r, res) => res.writeHead(200, { 'content-type': 'image/png', 'x-document-sha256': 'abc123' }).end(Buffer.from([1, 2, 3])));
      const d = await new VerifyClient({ apiKey: 'k', baseUrl: s.url }).sessions.evidenceDocument('abc', 'SELFIE');
      expect([...d.data]).toEqual([1, 2, 3]);
      expect(d).toMatchObject({ contentType: 'image/png', sha256: 'abc123' });
      expect(s.seen[0].url).toBe('/v1/sessions/abc/evidence/documents/SELFIE');
      await s.close();
    });
  });

  it('lists and replays webhook events', async () => {
    const s = await api((req, res) => (req.method === 'GET' ? json(res, 200, { items: [{ id: 'e1', status: 'FAILED' }] }) : json(res, 202, { status: 'PENDING' })));
    const c = new VerifyClient({ apiKey: 'k', baseUrl: s.url });
    expect(await c.webhookEvents.list('FAILED')).toEqual([{ id: 'e1', status: 'FAILED' }]);
    expect(s.seen[0].url).toBe('/v1/webhook-events?status=FAILED');
    await c.webhookEvents.retry('e1');
    expect(s.seen[1]).toMatchObject({ method: 'POST', url: '/v1/webhook-events/e1/retry' });
    await s.close();
  });
});

describe('UploadClient', () => {
  it('holds only the token: no API key and no Authorization header', async () => {
    const s = await api((_r, res) => json(res, 200, { steps: [], uploaded: [] }));
    await new UploadClient({ baseUrl: s.url, token: 'tok_abc' }).getSession();
    expect(s.seen[0].url).toBe('/v1/upload/tok_abc');
    expect(s.seen[0].headers.authorization).toBeUndefined();
    await s.close();
  });

  it('requires a token and escapes it', async () => {
    expect(() => new UploadClient({ baseUrl: 'http://x', token: '' })).toThrow('token');
    const s = await api((_r, res) => json(res, 200, {}));
    await new UploadClient({ baseUrl: s.url, token: 'a/b?c' }).getSession();
    expect(s.seen[0].url).toBe('/v1/upload/a%2Fb%3Fc');
    await s.close();
  });

  it('uploads a file as multipart field "file" and retries a transient failure', async () => {
    const s = await api((_r, res, _b, n) => (n === 1 ? json(res, 502, { message: 'bad gateway' }) : res.writeHead(204).end()));
    await new UploadClient({ baseUrl: s.url, token: 'tok' }).upload('SELFIE', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2])], { type: 'image/jpeg' }));
    expect(s.seen).toHaveLength(2);
    const last = s.seen[1];
    expect(last.url).toBe('/v1/upload/tok/SELFIE');
    expect(String(last.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    const text = last.body.toString('latin1');
    expect(text).toContain('name="file"');
    expect(text).toContain('filename="selfie.jpg"');
    await s.close();
  });

  it('reports a closed session as an error with the service message', async () => {
    const s = await api((_r, res) => json(res, 410, { message: 'Session already submitted' }));
    const err = await new UploadClient({ baseUrl: s.url, token: 'tok' }).upload('ID_FRONT', new Blob(['x'])).catch((e) => e);
    expect(err).toMatchObject({ status: 410, message: 'Session already submitted' });
    expect(s.seen).toHaveLength(1); // 410 is not retried
    await s.close();
  });

  it('never retries submit', async () => {
    const s = await api((_r, res) => json(res, 500, { message: 'boom' }));
    await expect(new UploadClient({ baseUrl: s.url, token: 'tok' }).submit()).rejects.toMatchObject({ status: 500 });
    expect(s.seen).toHaveLength(1);
    await s.close();
  });

  it('starts a liveness challenge', async () => {
    const s = await api((_r, res) => json(res, 200, { provider: 'x', sessionId: 'abc' }));
    expect(await new UploadClient({ baseUrl: s.url, token: 'tok' }).startLiveness()).toMatchObject({ sessionId: 'abc' });
    await s.close();
  });
});
