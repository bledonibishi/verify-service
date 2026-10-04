/** The service answered with an error status. */
export class VerifyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'VerifyApiError';
  }
  get isNotFound() {
    return this.status === 404;
  }
  /** Rate limited: wait and try again. */
  get isRateLimited() {
    return this.status === 429;
  }
}

/** The request never got an answer (network failure or timeout). */
export class VerifyNetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'VerifyNetworkError';
  }
}

export type SignatureFailure = 'malformed_header' | 'timestamp_outside_tolerance' | 'no_matching_signature';

/** A webhook or evidence signature did not verify. Treat the payload as untrusted. */
export class WebhookSignatureError extends Error {
  constructor(readonly reason: SignatureFailure, message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

/** Reads the message out of the service's error body, which is `{ message: string | string[] }`. */
export function messageOf(body: unknown, fallback: string): string {
  const m = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(m)) return m.join('; ');
  return typeof m === 'string' ? m : fallback;
}
