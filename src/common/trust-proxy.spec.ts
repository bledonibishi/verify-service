import { parseTrustProxy } from './trust-proxy';

describe('parseTrustProxy', () => {
  it('is off unless set', () => {
    for (const v of [undefined, '', ' ', '0', 'false', 'FALSE']) expect(parseTrustProxy(v)).toBeUndefined();
  });

  it('accepts a hop count or loopback', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('LOOPBACK')).toBe('loopback');
  });

  it.each(['true', 'yes', '*', '-1', '1.5', '100', '10.0.0.0/8', 'uniquelocal', 'loopback, 10.0.0.1'])('refuses %j rather than trust everyone', (v) => {
    expect(() => parseTrustProxy(v)).toThrow('TRUST_PROXY');
  });
});
