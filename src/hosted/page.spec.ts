/**
 * Runs the hosted page's JavaScript in jsdom with a scripted stand-in for the service and the
 * browser's camera/canvas APIs. No network, no real browser: it checks the page's logic (steps,
 * uploads, retries, errors, languages), not how it looks.
 */
import { JSDOM } from 'jsdom';
import { VERIFY_HTML, VERIFY_JS } from './page';

type Call = { method: string; url: string; body?: unknown };
type Reply = { status: number; json?: unknown } | Error;

const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PLAIN = { status: 'PENDING', requireDrivingLicence: false, uploaded: [], steps: [
  { kind: 'ID_FRONT', required: true }, { kind: 'ID_BACK', required: false }, { kind: 'SELFIE', required: true },
] };
const LICENCE = { ...PLAIN, requireDrivingLicence: true, steps: [
  { kind: 'ID_FRONT', required: true }, { kind: 'ID_BACK', required: true }, { kind: 'LICENCE_FRONT', required: true },
  { kind: 'LICENCE_BACK', required: false }, { kind: 'SELFIE', required: true },
] };

const ok = (json: unknown): Reply => ({ status: 200, json });

interface Options {
  url?: string;
  /** The answer(s) to GET /v1/upload/:token, consumed in order; the last one repeats. */
  session?: Reply | Reply[];
  /** Replies for uploads/submit, consumed in order; the last one repeats. */
  replies?: Reply[];
  /** null: the browser has no createImageBitmap. */
  bitmap?: { width: number; height: number } | null;
  blobSize?: number;
  language?: string;
  storedToken?: string;
}

