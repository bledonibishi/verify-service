import { VerificationResult } from '@prisma/client';

/** What tenants see in the API and webhooks. Flags and codes only. */
export interface VerificationSummary {
  decision: string;
  autoDecided: boolean;
  mrz: { found: boolean; valid: boolean; repaired: boolean };
  identity: { surname: string | null; givenNames: string | null; birthDate: string | null };
  expired: boolean | null;
  face: { status: string | null; similarity: number | null; provider: string | null; source: string | null };
  liveness: { status: string | null; confidence: number | null; provider: string | null };
  /** Present only for sessions that asked for a driving licence. Flags and field numbers, never values. */
  licence: {
    found: boolean;
    fields: string[];
    expired: boolean | null;
    datesValid: boolean | null;
    repaired: boolean | null;
    crossCheck: { personalNumber: string | null; surname: string | null; givenNames: string | null; birthDate: string | null };
  } | null;
  checks: unknown;
  issues: string[];
}

export function toSummary(r: VerificationResult): VerificationSummary {
  return {
    decision: r.decision,
    autoDecided: r.autoDecided,
    mrz: { found: r.mrzFound, valid: r.mrzValid, repaired: r.ocrRepaired },
    identity: { surname: r.surnameMatch, givenNames: r.givenNamesMatch, birthDate: r.birthDateMatch },
    expired: r.expired,
    face: { status: r.faceStatus, similarity: r.faceSimilarity, provider: r.faceProvider, source: r.faceSource },
    liveness: { status: r.livenessStatus, confidence: r.livenessConfidence, provider: r.livenessProvider },
    licence:
      r.licenceFound === null
        ? null
        : {
            found: r.licenceFound,
            fields: r.licenceFields,
            expired: r.licenceExpired,
            datesValid: r.licenceDatesValid,
            repaired: r.licenceRepaired,
            crossCheck: {
              personalNumber: r.licencePersonalNumberMatch,
              surname: r.licenceSurnameMatch,
              givenNames: r.licenceGivenNamesMatch,
              birthDate: r.licenceBirthDateMatch,
            },
          },
    checks: r.checks,
    issues: r.issueCodes,
  };
}
