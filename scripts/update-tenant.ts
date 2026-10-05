/**
 * Usage: pnpm tenant:update <tenantId> [options]   (same options as tenant:create)
 *   --webhook-url=https://...   where results are sent (http is allowed for local testing); --webhook-url=none stops webhooks
 * Retention changes apply to existing sessions at the next retention run: shortening a window
 * deletes sooner, so double-check before lowering one for a regulated customer.
 */
import { PrismaClient } from '@prisma/client';
import { SETTINGS_USAGE, checkRetention, parseTenantFlags } from '../src/tenants/settings';

/** `undefined`: not given. `null`: stop sending. Otherwise a valid http(s) address. Throws on anything else. */
function webhookUrlFrom(args: string[]): { rest: string[]; url: string | null | undefined } {
  const flag = args.find((a) => a.startsWith('--webhook-url='));
  const rest = args.filter((a) => a !== flag);
  if (!flag) return { rest, url: undefined };
  const value = flag.slice('--webhook-url='.length);
  if (value === 'none') return { rest, url: null };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('--webhook-url must be a full address such as https://pharmacy.example/webhooks/verify, or "none"');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('--webhook-url must start with http:// or https://');
  if (parsed.username || parsed.password) throw new Error('--webhook-url must not contain a user name or password');
  return { rest, url: parsed.toString() };
}

async function main() {
  let parsed;
  let webhook: ReturnType<typeof webhookUrlFrom>;
  try {
    webhook = webhookUrlFrom(process.argv.slice(2));
    parsed = parseTenantFlags(webhook.rest);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const [id] = parsed.positional;
  if (!id || (Object.keys(parsed.settings).length === 0 && webhook.url === undefined)) {
    console.error(`Usage: pnpm tenant:update <tenantId> ${SETTINGS_USAGE} [--webhook-url=<url>|none]`);
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
    const tenant = await prisma.tenant.update({
      where: { id },
      data: { ...parsed.settings, ...(webhook.url !== undefined ? { webhookUrl: webhook.url } : {}) },
    });
    console.log(`Updated ${tenant.name}:`);
    if (webhook.url !== undefined) console.log(`  webhook = ${tenant.webhookUrl ?? 'none (webhooks stopped)'}`);
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
