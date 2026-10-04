import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Time-based one-time passwords (RFC 6238) as used by every authenticator app: HMAC-SHA1, six
 * digits, 30-second steps. Implemented on the platform crypto, no dependency.
 */
export const STEP_SECONDS = 30;
export const DIGITS = 6;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Not valid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, the size authenticator apps expect. */
export const generateSecret = (): Buffer => randomBytes(20);

/** The code for one 30-second step. */
export function codeAt(secret: Buffer, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(counter).digest();
  const offset = h[h.length - 1] & 0xf;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (nowMs: number) => Math.floor(nowMs / 1000 / STEP_SECONDS);

/**
 * Checks a submitted code against the steps just before, at and just after now (clock drift).
 * `lastStep` is the newest step already used: a code for that step or an earlier one is refused,
 * so a code seen once (shoulder-surfing, a proxy) cannot be replayed. Returns the step it matched.
 */
export function verifyCode(secret: Buffer, submitted: string, nowMs: number, lastStep: number | null, window = 1): { ok: true; step: number } | { ok: false } {
  const code = submitted.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const now = stepOf(nowMs);
  let matched: number | null = null;
  // Always compare every candidate, so how long this takes does not reveal which step was close
  for (let step = now - window; step <= now + window; step++) {
    const a = Buffer.from(codeAt(secret, step));
    if (timingSafeEqual(a, Buffer.from(code)) && matched === null) matched = step;
  }
  if (matched === null || (lastStep !== null && matched <= lastStep)) return { ok: false };
  return { ok: true, step: matched };
}

/** The address an authenticator app imports (shown as text, or as a QR code by a client). */
export function otpauthUri(issuer: string, account: string, secret: Buffer): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---- recovery codes ---------------------------------------------------------------------------
// No 0/O/1/I/L: easy to read out and type from a printout
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** `XXXXX-XXXXX`: 10 characters of 31, about 49 bits. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

/** Accepts any case, with or without the dash or spaces. Returns the canonical form, or null. */
export function normalizeRecoveryCode(raw: string): string | null {
  const c = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-HJKMNP-Z2-9]{10}$/.test(c) ? `${c.slice(0, 5)}-${c.slice(5)}` : null;
}
