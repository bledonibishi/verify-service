import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
  });

  it('kills a hung engine after the timeout', async () => {
    const bin = script('hang', 'sleep 30');
    await expect(new TesseractProvider(bin, 'eng', 200).readText(Buffer.from('x'))).rejects.toThrow('timed out');
  });
});
