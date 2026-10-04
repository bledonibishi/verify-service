/**
 * Usage: pnpm usage:adjust <tenantId> <YYYY-MM> <quantity> "<reason>"
 * Records a correction in the given month: a negative quantity is a credit (for example after a
 * dispute), a positive one adds billable verifications. History is never edited; this adds a row.
 * The reason is stored on the row and must not contain personal data.
 */
import { PrismaClient } from '@prisma/client';
import { parseMonth } from '../src/usage/month';

async function main() {
  const [tenantId, rawMonth, rawQty, ...reasonParts] = process.argv.slice(2);
  const month = rawMonth ? parseMonth(rawMonth) : null;
  const qty = /^-?\d+$/.test(rawQty ?? '') ? Number(rawQty) : NaN;
  const reason = reasonParts.join(' ').trim();
  if (!tenantId || !month || !Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 1_000_000 || reason.length < 3 || reason.length > 300) {
    console.error('Usage: pnpm usage:adjust <tenantId> <YYYY-MM> <non-zero whole quantity> "<reason, 3-300 characters>"');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      console.error('No such tenant');
      process.exit(1);
    }
    // Noon on the first day: always inside the month it corrects, whatever the time zone
    const occurredAt = new Date(Date.UTC(month.from.getUTCFullYear(), month.from.getUTCMonth(), 1, 12));
    await prisma.usageEvent.create({ data: { tenantId, kind: 'adjustment', occurredAt, quantity: qty, note: reason } });
    console.log(`Recorded ${qty > 0 ? '+' : ''}${qty} for ${tenant.name} in ${month.label}: ${reason}`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
