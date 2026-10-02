import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from './webhooks.service';

const LEASE_MS = 60_000;
/** Multiples of WEBHOOK_RETRY_BASE_MS (default 30 s): 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h. */
const BACKOFF = [1, 4, 20, 60, 120, 360, 720, 1440];

interface Claimed {
  id: string;
  attempts: number;
}

/**
 * Delivers queued webhook events. Same shape as the verification worker: rows are claimed with
 * FOR UPDATE SKIP LOCKED and a lease, so any number of instances can run side by side, and every
 * outcome is written with a fence on the claimed attempt so a stale worker cannot overwrite a
 * newer one. Delivery is at-least-once; receivers dedupe on the event id.
 */
@Injectable()
export class WebhookDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private timer?: NodeJS.Timeout;
  private readonly loops = new Set<Promise<void>>();
  private stopped = false;
  private readonly enabled: boolean;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly baseMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: WebhooksService,
    private readonly config: ConfigService,
  ) {
    this.enabled = config.get('WEBHOOK_DISPATCHER_ENABLED') !== 'false';
    this.concurrency = Math.max(1, this.int('WEBHOOK_CONCURRENCY', 4));
    this.maxAttempts = Math.max(1, this.int('WEBHOOK_MAX_ATTEMPTS', BACKOFF.length + 1));
    this.baseMs = Math.max(1, this.int('WEBHOOK_RETRY_BASE_MS', 30_000));
    this.timeoutMs = Math.max(100, this.int('WEBHOOK_TIMEOUT_MS', 10_000));
  }

  private int(key: string, fallback: number): number {
    const n = parseInt(this.config.get<string>(key) ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  onApplicationBootstrap() {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.wake(), this.int('WEBHOOK_POLL_MS', 2000));
    void this.wake();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all(this.loops);
  }

  /** Tops up the drain loops; a dispatcher disabled by configuration never claims anything. */
  wake(): Promise<void> {
    if (!this.enabled || this.stopped) return Promise.resolve();
    while (this.loops.size < this.concurrency) {
      const loop: Promise<void> = this.drain().finally(() => this.loops.delete(loop));
      this.loops.add(loop);
    }
    return Promise.all(this.loops).then(() => undefined);
  }

  private async drain() {
    try {
      while (!this.stopped && (await this.tick())) {
        /* until nothing is due */
      }
    } catch (err) {
      this.logger.error(`Dispatcher loop failed: ${(err as Error).name}`);
    }
  }

  /** Claims and attempts one event. Returns false when nothing was due. */
  async tick(): Promise<boolean> {
    const claimed = await this.claim();
    if (!claimed) return false;
    try {
      await this.attempt(claimed);
    } catch (err) {
      // Bookkeeping failed (database trouble). The lease lapses and the event is claimed again.
      this.logger.error(`Webhook event ${claimed.id} bookkeeping failed: ${(err as Error).name}`);
    }
    return true;
  }

  private async claim(): Promise<Claimed | null> {
    const rows = await this.prisma.$queryRaw<Claimed[]>(Prisma.sql`
      UPDATE webhook_events
      SET attempts = attempts + 1, locked_until = now() + ${LEASE_MS} * interval '1 millisecond'
      WHERE id = (
        SELECT id FROM webhook_events
        WHERE status = 'PENDING' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
        ORDER BY next_attempt_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, attempts`);
    return rows[0] ?? null;
  }

  private fence(c: Claimed) {
    return { id: c.id, status: 'PENDING' as const, attempts: c.attempts };
  }

  private async attempt(c: Claimed) {
    const event = await this.prisma.webhookEvent.findUnique({ where: { id: c.id }, include: { tenant: true } });
    if (!event) return;
    const { tenant } = event;
    if (!tenant.webhookUrl) {
      await this.prisma.webhookEvent.updateMany({ where: this.fence(c), data: { status: 'FAILED', lastError: 'no_url', lockedUntil: null } });
      this.logger.warn(`Webhook event ${c.id} dropped: tenant has no webhook URL`);
      return;
    }

    const result = await this.http.deliver(tenant.webhookUrl, tenant.webhookSecret, event.id, event.body, this.timeoutMs);
    if (result.ok) {
      await this.prisma.webhookEvent.updateMany({
        where: this.fence(c),
        data: { status: 'DELIVERED', deliveredAt: new Date(), lastError: null, lockedUntil: null },
      });
      return;
    }

    if (c.attempts >= this.maxAttempts) {
      await this.prisma.webhookEvent.updateMany({ where: this.fence(c), data: { status: 'FAILED', lastError: result.code, lockedUntil: null } });
      this.logger.error(`Webhook event ${c.id} failed permanently after ${c.attempts} attempts (${result.code})`);
      return;
    }
    const factor = BACKOFF[Math.min(c.attempts, BACKOFF.length) - 1];
    const jitter = 0.8 + Math.random() * 0.4; // spread retries so a recovering receiver is not stampeded
    const delay = Math.round(this.baseMs * factor * jitter);
    await this.prisma.webhookEvent.updateMany({
      where: this.fence(c),
      data: { lastError: result.code, lockedUntil: null, nextAttemptAt: new Date(Date.now() + delay) },
    });
    this.logger.warn(`Webhook event ${c.id} attempt ${c.attempts} failed (${result.code}); retrying in ${Math.round(delay / 1000)}s`);
  }
}
