/**
 * Reads TRUST_PROXY: how many reverse proxies sit in front of the service, so the client's address
 * comes from the right place in X-Forwarded-For. This matters for the per-IP login rate limit:
 * behind a proxy every visitor would otherwise share the proxy's address.
 *
 * Deliberately narrow: a hop count (`1` for one proxy such as Caddy or a load balancer) or
 * `loopback` (a proxy on the same machine). `true` is refused, because it trusts the header from
 * anyone and lets a client pick the address the limiter sees.
 */
export function parseTrustProxy(raw: string | undefined): number | 'loopback' | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === '0' || value === 'false') return undefined;
  if (value === 'loopback') return 'loopback';
  if (/^[1-9]\d?$/.test(value)) return Number(value);
  throw new Error('TRUST_PROXY must be a number of proxies (for example 1) or "loopback"');
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Reads HOST: the address the service listens on. Unset keeps Node's default (every address).
 * Behind a proxy on the same machine, `127.0.0.1` makes sure nobody reaches the service directly,
 * because a direct client could otherwise send its own X-Forwarded-For and pick the address the
 * rate limits see.
 */
export function parseListenHost(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (value === '') return undefined;
  if (LOOPBACK.has(value) || value === '0.0.0.0' || value === '::' || /^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return value;
  throw new Error('HOST must be an IP address such as 127.0.0.1 (only the proxy can reach it) or 0.0.0.0');
}

/** True when the trusted-proxy setting is in force but the service is reachable on more than loopback. */
export function directClientsCanSpoof(trust: number | 'loopback' | undefined, host: string | undefined): boolean {
  return trust !== undefined && !(host !== undefined && LOOPBACK.has(host));
}
