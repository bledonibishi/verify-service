/**
 * Usage: pnpm tenant:update <tenantId> [options]   (same options as tenant:create)
 * Retention changes apply to existing sessions at the next retention run: shortening a window
 * deletes sooner, so double-check before lowering one for a regulated customer.
 */
import { PrismaClient } from '@prisma/client';
import { SETTINGS_USAGE, checkRetention, parseTenantFlags } from '../src/tenants/settings';

async function main() {
  let parsed;
  try {
    parsed = parseTenantFlags(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const [id] = parsed.positional;
  if (!id || Object.keys(parsed.settings).length === 0) {
    console.error(`Usage: pnpm tenant:update <tenantId> ${SETTINGS_USAGE}`);
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const current = await prisma.tenant.findUnique({ where: { id } });
    if (!current) {
      console.error('No such tenant');
      process.exit(1);
    }
    const next = { ...current, ...parsed.settings };
    checkRetention(next);
    const tenant = await prisma.tenant.update({ where: { id }, data: parsed.settings });
    console.log(`Updated ${tenant.name}:`);
    for (const key of Object.keys(parsed.settings) as (keyof typeof parsed.settings)[]) console.log(`  ${key} = ${tenant[key]}`);
    if (tenant.recordRetentionDays < 1825) console.log('Note: records are kept less than 5 years; regulated customers may need at least that.');
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
