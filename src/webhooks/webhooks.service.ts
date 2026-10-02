import { Injectable, Logger } from '@nestjs/common';
import { hmacSign } from '../common/crypto';

export interface WebhookTarget {
  webhookUrl: string | null;
  webhookSecret: string;
}

export interface WebhookEvent {
  type: 'session.status_changed';
  sessionId: string;
  externalRef: string;
  status: string;
  occurredAt: string;
  /** Automated check results; present once the pipeline has run. */
  verification?: unknown;
}

/**
 * Sends signed webhooks. Signature header: `X-Verify-Signature: t=<unix>,v1=<hmac>`
 * where hmac = HMAC-SHA256(secret, `${t}.${body}`). Receivers should reject old timestamps.
 * Delivery is best-effort for now; a retry queue is a planned follow-up.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  async send(target: WebhookTarget, event: WebhookEvent): Promise<void> {
    if (!target.webhookUrl) return;
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const signature = hmacSign(target.webhookSecret, `${t}.${body}`);
    try {
      const res = await fetch(target.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-verify-signature': `t=${t},v1=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.logger.warn(`Webhook returned ${res.status} for session ${event.sessionId}`);
    } catch (err) {
      this.logger.warn(`Webhook failed for session ${event.sessionId}: ${(err as Error).message}`);
    }
  }
}
