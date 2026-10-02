import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

export type PurgeReason = 'retention' | 'abandoned' | 'tenant_request';

type Tx = Prisma.TransactionClient;
const TX = { timeout: 60_000 };

/**
 * The only code that erases data. Both operations hold a row lock on the session while they work
 * and delete the stored files before the database rows, so a failure part-way leaves rows that
 * still point at (now missing) files, which a retry finishes, and never an encrypted file with
 * nothing pointing at it.
 */
@Injectable()
export class PurgeService {
  private readonly logger = new Logger(PurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Locks the sessions matching a raw condition. Skips rows another worker already holds. */
  async lockDue(tx: Tx, due: Prisma.Sql, limit: number): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT s.id FROM sessions s JOIN tenants t ON t.id = s.tenant_id
      WHERE ${due}
      ORDER BY s.created_at
      LIMIT ${limit}
      FOR UPDATE OF s SKIP LOCKED`);
    return rows.map((r) => r.id);
  }

  /** Removes the images but keeps the record. Returns how many were removed. */
  async deleteDocumentsOf(tx: Tx, sessionId: string): Promise<number> {
    const docs = await tx.document.findMany({ where: { sessionId } });
    if (docs.length === 0) return 0;
    for (const d of docs) await this.storage.delete(d.storageKey);
    await tx.session.update({
      where: { id: sessionId },
      data: {
        documentsDeletedAt: new Date(),
        documentsManifest: docs.map((d) => ({ kind: d.kind, contentType: d.contentType, sizeBytes: d.sizeBytes, sha256: d.sha256 })),
      },
    });
    await tx.document.deleteMany({ where: { sessionId } });
    await tx.auditLog.create({
      data: { sessionId, event: 'retention.documents_deleted', detail: { count: docs.length, kinds: docs.map((d) => d.kind) } },
    });
    return docs.length;
  }

  /** Erase a whole session: files, rows (results, audit log, jobs, documents) and leave a tombstone. */
  async purgeLocked(tx: Tx, sessionId: string, tenantId: string, reason: PurgeReason): Promise<number> {
    const docs = await tx.document.findMany({ where: { sessionId } });
    for (const d of docs) await this.storage.delete(d.storageKey);
    await tx.session.delete({ where: { id: sessionId } });
    await tx.deletionRecord.create({ data: { tenantId, sessionId, reason, documentCount: docs.length } });
    return docs.length;
  }

  /**
   * Run `work` for each due session inside its own short transaction. One failure doesn't stop the
   * rest. Sessions that fail are added to `skip` so the same run moves on to newer ones instead of
   * retrying the same oldest batch forever; the next run tries them again.
   * `work` returns how many units it handled (documents, or 1 per record).
   */
  async forEachDue(
    due: Prisma.Sql,
    limit: number,
    work: (tx: Tx, id: string, tenantId: string) => Promise<number>,
    skip: Set<string>,
  ): Promise<{ units: number; sessions: number; failed: number; attempted: number }> {
    const out = { units: 0, sessions: 0, failed: 0, attempted: 0 };
    const candidates = await this.prisma.$transaction(async (tx) => this.peek(tx, due, limit, [...skip]), TX);
    for (const id of candidates) {
      out.attempted++;
      skip.add(id); // handled or failed, it is not retried within this run
      try {
        let units: number | null = null;
        await this.prisma.$transaction(async (tx) => {
          const locked = await this.lockDue(tx, Prisma.sql`s.id = ${id} AND (${due})`, 1);
          if (locked.length === 0) return; // someone else got it, or it's no longer due
          const s = await tx.session.findUniqueOrThrow({ where: { id }, select: { tenantId: true } });
          units = await work(tx, id, s.tenantId);
        }, TX);
        if (units !== null) {
          out.sessions++;
          out.units += units;
        }
      } catch (err) {
        out.failed++;
        // The session id and the error class say what is still undeleted and why; no personal data.
        const code = (err as { code?: string }).code;
        this.logger.warn(`Erasure failed for session ${id}: ${(err as Error).name}${code ? ` ${code}` : ''}: ${String((err as Error).message).split('\n').pop()?.slice(0, 200)}`);
      }
    }
    return out;
  }

  private async peek(tx: Tx, due: Prisma.Sql, limit: number, skip: string[]): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT s.id FROM sessions s JOIN tenants t ON t.id = s.tenant_id
      WHERE ${due} AND NOT (s.id = ANY(${skip}::text[]))
      ORDER BY s.created_at LIMIT ${limit}`);
    return rows.map((r) => r.id);
  }

  /** Data-subject deletion requested by the tenant through the API. */
  async deleteForTenant(tenantId: string, sessionId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: SessionStatus }[]>(Prisma.sql`
        SELECT id, status FROM sessions WHERE id = ${sessionId} AND tenant_id = ${tenantId} FOR UPDATE`);
      if (rows.length === 0) throw new NotFoundException('Session not found');
      // The pipeline is reading these files right now; it finishes in seconds.
      if (rows[0].status === SessionStatus.PROCESSING) throw new ConflictException('Session is being processed; try again shortly');
      await this.purgeLocked(tx, sessionId, tenantId, 'tenant_request');
    }, TX);
  }
}
