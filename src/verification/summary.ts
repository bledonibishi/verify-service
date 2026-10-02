import { VerificationResult } from '@prisma/client';

/** What tenants see in the API and webhooks. Flags and codes only. */
export interface VerificationSummary {
  decision: string;
  autoDecided: boolean;
  mrz: { found: boolean; valid: boolean; repaired: boolean };
  identity: { surname: string | null; givenNames: string | null; birthDate: string | null };
  expired: boolean | null;
  face: { status: string | null; similarity: number | null; provider: string | null };
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
    face: { status: r.faceStatus, similarity: r.faceSimilarity, provider: r.faceProvider },
    checks: r.checks,
    issues: r.issueCodes,
  };
}
