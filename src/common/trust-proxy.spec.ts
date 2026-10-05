import { directClientsCanSpoof, parseListenHost, parseTrustProxy } from './trust-proxy';

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

describe('parseListenHost', () => {
  it('keeps the default when unset, and accepts addresses', () => {
    expect(parseListenHost(undefined)).toBeUndefined();
    expect(parseListenHost(' ')).toBeUndefined();
    for (const h of ['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::', '10.0.0.5']) expect(parseListenHost(h)).toBe(h);
  });

  it.each(['example.com', '127.0.0.1:4100', 'all', '1.2.3'])('refuses %j', (h) => {
    expect(() => parseListenHost(h)).toThrow('HOST');
  });
});

describe('directClientsCanSpoof', () => {
  it('warns only when a proxy is trusted and the port is reachable from outside the machine', () => {
    expect(directClientsCanSpoof(undefined, undefined)).toBe(false);
    expect(directClientsCanSpoof(1, '127.0.0.1')).toBe(false);
    expect(directClientsCanSpoof('loopback', '::1')).toBe(false);
    expect(directClientsCanSpoof(1, undefined)).toBe(true);
    expect(directClientsCanSpoof(1, '0.0.0.0')).toBe(true);
  });
});
