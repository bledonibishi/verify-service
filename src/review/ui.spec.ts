import { APP_JS, INDEX_HTML } from './ui';

describe('review UI assets', () => {
  it('app.js is syntactically valid', () => {
    expect(() => new Function(APP_JS)).not.toThrow();
  });

  it('writes API values with textContent, never as HTML', () => {
    expect(APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  it('loads its script and style from the same origin only', () => {
    const urls = [...INDEX_HTML.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith('/review/'))).toBe(true);
  });

  it('sets no inline styles or handlers (the CSP would block them)', () => {
    expect(APP_JS).not.toMatch(/style\s*:/);
    expect(APP_JS).not.toMatch(/setAttribute\(\s*['"]style/);
    expect(INDEX_HTML).not.toMatch(/\sstyle=/);
  });

  it('drops responses that arrive after sign-out or navigation', () => {
    // Every async render path checks the navigation generation before touching the page
    const checks = APP_JS.match(/my !== gen|my === gen/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(6);
    expect(APP_JS).toMatch(/function nav\(\)/);
  });
});
