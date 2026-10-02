import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetentionService } from './retention.service';

/** Runs the retention job on a timer: shortly after start, then every RETENTION_INTERVAL_MS (default 1 hour). */
@Injectable()
export class RetentionScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RetentionScheduler.name);
  private timer?: NodeJS.Timeout;
  private current: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly retention: RetentionService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get('RETENTION_JOB_ENABLED') === 'false') return;
    const n = parseInt(this.config.get<string>('RETENTION_INTERVAL_MS') ?? '', 10);
    const interval = Number.isFinite(n) && n >= 1000 ? n : 3600_000;
    this.timer = setInterval(() => void this.tick(), interval);
    setTimeout(() => void this.tick(), 10_000).unref();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.current;
  }

  private tick(): Promise<void> {
    if (this.stopped || this.current) return this.current ?? Promise.resolve();
    this.current = this.retention
      .run()
      .then((r) => {
        if (r.documentsDeleted + r.recordsDeleted + r.abandonedDeleted > 0) {
          this.logger.log(`Retention: documents=${r.documentsDeleted} records=${r.recordsDeleted} abandoned=${r.abandonedDeleted}`);
        }
      })
      .catch((err) => this.logger.error(`Retention run failed: ${(err as Error).name}`))
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }
}
