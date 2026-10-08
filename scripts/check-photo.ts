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
import { checkImage } from './lib/check-image';

const [path, ...flags] = process.argv.slice(2);
if (!path) {
  console.log('usage: pnpm check:photo <image> [--shape] [--variants]');
  process.exit(2);
}

checkImage(readFileSync(path), flags).then(
  (code) => process.exit(code),
  (err) => {
    // Fixed messages only: an engine error can echo recognised text
    console.log(err?.name === 'OcrUnavailableError' ? 'tesseract is not installed' : 'could not read the image');
    process.exit(2);
  },
);
