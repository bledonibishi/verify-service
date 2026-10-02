import { randomBytes } from 'crypto';
import { decrypt, encrypt, hmacSign, randomToken, safeEqual, sha256 } from './crypto';

describe('crypto', () => {
  it('round-trips encrypted data', () => {
    const key = randomBytes(32);
    const data = Buffer.from('passport-bytes');
    const blob = encrypt(key, data);
    expect(blob.includes(data)).toBe(false);
    expect(decrypt(key, blob).equals(data)).toBe(true);
  });

  it('rejects tampered ciphertext', () => {
    const key = randomBytes(32);
    const blob = encrypt(key, Buffer.from('secret'));
    blob[blob.length - 1] ^= 0xff;
    expect(() => decrypt(key, blob)).toThrow();
  });

  it('rejects the wrong key', () => {
    const blob = encrypt(randomBytes(32), Buffer.from('secret'));
    expect(() => decrypt(randomBytes(32), blob)).toThrow();
  });

  it('hashes deterministically and generates unique tokens', () => {
    expect(sha256('a')).toBe(sha256('a'));
    expect(sha256('a')).not.toBe(sha256('b'));
    expect(randomToken()).not.toBe(randomToken());
  });

  it('signs and compares safely', () => {
    const sig = hmacSign('secret', 'payload');
    expect(safeEqual(sig, hmacSign('secret', 'payload'))).toBe(true);
    expect(safeEqual(sig, hmacSign('other', 'payload'))).toBe(false);
    expect(safeEqual('a', 'ab')).toBe(false);
  });
});
