/** What the tenant sees about a human decision. */
export const reviewSummary = (s: { status: string; reviewReason: string | null; reviewedAt: Date | null }) =>
  s.reviewedAt ? { decision: s.status, reason: s.reviewReason, decidedAt: s.reviewedAt.toISOString() } : null;
