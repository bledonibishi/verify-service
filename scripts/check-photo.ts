/**
 * Local check of a real ID-back photo, end to end as the service reads it:
 *
 *   pnpm check:photo fixtures/private/my-id-back.jpg
 *   pnpm check:photo fixtures/private/my-id-back.jpg --shape   (on failure, also print the OCR shape)
 *   pnpm check:photo fixtures/private/my-id-back.jpg --variants (shape of the MRZ-like lines each variant gives)
 *
 * Needs `tesseract` installed. Nothing leaves this machine. Prints only pass/fail per check
 * and, with --shape, the OCR text with every digit shown as 9 and every letter as A, so the
 * output is safe to paste into a chat or issue. It never prints names, numbers or dates. The one
 * exception: with --variants, the first five characters of line 1 (document type + RKS, the same
 * on every Kosovo card) are shown, to diagnose a misread document type.
 */
import { readFileSync } from 'fs';
import { cleanMrzText, readKosovoMrz } from '../src/documents/mrz';
import { mrzVariants } from '../src/ocr/mrz-image';
import { TesseractProvider } from '../src/ocr/tesseract.provider';

const [path, ...flags] = process.argv.slice(2);
if (!path) {
  console.log('usage: pnpm check:photo <image> [--shape]');
  process.exit(2);
}
const shape = (t: string) => t.replace(/[0-9]/g, '9').replace(/[A-Za-z]/g, 'A');
const readable = (t: string) => readKosovoMrz(t)?.result.ok === true;

async function main() {
  const image = readFileSync(path);
  const engine = new TesseractProvider();
  const asUploaded = await engine.readText(image);
  const direct = readable(asUploaded.text);
  const final = direct ? asUploaded : await engine.readText(image, { accept: readable });
  const read = readKosovoMrz(final.text);
  console.log(`photo as uploaded: ${direct ? 'MRZ read' : 'MRZ not read'}`);
  if (!direct) console.log(`with cleaned-up variants: ${read?.result.ok ? 'MRZ read' : 'MRZ not read'}`);
  if (read) {
    console.log(`structure ${read.result.ok ? 'OK' : 'INVALID'}${read.repaired ? ' (needed OCR repair)' : ''}`);
    for (const c of read.result.checks) console.log(`  check digit ${c.field}: ${c.ok ? 'pass' : 'FAIL'}`);
    for (const i of read.result.issues) console.log(`  ${i.severity}: ${i.code}`);
    if (read.result.data) {
      console.log(`  document expired: ${read.result.data.expired ? 'yes' : 'no'}`);
      console.log(`  issuer RKS: ${read.result.data.issuingState === 'RKS' ? 'yes' : 'no'}`);
    }
  }
  if (flags.includes('--variants')) {
    // For each way of reading the photo: the length and shape of every line that could be an MRZ line
    const describe = (label: string, text: string) => {
      const lines = text.split(/\r?\n/).map(cleanMrzText).filter((l) => l.length >= 20);
      // Only line 1 can show its first five characters: letters, then its 6+ digits, then a run of fillers.
      // Any other line (names, labels, noise) shows its shape only, and at most one line per reading is opened up.
      const line1 = lines.findIndex((l) => /^[A-Z]{5,8}[0-9]{6,9}<{6,}/.test(l));
      console.log(`${label}: ${lines.length ? lines.map((l, i) => `${l.length}:${shape(l)}${i === line1 ? ` [starts ${l.slice(0, 5)}]` : ''}`).join('  |  ') : '(no long lines)'}`);
    };
    describe('as uploaded', asUploaded.text);
    let n = 0;
    for await (const v of mrzVariants(image)) describe(`variant ${n++}`, (await engine.readText(v)).text);
  }
  if (!read?.result.ok && flags.includes('--shape')) console.log('OCR shape (digits=9, letters=A):\n' + shape(final.text));
  process.exit(read?.result.ok ? 0 : 1);
}

main().catch((err) => {
  // Fixed messages only: an engine error can echo recognised text
  console.log(err?.name === 'OcrUnavailableError' ? 'tesseract is not installed' : 'could not read the image');
  process.exit(2);
});
