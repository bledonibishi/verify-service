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

function matchGiven(expected: string, mrzGiven: string): boolean {
  const exp = normalizeName(expected);
  const mrz = normalizeName(mrzGiven);
  if (exp === mrz) return true;
  const mrzTokens = mrz.split(' ');
  // The caller may supply only the first of several given names.
  return exp.split(' ').every((t) => mrzTokens.includes(t));
}

export function compareIdentity(data: Td1Data, expected: ExpectedIdentity): IdentityComparison {
  const field = (provided: string | undefined, ok: () => boolean): FieldMatch =>
    !provided ? 'not_provided' : ok() ? 'match' : 'mismatch';

  return {
    surname: field(expected.lastName, () => normalizeName(expected.lastName!) === normalizeName(data.surname)),
    givenNames: field(expected.firstName, () => matchGiven(expected.firstName!, data.givenNames)),
    birthDate: field(expected.birthDate, () => expected.birthDate === data.birthDate),
  };
}
