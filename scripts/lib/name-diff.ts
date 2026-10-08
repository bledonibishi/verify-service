/**
 * Describes how a provided name differs from the name read from the MRZ without showing either:
 * word counts, and for each provided word whether it was found, and if not, how the closest read
 * word differs (length, number of differing letters, whether they are OCR look-alikes).
 */
import { normalizeName } from '../../src/documents/mrz';

/** Letters Tesseract commonly confuses in the MRZ font. */
const LOOKALIKES = ['IL1T', 'O0DQ', 'B8', 'S5', 'Z2', 'G6', 'EF', 'KX', 'MN', 'UV', 'CG'];
const lookalike = (a: string, b: string) => LOOKALIKES.some((g) => g.includes(a) && g.includes(b));

/**
 * With `letters`, also shows each differing pair (position, the letter read, the letter provided):
 * opt-in, for the person whose own card it is, to find which letter the OCR confuses.
 */
export function describeNameDiff(provided: string, read: string, letters = false): string {
  const p = normalizeName(provided).split(' ').filter(Boolean);
  const r = normalizeName(read).split(' ').filter(Boolean);
  if (p.join(' ') === r.join(' ')) return 'same';
  const parts = [`provided ${p.length} word(s), read ${r.length} word(s)`];
  p.forEach((word, i) => {
    const at = r.indexOf(word);
    if (at >= 0) {
      parts.push(`word ${i + 1}: found (read word ${at + 1})`);
      return;
    }
    const same = r.filter((w) => w.length === word.length);
    if (same.length) {
      const diffs = same.map((w) => [...w].map((c, k) => [c, word[k]] as const).filter(([a, b]) => a !== b));
      const best = diffs.reduce((x, y) => (y.length < x.length ? y : x));
      parts.push(`word ${i + 1}: ${best.length} letter(s) differ in a read word of the same length (${best.every(([a, b]) => lookalike(a, b)) ? 'all OCR look-alikes' : 'not all look-alikes'})`);
      if (letters) {
        const w = same[diffs.indexOf(best)];
        const pairs = [...w].map((c, k) => [k, c, word[k]] as const).filter(([, a, b]) => a !== b);
        parts.push(pairs.map(([k, a, b]) => `letter ${k + 1} of ${w.length}: read ${a}, provided ${b}`).join(', '));
      }
      return;
    }
    const lengths = r.map((w) => w.length - word.length);
    parts.push(`word ${i + 1}: no read word of the same length (read words are ${lengths.map((d) => (d > 0 ? `+${d}` : `${d}`)).join(', ')} letters longer/shorter)`);
  });
  return parts.join('; ');
}