function boot(o: Options = {}) {
  const dom = new JSDOM(VERIFY_HTML, { url: o.url ?? `http://verify.test/verify#${TOKEN}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  const calls: Call[] = [];
  const replies = [...(o.replies ?? [{ status: 204 }])];
  const sessions = Array.isArray(o.session) ? [...o.session] : [o.session ?? ok(PLAIN)];
  const canvas: { width?: number; height?: number; quality?: number; type?: string; draws: number } = { draws: 0 };

  w.fetch = async (url: string, init: { method?: string; body?: unknown } = {}) => {
    const call: Call = { method: init.method ?? 'GET', url, body: init.body };
    calls.push(call);
    const pool = call.method === 'GET' ? sessions : replies;
    const r: Reply = pool.length > 1 ? pool.shift()! : pool[0];
    if (r instanceof Error) throw r;
    return { status: r.status, json: async () => r.json ?? {} };
  };
  w.setTimeout = (fn: () => void) => {
    fn();
    return 0;
  }; // retries without waiting
  w.URL.createObjectURL = () => 'blob:preview';
  w.URL.revokeObjectURL = () => undefined;
  if (o.bitmap !== null) w.createImageBitmap = async () => ({ ...(o.bitmap ?? { width: 4000, height: 3000 }), close() {} });
  w.HTMLCanvasElement.prototype.getContext = function () {
    canvas.width = this.width;
    canvas.height = this.height;
    return { drawImage() { canvas.draws++; } };
  };
  w.HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void, type: string, quality: number) {
    canvas.type = type;
    canvas.quality = quality;
    cb(new w.Blob([new Uint8Array(o.blobSize ?? 1000)], { type }));
  };
  if (o.language) Object.defineProperty(w.navigator, 'languages', { value: [o.language], configurable: true });
  if (o.storedToken) w.sessionStorage.setItem('verify-token', o.storedToken);
  w.eval(VERIFY_JS);
  return { dom, w, calls, canvas, doc: w.document as Document };
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const text = (d: Document) => d.getElementById('app')!.textContent ?? '';
const h1 = (d: Document) => d.querySelector('h1')?.textContent;
const button = (d: Document, label: string) => [...d.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;
const firstAction = (d: Document) => d.querySelector('button:not([aria-pressed])') as HTMLButtonElement | null;

/** Pick a file through the first matching file input (camera or gallery). */
function pick(env: ReturnType<typeof boot>, file: { size?: number; type?: string; name?: string } = {}, which: 0 | 1 = 0) {
  const input = env.doc.querySelectorAll('input[type=file]')[which] as HTMLInputElement;
  const f = new env.w.File([new Uint8Array(file.size ?? 5000)], file.name ?? 'photo.jpg', { type: file.type ?? 'image/jpeg' });
  Object.defineProperty(input, 'files', { value: [f], configurable: true });
  input.dispatchEvent(new env.w.Event('change'));
  return input;
}
async function start(env: ReturnType<typeof boot>) { await flush(); button(env.doc, 'Start')!.click(); await flush(); }
async function use(env: ReturnType<typeof boot>) { button(env.doc, 'Use this photo')!.click(); await flush(); }

describe('hosted page', () => {
  it('moves the token out of the address bar and talks only to the upload API', async () => {
    const env = boot();
    await flush();
    expect(env.w.location.hash).toBe('');
    expect(env.w.location.href).not.toContain(TOKEN);
    expect(env.w.sessionStorage.getItem('verify-token')).toBe(TOKEN);
    expect(env.calls[0]).toMatchObject({ method: 'GET', url: `/v1/upload/${TOKEN}` });
    expect(env.calls.every((c) => c.url.startsWith('/v1/upload/'))).toBe(true);
    expect(h1(env.doc)).toBe('Verify your identity');
    expect(text(env.doc)).toContain('Your identity card');
    expect(text(env.doc)).not.toContain('driving licence');
  });

  it('shows a clear message, and sends nothing, when there is no usable token', async () => {
    for (const url of ['http://verify.test/verify', 'http://verify.test/verify#short', 'http://verify.test/verify#<script>alert(1)</script>']) {
      const env = boot({ url });
      await flush();
      expect(h1(env.doc)).toBe('Link not found');
      expect(env.calls).toHaveLength(0);
    }
  });

  it('resumes from sessionStorage after a reload, when the fragment is gone', async () => {
    const env = boot({ url: 'http://verify.test/verify', storedToken: TOKEN });
    await flush();
    expect(env.calls[0]).toMatchObject({ method: 'GET', url: `/v1/upload/${TOKEN}` });
    expect(h1(env.doc)).toBe('Verify your identity');
  });

  it('walks through the steps, shrinking each photo to a JPEG before upload', async () => {
    const env = boot({ bitmap: { width: 4000, height: 3000 } });
    await start(env);
    expect(h1(env.doc)).toBe('Front of your identity card');
    expect(text(env.doc)).toContain('Step 1 of 3');
    const input = pick(env);
    expect((env.doc.querySelector('img.preview') as HTMLImageElement).hidden).toBe(false);
    expect(input.getAttribute('capture')).toBe('environment'); // the camera picker opens the rear camera for documents
    await use(env);

    const upload = env.calls.find((c) => c.method === 'POST')!;
    expect(upload.url).toBe(`/v1/upload/${TOKEN}/ID_FRONT`);
    const file = (upload.body as FormData).get('file') as File;
    expect(file.type).toBe('image/jpeg');
    expect(file.name).toBe('id_front.jpg');
    expect(env.canvas).toMatchObject({ width: 2000, height: 1500, type: 'image/jpeg', quality: 0.85 }); // longest edge 2000
    expect(h1(env.doc)).toBe('Back of your identity card');
    expect(text(env.doc)).toContain('Optional');
  });

  it('uses the front camera for the selfie, and offers a gallery picker without capture', async () => {
    const env = boot();
    await start(env);
    for (const kind of ['ID_FRONT', 'ID_BACK']) { pick(env); await use(env); expect(env.calls.at(-1)!.url).toContain(kind); }
    expect(h1(env.doc)).toBe('A selfie');
    expect(env.doc.querySelectorAll('input[type=file]')[0].getAttribute('capture')).toBe('user');
    expect(env.doc.querySelectorAll('input[type=file]')[1].hasAttribute('capture')).toBe(false);
  });

  it('does not enlarge small photos, and recompresses an oversized result', async () => {
    const small = boot({ bitmap: { width: 800, height: 600 } });
    await start(small);
    pick(small); await use(small);
    expect(small.canvas).toMatchObject({ width: 800, height: 600 });

    const huge = boot({ blobSize: 9 * 1024 * 1024 });
    await start(huge);
    pick(huge); await use(huge);
    expect(huge.canvas.quality).toBe(0.6); // second pass at lower quality
  });

  it('sends the original when the browser cannot re-encode, if the service would accept it', async () => {
    const ok = boot({ bitmap: null });
    await start(ok);
    pick(ok, { type: 'image/png', name: 'x.png' }); await use(ok);
    expect(((ok.calls.find((c) => c.method === 'POST')!.body as FormData).get('file') as File).type).toBe('image/png');

    const big = boot({ bitmap: null });
    await start(big);
    pick(big, { size: 9 * 1024 * 1024 }); await use(big);
    expect(big.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(text(big.doc)).toContain('too large');

    const notImage = boot({ bitmap: null });
    await start(notImage);
    pick(notImage, { type: 'application/pdf', name: 'a.pdf' }); await use(notImage);
    expect(notImage.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(text(notImage.doc)).toContain('could not read that file');
  });

  it('retries a busy server and a dropped connection, then moves on', async () => {
    const env = boot({ replies: [{ status: 503 }, new Error('network down'), { status: 204 }] });
    await start(env);
    pick(env); await use(env);
    expect(env.calls.filter((c) => c.method === 'POST')).toHaveLength(3);
    expect(h1(env.doc)).toBe('Back of your identity card');
  });

  it.each([
    [400, 'could not read that file'],
    [413, 'too large'],
    [429, 'Too many attempts'],
    [422, 'Something went wrong'],
  ])('shows a helpful message for a %i and lets the user try again', async (status, expected) => {
    const env = boot({ replies: [{ status }] });
    await start(env);
    pick(env); await use(env);
    expect(text(env.doc)).toContain(expected);
    expect(h1(env.doc)).toBe('Front of your identity card'); // stayed on the step
    expect(button(env.doc, 'Use this photo')!.disabled).toBe(false);
    expect(env.doc.querySelector('[role=alert]')!.textContent).toContain(expected);
  });

  it('gives up after repeated connection failures with a network message', async () => {
    const env = boot({ replies: [new Error('offline')] });
    await start(env);
    pick(env); await use(env);
    expect(env.calls.filter((c) => c.method === 'POST')).toHaveLength(4); // first try and three retries
    expect(text(env.doc)).toContain('The connection failed');
    expect(button(env.doc, 'Use this photo')!.disabled).toBe(false);
  });

  it('shows "cannot be used" for an expired or used link, and "not found" for an unknown one', async () => {
    const gone = boot({ session: { status: 410 } });
    await flush();
    expect(h1(gone.doc)).toBe('This link cannot be used');
    const missing = boot({ session: { status: 404 } });
    await flush();
    expect(h1(missing.doc)).toBe('Link not found');
    const closedMidway = boot({ replies: [{ status: 410 }] });
    await start(closedMidway);
    pick(closedMidway); await use(closedMidway);
    expect(h1(closedMidway.doc)).toBe('This link cannot be used');
  });

  it('lets the user submit once the required photos are in, then confirms and forgets the token', async () => {
    const env = boot({ replies: [{ status: 204 }, { status: 204 }, { status: 200, json: { status: 'PROCESSING' } }] });
    await start(env);
    pick(env); await use(env); // ID front
    button(env.doc, 'Skip this step')!.click(); await flush(); // optional ID back
    pick(env); await use(env); // selfie
    expect(h1(env.doc)).toBe('Almost done');
    expect(text(env.doc)).toContain('Front of your identity card');
    button(env.doc, 'Submit for verification')!.click(); await flush();
    expect(env.calls.at(-1)).toMatchObject({ method: 'POST', url: `/v1/upload/${TOKEN}/submit` });
    expect(h1(env.doc)).toBe('Thank you');
    expect(env.w.sessionStorage.getItem('verify-token')).toBeNull(); // the used token is forgotten
  });

  it('does not offer to skip a required photo', async () => {
    const env = boot();
    await start(env);
    expect(h1(env.doc)).toBe('Front of your identity card');
    expect(button(env.doc, 'Skip this step')).toBeUndefined();
  });

  it('handles a failed or refused submit', async () => {
    // A bare 410 (no reason given) is looked into: the session is then also reported gone, so the link is dead
    const mk = (submit: Reply) => boot({ replies: [{ status: 204 }, { status: 204 }, { status: 204 }, submit], session: [ok(PLAIN), { status: 410 }] });
    const finish = async (env: ReturnType<typeof boot>) => {
      await start(env);
      pick(env); await use(env);
      pick(env); await use(env);
      pick(env); await use(env);
      button(env.doc, 'Submit for verification')!.click(); await flush();
    };
    const closed = mk({ status: 410 });
    await finish(closed);
    expect(h1(closed.doc)).toBe('This link cannot be used');
    const incomplete = mk({ status: 400 });
    await finish(incomplete);
    expect(text(incomplete.doc)).toContain('required photos are missing');
    expect(button(incomplete.doc, 'Submit for verification')!.disabled).toBe(false);
  });

  it('asks for the licence when the session requires one', async () => {
    const env = boot({ session: ok(LICENCE) });
    await flush();
    expect(text(env.doc)).toContain('Your driving licence');
    button(env.doc, 'Start')!.click(); await flush();
    expect(text(env.doc)).toContain('of 5');
    for (const kind of ['ID_FRONT', 'ID_BACK']) { pick(env); await use(env); expect(env.calls.at(-1)!.url).toContain(kind); }
    expect(h1(env.doc)).toBe('Front of your driving licence');
    expect(button(env.doc, 'Skip this step')).toBeUndefined(); // licence front is required
    pick(env); await use(env);
    expect(h1(env.doc)).toBe('Back of your driving licence');
    expect(button(env.doc, 'Skip this step')).toBeDefined(); // licence back is optional
  });

  it('starts at the first step that is not uploaded yet', async () => {
    const env = boot({ session: ok({ ...PLAIN, uploaded: ['ID_FRONT'] }) });
    await start(env);
    expect(h1(env.doc)).toBe('Back of your identity card');
    expect(env.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('writes what the server sends as text, never as HTML', async () => {
    const evil = '<img src=x onerror="window.pwned=1">';
    const env = boot({ session: ok({ ...PLAIN, steps: [{ kind: evil, required: true }] }) });
    await start(env);
    expect(text(env.doc)).toContain(evil);
    expect(env.doc.querySelectorAll('img:not(.preview)')).toHaveLength(0);
    expect((env.w as any).pwned).toBeUndefined();
  });

  describe('languages', () => {
    it('follows the browser language, and ?lang= overrides it', async () => {
      const sq = boot({ language: 'sq-AL' });
      await flush();
      expect(h1(sq.doc)).toBe('Verifikoni identitetin tuaj');
      const sr = boot({ language: 'sr-Latn-RS' });
      await flush();
      expect(h1(sr.doc)).toBe('Potvrdite svoj identitet');
      const override = boot({ language: 'sq', url: `http://verify.test/verify?lang=en#${TOKEN}` });
      await flush();
      expect(h1(override.doc)).toBe('Verify your identity');
      expect(boot({ language: 'fr' }).doc.documentElement.lang).toBe('en'); // unknown languages fall back to English
    });

    it('switches language in place, including on an error screen', async () => {
      const env = boot();
      await flush();
      button(env.doc, 'SQ')!.click();
      expect(h1(env.doc)).toBe('Verifikoni identitetin tuaj');
      expect(env.doc.documentElement.lang).toBe('sq');
      const fatal = boot({ session: { status: 410 } });
      await flush();
      button(fatal.doc, 'SR')!.click();
      expect(h1(fatal.doc)).toBe('Ova veza se ne može koristiti');
    });

    it('has every string in every language, and never shows a raw key', async () => {
      const block = (name: string) => VERIFY_JS.split(`    ${name}: {`)[1].split(/\n    (?:sq|sr): \{|\n  \};/)[0];
      const keys = (b: string) => new Set([...b.matchAll(/(\w+): '/g)].map((m) => m[1]));
      const en = keys(block('en'));
      for (const lang of ['sq', 'sr']) {
        const k = keys(block(lang));
        expect([...en].filter((x) => !k.has(x))).toEqual([]);
        expect([...k].filter((x) => !en.has(x))).toEqual([]);
      }
      expect(en.size).toBeGreaterThan(40);
      for (const language of ['en', 'sq', 'sr']) {
        const env = boot({ session: ok(LICENCE), url: `http://verify.test/verify?lang=${language}#${TOKEN}` });
        await flush();
        const seen = [text(env.doc)];
        button(env.doc, language === 'en' ? 'Start' : language === 'sq' ? 'Fillo' : 'Počni')!.click(); await flush();
        for (let i = 0; i < 5; i++) { seen.push(text(env.doc)); firstAction(env.doc)?.click(); await flush(); }
        for (const s of seen) expect(s).not.toMatch(/\b(ID_FRONT|ID_BACK|LICENCE_FRONT|LICENCE_BACK|SELFIE)(_HINT)?\b/);
      }
    });
  });

  describe('after a reload or a lost reply', () => {
    const SUBMITTED = { status: 410, json: { code: 'session_submitted', message: 'Session already submitted' } };
    const EXPIRED = { status: 410, json: { code: 'session_expired', message: 'Session expired' } };
    const CLOSED = { status: 410, json: { code: 'session_closed', message: 'Session is closed' } };
    /** Uploads the three photos of a plain session and reaches the review screen. */
    async function toReview(env: ReturnType<typeof boot>) {
      await start(env);
      pick(env); await use(env);
      button(env.doc, 'Skip this step')!.click(); await flush();
      pick(env); await use(env);
      expect(h1(env.doc)).toBe('Almost done');
    }
    const submits = (env: ReturnType<typeof boot>) => env.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/submit'));
    const submit = async (env: ReturnType<typeof boot>) => { button(env.doc, 'Submit for verification')!.click(); await flush(20); };

    it('goes straight to the review screen when every photo was already uploaded, so the user can still submit', async () => {
      const env = boot({ session: ok({ ...PLAIN, uploaded: ['ID_FRONT', 'ID_BACK', 'SELFIE'] }), replies: [{ status: 200, json: {} }] });
      await start(env);
      expect(h1(env.doc)).toBe('Almost done');
      expect(button(env.doc, 'Submit for verification')!.disabled).toBe(false);
      await submit(env);
      expect(h1(env.doc)).toBe('Thank you');
    });

    it('retries the first request, and offers "Try again" instead of "link not found" if the service stays down', async () => {
      const flaky = boot({ session: [{ status: 503 }, { status: 503 }, ok(PLAIN)] });
      await flush();
      expect(h1(flaky.doc)).toBe('Verify your identity');
      expect(flaky.calls.filter((c) => c.method === 'GET')).toHaveLength(3);

      const down = boot({ session: [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, ok(PLAIN)] });
      await flush();
      expect(h1(down.doc)).toBe('We cannot reach the service');
      expect(h1(down.doc)).not.toBe('Link not found');
      button(down.doc, 'Try again')!.click(); await flush();
      expect(h1(down.doc)).toBe('Verify your identity');

      const offline = boot({ session: new Error('offline') });
      await flush();
      expect(h1(offline.doc)).toBe('We cannot reach the service');
      expect(button(offline.doc, 'Try again')).toBeDefined();
    });

    it('thanks a user who reloads after submitting, and says "cannot be used" only when it truly expired', async () => {
      const done = boot({ session: SUBMITTED });
      await flush();
      expect(h1(done.doc)).toBe('Thank you');
      expect(done.w.sessionStorage.getItem('verify-token')).toBeNull();
      const expired = boot({ session: EXPIRED });
      await flush();
      expect(h1(expired.doc)).toBe('This link cannot be used');
      const unknown = boot({ session: { status: 410 } });
      await flush();
      expect(h1(unknown.doc)).toBe('This link cannot be used');
    });

    it('does not tell the user their link is dead when the submit went through but its reply was lost', async () => {
      // 1) the connection drops after the service accepted it: the page looks, sees it was submitted, and thanks the user
      const lost = boot({ replies: [{ status: 204 }, { status: 204 }, new Error('connection reset')], session: [ok(PLAIN), SUBMITTED] });
      await toReview(lost);
      await submit(lost);
      expect(h1(lost.doc)).toBe('Thank you');
      expect(submits(lost)).toHaveLength(1); // never sent a second time

      // 2) the service answered 503: same, it looks first
      const busy = boot({ replies: [{ status: 204 }, { status: 204 }, { status: 503 }], session: [ok(PLAIN), SUBMITTED] });
      await toReview(busy);
      await submit(busy);
      expect(h1(busy.doc)).toBe('Thank you');
      expect(submits(busy)).toHaveLength(1);
    });

    it('submits again only when the session is verifiably still open', async () => {
      const env = boot({ replies: [{ status: 204 }, { status: 204 }, new Error('reset'), { status: 200, json: { status: 'PROCESSING' } }], session: [ok(PLAIN), ok(PLAIN)] });
      await toReview(env);
      await submit(env);
      expect(submits(env)).toHaveLength(2); // the look showed it was still open, so it went again
      expect(h1(env.doc)).toBe('Thank you');
    });

    it('treats an explicit "already submitted" as success and an explicit "expired" as a dead link', async () => {
      const again = boot({ replies: [{ status: 204 }, { status: 204 }, SUBMITTED] });
      await toReview(again);
      await submit(again);
      expect(h1(again.doc)).toBe('Thank you');
      expect(submits(again)).toHaveLength(1);

      const dead = boot({ replies: [{ status: 204 }, { status: 204 }, EXPIRED] });
      await toReview(dead);
      await submit(dead);
      expect(h1(dead.doc)).toBe('This link cannot be used');
    });

    it('asks the service what "closed" meant before deciding', async () => {
      const wasSubmitted = boot({ replies: [{ status: 204 }, { status: 204 }, CLOSED], session: [ok(PLAIN), SUBMITTED] });
      await toReview(wasSubmitted);
      await submit(wasSubmitted);
      expect(h1(wasSubmitted.doc)).toBe('Thank you');
      const wasExpired = boot({ replies: [{ status: 204 }, { status: 204 }, CLOSED], session: [ok(PLAIN), EXPIRED] });
      await toReview(wasExpired);
      await submit(wasExpired);
      expect(h1(wasExpired.doc)).toBe('This link cannot be used');
    });

    it('gives up cleanly when it cannot find out, never resubmits blindly, and lets the user try again', async () => {
      const env = boot({ replies: [{ status: 204 }, { status: 204 }, new Error('reset')], session: [ok(PLAIN), new Error('still offline')] });
      await toReview(env);
      await submit(env);
      expect(submits(env)).toHaveLength(1);
      expect(text(env.doc)).toContain('The connection failed');
      expect(h1(env.doc)).toBe('Almost done'); // not a dead-link screen
      expect(button(env.doc, 'Submit for verification')!.disabled).toBe(false);
    });
  });
});
