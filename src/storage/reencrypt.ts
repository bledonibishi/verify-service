import { Prisma, PrismaClient } from '@prisma/client';
import { StorageService } from './storage.service';

export interface ReencryptReport {
  /** Objects rewritten in the current format (with dryRun: objects that would be). */
  rewrapped: number;
  /** Reviewers' authenticator secrets re-sealed (with dryRun: that would be). They depend on the same key as the documents. */
  secretsRewrapped: number;
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
  const report: ReencryptReport = { rewrapped: 0, secretsRewrapped: 0, current: 0, missing: 0, failed: 0 };
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
    if (docs.length === 0) break;
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
  await reencryptSecrets(prisma, storage, opts, report);
  return report;
}

/** Reviewers' authenticator secrets are sealed with the same key provider, so they migrate with the documents. */
async function reencryptSecrets(prisma: PrismaClient, storage: StorageService, opts: { dryRun?: boolean; tenantId?: string; batch?: number }, report: ReencryptReport) {
  const batch = opts.batch ?? 100;
  let after = '';
  for (;;) {
    const rows = await prisma.reviewer.findMany({
      where: { id: { gt: after }, totpSecretSealed: { not: null }, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) },
      orderBy: { id: 'asc' },
      take: batch,
      select: { id: true, totpSecretSealed: true },
    });
    if (rows.length === 0) return;
    after = rows[rows.length - 1].id;
    for (const r of rows) {
      try {
        const next = await storage.resealSecret(r.totpSecretSealed as string, r.id);
        if (next === null) continue;
        if (opts.dryRun) {
          report.secretsRewrapped++;
          continue;
        }
        // Only if it is still what we read: a reviewer who turned two-factor off or set it up again meanwhile is left alone
        const updated = await prisma.reviewer.updateMany({ where: { id: r.id, totpSecretSealed: r.totpSecretSealed }, data: { totpSecretSealed: next } });
        if (updated.count === 1) report.secretsRewrapped++;
      } catch {
        report.failed++;
      }
    }
  }
}