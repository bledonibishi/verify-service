/**
 * Runs the review page's JavaScript in jsdom against a scripted stand-in for the API. No network and
 * no real browser: it checks how the page reacts to the answers it can get.
 */
import { JSDOM } from 'jsdom';
import { APP_JS, INDEX_HTML } from './ui';

type Reply = { status: number; json?: unknown };
interface Call { method: string; path: string; body?: unknown }

const NOT_SIGNED_IN: Reply = { status: 401, json: { statusCode: 401, message: 'Not signed in' } };
const ME = { email: 'alice@example.test', name: 'Alice', twoFactorEnabled: false, twoFactorSetupRequired: false };

/** `routes` maps "METHOD /path" to a reply, or a list of replies used in turn (the last repeats). */
function boot(routes: Record<string, Reply | Reply[]>) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://review.test/review', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  const calls: Call[] = [];
  const queues = new Map<string, Reply[]>();
  for (const [k, v] of Object.entries(routes)) queues.set(k, Array.isArray(v) ? [...v] : [v]);
  w.fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    const path = String(url).replace('/review/api', '');
    const method = init.method ?? 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    const q = queues.get(`${method} ${path.split('?')[0]}`);
    const r = q ? (q.length > 1 ? q.shift()! : q[0]) : { status: 404, json: { message: 'no route' } };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json ?? {} };
  };
  w.eval(APP_JS);
  return { w, doc: w.document as Document, calls };
}

