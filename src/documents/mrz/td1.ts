import { checkDigit } from './check-digit';

/**
 * Parser/validator for ICAO 9303 TD1 machine-readable zones (three lines of 30 characters),
 * the format used on the Kosovo identity card.
 *
 * Kosovo specifics: issuer and nationality are `RKS`, which is not an ISO 3166 code, so generic
 * MRZ libraries that validate country codes reject it. The 10-digit personal number sits in the
 * second optional-data field (line 2, positions 19-29).
 */

export type MrzCheckField = 'documentNumber' | 'birthDate' | 'expiryDate' | 'composite';

export interface MrzCheck {
  field: MrzCheckField;
  expected: string;
  actual: string;
  ok: boolean;
}

export type MrzIssueCode =
  | 'WRONG_LENGTH'
  | 'INVALID_CHARACTERS'
  | 'CHECK_DIGIT_MISMATCH'
  | 'INVALID_BIRTH_DATE'
  | 'INVALID_EXPIRY_DATE'
  | 'INVALID_SEX'
  | 'UNEXPECTED_DOCUMENT_TYPE'
  | 'UNEXPECTED_ISSUER'
  | 'UNEXPECTED_NATIONALITY'
  | 'DOCUMENT_NUMBER_FORMAT'
  | 'PERSONAL_NUMBER_FORMAT'
  | 'OPTIONAL_DATA_PRESENT'
  | 'INVALID_NAME'
  | 'GIVEN_NAMES_MISSING'
  | 'OCR_REPAIRED';

export interface MrzIssue {
  code: MrzIssueCode;
  /** `error` issues make the MRZ invalid; `warning` issues deviate from the Kosovo profile. */
  severity: 'error' | 'warning';
  message: string;
}

export interface Td1Data {
  documentType: string;
  issuingState: string;
  documentNumber: string;
  /** ISO date YYYY-MM-DD */
  birthDate: string;
  sex: 'M' | 'F' | 'X';
  /** ISO date YYYY-MM-DD */
  expiryDate: string;
  nationality: string;
  personalNumber: string;
  surname: string;
  givenNames: string;
  expired: boolean;
}

export interface Td1Result {
  /** True when the structure is well formed and every check digit matches. */
  ok: boolean;
  data: Td1Data | null;
  checks: MrzCheck[];
  issues: MrzIssue[];
}

export interface ParseOptions {
  /** Injectable clock for tests. */
  now?: Date;
}

const stripFiller = (s: string) => s.replace(/<+$/, '');

/**
 * Two-digit years carry no century, so pick the one that makes sense for the field: a birth date is
 * never in the future (latest matching year up to now), and an expiry date is the matching year
 * within 50 years of now. Without this, an expiry of 991231 would read as 2099 and look valid.
 */
function parseDate(yymmdd: string, kind: 'birth' | 'expiry', now: Date): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  const nowYear = now.getUTCFullYear();
  let year = Math.floor(nowYear / 100) * 100 + yy;
  if (kind === 'birth') {
    if (year > nowYear) year -= 100;
  } else if (year - nowYear > 50) {
    year -= 100;
  } else if (nowYear - year > 50) {
    year += 100;
  }
  const d = new Date(Date.UTC(year, mm - 1, dd));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function failure(issues: MrzIssue[], checks: MrzCheck[] = []): Td1Result {
  return { ok: false, data: null, checks, issues };
}

