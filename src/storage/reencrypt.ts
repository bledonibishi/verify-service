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
export async function reencryptAll(prisma: PrismaClient, storage: StorageService, opts: { dryRun?: boolean; /** Only this tenant's documents. */ tenantId?: string } = {}): Promise<ReencryptReport> {
  const report: ReencryptReport = { rewrapped: 0, current: 0, missing: 0, failed: 0 };
  let after: string | undefined;
  for (;;) {
    const docs = await prisma.document.findMany({
      where: opts.tenantId ? { session: { tenantId: opts.tenantId } } : {},
      orderBy: { id: 'asc' },
      take: 100,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: { id: true, sessionId: true, storageKey: true },
    });
    if (docs.length === 0) return report;
    after = docs[docs.length - 1].id;

    for (const d of docs) {
      try {
        const outcome = await prisma.$transaction(
          async (tx) => {
            const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM sessions WHERE id = ${d.sessionId} FOR SHARE`);
            // Erased while we were working through the list: nothing to do
            if (locked.length === 0 || !(await tx.document.findUnique({ where: { id: d.id }, select: { id: true } }))) return 'missing' as const;
            if (opts.dryRun) {
              const state = await storage.inspect(d.storageKey);
              return state === 'stale' ? ('rewrapped' as const) : state;
            }
            return storage.rewrap(d.storageKey);
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