// jsdom queues hashchange events on a timer, so wait on a timer as well as on the microtask queue
const flush = async (n = 6) => { for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 2)); } };
const h2 = (d: Document) => d.querySelector('h2')?.textContent;
const text = (d: Document) => d.getElementById('app')!.textContent ?? '';
const button = (d: Document, label: string) => [...d.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;
const type = (d: Document, id: string, value: string) => ((d.getElementById(id) as HTMLInputElement).value = value);
const submit = async (d: Document) => { d.querySelector('form')!.dispatchEvent(new (d.defaultView as any).Event('submit', { cancelable: true })); await flush(); };

describe('review page: sign-in', () => {
  it('shows the sign-in form when there is no session', async () => {
    const env = boot({ 'GET /me': NOT_SIGNED_IN });
    await flush();
    expect(h2(env.doc)).toBe('Sign in');
  });

  it('asks for the second factor after the password, and keeps the form (and the challenge) after a mistyped code', async () => {
    const env = boot({
      'GET /me': [NOT_SIGNED_IN, { status: 200, json: ME }],
      'POST /login': { status: 200, json: { twoFactorRequired: true, challenge: 'c'.repeat(43) } },
      'POST /login/2fa': [{ status: 401, json: { statusCode: 401, message: 'Invalid or expired code' } }, { status: 200, json: { email: ME.email } }],
      'GET /sessions': { status: 200, json: { items: [], nextCursor: null } },
    });
    await flush();
    type(env.doc, 'email', 'alice@example.test');
    type(env.doc, 'password', 'a-long-password');
    await submit(env.doc);
    expect(h2(env.doc)).toBe('Two-factor sign-in');
    expect(env.calls.filter((c) => c.path === '/login')[0].body).toEqual({ email: 'alice@example.test', password: 'a-long-password' });

    // A wrong code: the message appears in the form that is still there; the person is NOT sent back to the password
    type(env.doc, 'code', '000000');
    await submit(env.doc);
    expect(h2(env.doc)).toBe('Two-factor sign-in');
    expect(text(env.doc)).toContain('That code did not work');
    expect(env.calls.filter((c) => c.path === '/login')).toHaveLength(1);

    // The same challenge is used for the second try
    type(env.doc, 'code', '123456');
    await submit(env.doc);
    const tries = env.calls.filter((c) => c.path === '/login/2fa');
    expect(tries.map((c) => c.body)).toEqual([{ challenge: 'c'.repeat(43), code: '000000' }, { challenge: 'c'.repeat(43), code: '123456' }]);
    expect(h2(env.doc)).toBe('Waiting for review');
  });

  it('can go back from the second step to the password', async () => {
    const env = boot({
      'GET /me': NOT_SIGNED_IN,
      'POST /login': { status: 200, json: { twoFactorRequired: true, challenge: 'c'.repeat(43) } },
    });
    await flush();
    type(env.doc, 'email', 'a@b.test');
    type(env.doc, 'password', 'x');
    await submit(env.doc);
    button(env.doc, 'Back')!.click();
    expect(h2(env.doc)).toBe('Sign in');
  });
});

describe('review page: two-factor settings and requirement', () => {
  it('goes straight to setup when the organisation requires two-factor and the reviewer has none', async () => {
    const env = boot({
      'GET /me': { status: 200, json: { ...ME, twoFactorSetupRequired: true } },
      'GET /2fa': { status: 200, json: { enabled: false, recoveryCodesLeft: 0, required: true } },
    });
    await flush();
    expect(h2(env.doc)).toBe('Two-factor sign-in');
    expect(text(env.doc)).toContain('requires two-factor');
    expect(env.calls.some((c) => c.path.startsWith('/sessions'))).toBe(false); // nothing else was asked for
    expect(button(env.doc, 'Back to queue')).toBeUndefined(); // and there is no way past it
  });

  it('is taken to setup when the requirement starts while already working, instead of seeing bare errors', async () => {
    const env = boot({
      'GET /me': { status: 200, json: ME },
      'GET /sessions': { status: 403, json: { statusCode: 403, message: 'Set up two-factor sign-in to continue', code: 'two_factor_setup_required' } },
      'GET /2fa': { status: 200, json: { enabled: false, recoveryCodesLeft: 0, required: true } },
    });
    await flush();
    expect(h2(env.doc)).toBe('Two-factor sign-in');
    expect(text(env.doc)).toContain('requires two-factor');
    expect(text(env.doc)).not.toContain('Could not load the queue');
  });

  it('keeps the person on the Security page when a password or code is wrong, with the message in place', async () => {
    const env = boot({
      'GET /me': { status: 200, json: ME },
      'GET /sessions': { status: 200, json: { items: [], nextCursor: null } },
      'GET /2fa': { status: 200, json: { enabled: false, recoveryCodesLeft: 0, required: false } },
      'POST /2fa/setup': { status: 401, json: { statusCode: 401, message: 'Invalid password' } },
    });
    await flush();
    button(env.doc, 'Security')!.click();
    await flush();
    expect(h2(env.doc)).toBe('Two-factor sign-in');
    type(env.doc, 'pw1', 'wrong');
    button(env.doc, 'Set up')!.click();
    await flush();
    expect(h2(env.doc)).toBe('Two-factor sign-in'); // not bounced to the sign-in form
    expect(text(env.doc)).toContain('password or code was not right');
  });

  it('still returns to sign-in when the session really is gone', async () => {
    const env = boot({
      'GET /me': [{ status: 200, json: ME }, NOT_SIGNED_IN],
      'GET /sessions': NOT_SIGNED_IN,
    });
    await flush();
    expect(h2(env.doc)).toBe('Sign in');
  });

  it('walks through setup, shows the recovery codes as text, and continues only when they are acknowledged', async () => {
    const evil = '<img src=x onerror="window.pwned=1">';
    const env = boot({
      'GET /me': { status: 200, json: ME },
      'GET /sessions': { status: 200, json: { items: [], nextCursor: null } },
      'GET /2fa': { status: 200, json: { enabled: false, recoveryCodesLeft: 0, required: false } },
      'POST /2fa/setup': { status: 200, json: { secret: 'ABCDEFGHIJKLMNOP', otpauthUri: 'otpauth://totp/x' } },
      'POST /2fa/enable': { status: 200, json: { recoveryCodes: ['AAAAA-BBBBB', evil] } },
    });
    await flush();
    button(env.doc, 'Security')!.click();
    await flush();
    type(env.doc, 'pw1', 'a-long-password');
    button(env.doc, 'Set up')!.click();
    await flush();
    expect(text(env.doc)).toContain('ABCDEFGHIJKLMNOP');
    type(env.doc, 'code1', '123456');
    button(env.doc, 'Turn on')!.click();
    await flush();
    expect(text(env.doc)).toContain('AAAAA-BBBBB');
    expect(text(env.doc)).toContain(evil); // shown as text
    expect(env.doc.querySelectorAll('img')).toHaveLength(0);
    expect((env.w as any).pwned).toBeUndefined();
    expect(env.calls.find((c) => c.path === '/2fa/enable')!.body).toEqual({ code: '123456' });
    button(env.doc, 'I have saved them')!.click();
    await flush();
    expect(h2(env.doc)).toBe('Waiting for review');
  });

  it('does not offer to turn it off where the organisation requires it', async () => {
    const env = boot({
      'GET /me': { status: 200, json: { ...ME, twoFactorEnabled: true } },
      'GET /sessions': { status: 200, json: { items: [], nextCursor: null } },
      'GET /2fa': { status: 200, json: { enabled: true, recoveryCodesLeft: 7, required: true } },
    });
    await flush();
    button(env.doc, 'Security')!.click();
    await flush();
    expect(text(env.doc)).toContain('Recovery codes left: 7');
    expect(button(env.doc, 'Turn off')).toBeUndefined();
    expect(text(env.doc)).toContain('cannot be turned off');
  });
});