export function parseTd1(lines: string[], opts: ParseOptions = {}): Td1Result {
  const now = opts.now ?? new Date();
  const issues: MrzIssue[] = [];

  if (lines.length !== 3 || lines.some((l) => l.length !== 30)) {
    return failure([
      { code: 'WRONG_LENGTH', severity: 'error', message: 'TD1 needs exactly 3 lines of 30 characters' },
    ]);
  }
  if (!lines.every((l) => /^[A-Z0-9<]{30}$/.test(l))) {
    return failure([
      { code: 'INVALID_CHARACTERS', severity: 'error', message: 'MRZ may only contain A-Z, 0-9 and <' },
    ]);
  }

  const [l1, l2, l3] = lines;
  const documentType = stripFiller(l1.slice(0, 2));
  const issuingState = l1.slice(2, 5);
  const documentNumber = stripFiller(l1.slice(5, 14));
  const birthRaw = l2.slice(0, 6);
  const expiryRaw = l2.slice(8, 14);
  const nationality = l2.slice(15, 18);
  const personalNumber = stripFiller(l2.slice(18, 29));

  const checks: MrzCheck[] = ([
    { field: 'documentNumber', actual: l1[14], expected: checkDigit(l1.slice(5, 14)) },
    { field: 'birthDate', actual: l2[6], expected: checkDigit(birthRaw) },
    { field: 'expiryDate', actual: l2[14], expected: checkDigit(expiryRaw) },
    {
      field: 'composite',
      actual: l2[29],
      expected: checkDigit(l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29)),
    },
  ] as Omit<MrzCheck, 'ok'>[]).map((c) => ({ ...c, ok: c.actual === c.expected }));

  for (const c of checks.filter((c) => !c.ok)) {
    issues.push({
      code: 'CHECK_DIGIT_MISMATCH',
      severity: 'error',
      message: `Check digit for ${c.field} does not match`,
    });
  }

  const birthDate = parseDate(birthRaw, 'birth', now);
  const expiryDate = parseDate(expiryRaw, 'expiry', now);
  const today = now.toISOString().slice(0, 10);
  if (!birthDate) issues.push({ code: 'INVALID_BIRTH_DATE', severity: 'error', message: 'Birth date is not a real date' });
  else if (birthDate > today) issues.push({ code: 'INVALID_BIRTH_DATE', severity: 'error', message: 'Birth date is in the future' });
  if (!expiryDate) issues.push({ code: 'INVALID_EXPIRY_DATE', severity: 'error', message: 'Expiry date is not a real date' });

  const sexChar = l2[7];
  if (!['M', 'F', '<'].includes(sexChar)) {
    issues.push({ code: 'INVALID_SEX', severity: 'error', message: 'Sex must be M, F or <' });
  }

  // Kosovo profile: deviations are warnings so other issuers can be added later.
  if (!documentType.startsWith('I')) {
    issues.push({ code: 'UNEXPECTED_DOCUMENT_TYPE', severity: 'warning', message: 'Not an identity card (I*) document type' });
  }
  if (issuingState !== 'RKS') {
    issues.push({ code: 'UNEXPECTED_ISSUER', severity: 'warning', message: 'Issuing state is not RKS' });
  }
  if (nationality !== 'RKS') {
    issues.push({ code: 'UNEXPECTED_NATIONALITY', severity: 'warning', message: 'Nationality is not RKS' });
  }
  if (!/^[A-Z]{2}\d{7}$/.test(documentNumber)) {
    issues.push({ code: 'DOCUMENT_NUMBER_FORMAT', severity: 'warning', message: 'Document number differs from the observed 2 letters + 7 digits' });
  }
  if (!/^\d{10}$/.test(personalNumber)) {
    issues.push({ code: 'PERSONAL_NUMBER_FORMAT', severity: 'warning', message: 'Personal number is not 10 digits' });
  }

  // Repeated filler-like characters can slip past the composite check digit (15 identical
  // characters always weigh in at a multiple of 5), so the empty field is checked directly.
  if (!/^<{15}$/.test(l1.slice(15, 30))) {
    issues.push({ code: 'OPTIONAL_DATA_PRESENT', severity: 'warning', message: 'Optional data 1 is expected to be empty on Kosovo cards' });
  }

  const [surnamePart, ...rest] = stripFiller(l3).split('<<');
  const surname = surnamePart.replace(/</g, ' ').trim();
  const givenNames = rest.join(' ').replace(/</g, ' ').trim();

  if (/\d/.test(l3)) {
    issues.push({ code: 'INVALID_NAME', severity: 'error', message: 'Name line contains digits' });
  } else if (!surname) {
    issues.push({ code: 'INVALID_NAME', severity: 'error', message: 'Surname is missing' });
  } else if (!givenNames) {
    issues.push({ code: 'GIVEN_NAMES_MISSING', severity: 'warning', message: 'Given names are missing' });
  }

  const hasError = issues.some((i) => i.severity === 'error');
  const data: Td1Data | null =
    birthDate && expiryDate
      ? {
          documentType,
          issuingState,
          documentNumber,
          birthDate,
          sex: sexChar === 'M' ? 'M' : sexChar === 'F' ? 'F' : 'X',
          expiryDate,
          nationality,
          personalNumber,
          surname,
          givenNames,
          expired: expiryDate < today,
        }
      : null;

  return { ok: !hasError && data !== null, data, checks, issues };
}
