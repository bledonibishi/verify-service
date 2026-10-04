import { createHmac } from 'crypto';
import { WebhookSignatureError, constructWebhookEvent, verifySignature } from '../src';

const secret = 'whsec_test_secret';
const now = new Date('2026-10-04T12:00:00Z');
const t = Math.floor(now.getTime() / 1000);
const body = JSON.stringify({ eventId: 'e1', type: 'session.status_changed', sessionId: 's1', externalRef: 'u1', status: 'APPROVED', occurredAt: '2026-10-04T11:59:59Z' });
const sign = (b = body, at = t, key = secret) => `t=${at},v1=${createHmac('sha256', key).update(`${at}.${b}`).digest('hex')}`;
const check = (over: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
  verifySignature({ payload: body, signatureHeader: sign(), secret, now, ...over });
const reasonOf = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return (e as WebhookSignatureError).reason;
  }
  return 'no error';
};

describe('verifySignature', () => {
  it('accepts a correct, recent signature (string or Buffer body)', () => {
    expect(() => check()).not.toThrow();
    expect(() => check({ payload: Buffer.from(body) })).not.toThrow();
  });

  it('rejects a tampered body, even by one character', () => {
    expect(reasonOf(() => check({ payload: body.replace('APPROVED', 'REJECTED') }))).toBe('no_matching_signature');
    expect(reasonOf(() => check({ payload: body + ' ' }))).toBe('no_matching_signature');
    // Re-serialised JSON is a different body: callers must verify the raw bytes
    expect(reasonOf(() => check({ payload: JSON.stringify(JSON.parse(body), null, 2) }))).toBe('no_matching_signature');
  });

  it('rejects the wrong secret and a signature made for another timestamp', () => {
    expect(reasonOf(() => check({ secret: 'whsec_other' }))).toBe('no_matching_signature');
    const sig = sign();
    expect(reasonOf(() => check({ signatureHeader: sig.replace(`t=${t}`, `t=${t + 1}`) }))).toBe('no_matching_signature');
  });

  it('rejects old and far-future timestamps, honouring the tolerance', () => {
    expect(reasonOf(() => check({ signatureHeader: sign(body, t - 301) }))).toBe('timestamp_outside_tolerance');
    expect(reasonOf(() => check({ signatureHeader: sign(body, t + 301) }))).toBe('timestamp_outside_tolerance');
    expect(() => check({ signatureHeader: sign(body, t - 299) })).not.toThrow();
    expect(() => check({ signatureHeader: sign(body, t - 3000), toleranceSeconds: 4000 })).not.toThrow();
    expect(reasonOf(() => check({ signatureHeader: sign(body, t - 11), toleranceSeconds: 10 }))).toBe('timestamp_outside_tolerance');
  });

  it.each([undefined, '', 'garbage', 't=abc,v1=ff', `t=${t}`, `v1=abcd`, `t=${t},v1=`, 't=,v1=aa', `t=${'9'.repeat(20)},v1=aa`])('rejects the malformed header %j', (header) => {
    expect(reasonOf(() => check({ signatureHeader: header }))).toBe('malformed_header');
  });

  it('accepts any one of several v1 signatures, so a secret can be rotated', () => {
    const good = sign().split('v1=')[1];
    expect(() => check({ signatureHeader: `t=${t},v1=${'0'.repeat(64)},v1=${good}` })).not.toThrow();
    expect(reasonOf(() => check({ signatureHeader: `t=${t},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}` }))).toBe('no_matching_signature');
  });

  it('tolerates whitespace in the header and rejects signatures of the wrong length without throwing oddly', () => {
    expect(() => check({ signatureHeader: sign().replace(',', ', ') })).not.toThrow();
    expect(reasonOf(() => check({ signatureHeader: `t=${t},v1=abc` }))).toBe('no_matching_signature');
  });

  it('never puts the secret or the expected signature in its error', () => {
    try {
      check({ secret: 'whsec_other' });
    } catch (e) {
      const text = JSON.stringify(e) + (e as Error).message;
      expect(text).not.toContain('whsec_');
      expect(text).not.toContain(sign().split('v1=')[1]);
    }
  });
});

describe('constructWebhookEvent', () => {
  it('returns the parsed event only after the signature verifies', () => {
    const event = constructWebhookEvent({ payload: body, signatureHeader: sign(), secret, now });
    expect(event).toMatchObject({ eventId: 'e1', status: 'APPROVED', sessionId: 's1' });
    expect(() => constructWebhookEvent({ payload: body, signatureHeader: sign(body, t, 'x'), secret, now })).toThrow(WebhookSignatureError);
  });

  it('checks the signature before parsing, so unsigned garbage is a signature error, not a JSON error', () => {
    expect(() => constructWebhookEvent({ payload: '{not json', signatureHeader: undefined, secret, now })).toThrow(WebhookSignatureError);
  });
});
