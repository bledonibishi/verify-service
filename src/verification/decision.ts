import { FieldMatch, IdentityComparison, LenientResult, compareIdentity, extractTd1Lines, parseKosovoTd1 } from '../documents/mrz';
import type { ExpectedIdentity } from '../documents/mrz';

/** Selfie-to-ID comparison against the tenant's threshold. */
export interface FaceOutcome {
  status: 'match' | 'below_threshold' | 'no_face' | 'multiple_faces' | 'unusable_image';
  similarity: number | null;
}

/** Liveness result against the tenant's minimum confidence. */
export interface LivenessOutcome {
  status: 'live' | 'not_live' | 'incomplete';
  confidence: number | null;
}

/** Pass/fail outcome of reading and checking the documents. Holds no values read from the card. */
export interface CheckOutcome {
  /** Null when the face check did not run (see the FACE_* issue codes). */
  face: FaceOutcome | null;
  /** Null when no liveness check ran (see the LIVENESS_* issue codes). */
  liveness: LivenessOutcome | null;
  /** Which image the face comparison used. */
  faceSource: 'liveness' | 'selfie' | null;
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
  return { face: null, liveness: null, faceSource: null, mrzFound: false, mrzValid: false, ocrRepaired: false, identity: null, expired: null, checks: [], issueCodes: [issueCode] };
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
    return { face: null, liveness: null, faceSource: null, mrzFound: true, mrzValid: false, ocrRepaired: false, identity: null, expired: null, checks, issueCodes: dedupe(issueCodes) };
  }

  const identity = compareIdentity(result.data, expected);
  for (const key of Object.keys(identity) as (keyof IdentityComparison)[]) {
    if (identity[key] === 'mismatch') issueCodes.push(MISMATCH_CODE[key]);
    if (identity[key] === 'not_provided') issueCodes.push('EXPECTED_IDENTITY_MISSING');
  }
  if (result.data.expired) issueCodes.push('DOCUMENT_EXPIRED');

  return {
    face: null,
    liveness: null,
    faceSource: null,
    mrzFound: true,
    mrzValid: true,
    ocrRepaired: lenient.repaired,
    identity,
    expired: result.data.expired,
    checks,
    issueCodes: dedupe(issueCodes),
  };
}

const FACE_CODE = { below_threshold: 'FACE_BELOW_THRESHOLD', no_face: 'FACE_NOT_DETECTED', multiple_faces: 'FACE_MULTIPLE_FACES', unusable_image: 'FACE_IMAGE_UNUSABLE' } as const;

/** Turns a raw similarity into a pass/fail against the tenant's threshold. */
export function faceOutcome(r: { similarity: number } | { status: 'no_face' | 'multiple_faces' | 'unusable_image' }, threshold: number): FaceOutcome {
  if ('similarity' in r) return { status: r.similarity >= threshold ? 'match' : 'below_threshold', similarity: r.similarity };
  return { status: r.status, similarity: null };
}

/**
 * Adds the face result to the document outcome. With no result, `missing` names documents that
 * were absent (reported as such); otherwise the provider was unavailable (FACE_UNAVAILABLE).
 */
export function withFace(outcome: CheckOutcome, face: FaceOutcome | null, missing: string[] = []): CheckOutcome {
  const codes = face === null ? (missing.length ? missing : ['FACE_UNAVAILABLE']) : face.status === 'match' ? [] : [FACE_CODE[face.status]];
  return { ...outcome, face, issueCodes: dedupe([...outcome.issueCodes, ...codes]) };
}

const LIVENESS_CODE = { not_live: 'LIVENESS_FAILED', incomplete: 'LIVENESS_INCOMPLETE' } as const;

/** Applies the tenant's minimum confidence: a "live" verdict below it counts as not live. */
export function livenessOutcome(r: { status: 'live' | 'not_live' | 'incomplete'; confidence: number | null }, minConfidence: number): LivenessOutcome {
  const live = r.status === 'live' && r.confidence !== null && r.confidence >= minConfidence;
  return { status: live ? 'live' : r.status === 'live' ? 'not_live' : r.status, confidence: r.confidence };
}

/**
 * Adds the liveness result. With no result, `performed: false` means the user never started a
 * challenge (LIVENESS_NOT_PERFORMED); otherwise the provider was unavailable (LIVENESS_UNAVAILABLE).
 */
export function withLiveness(outcome: CheckOutcome, liveness: LivenessOutcome | null, performed = true): CheckOutcome {
  const codes =
    liveness === null ? [performed ? 'LIVENESS_UNAVAILABLE' : 'LIVENESS_NOT_PERFORMED'] : liveness.status === 'live' ? [] : [LIVENESS_CODE[liveness.status]];
  return { ...outcome, liveness, issueCodes: dedupe([...outcome.issueCodes, ...codes]) };
}

/**
 * A face match only proves anything about the live person if the compared image came from the
 * liveness challenge. A "live" verdict paired with a match against the separately uploaded
 * selfie (someone else's photo, say) must not be approvable.
 */
export function bindFaceToLiveness(outcome: CheckOutcome): CheckOutcome {
  if (outcome.liveness?.status !== 'live' || outcome.face === null || outcome.faceSource === 'liveness') return outcome;
  return { ...outcome, issueCodes: dedupe([...outcome.issueCodes, 'FACE_NOT_BOUND_TO_LIVENESS']) };
}

const dedupe = (codes: string[]) => [...new Set(codes)];

const isMatch = (m: FieldMatch | undefined) => m === 'match';

/**
 * Auto-approval needs a face match and a passed liveness check as well as the document checks.
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
    outcome.liveness?.status === 'live' &&
    outcome.faceSource === 'liveness' &&
    outcome.checks.length > 0 &&
    outcome.checks.every((c) => c.ok) &&
    isMatch(outcome.identity?.surname) &&
    isMatch(outcome.identity?.givenNames) &&
    isMatch(outcome.identity?.birthDate);
  return autoApprove && clean ? 'APPROVED' : 'NEEDS_REVIEW';
}
