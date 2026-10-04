import { createHmac, timingSafeEqual } from 'crypto';
import { WebhookSignatureError } from './errors';
import type { WebhookEvent } from './types';

export interface VerifyOptions {
  /** The raw request body exactly as received: do not parse and re-serialise it first. */
  payload: string | Buffer;
  /** The `X-Verify-Signature` header (webhooks) or `X-Evidence-Signature` header (evidence export). */
  signatureHeader: string | undefined;
  /** The webhook secret printed when the tenant was created. */
  secret: string;
  /** How old a signature may be, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** For tests. */
  now?: Date;
}

/**
 * Checks `t=<unix>,v1=<hmac>` where hmac = HMAC-SHA256(secret, "<t>.<body>"). Throws
 * `WebhookSignatureError` unless the signature matches and is recent. Several `v1=` values are
 * accepted so a secret can be rotated.
 */
export function verifySignature(opts: VerifyOptions): void {
  const header = opts.signatureHeader;
  const parts = (header ?? '').split(',').map((p) => p.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const candidates = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3)).filter((c) => c.length > 0);
  if (!header || !t || !/^\d{1,12}$/.test(t) || candidates.length === 0) {
    throw new WebhookSignatureError('malformed_header', 'Signature header is missing or malformed');
  }

  const tolerance = opts.toleranceSeconds ?? 300;
  const age = Math.floor((opts.now ?? new Date()).getTime() / 1000) - Number(t);
  if (Math.abs(age) > tolerance) {
    throw new WebhookSignatureError('timestamp_outside_tolerance', 'Signature timestamp is too old (or too far in the future)');
  }

  const body = typeof opts.payload === 'string' ? opts.payload : opts.payload.toString('utf8');
  const expected = Buffer.from(createHmac('sha256', opts.secret).update(`${t}.${body}`).digest('hex'));
  const ok = candidates.some((c) => {
    const got = Buffer.from(c);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new WebhookSignatureError('no_matching_signature', 'Signature does not match');
}

/** Verifies the signature, then parses the body. Use this in your webhook endpoint. */
export function constructWebhookEvent(opts: VerifyOptions): WebhookEvent {
  verifySignature(opts);
  return JSON.parse(typeof opts.payload === 'string' ? opts.payload : opts.payload.toString('utf8')) as WebhookEvent;
}
