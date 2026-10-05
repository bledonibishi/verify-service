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

/** Licence dates are printed in local (Kosovo, CET) calendar days, so "today" is the local day. */
const localToday = (now: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(now);

/** ISO date plus whole calendar years/months (29 February moves to 1 March in a common year). */
function addCalendar(iso: string, years: number, months = 0): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y + years, m - 1 + months, d)).toISOString().slice(0, 10);
}

/** Dates that cannot belong to a real licence, whatever the holder. ISO dates compare as strings. */
function datesPlausible(f: LicenceFields, today: string): boolean | null {
  if (!f.issueDate || !f.expiryDate) return null;
  if (f.issueDate > today) return false; // issued in the future, not even by a day
  if (f.expiryDate <= f.issueDate) return false;
  if (f.expiryDate < addCalendar(f.issueDate, 0, 6)) return false; // under six months
  if (f.expiryDate > addCalendar(f.issueDate, 15)) return false; // over 15 years (the samples show ten)
  if (f.birthDate && addCalendar(f.birthDate, 15) > f.issueDate) return false; // holder under 15 on the issue date
  return true;
}

/** The licence's given names must be the leading part of the ID's: it may omit later names, never add any. */
function matchGiven(licence: string, mrz: string): boolean {
  const l = normalizeName(licence).split(' ');
  const m = normalizeName(mrz).split(' ');
  return l.length <= m.length && l.every((token, i) => token === m[i]);
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

  const today = localToday(now);
  const expired = fields.expiryDate ? fields.expiryDate < today : null;
  if (expired) issueCodes.push('LICENCE_EXPIRED');
  const datesValid = datesPlausible(fields, today);
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
