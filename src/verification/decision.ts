import { FieldMatch, IdentityComparison, LenientResult, compareIdentity, readKosovoMrz } from '../documents/mrz';
import type { ExpectedIdentity, Td1Data } from '../documents/mrz';
import { LicenceOutcome, licenceClean } from '../documents/licence';

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
  /** Null unless the session asked for a driving licence (see LICENCE_* issue codes). */
  licence: LicenceOutcome | null;
  /** True when the session required a licence: auto-approval then needs it clean. */
  licenceRequired: boolean;
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
  /**
   * Providers that are configured but failed (`face_unavailable`, `liveness_unavailable`). A provider
   * that is deliberately switched off is not an outage. Used by metering: our failures are not billed.
   */
  outages?: string[];
}

export type Decision = 'APPROVED' | 'NEEDS_REVIEW';

/** Outcome used when the ID back is absent or the pipeline gave up. */
export function emptyOutcome(issueCode: string): CheckOutcome {
  return { licence: null, licenceRequired: false, face: null, liveness: null, faceSource: null, mrzFound: false, mrzValid: false, ocrRepaired: false, identity: null, expired: null, checks: [], issueCodes: [issueCode] };
}

const MISMATCH_CODE: Record<keyof IdentityComparison, string> = {
  surname: 'SURNAME_MISMATCH',
  givenNames: 'GIVEN_NAMES_MISMATCH',
  birthDate: 'BIRTH_DATE_MISMATCH',
};

/** One letter apart: most likely an OCR misread (names have no check digit), still for a person to confirm. */
const NEAR_MATCH_CODE: Record<keyof IdentityComparison, string> = {
  surname: 'SURNAME_NEAR_MATCH',
  givenNames: 'GIVEN_NAMES_NEAR_MATCH',
  birthDate: 'BIRTH_DATE_MISMATCH', // dates are exact; never produced
};

/** True when the OCR text holds an MRZ whose check digits all pass; used to decide whether to try harder on the image. */
export function mrzReadable(ocrText: string, now = new Date()): boolean {
  return readKosovoMrz(ocrText, { now })?.result.ok === true;
}

/**
 * How the OCR engine judges readings of an ID back. A reading is accepted when its check digits
 * pass, unless a name is one letter away from the one provided: names have no check digit, and
 * that is what one misread letter looks like (an I at the card's edge read as E). Then the engine
 * keeps reading its other versions of the photo, within its time budget, for one that reads the
 * name as provided; that reading must also agree with the first on every check-digit-protected
 * field (the same card). If none does, the first readable reading is kept and a person compares the
 * name. A clear mismatch is accepted at once: reading again would not change it.
 */
export function idBackJudge(expected: ExpectedIdentity, now = new Date()): { accept: (text: string) => boolean; fallback: (text: string) => boolean } {
  let card: string | null = null;
  const protectedFields = (d: Td1Data) => [d.documentNumber, d.birthDate, d.expiryDate, d.personalNumber, d.sex, d.issuingState].join('|');
  return {
    accept: (text) => {
      const read = readKosovoMrz(text, { now });
      if (!read?.result.ok || !read.result.data) return false;
      const fields = protectedFields(read.result.data);
      if (card === null) card = fields;
      else if (fields !== card) return false;
      const identity = compareIdentity(read.result.data, expected);
      return identity.surname !== 'near_match' && identity.givenNames !== 'near_match';
    },
    fallback: (text) => mrzReadable(text, now),
  };
}

/** Turns OCR text from the ID back into check results. */
export function checkIdBack(ocrText: string, expected: ExpectedIdentity, now = new Date()): CheckOutcome {
  return readIdBack(ocrText, expected, now).outcome;
}

/**
 * Like `checkIdBack`, but also hands back the parsed MRZ values for in-memory use (the licence
 * cross-check). The values are never stored or returned to tenants; only the outcome is.
 */
export function readIdBack(ocrText: string, expected: ExpectedIdentity, now = new Date()): { outcome: CheckOutcome; data: Td1Data | null } {
  const lenient: LenientResult | null = readKosovoMrz(ocrText, { now });
  if (!lenient) return { outcome: emptyOutcome('MRZ_NOT_FOUND'), data: null };
  const { result } = lenient;
  const issueCodes: string[] = result.issues.map((i) => i.code);
  const checks = result.checks.map((c) => ({ field: c.field, ok: c.ok }));

  if (!result.ok || !result.data) {
    return {
      outcome: { licence: null, licenceRequired: false, face: null, liveness: null, faceSource: null, mrzFound: true, mrzValid: false, ocrRepaired: false, identity: null, expired: null, checks, issueCodes: dedupe(issueCodes) },
      data: null,
    };
  }

  const identity = compareIdentity(result.data, expected);
  for (const key of Object.keys(identity) as (keyof IdentityComparison)[]) {
    if (identity[key] === 'mismatch') issueCodes.push(MISMATCH_CODE[key]);
    if (identity[key] === 'near_match') issueCodes.push(NEAR_MATCH_CODE[key]);
    if (identity[key] === 'not_provided') issueCodes.push('EXPECTED_IDENTITY_MISSING');
  }
  if (result.data.expired) issueCodes.push('DOCUMENT_EXPIRED');

  return {
    data: result.data,
    outcome: {
    licence: null,
    licenceRequired: false,
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
    },
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

/**
 * Adds the driving licence result. `unavailable` is for the licence image or OCR engine being
 * absent (nothing could be read), reported separately from a licence that was read badly.
 */
export function withLicence(outcome: CheckOutcome, licence: LicenceOutcome | null, missingCode?: string): CheckOutcome {
  const codes = licence ? licence.issueCodes : [missingCode ?? 'LICENCE_NOT_READABLE'];
  return { ...outcome, licence, licenceRequired: true, issueCodes: dedupe([...outcome.issueCodes, ...codes]) };
}

const dedupe = (codes: string[]) => [...new Set(codes)];

const isMatch = (m: FieldMatch | undefined) => m === 'match';

/**
 * Auto-approval needs a face match and a passed liveness check as well as the document checks,
 * and a clean driving licence when the session required one.
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
    (!outcome.licenceRequired || (outcome.licence !== null && licenceClean(outcome.licence))) &&
    outcome.checks.length > 0 &&
    outcome.checks.every((c) => c.ok) &&
    isMatch(outcome.identity?.surname) &&
    isMatch(outcome.identity?.givenNames) &&
    isMatch(outcome.identity?.birthDate);
  return autoApprove && clean ? 'APPROVED' : 'NEEDS_REVIEW';
}
