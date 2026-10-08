import sharp from 'sharp';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OcrUnavailableError } from './ocr-provider';
import { TesseractProvider } from './tesseract.provider';

// Uses stand-in shell scripts, never a real OCR engine or real images.
describe('TesseractProvider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tess-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const script = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it('feeds the image on stdin and returns stdout', async () => {
    const bin = script('ok', 'cat >/dev/null; echo "ABC<<123"');
    await expect(new TesseractProvider(bin).readText(Buffer.from('img'))).resolves.toEqual({ text: 'ABC<<123\n' });
  });

  it('reports a missing binary as unavailable', async () => {
    await expect(new TesseractProvider(join(dir, 'nope')).readText(Buffer.from('x'))).rejects.toBeInstanceOf(OcrUnavailableError);
  });

  it('fails on a non-zero exit without leaking engine output', async () => {
    const bin = script('bad', 'cat >/dev/null; echo "SECRET TEXT" >&2; exit 3');
    const err = await new TesseractProvider(bin).readText(Buffer.from('x')).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain('SECRET');
    expect(err.reason).toBe('exit');
  });

  it('kills a hung engine after the timeout', async () => {
    const bin = script('hang', 'sleep 30');
    await expect(new TesseractProvider(bin, 'eng', 200).readText(Buffer.from('x'))).rejects.toMatchObject({ reason: 'timeout' });
  });
});

describe('TesseractProvider modes', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'tess-modes-'));
  afterAll(() => rmSync(dir2, { recursive: true, force: true }));
  // A stand-in "engine" that prints the arguments it was started with
  const echo = join(dir2, 'echo');
  writeFileSync(echo, '#!/bin/sh\ncat >/dev/null\necho "$@"\n');
  chmodSync(echo, 0o755);

  it('restricts the alphabet for the MRZ (default) but not for printed text', async () => {
    const p = new TesseractProvider(echo, 'ocrb', 5000, 'eng+sqi');
    const mrz = (await p.readText(Buffer.from('x'))).text;
    expect(mrz).toContain('tessedit_char_whitelist');
    expect(mrz).toContain('-l ocrb');
    const text = (await p.readText(Buffer.from('x'), { mode: 'text' })).text;
    expect(text).not.toContain('whitelist');
    expect(text).toContain('-l eng+sqi');
  });
});

describe('TesseractProvider tries cleaned-up images only when asked and only when needed', () => {
  const dir3 = mkdtempSync(join(tmpdir(), 'tess-variants-'));
  afterAll(() => rmSync(dir3, { recursive: true, force: true }));
  // Answers BAD for its first `n` runs, then GOOD, and counts runs in a file
  const flaky = (n: number) => {
    const counter = join(dir3, `count-${n}`);
    writeFileSync(counter, '');
    const file = join(dir3, `flaky-${n}`);
    writeFileSync(file, `#!/bin/sh\ncat >/dev/null\necho x >> "${counter}"\nif [ $(wc -l < "${counter}") -le ${n} ]; then echo BAD; else echo GOOD; fi\n`);
    chmodSync(file, 0o755);
    return { bin: file, runs: () => readFileSync(counter, 'utf8').split('\n').filter(Boolean).length };
  };
  const photo = () => sharp({ create: { width: 800, height: 600, channels: 3, background: '#cccccc' } }).png().toBuffer();

  it('reads once when no judge is given', async () => {
    const f = flaky(5);
    expect((await new TesseractProvider(f.bin).readText(await photo())).text).toBe('BAD\n');
    expect(f.runs()).toBe(1);
  });

  it('reads once when the first reading is accepted', async () => {
    const f = flaky(0);
    await new TesseractProvider(f.bin).readText(await photo(), { accept: (t) => t.includes('GOOD') });
    expect(f.runs()).toBe(1);
  });

  it('moves on to cleaned-up images and stops at the first accepted one', async () => {
    const f = flaky(3);
    const r = await new TesseractProvider(f.bin).readText(await photo(), { accept: (t) => t.includes('GOOD') });
    expect(r.text).toBe('GOOD\n');
    expect(f.runs()).toBe(4);
  });

  it('gives back the first reading when nothing is accepted, after a bounded number of tries', async () => {
    const f = flaky(1000);
    const r = await new TesseractProvider(f.bin).readText(await photo(), { accept: () => false });
    expect(r.text).toBe('BAD\n');
    expect(f.runs()).toBeLessThanOrEqual(19); // the photo as given, then at most 18 variants
  });

  it('stays within the total time budget even when the engine hangs on the variants', async () => {
    const counter = join(dir3, 'slow-count');
    writeFileSync(counter, '');
    const slow = join(dir3, 'slow');
    // The first run answers at once; every later run hangs
    writeFileSync(slow, `#!/bin/sh\ncat >/dev/null\necho x >> "${counter}"\nif [ $(wc -l < "${counter}") -le 1 ]; then echo BAD; else sleep 30; fi\n`);
    chmodSync(slow, 0o755);
    const started = Date.now();
    const r = await new TesseractProvider(slow, 'eng', 30_000, 'eng', 4_000).readText(await photo(), { accept: () => false });
    expect(r.text).toBe('BAD\n');
    expect(Date.now() - started).toBeLessThan(8_000); // the budget, not 30 s per attempt
  }, 30_000);

  it('never applies to printed text (licences)', async () => {
    const f = flaky(5);
    await new TesseractProvider(f.bin).readText(await photo(), { mode: 'text', accept: () => false });
    expect(f.runs()).toBe(1);
  });
});
