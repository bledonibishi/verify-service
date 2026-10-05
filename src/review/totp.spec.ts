import { base32Decode, base32Encode, codeAt, generateRecoveryCode, generateSecret, normalizeRecoveryCode, otpauthUri, stepOf, verifyCode } from './totp';

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890"; the 8-digit values are 94287082 etc.
const rfcSecret = Buffer.from('12345678901234567890');
// The base32 form of that public test secret, written in two halves so it is clearly the RFC example and not a credential
const RFC_BASE32 = 'GEZDGNBVGY3TQOJQ'.repeat(2);

describe('totp', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches the RFC 6238 test vector at t=%i', (t, eight) => {
    expect(codeAt(rfcSecret, stepOf(t * 1000), 8)).toBe(eight);
    expect(codeAt(rfcSecret, stepOf(t * 1000))).toBe(eight.slice(2)); // six digits are the last six
  });

  it('round-trips base32 and matches the known encoding of the RFC secret', () => {
    expect(base32Encode(rfcSecret)).toBe(RFC_BASE32);
    expect(base32Decode(RFC_BASE32).equals(rfcSecret)).toBe(true);
    const s = generateSecret();
    expect(s).toHaveLength(20);
    expect(base32Decode(base32Encode(s)).equals(s)).toBe(true);
    expect(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq====').equals(rfcSecret)).toBe(true); // as people type it
    expect(() => base32Decode('not*base32')).toThrow();
  });

  describe('verifyCode', () => {
    const now = 1_700_000_000_000;
    const step = stepOf(now);
    const at = (s: number) => codeAt(rfcSecret, s);

    it('accepts the current code and the one step either side, nothing further', () => {
      expect(verifyCode(rfcSecret, at(step), now, null)).toEqual({ ok: true, step });
      expect(verifyCode(rfcSecret, at(step - 1), now, null)).toEqual({ ok: true, step: step - 1 });
      expect(verifyCode(rfcSecret, at(step + 1), now, null)).toEqual({ ok: true, step: step + 1 });
      expect(verifyCode(rfcSecret, at(step - 2), now, null)).toEqual({ ok: false });
      expect(verifyCode(rfcSecret, at(step + 2), now, null)).toEqual({ ok: false });
    });

    it('refuses a code for a step already used, or an earlier one (replay)', () => {
      expect(verifyCode(rfcSecret, at(step), now, step)).toEqual({ ok: false });
      expect(verifyCode(rfcSecret, at(step - 1), now, step)).toEqual({ ok: false });
      expect(verifyCode(rfcSecret, at(step + 1), now, step)).toEqual({ ok: true, step: step + 1 });
    });

    it('rejects anything that is not six digits, and wrong codes', () => {
      for (const bad of ['', '12345', '1234567', 'abcdef', '12345a', at(step) + '0', ' ', '١٢٣٤٥٦']) {
        expect(verifyCode(rfcSecret, bad, now, null)).toEqual({ ok: false });
      }
      expect(verifyCode(rfcSecret, at(step) === '000000' ? '000001' : '000000', now, null).ok).toBe(false);
      expect(verifyCode(generateSecret(), at(step), now, null)).toEqual({ ok: false });
    });

    it('ignores spaces people type in the middle', () => {
      const c = at(step);
      expect(verifyCode(rfcSecret, `${c.slice(0, 3)} ${c.slice(3)}`, now, null).ok).toBe(true);
    });
  });

  it('builds an otpauth address an authenticator app understands', () => {
    const uri = otpauthUri('Verify Service', 'alice@example.com', rfcSecret);
    expect(uri).toBe(`otpauth://totp/Verify%20Service%3Aalice%40example.com?secret=${RFC_BASE32}&issuer=Verify%20Service&algorithm=SHA1&digits=6&period=30`);
  });

  describe('recovery codes', () => {
    it('are readable, well formed and unpredictable', () => {
      const codes = new Set(Array.from({ length: 200 }, generateRecoveryCode));
      expect(codes.size).toBe(200);
      for (const c of codes) expect(c).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    });

    it('are accepted in any case and spacing, and nothing else', () => {
      expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDE-FGHJK');
      expect(normalizeRecoveryCode(' ABCDE FGHJK ')).toBe('ABCDE-FGHJK');
      expect(normalizeRecoveryCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
      for (const bad of ['', 'ABCDE-FGHJ', 'ABCDE-FGHJKL', 'ABCDE-FGHJ0', 'ABCDE-FGHJI', '123456', 'ABCDE-FGH!K']) expect(normalizeRecoveryCode(bad)).toBeNull();
    });
  });
});
