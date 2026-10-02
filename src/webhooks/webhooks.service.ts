import { Injectable } from '@nestjs/common';
import { hmacSign } from '../common/crypto';

export type DeliveryResult = { ok: true } | { ok: false; code: string };

/**
 * One signed HTTP delivery attempt. Signature header: `X-Verify-Signature: t=<unix>,v1=<hmac>`
 * where hmac = HMAC-SHA256(secret, `${t}.${body}`); the timestamp is fresh on every attempt, the
 * body is not. Receivers should reject old timestamps and dedupe on `X-Verify-Event-Id`.
 * Retries and bookkeeping live in the dispatcher, not here.
 */
@Injectable()
export class WebhooksService {
  async deliver(url: string, secret: string, eventId: string, body: string, timeoutMs: number): Promise<DeliveryResult> {
    const t = Math.floor(Date.now() / 1000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-verify-signature': `t=${t},v1=${hmacSign(secret, `${t}.${body}`)}`,
          'x-verify-event-id': eventId,
        },
        body,
        // A redirect would send a signed body somewhere the tenant did not configure
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Only the status matters. Cancel instead of reading, so a huge or endless reply costs nothing.
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, code: `http_${res.status}` };
    } catch (err) {
      const name = (err as Error).name;
      return { ok: false, code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
    }
  }
}
