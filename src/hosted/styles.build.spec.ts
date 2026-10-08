import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LIVENESS_HTML, LIVENESS_JS, VERIFY_HTML, VERIFY_JS } from './page';
import { APP_JS as REVIEW_JS, INDEX_HTML as REVIEW_HTML } from '../review/ui';

// Builds the real Tailwind stylesheet (no network): every class the pages use must end up in it,
// and it must not pull anything from another origin (the pages' policy allows styles from 'self' only).
describe('hosted page stylesheet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'css-build-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let css = '';

  beforeAll(() => {
    execFileSync('pnpm', ['exec', 'tailwindcss', '-i', 'src/hosted/tailwind.css', '-o', join(dir, 'app.css'), '--minify'], { stdio: 'pipe', timeout: 60_000 });
    css = readFileSync(join(dir, 'app.css'), 'utf8');
  }, 60_000);

  it('contains the classes the hosted pages, the review screen and their scripts use', () => {
    const used = new Set<string>();
    for (const src of [VERIFY_HTML, VERIFY_JS, LIVENESS_HTML, LIVENESS_JS, REVIEW_HTML, REVIEW_JS]) {
      for (const m of src.matchAll(/(?:class(?:Name)?\s*[:=]\s*|class=)(['"])([^'"]+)\1/g)) m[2].split(/\s+/).forEach((c) => used.add(c));
      // the class lists in the scripts' C maps
      const map = /var C = \{([\s\S]*?)\n  \};/.exec(src);
      if (map) for (const m of map[1].matchAll(/:\s*'([^']+)'/g)) m[1].split(/\s+/).forEach((c) => used.add(c));
    }
    expect(used.size).toBeGreaterThan(100); // the check is not vacuous
    const markers = new Set(['btn', 'primary', 'preview', 'progress', 'done', 'now', 'link', 'widget', 'more']);
    const escape = (c: string) => c.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
    const missing = [...used].filter((c) => /[a-z]/.test(c) && !markers.has(c) && c.length < 120 && !css.includes(`.${escape(c)}`));
    expect(missing).toEqual([]);
  });

  it('keeps dark mode, the hidden rule and the widget theme', () => {
    expect(css).toContain('prefers-color-scheme:dark');
    expect(css).toMatch(/\[hidden\]/);
    expect(css).toContain('--amplify-colors-primary-80');
  });

  it('loads nothing from another origin', () => {
    expect(css).not.toMatch(/@import\s+(url\()?["']?https?:/);
    expect(css).not.toMatch(/url\(\s*["']?https?:/);
  });
});
