import { approximateTd1Candidates } from './align';
import { ParseOptions, Td1Result, parseTd1 } from './td1';

/**
 * OCR tidy-up for MRZ text. The MRZ uses a fixed font and a tiny alphabet, so most OCR errors are
 * look-alike swaps (O/0, I/1, ...). Repairs are only accepted when every check digit then
 * passes, so a repair can never turn a bad document into a good one by itself.
 */

const TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8' };
const TO_ALPHA: Record<string, string> = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B' };
type CharClass = 'alpha' | 'digit' | 'any';

// Kosovo TD1 layout by position (see td1.ts). Line 2 positions 18-27 are the 10-digit personal number.
const LINE1: CharClass[] = [
  ...Array(5).fill('alpha'), // type + issuer
  'alpha',
  'alpha',
  ...Array(7).fill('digit'), // document number: observed as 2 letters + 7 digits
  'digit', // check digit
  ...Array(15).fill('any'), // optional data (empty on Kosovo cards)
];
const LINE2: CharClass[] = [
  ...Array(6).fill('digit'), // birth date
  'digit',
  'alpha', // sex
  ...Array(6).fill('digit'), // expiry
  'digit',
  ...Array(3).fill('alpha'), // nationality
  ...Array(10).fill('digit'), // personal number
  'any', // filler
  'digit', // composite check digit
];

function normalizeChars(line: string): string {
  return line
    .toUpperCase()
    .replace(/[«‹〈＜]/g, '<')
    .replace(/\s+/g, '');
}

function applyClasses(line: string, classes: CharClass[]): string {
  return [...line]
    .map((c, i) => {
      if (classes[i] === 'digit') return TO_DIGIT[c] ?? c;
      if (classes[i] === 'alpha') return TO_ALPHA[c] ?? c;
      return c;
    })
    .join('');
}

/** Line 3 holds only letters and `<`; fix digits, and trailing filler misread as letters. */
function repairNameLine(line: string): string {
  const letters = [...line].map((c) => TO_ALPHA[c] ?? c).join('');
  // OCR usually misreads the filler as one repeated letter (KKKK, CCCC, ...). No real name has
  // the same letter four times in a row, so only that pattern is rewritten; a name ending in
  // K, C, L, E or S followed by real filler is left alone. Mixed runs are not guessed at.
  return letters.replace(/([KCLES])\1{3,}$/, (run) => '<'.repeat(run.length));
}

export function repairKosovoTd1(lines: string[]): string[] {
  if (lines.length !== 3 || lines.some((l) => l.length !== 30)) return lines;
  const line1 = applyClasses(lines[0], LINE1);
  // Kosovo cards leave optional data 1 empty. Only blank it when it is made of filler or the
  // letters OCR mistakes for filler; real content (digits, other letters) stays, so tampering with
  // that field is reported and not quietly erased.
  const optional = line1.slice(15);
  return [
    line1.slice(0, 15) + (/^[<KCLES]+$/.test(optional) ? '<'.repeat(15) : optional),
    applyClasses(lines[1], LINE2),
    repairNameLine(lines[2]),
  ];
}

/** Finds a TD1 triple in raw OCR output, tolerating spaces, case and merged lines. */
export function extractTd1Lines(ocrText: string): string[] | null {
  const lines = ocrText.split(/\r?\n/).map(normalizeChars).filter((l) => l.length > 0);
  for (let i = 0; i + 2 < lines.length; i++) {
    const triple = lines.slice(i, i + 3);
    if (triple.every((l) => l.length === 30) && triple[0].startsWith('I')) return triple;
  }
  // Some OCR engines return the zone as one unbroken string.
  const joined = lines.join('');
  const m = joined.match(/I[A-Z<][A-Z]{3}[A-Z0-9<]{85}/);
  if (m) return [m[0].slice(0, 30), m[0].slice(30, 60), m[0].slice(60, 90)];
  return null;
}

export interface LenientResult {
  result: Td1Result;
  lines: string[];
  /** True when OCR repairs were needed for the check digits to pass. */
  repaired: boolean;
}

/**
 * Parses as-is first, then retries with OCR repairs. A repair is only accepted when every check
 * digit passes. Clean input is returned untouched; input that parses but carries stray characters
 * in the field Kosovo cards leave empty (which the check digits cannot catch) is cleaned up.
 */
export function parseKosovoTd1(lines: string[], opts: ParseOptions = {}): LenientResult {
  const clean = lines.map(normalizeChars);
  const direct = parseTd1(clean, opts);
  const tidy = direct.ok && !direct.issues.some((i) => i.code === 'OPTIONAL_DATA_PRESENT');
  if (tidy) return { result: direct, lines: clean, repaired: false };

  const fixed = repairKosovoTd1(clean);
  // Nothing to repair: report what we have instead of claiming a correction that didn't happen.
  if (fixed.every((l, i) => l === clean[i])) return { result: direct, lines: clean, repaired: false };
  const retry = parseTd1(fixed, opts);
  if (retry.ok) {
    retry.issues.push({ code: 'OCR_REPAIRED', severity: 'warning', message: 'MRZ characters were corrected after OCR' });
    return { result: retry, lines: fixed, repaired: true };
  }

  return { result: direct, lines: clean, repaired: false };
}

/**
 * Reads the MRZ out of raw OCR text. A clean read is parsed as it is. Otherwise lines of the wrong
 * length (OCR miscounts runs of `<`) are aligned to the card's layout, and the result is accepted
 * only if every check digit passes; then it is reported as repaired, like any other OCR correction,
 * so a person still looks at it before anything is approved automatically.
 */
export function readKosovoMrz(ocrText: string, opts: ParseOptions = {}): LenientResult | null {
  const exact = extractTd1Lines(ocrText);
  const first = exact ? parseKosovoTd1(exact, opts) : null;
  if (first?.result.ok) return first;

  // Closest fit first, but the check digits decide: a damaged triple must not hide a valid one
  let fallback: LenientResult | null = null;
  for (const approx of approximateTd1Candidates(ocrText)) {
    const r = parseKosovoTd1(approx.lines, opts);
    // A `<` weighs the same as a `0` in a check digit, so a lost trailing zero would pass them.
    // A repaired read must therefore also have the exact shape of a Kosovo card's fields.
    const shapeOk = !r.result.issues.some((i) => i.code === 'PERSONAL_NUMBER_FORMAT' || i.code === 'DOCUMENT_NUMBER_FORMAT' || i.code === 'OPTIONAL_DATA_PRESENT');
    if (r.result.ok && shapeOk) {
      if (!r.result.issues.some((i) => i.code === 'OCR_REPAIRED')) {
        r.result.issues.push({ code: 'OCR_REPAIRED', severity: 'warning', message: 'MRZ line lengths or characters were corrected after OCR' });
      }
      return { ...r, repaired: true };
    }
    fallback ??= r;
  }
  // Nothing passed: report the exact reader's result, else the closest candidate's, rather than pretend
  return first ?? fallback;
}
