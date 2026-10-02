import { Td1Data } from './td1';

export type FieldMatch = 'match' | 'mismatch' | 'not_provided';

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

/** The supplied first name(s) must be the leading given name(s) on the card, in order. */
function matchGiven(expected: string, mrzGiven: string): boolean {
  const exp = normalizeName(expected).split(' ');
  const mrz = normalizeName(mrzGiven).split(' ');
  return exp.length <= mrz.length && exp.every((token, i) => token === mrz[i]);
}

export function compareIdentity(data: Td1Data, expected: ExpectedIdentity): IdentityComparison {
  // Text that normalises to nothing (e.g. "!!!") was provided, but can never match a name.
  const field = (provided: string | undefined, ok: (normalized: string) => boolean): FieldMatch => {
    if (!provided?.trim()) return 'not_provided';
    const normalized = normalizeName(provided);
    return normalized !== '' && ok(normalized) ? 'match' : 'mismatch';
  };

  return {
    surname: field(expected.lastName, (n) => n === normalizeName(data.surname)),
    givenNames: field(expected.firstName, () => matchGiven(expected.firstName!, data.givenNames)),
    birthDate: !expected.birthDate ? 'not_provided' : expected.birthDate === data.birthDate ? 'match' : 'mismatch',
  };
}
