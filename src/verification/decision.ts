import { FieldMatch, IdentityComparison, LenientResult, compareIdentity, extractTd1Lines, parseKosovoTd1 } from '../documents/mrz';
import type { ExpectedIdentity } from '../documents/mrz';

/** Pass/fail outcome of reading and checking the ID back. Holds no values read from the card. */
export interface CheckOutcome {
  mrzFound: boolean;
  mrzValid: boolean;
  ocrRepaired: boolean;
  identity: IdentityComparison | null;
  expired: boolean | null;
  checks: { field: string; ok: boolean }[];
  issueCodes: string[];
}

export type Decision = 'APPROVED' | 'NEEDS_REVIEW';

/** Outcome used when the ID back is absent or the pipeline gave up. */
export function emptyOutcome(issueCode: string): CheckOutcome {
  return { mrzFound: false, mrzValid: false, ocrRepaired: false, identity: null, expired: null, checks: [], issueCodes: [issueCode] };
}

const MISMATCH_CODE: Record<keyof IdentityComparison, string> = {
  surname: 'SURNAME_MISMATCH',
  givenNames: 'GIVEN_NAMES_MISMATCH',
  birthDate: 'BIRTH_DATE_MISMATCH',
};

/** Turns OCR text from the ID back into check results. */
export function checkIdBack(ocrText: string, expected: ExpectedIdentity, now = new Date()): CheckOutcome {
  const lines = extractTd1Lines(ocrText);
  if (!lines) return emptyOutcome('MRZ_NOT_FOUND');

  const lenient: LenientResult = parseKosovoTd1(lines, { now });
  const { result } = lenient;
  const issueCodes: string[] = result.issues.map((i) => i.code);
  const checks = result.checks.map((c) => ({ field: c.field, ok: c.ok }));

  if (!result.ok || !result.data) {
    return { mrzFound: true, mrzValid: false, ocrRepaired: false, identity: null, expired: null, checks, issueCodes: dedupe(issueCodes) };
  }

  const identity = compareIdentity(result.data, expected);
  for (const key of Object.keys(identity) as (keyof IdentityComparison)[]) {
    if (identity[key] === 'mismatch') issueCodes.push(MISMATCH_CODE[key]);
    if (identity[key] === 'not_provided') issueCodes.push('EXPECTED_IDENTITY_MISSING');
  }
  if (result.data.expired) issueCodes.push('DOCUMENT_EXPIRED');

  return {
    mrzFound: true,
    mrzValid: true,
    ocrRepaired: lenient.repaired,
    identity,
    expired: result.data.expired,
    checks,
    issueCodes: dedupe(issueCodes),
  };
}

const dedupe = (codes: string[]) => [...new Set(codes)];

const isMatch = (m: FieldMatch | undefined) => m === 'match';

/**
 * Conservative by design: the only automatic outcome is approval, and only when the tenant opted
 * in and every check passed with no issue of any severity (an OCR repair counts as an issue).
 * Nothing is ever rejected automatically; everything else goes to a human.
 */
export function decide(outcome: CheckOutcome, autoApprove: boolean): Decision {
  const clean =
    outcome.mrzFound &&
    outcome.mrzValid &&
    outcome.issueCodes.length === 0 &&
    outcome.expired === false &&
    outcome.checks.length > 0 &&
    outcome.checks.every((c) => c.ok) &&
    isMatch(outcome.identity?.surname) &&
    isMatch(outcome.identity?.givenNames) &&
    isMatch(outcome.identity?.birthDate);
  return autoApprove && clean ? 'APPROVED' : 'NEEDS_REVIEW';
}
