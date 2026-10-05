import { Prisma, PrismaClient } from '@prisma/client';
import { Month } from './month';

export interface UsageTotals {
  /** Completed verifications that are billed. */
  billable: number;
  /** Completed verifications we do not bill (our own failures), with the reason. */
  nonBillable: number;
  nonBillableByReason: Record<string, number>;
  /** Operator corrections: negative numbers are credits. */
  adjustments: number;
  /** billable + adjustments */
  net: number;
  /** Of the billable verifications, how many used each add-on. */
  features: { face: number; liveness: number; licence: number; autoDecided: number };
}

type Db = Pick<PrismaClient, 'usageEvent'> | Prisma.TransactionClient;

const empty = (): UsageTotals => ({
  billable: 0,
  nonBillable: 0,
  nonBillableByReason: {},
  adjustments: 0,
  net: 0,
  features: { face: 0, liveness: 0, licence: 0, autoDecided: 0 },
});

/** Totals per tenant for one month. Pass `tenantId` to limit it to one tenant. */
export async function aggregateUsage(db: Db, month: Month, tenantId?: string): Promise<Map<string, UsageTotals>> {
  const rows = await db.usageEvent.groupBy({
    by: ['tenantId', 'kind', 'billable', 'nonBillableReason', 'face', 'liveness', 'licence', 'autoDecided'],
    where: { occurredAt: { gte: month.from, lt: month.to }, ...(tenantId ? { tenantId } : {}) },
    _sum: { quantity: true },
  });
  const out = new Map<string, UsageTotals>();
  for (const r of rows) {
    const t = out.get(r.tenantId) ?? empty();
    out.set(r.tenantId, t);
    const n = r._sum.quantity ?? 0;
    if (r.kind === 'adjustment') {
      t.adjustments += n;
    } else if (r.billable) {
      t.billable += n;
      if (r.face) t.features.face += n;
      if (r.liveness) t.features.liveness += n;
      if (r.licence) t.features.licence += n;
      if (r.autoDecided) t.features.autoDecided += n;
    } else {
      t.nonBillable += n;
      const reason = r.nonBillableReason ?? 'unknown';
      t.nonBillableByReason[reason] = (t.nonBillableByReason[reason] ?? 0) + n;
    }
  }
  for (const t of out.values()) t.net = t.billable + t.adjustments;
  return out;
}

export const emptyTotals = empty;

/** A CSV the operator can paste into an invoice or spreadsheet. Fields are quoted when they need it. */
export function usageCsv(month: Month, rows: { tenantId: string; tenantName: string; totals: UsageTotals }[]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    // A leading = + - @ makes spreadsheets run a cell as a formula; a tenant name must not be able to do that
    const safe = /^[=+\-@\t\r]/.test(s) && typeof v === 'string' ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const header = ['month', 'tenant_id', 'tenant_name', 'billable', 'non_billable', 'adjustments', 'net_billable', 'face_matches', 'liveness_checks', 'licence_checks', 'auto_decided'];
  const lines = rows.map((r) =>
    [month.label, r.tenantId, r.tenantName, r.totals.billable, r.totals.nonBillable, r.totals.adjustments, r.totals.net, r.totals.features.face, r.totals.features.liveness, r.totals.features.licence, r.totals.features.autoDecided]
      .map(cell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}
