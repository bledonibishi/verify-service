import { FieldMatch, IdentityComparison, LenientResult, compareIdentity, extractTd1Lines, parseKosovoTd1 } from '../documents/mrz';
import type { ExpectedIdentity } from '../documents/mrz';

/** Pass/fail outcome of reading and checking the ID back. Holds no values read from the card. */
export interface FaceOutcome {
  status: 'match' | 'below_threshold' | 'no_face' | 'unusable_image';
  similarity: number | null;
}

export interface CheckOutcome {
  /** Null when the face check did not run (see the FACE_* issue codes). */
  face: FaceOutcome | null;
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
  return { face: null, mrzFound: false, mrzValid: false, ocrRepaired: false, identity: null, expired: null, checks: [], issueCodes: [issueCode] };
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
    return { face: null, mrzFound: true, mrzValid: false, ocrRepaired: false, identity: null, expired: null, checks, issueCodes: dedupe(issueCodes) };
  }

  const identity = compareIdentity(result.data, expected);
  for (const key of Object.keys(identity) as (keyof IdentityComparison)[]) {
    if (identity[key] === 'mismatch') issueCodes.push(MISMATCH_CODE[key]);
    if (identity[key] === 'not_provided') issueCodes.push('EXPECTED_IDENTITY_MISSING');
  }
  if (result.data.expired) issueCodes.push('DOCUMENT_EXPIRED');

  return {
    face: null,
    mrzFound: true,
    mrzValid: true,
    ocrRepaired: lenient.repaired,
    identity,
    expired: result.data.expired,
    checks,
    issueCodes: dedupe(issueCodes),
  };
}

const FACE_CODE = { below_threshold: 'FACE_BELOW_THRESHOLD', no_face: 'FACE_NOT_DETECTED', unusable_image: 'FACE_IMAGE_UNUSABLE' } as const;

/** Turns a raw similarity into a pass/fail against the tenant's threshold. */
export function faceOutcome(r: { similarity: number } | { status: 'no_face' | 'unusable_image' }, threshold: number): FaceOutcome {
  if ('similarity' in r) return { status: r.similarity >= threshold ? 'match' : 'below_threshold', similarity: r.similarity };
  return { status: r.status, similarity: null };
}

/** Adds the face result (or, with null, a FACE_UNAVAILABLE issue) to the document outcome. */
export function withFace(outcome: CheckOutcome, face: FaceOutcome | null): CheckOutcome {
  const code = face === null ? 'FACE_UNAVAILABLE' : face.status === 'match' ? null : FACE_CODE[face.status];
  return { ...outcome, face, issueCodes: code ? dedupe([...outcome.issueCodes, code]) : outcome.issueCodes };
}

const dedupe = (codes: string[]) => [...new Set(codes)];

const isMatch = (m: FieldMatch | undefined) => m === 'match';

/**
 * Auto-approval needs the face match as well as the document checks.
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
    outcome.face?.status === 'match' &&
    outcome.checks.length > 0 &&
    outcome.checks.every((c) => c.ok) &&
    isMatch(outcome.identity?.surname) &&
    isMatch(outcome.identity?.givenNames) &&
    isMatch(outcome.identity?.birthDate);
  return autoApprove && clean ? 'APPROVED' : 'NEEDS_REVIEW';
}
