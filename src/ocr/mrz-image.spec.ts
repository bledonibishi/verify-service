import { spawnSync } from 'child_process';
import sharp from 'sharp';
import { buildTd1, SAMPLE } from '../documents/mrz/testing';
import { mrzVariants } from './mrz-image';

export async function renderCard(opts: { grey?: number; pattern?: boolean; photo?: boolean; stripe?: number; blur?: number } = {}): Promise<Buffer> {
  const lines = buildTd1(SAMPLE);
  const w = 1000;
  const h = 700;
  const ink = opts.grey ?? 90;
  const pattern = opts.pattern
    ? Array.from({ length: 40 }, (_, i) => `<line x1="0" y1="${i * 18}" x2="${w}" y2="${i * 18 + 60}" stroke="rgb(${opts.stripe ?? 175},${opts.stripe ?? 175},${(opts.stripe ?? 175) + 10})" stroke-width="3"/>`).join('')
    : '';
  const text = lines
    .map((l, i) => `<text x="40" y="${h - 190 + i * 62}" font-family="Courier New, DejaVu Sans Mono, Menlo, monospace" font-size="43" textLength="${w - 80}" lengthAdjust="spacing" fill="rgb(${ink},${ink},${ink})" xml:space="preserve">${l.replace(/</g, '&lt;')}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="rgb(222,222,226)"/>${pattern}${text}</svg>`;
  const img = sharp(Buffer.from(svg)).png();
  return opts.photo ? sharp(await img.toBuffer()).blur(opts.blur ?? 0.8).jpeg({ quality: 70 }).toBuffer() : img.toBuffer();
}

describe('mrzVariants', () => {
  it('cuts a whole photo down to its bottom and cleans it, one variant at a time', async () => {
    const photo = await renderCard();
    const seen: { w: number; h: number }[] = [];
    for await (const v of mrzVariants(photo)) {
      const m = await sharp(v).metadata();
      expect(m.format).toBe('png');
      seen.push({ w: m.width!, h: m.height! });
    }
    expect(seen.length).toBe(18); // 6 bands x 3 treatments
    // the first variants are the shortest (bottom 35%), the last is the whole photo
    expect(seen[0].h).toBeLessThan(seen[seen.length - 1].h);
  });

  it('does not cut an already tight crop of the MRZ', async () => {
    const crop = await sharp({ create: { width: 973, height: 158, channels: 3, background: '#ddd' } }).png().toBuffer();
    const all: Buffer[] = [];
    for await (const v of mrzVariants(crop)) all.push(v);
    expect(all.length).toBe(3);
  });

  it('is lazy: asking for one variant does the work for one', async () => {
    const it = mrzVariants(await renderCard());
    const first = await it.next();
    expect(first.done).toBe(false);
    await it.return(undefined);
  });

  it('yields nothing for data that is not an image, and never throws', async () => {
    for (const bad of [Buffer.alloc(0), Buffer.from('not an image'), Buffer.from([0xff, 0xd8, 0xff, 0x00])]) {
      const out: Buffer[] = [];
      for await (const v of mrzVariants(bad)) out.push(v);
      expect(out).toEqual([]);
    }
  });

  it('keeps the enlarged crop within the pixel budget for a tall, narrow upload', async () => {
    // 100 x 6000 is only 0.6 MP, but enlarging it to 2200 wide would make 290 MP
    const narrow = await sharp({ create: { width: 100, height: 6000, channels: 3, background: '#cccccc' } }).png().toBuffer();
    let count = 0;
    for await (const v of mrzVariants(narrow)) {
      const m = await sharp(v).metadata();
      expect(m.width! * m.height!).toBeLessThanOrEqual(30_000_000);
      count++;
    }
    expect(count).toBeGreaterThan(0);
  }, 60_000);

  it('refuses an enormous image instead of allocating it', async () => {
    const huge = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 9 }).toBuffer();
    const out: Buffer[] = [];
    for await (const v of mrzVariants(huge)) out.push(v);
    expect(out).toEqual([]);
  });
});

const haveTesseract = spawnSync('tesseract', ['--version']).status === 0;
(haveTesseract ? describe : describe.skip)('reading a synthetic low-contrast card with the real engine', () => {
  // Only fictional data from testing.ts is rendered; skipped where tesseract is not installed
  it('reads a card photographed small in the middle of a large photo', async () => {
    const { TesseractProvider } = await import('./tesseract.provider');
    const { mrzReadable } = await import('../verification/decision');
    const card = await sharp(await renderCard({})).resize({ width: 520 }).toBuffer();
    const photo = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: '#2a2a2e' } }).composite([{ input: card, top: 560, left: 340 }]).jpeg().toBuffer();
    const engine = new TesseractProvider();
    const { text } = await engine.readText(photo, { accept: (t) => mrzReadable(t) });
    expect(mrzReadable(text)).toBe(true);
  }, 120_000);

  it.each([90, 270, 180] as const)('reads a card photographed turned %i degrees', async (degrees) => {
    const { TesseractProvider } = await import('./tesseract.provider');
    const { mrzReadable } = await import('../verification/decision');
    const photo = await sharp(await renderCard({ photo: true })).rotate(degrees).jpeg().toBuffer();
    const engine = new TesseractProvider();
    expect(mrzReadable((await engine.readText(photo)).text)).toBe(false);
    const { text } = await engine.readText(photo, { accept: (t) => mrzReadable(t) });
    expect(mrzReadable(text)).toBe(true);
  }, 120_000);

  it('reads a grey, blurred photo that the unmodified image does not give', async () => {
    const { TesseractProvider } = await import('./tesseract.provider');
    const { mrzReadable } = await import('../verification/decision');
    const photo = await renderCard({ grey: 150, photo: true, blur: 2.5 });
    const engine = new TesseractProvider();
    // Without the cleaned-up variants this photo is not readable...
    expect(mrzReadable((await engine.readText(photo)).text)).toBe(false);
    // ...and with them it is
    const { text } = await engine.readText(photo, { accept: (t) => mrzReadable(t) });
    expect(mrzReadable(text)).toBe(true);
  }, 120_000);
});
