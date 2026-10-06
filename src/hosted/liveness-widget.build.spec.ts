import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Builds the real AWS widget bundle (no network, no AWS): catches a dependency update that breaks
// the build or the page's contract with it. Running it in a browser needs a real phone (docs/liveness.md).
describe('liveness widget bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'liveness-build-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('builds into one script and one stylesheet that define window.VerifyLiveness.mount', () => {
    execFileSync('node', ['scripts/build-liveness.mjs', dir], { cwd: process.cwd(), stdio: 'pipe', timeout: 120_000 });
    const js = join(dir, 'liveness-widget.js');
    const css = join(dir, 'liveness-widget.css');
    expect(existsSync(js)).toBe(true);
    expect(existsSync(css)).toBe(true);
    const code = readFileSync(js, 'utf8');
    expect(code).toContain('VerifyLiveness');
    // The page's policy forbids eval; the bundle must not need it
    expect(code).not.toMatch(/\bnew Function\(|\beval\(/);
    // No stylesheet pulled from elsewhere
    expect(readFileSync(css, 'utf8')).not.toMatch(/@import|url\(\s*['"]?https?:/);
  }, 120_000);
});
