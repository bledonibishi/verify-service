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
