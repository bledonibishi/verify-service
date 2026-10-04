import { Prisma, PrismaClient } from '@prisma/client';
import { StorageService } from './storage.service';

export interface ReencryptReport {
  /** Objects rewritten in the current format (with dryRun: objects that would be). */
  rewrapped: number;
  current: number;
  missing: number;
  failed: number;
}

/**
 * Moves every stored document to the current encryption format, for example after switching from
 * the master key to KMS. Safe to run again and to interrupt. Each object is handled under a share
 * lock on its session row: erasure takes the exclusive lock on the same row, so this can never
 * write an object back after the person was erased. Prints and returns counts only.
 */
export async function reencryptAll(prisma: PrismaClient, storage: StorageService, opts: { dryRun?: boolean; /** Only this tenant's documents. */ tenantId?: string; /** Documents per page (default 100). */ batch?: number } = {}): Promise<ReencryptReport> {
  const report: ReencryptReport = { rewrapped: 0, current: 0, missing: 0, failed: 0 };
  const batch = opts.batch ?? 100;
  // A plain "id greater than" cursor, not a cursor on the previous row: if that row is erased while
  // we work, the next page must still start in the right place instead of coming back empty.
  let after = '';
  for (;;) {
    const docs = await prisma.document.findMany({
      where: { id: { gt: after }, ...(opts.tenantId ? { session: { tenantId: opts.tenantId } } : {}) },
      orderBy: { id: 'asc' },
      take: batch,
      select: { id: true, sessionId: true },
    });
    if (docs.length === 0) return report;
    after = docs[docs.length - 1].id;

    for (const d of docs) {
      try {
        const outcome = await prisma.$transaction(
          async (tx) => {
            const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM sessions WHERE id = ${d.sessionId} FOR SHARE`);
            if (locked.length === 0) return 'missing' as const; // erased while we were working through the list
            // Read the row again now that the session is locked: a replacement upload may have given
            // it a new storage key, and rewriting the old one would leave a file no row points to
            const current = await tx.document.findUnique({ where: { id: d.id }, select: { storageKey: true } });
            if (!current) return 'missing' as const;
            if (opts.dryRun) {
              const state = await storage.inspect(current.storageKey);
              return state === 'stale' ? ('rewrapped' as const) : state;
            }
            return storage.rewrap(current.storageKey);
          },
          { timeout: 60_000 },
        );
        report[outcome]++;
      } catch {
        report.failed++; // left as it was; run again after fixing the cause
      }
    }
  }
}
