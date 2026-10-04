import { Td1Data, normalizeName } from '../mrz';
import { LicenceField, LicenceFields, REQUIRED_FIELDS, parseLicenceFields } from './parse';

export type Match = 'match' | 'mismatch' | 'unavailable';

/** What the licence check learned. Flags and field numbers only: no printed value leaves this module. */
export interface LicenceOutcome {
  /** Every required field was read. */
  found: boolean;
  fields: LicenceField[];
  expired: boolean | null;
  /** Issue before expiry, a plausible validity, and a holder old enough on the issue date. */
  datesValid: boolean | null;
  repaired: boolean;
  personalNumber: Match;
  surname: Match;
  givenNames: Match;
  birthDate: Match;
  issueCodes: string[];
}

const YEAR_MS = 365.25 * 86_400_000;
const addYears = (iso: string, years: number) => new Date(Date.parse(iso) + years * YEAR_MS);

/** Dates that cannot belong to a real licence, whatever the holder. */
function datesPlausible(f: LicenceFields, now: Date): boolean | null {
  if (!f.issueDate || !f.expiryDate) return null;
  const issue = Date.parse(f.issueDate);
  const expiry = Date.parse(f.expiryDate);
  if (issue > now.getTime() + 86_400_000) return false; // issued in the future
  if (expiry <= issue) return false;
  const years = (expiry - issue) / YEAR_MS;
  if (years < 0.5 || years > 15.5) return false; // licences in the samples were valid for 10 years
  if (f.birthDate && Date.parse(f.birthDate) > addYears(f.issueDate, -15).getTime()) return false; // holder under 15 at issue
  return true;
}

function matchGiven(licence: string, mrz: string): boolean {
  const a = normalizeName(licence).split(' ');
  const b = normalizeName(mrz).split(' ');
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((token, i) => token === long[i]);
}

/**
 * Reads a licence and cross-checks it against the ID card's MRZ (personal number, name, date of
 * birth). With no readable ID (`id` null) nothing can be compared, which is reported, never
 * assumed to match. A clean result needs everything read, every date plausible, no OCR repairs
 * and all four cross-checks matching.
 */
export function checkLicence(ocrText: string, id: Td1Data | null, now = new Date()): LicenceOutcome {
  const { fields, found, repaired } = parseLicenceFields(ocrText);
  const issueCodes: string[] = [];
  const complete = REQUIRED_FIELDS.every((f) => found.includes(f));
  if (found.length === 0) issueCodes.push('LICENCE_NOT_READABLE');
  else if (!complete) issueCodes.push('LICENCE_FIELDS_INCOMPLETE');
  if (repaired) issueCodes.push('LICENCE_OCR_REPAIRED');

  const expired = fields.expiryDate ? Date.parse(fields.expiryDate) < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) : null;
  if (expired) issueCodes.push('LICENCE_EXPIRED');
  const datesValid = datesPlausible(fields, now);
  if (datesValid === false) issueCodes.push('LICENCE_DATES_IMPLAUSIBLE');

  const compare = (have: string | undefined, ok: (idValue: Td1Data) => boolean): Match => (!id || !have ? 'unavailable' : ok(id) ? 'match' : 'mismatch');
  const personalNumber = compare(fields.personalNumber, (d) => d.personalNumber === fields.personalNumber);
  const surname = compare(fields.surname, (d) => normalizeName(d.surname) === fields.surname);
  const givenNames = compare(fields.givenNames, (d) => matchGiven(fields.givenNames!, d.givenNames));
  const birthDate = compare(fields.birthDate, (d) => d.birthDate === fields.birthDate);

  if (!id) issueCodes.push('LICENCE_CROSSCHECK_UNAVAILABLE');
  else {
    if (personalNumber === 'mismatch') issueCodes.push('LICENCE_PERSONAL_NUMBER_MISMATCH');
    if (surname === 'mismatch') issueCodes.push('LICENCE_SURNAME_MISMATCH');
    if (givenNames === 'mismatch') issueCodes.push('LICENCE_GIVEN_NAMES_MISMATCH');
    if (birthDate === 'mismatch') issueCodes.push('LICENCE_BIRTH_DATE_MISMATCH');
  }

  return { found: complete, fields: found, expired, datesValid, repaired, personalNumber, surname, givenNames, birthDate, issueCodes };
}

/** A licence is clean only when nothing at all was flagged. */
export function licenceClean(l: LicenceOutcome): boolean {
  return (
    l.found &&
    l.issueCodes.length === 0 &&
    l.expired === false &&
    l.datesValid === true &&
    !l.repaired &&
    l.personalNumber === 'match' &&
    l.surname === 'match' &&
    l.givenNames === 'match' &&
    l.birthDate === 'match'
  );
}
