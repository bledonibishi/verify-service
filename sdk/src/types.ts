export type DocumentKind = 'ID_FRONT' | 'ID_BACK' | 'SELFIE' | 'LICENCE_FRONT' | 'LICENCE_BACK';

export type SessionStatus = 'PENDING' | 'PROCESSING' | 'APPROVED' | 'REJECTED' | 'NEEDS_REVIEW' | 'EXPIRED';

export type Match = 'match' | 'mismatch' | 'not_provided' | 'unavailable';

export interface CreateSessionInput {
  /** Your own identifier for the person being verified. */
  externalRef: string;
  /** What you expect the document to say; compared with the ID. */
  firstName?: string;
  lastName?: string;
  /** `YYYY-MM-DD` */
  birthDate?: string;
  /** Also read and cross-check a driving licence. */
  requireDrivingLicence?: boolean;
}

export interface CreatedSession {
  id: string;
  /** Send this to your user. The token is shown once and cannot be recovered. */
  uploadToken: string;
  /** Base of the upload API for this session. */
  uploadUrl: string;
  /** The hosted capture page. Open it in the user's browser or webview. */
  hostedUrl: string;
  expiresAt: string;
  status: SessionStatus;
  requireDrivingLicence: boolean;
}

/** Flags and codes only: no value read from a document is ever included. */
export interface VerificationSummary {
  decision: string;
  autoDecided: boolean;
  mrz: { found: boolean; valid: boolean; repaired: boolean };
  identity: { surname: Match | null; givenNames: Match | null; birthDate: Match | null };
  expired: boolean | null;
  face: { status: string | null; similarity: number | null; provider: string | null; source: string | null };
  liveness: { status: string | null; confidence: number | null; provider: string | null };
  licence: {
    found: boolean;
    fields: string[];
    expired: boolean | null;
    datesValid: boolean | null;
    repaired: boolean | null;
    crossCheck: { personalNumber: Match | null; surname: Match | null; givenNames: Match | null; birthDate: Match | null };
  } | null;
  checks: { field: string; ok: boolean }[];
  /** Issue codes explaining anything that needs a human, such as `FACE_BELOW_THRESHOLD`. */
  issues: string[];
}

export interface ReviewDecision {
  decision: 'APPROVED' | 'REJECTED';
  reason: string | null;
  decidedAt: string;
}

export interface Session {
  id: string;
  externalRef: string;
  status: SessionStatus;
  expiresAt: string;
  requireDrivingLicence: boolean;
  uploaded: DocumentKind[];
  documentsDeletedAt: string | null;
  verification: VerificationSummary | null;
  review: ReviewDecision | null;
  createdAt: string;
  updatedAt: string;
}

/** The body of a webhook (`session.status_changed`). Dedupe on `eventId`: delivery is at-least-once. */
export interface WebhookEvent {
  eventId: string;
  type: 'session.status_changed';
  sessionId: string;
  externalRef: string;
  status: SessionStatus;
  occurredAt: string;
  verification?: VerificationSummary;
  review?: ReviewDecision | null;
}

export interface WebhookEventRecord {
  id: string;
  sessionId: string;
  type: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  /** A fixed code such as `http_500`, `timeout` or `network`; never the receiver's response. */
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface EvidenceBundle {
  version: number;
  generatedAt: string;
  session: { id: string; externalRef: string; status: SessionStatus; createdAt: string; decidedAt: string | null; expiresAt: string };
  expectedIdentity: { firstName: string | null; lastName: string | null; birthDate: string | null };
  verification: VerificationSummary | null;
  review: (ReviewDecision & { reviewer: string | null }) | null;
  documents: { kind: DocumentKind; contentType: string; sizeBytes: number; sha256: string | null }[];
  documentsDeletedAt: string | null;
  auditLog: { event: string; detail: unknown; at: string }[];
}

/** What the capture page needs to know about one session, from the upload token alone. */
export interface UploadSessionInfo {
  status: SessionStatus;
  expiresAt: string;
  requireDrivingLicence: boolean;
  /** In the order to ask for them. */
  steps: { kind: DocumentKind; required: boolean }[];
  uploaded: DocumentKind[];
  /** Whether a liveness provider is configured. */
  liveness: boolean;
}

export interface UsageSummary {
  /** UTC calendar month, `YYYY-MM`. */
  month: string;
  from: string;
  to: string;
  verifications: {
    /** Completed verifications that are billed. */
    billable: number;
    /** Completed verifications that are not billed (our own failures). */
    nonBillable: number;
    nonBillableByReason: Record<string, number>;
    /** Corrections: negative numbers are credits. */
    adjustments: number;
    /** billable + adjustments */
    net: number;
  };
  /** Of the billable verifications, how many used each add-on. */
  features: { face: number; liveness: number; licence: number; autoDecided: number };
  cap: {
    /** Null: no cap. */
    limit: number | null;
    softLimitPercent: number;
    /** Billable this month plus sessions in flight; null for past months. */
    committed: number | null;
    remaining: number | null;
  };
}

export interface UsageEventRecord {
  id: string;
  kind: 'verification' | 'adjustment';
  /** One you already hold; null for adjustments. */
  sessionId: string | null;
  occurredAt: string;
  quantity: number;
  billable: boolean;
  nonBillableReason: string | null;
  face: boolean;
  liveness: boolean;
  licence: boolean;
  autoDecided: boolean;
  note: string | null;
}
