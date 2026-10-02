/**
 * Local MRZ checker for real documents. Paste or pipe the OCR text of a card's back:
 *
 *   pnpm check:mrz < my-card.txt
 *
 * Prints only pass/fail per check and issue codes. It never prints names, numbers or dates,
 * so the output is safe to paste into a chat or issue.
 */
import { readFileSync } from 'fs';
import { extractTd1Lines, parseKosovoTd1 } from '../src/documents/mrz';

const text = readFileSync(0, 'utf8');
const lines = extractTd1Lines(text);

if (!lines) {
  console.log('MRZ: not found (need three lines of 30 characters)');
  process.exit(1);
}

const { result, repaired } = parseKosovoTd1(lines);
console.log(`MRZ found, structure ${result.ok ? 'OK' : 'INVALID'}${repaired ? ' (needed OCR repair)' : ''}`);
for (const c of result.checks) console.log(`  check digit ${c.field}: ${c.ok ? 'pass' : 'FAIL'}`);
for (const i of result.issues) console.log(`  ${i.severity}: ${i.code}`);
if (result.data) {
  console.log(`  document expired: ${result.data.expired ? 'yes' : 'no'}`);
  console.log(`  issuer RKS: ${result.data.issuingState === 'RKS' ? 'yes' : 'no'}`);
}
process.exit(result.ok ? 0 : 1);
