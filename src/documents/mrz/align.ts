/**
 * Fixing OCR lines of the wrong length. Tesseract is good at the characters of an MRZ but poor at
 * counting: a run of `<` fillers comes back too long or too short, and stray marks become extra
 * characters, so a line that should be 30 characters is 27 or 32 and cannot be parsed at all.
 *
 * Each OCR line is aligned against the known layout of its line (which positions are digits,
 * letters or filler) by the cheapest set of edits: drop an extra character, put back a missing
 * filler, accept a look-alike. The result is only a candidate. It is accepted by the caller only
 * if every check digit then passes, so this can make a damaged read parseable but can never turn a
 * wrong card into a right one.
 */

type Slot =
  | { kind: 'lit'; ch: string }
  | { kind: 'digit' | 'alpha' | 'alnum' | 'fill' | 'alphafill' };

const rep = (n: number, s: Slot): Slot[] => Array.from({ length: n }, () => s);

/** Kosovo TD1, by position. See td1.ts and docs/kosovo-documents.md. */
const LINE1: Slot[] = [
  { kind: 'lit', ch: 'I' }, { kind: 'alphafill' },
  { kind: 'lit', ch: 'R' }, { kind: 'lit', ch: 'K' }, { kind: 'lit', ch: 'S' },
  ...rep(9, { kind: 'alnum' }), // document number
  { kind: 'digit' }, // its check digit
  ...rep(15, { kind: 'fill' }), // optional data, empty on Kosovo cards
];
const LINE2: Slot[] = [
  ...rep(7, { kind: 'digit' }), // birth date + check digit
  { kind: 'alphafill' }, // sex
  ...rep(7, { kind: 'digit' }), // expiry + check digit
  { kind: 'lit', ch: 'R' }, { kind: 'lit', ch: 'K' }, { kind: 'lit', ch: 'S' },
  ...rep(10, { kind: 'digit' }), // personal number
  { kind: 'fill' },
  { kind: 'digit' }, // composite check digit
];
const LINE3: Slot[] = rep(30, { kind: 'alphafill' });

export const TEMPLATES = [LINE1, LINE2, LINE3];

const TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8' };
const TO_ALPHA: Record<string, string> = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B' };
const FILL_LOOKALIKE = new Set(['K', 'C', 'L', 'E', 'S', 'I', 'X', 'R']);

/** How badly a character fits a position. 0 fits, small is a look-alike, large is wrong. */
function fit(c: string, slot: Slot): number {
  const isDigit = /\d/.test(c);
  const isAlpha = /[A-Z]/.test(c);
  switch (slot.kind) {
    case 'lit':
      return c === slot.ch ? 0 : TO_DIGIT[slot.ch] === c || TO_ALPHA[c] === slot.ch || (slot.ch === 'I' && /[1L]/.test(c)) ? 0.4 : 1.6;
    case 'digit':
      return isDigit ? 0 : TO_DIGIT[c] ? 0.4 : 1.6;
    case 'alpha':
      return isAlpha ? 0 : TO_ALPHA[c] ? 0.4 : 1.6;
    case 'alnum':
      return isDigit || isAlpha ? 0 : 1.0;
    case 'fill':
      return c === '<' ? 0 : FILL_LOOKALIKE.has(c) ? 0.4 : 1.2;
    case 'alphafill':
      return isAlpha || c === '<' ? 0 : TO_ALPHA[c] ? 0.4 : 1.6;
  }
}

/**
 * Only fillers are ever put back or taken out. Inventing a missing digit, or choosing which of
 * two digits is the extra one, would be a guess that the check digits then confirm one time in
 * ten by chance; leaving such a line unrepaired makes it fail instead. Runs of `<` are what OCR
 * miscounts, so that is all the repair touches (a stray letter in a filler run is handled as a
 * look-alike substitution, which gives the same text).
 */
const NOT_ALLOWED = Infinity;
const missingCost = (slot: Slot) => (slot.kind === 'fill' || slot.kind === 'alphafill' ? 0.2 : NOT_ALLOWED);
const extraCost = (c: string) => (c === '<' ? 0.5 : NOT_ALLOWED);

export interface Alignment {
  line: string;
  /** 0 means it already fitted perfectly; each edit adds to it. */
  cost: number;
  /** Characters dropped, added or swapped. */
  edits: number;
}

