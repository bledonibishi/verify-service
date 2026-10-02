import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PurgeService } from './purge.service';

const BATCH = 50;

export interface RetentionReport {
  documentsDeleted: number;
  recordsDeleted: number;
  abandonedDeleted: number;
  failed: number;
}

/**
 * Applies each tenant's retention windows. Windows are read from the tenant at run time, so
 * changing a tenant's setting applies to existing sessions too (shortening it deletes sooner).
 * Safe to run on several instances at once: every session is locked before it is touched.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly purge: PurgeService,
    private readonly config: ConfigService,
  ) {}

  private graceHours(): number {
    const n = parseInt(this.config.get<string>('ABANDONED_GRACE_HOURS') ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : 24;
  }

  async run(): Promise<RetentionReport> {
    const report: RetentionReport = { documentsDeleted: 0, recordsDeleted: 0, abandonedDeleted: 0, failed: 0 };

    // 1. Whole records past their window go first, so their documents are not handled twice.
    const record = Prisma.sql`s.decided_at IS NOT NULL AND s.decided_at + make_interval(days => t.record_retention_days) <= now()`;
    // 2. Sessions the user never submitted: the link expired and nothing will ever decide them.
    const abandoned = Prisma.sql`s.status IN ('PENDING', 'EXPIRED') AND s.expires_at + make_interval(hours => ${this.graceHours()}::int) <= now()`;
    // 3. Decided sessions whose documents have outlived their window.
    const docs = Prisma.sql`s.decided_at IS NOT NULL AND s.documents_deleted_at IS NULL
      AND s.decided_at + make_interval(days => t.document_retention_days) <= now()
      AND EXISTS (SELECT 1 FROM documents d WHERE d.session_id = s.id)`;

    for (const [due, reason, key] of [
      [record, 'retention', 'recordsDeleted'],
      [abandoned, 'abandoned', 'abandonedDeleted'],
    ] as const) {
      for (;;) {
        const r = await this.purge.forEachDue(due, BATCH, (tx, id, tenantId) => this.purge.purgeLocked(tx, id, tenantId, reason));
        report[key] += r.done;
        report.failed += r.failed;
        if (r.done === 0) break; // nothing left, or only failures: stop rather than spin
      }
    }
    for (;;) {
      const r = await this.purge.forEachDue(docs, BATCH, async (tx, id) => {
        await this.purge.deleteDocumentsOf(tx, id);
      });
      report.documentsDeleted += r.done;
      report.failed += r.failed;
      if (r.done === 0) break;
    }

    if (report.failed > 0) this.logger.warn(`Retention run: ${report.failed} session(s) failed and will be retried`);
    return report;
  }
}
