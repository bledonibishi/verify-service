/**
 * Usage: pnpm usage:report <YYYY-MM> [tenantId]
 * Prints a CSV of each tenant's usage for a UTC calendar month, for invoicing. Only counts and
 * names are printed; there is no personal data in usage.
 */
import { PrismaClient } from '@prisma/client';
import { aggregateUsage, emptyTotals, usageCsv } from '../src/usage/aggregate';
import { parseMonth } from '../src/usage/month';

async function main() {
  const [rawMonth, tenantId] = process.argv.slice(2);
  const month = rawMonth ? parseMonth(rawMonth) : null;
  if (!month) {
    console.error('Usage: pnpm usage:report <YYYY-MM> [tenantId]');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const totals = await aggregateUsage(prisma, month, tenantId);
    const tenants = await prisma.tenant.findMany({ where: tenantId ? { id: tenantId } : {}, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    if (tenantId && tenants.length === 0) {
      console.error('No such tenant');
      process.exit(1);
    }
    // Every tenant appears, with zeros when it had no usage, so nothing is silently missing from an invoice run
    process.stdout.write(usageCsv(month, tenants.map((t) => ({ tenantId: t.id, tenantName: t.name, totals: totals.get(t.id) ?? emptyTotals() }))));
  } finally {
    await prisma.$disconnect();
  }
}

main();