/** Aligns one OCR line to a template of the same length as a valid line (30 slots). */
export function alignLine(raw: string, template: Slot[]): Alignment {
  const n = raw.length;
  const m = template.length;
  const INF = 1e9;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  const move: ('d' | 'x' | 'm')[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill('d'));
  dp[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (dp[i][j] >= INF) continue;
      // Tiny position-dependent terms make ties resolve toward the end of the line, where lost
      // or extra fillers almost always are, instead of in the middle of the data
      if (i < n && j < m) {
        const c = dp[i][j] + fit(raw[i], template[j]);
        if (c < dp[i + 1][j + 1]) [dp[i + 1][j + 1], move[i + 1][j + 1]] = [c, 'd'];
      }
      if (i < n) {
        const c = dp[i][j] + extraCost(raw[i]) + 0.001 * (n - i);
        if (c < dp[i + 1][j]) [dp[i + 1][j], move[i + 1][j]] = [c, 'x'];
      }
      if (j < m) {
        const c = dp[i][j] + missingCost(template[j]) + 0.001 * (m - j);
        if (c < dp[i][j + 1]) [dp[i][j + 1], move[i][j + 1]] = [c, 'm'];
      }
    }
  }
  if (dp[n][m] >= INF) {
    // No repair is allowed to produce a valid shape: report an impossible cost so callers skip it
    return { line: raw.slice(0, m).padEnd(m, '<'), cost: Infinity, edits: n };
  }
  let i = n;
  let j = m;
  const out: string[] = [];
  let edits = 0;
  while (i > 0 || j > 0) {
    const mv = move[i][j];
    if (mv === 'd') {
      if (fit(raw[i - 1], template[j - 1]) > 0) edits++;
      out.push(raw[i - 1]);
      i--;
      j--;
    } else if (mv === 'x') {
      edits++;
      i--;
    } else {
      edits++;
      out.push('<');
      j--;
    }
  }
  return { line: out.reverse().join(''), cost: Math.round(dp[n][m] * 1000) / 1000, edits };
}

/** Keeps only the characters an MRZ can contain; marks and spaces OCR invents are dropped. */
export function cleanMrzText(line: string): string {
  return line
    .toUpperCase()
    .replace(/[«‹〈＜]/g, '<')
    .replace(/[^A-Z0-9<]/g, '');
}

export interface ApproximateTd1 {
  lines: string[];
  /** Sum of the three alignment costs; lower is a closer fit. */
  cost: number;
}

const MAX_LINE_COST = 3;
const MAX_TOTAL_COST = 5;
const MIN_LEN = 20;
const MAX_LEN = 42;

/** How many lines after a candidate's first line may be skipped over, and how many candidates are kept. */
const MAX_SPAN = 6;
const MAX_CANDIDATES = 20;

/**
 * Every way of choosing three lines of the OCR text that fit the Kosovo TD1 layout once their
 * lengths are repaired, closest fit first. Lines in between are skipped (field labels, specks,
 * however long), within a window of a few lines. More than one is returned because the closest
 * fit is not always the right one: the caller decides by the check digits, and a damaged triple
 * must not hide a valid one further down.
 */
export function approximateTd1Candidates(ocrText: string): ApproximateTd1[] {
  const lines = ocrText.split(/\r?\n/).map(cleanMrzText).filter((l) => l.length >= MIN_LEN && l.length <= MAX_LEN);
  const aligned = new Map<string, Alignment>(); // line index + template, aligned once
  const align = (i: number, k: number) => {
    const key = `${i}:${k}`;
    let a = aligned.get(key);
    if (!a) aligned.set(key, (a = alignLine(lines[i], TEMPLATES[k])));
    return a;
  };
  const found: ApproximateTd1[] = [];
  for (let i = 0; i < lines.length; i++) {
    const first = align(i, 0);
    if (first.cost > MAX_LINE_COST) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + MAX_SPAN); j++) {
      const second = align(j, 1);
      if (second.cost > MAX_LINE_COST || first.cost + second.cost > MAX_TOTAL_COST) continue;
      for (let k = j + 1; k < Math.min(lines.length, i + MAX_SPAN); k++) {
        const third = align(k, 2);
        const cost = first.cost + second.cost + third.cost;
        if (third.cost > MAX_LINE_COST || cost > MAX_TOTAL_COST) continue;
        found.push({ lines: [first.line, second.line, third.line], cost });
      }
    }
  }
  return found.sort((a, b) => a.cost - b.cost).slice(0, MAX_CANDIDATES);
}

/** The closest-fitting candidate, or null. See `approximateTd1Candidates`. */
export function extractApproximateTd1(ocrText: string): ApproximateTd1 | null {
  return approximateTd1Candidates(ocrText)[0] ?? null;
}
