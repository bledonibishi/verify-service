import { Td1Data } from './td1';

/**
 * `near_match`: a name equal to the card's except for one letter in one word of four letters or
 * more, which is what a single OCR misread looks like (names have no check digit). Never counts as a
 * match for automatic approval; a person decides.
 */
export type FieldMatch = 'match' | 'near_match' | 'mismatch' | 'not_provided';

export interface ExpectedIdentity {
  firstName?: string;
  lastName?: string;
  /** ISO date YYYY-MM-DD */
  birthDate?: string;
}

export interface IdentityComparison {
  surname: FieldMatch;
  givenNames: FieldMatch;
  birthDate: FieldMatch;
}

/**
 * Normalises a name the way the MRZ does: Albanian ë/ç become E/C (ICAO transliteration),
 * everything is upper case, and hyphens, apostrophes and repeated spaces collapse to one space.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words of at least this length may differ by one letter for a near match; a short name could too easily be another. */
const NEAR_MIN_LENGTH = 4;

/** Two words of the same length that differ in exactly one letter. */
function oneLetterApart(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < NEAR_MIN_LENGTH) return false;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diffs > 1) return false;
  return diffs === 1;
}

/** Compares word by word: equal, or equal but for one letter in one word (a near match). */
function compareWords(provided: string[], card: string[]): 'match' | 'near_match' | 'mismatch' {
  if (provided.length !== card.length) return 'mismatch';
  const differing = provided.map((w, i) => [w, card[i]] as const).filter(([a, b]) => a !== b);
  if (differing.length === 0) return 'match';
  return differing.length === 1 && oneLetterApart(differing[0][0], differing[0][1]) ? 'near_match' : 'mismatch';
}

/** The supplied first name(s) must be the leading given name(s) on the card, in order. */
function matchGiven(expected: string, mrzGiven: string): 'match' | 'near_match' | 'mismatch' {
  const exp = normalizeName(expected).split(' ');
  const mrz = normalizeName(mrzGiven).split(' ');
  return exp.length <= mrz.length ? compareWords(exp, mrz.slice(0, exp.length)) : 'mismatch';
}

export function compareIdentity(data: Td1Data, expected: ExpectedIdentity): IdentityComparison {
  // Text that normalises to nothing (e.g. "!!!") was provided, but can never match a name.
  const field = (provided: string | undefined, compare: (normalized: string) => 'match' | 'near_match' | 'mismatch'): FieldMatch => {
    if (!provided?.trim()) return 'not_provided';
    const normalized = normalizeName(provided);
    return normalized !== '' ? compare(normalized) : 'mismatch';
  };

  return {
    surname: field(expected.lastName, (n) => compareWords(n.split(' '), normalizeName(data.surname).split(' '))),
    givenNames: field(expected.firstName, () => matchGiven(expected.firstName!, data.givenNames)),
    birthDate: !expected.birthDate ? 'not_provided' : expected.birthDate === data.birthDate ? 'match' : 'mismatch',
  };
}
