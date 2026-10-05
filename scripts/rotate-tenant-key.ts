/**
 * Usage: pnpm tenant:rotate-key <tenantId> [--grace-hours=N] [--webhook-secret]
 *
 * Issues a new API key for a tenant. With no --grace-hours the old key stops working immediately
 * (use this after a leak). With --grace-hours=24 the old key keeps working for 24 hours (max 168)
 * so the tenant can deploy the new one without downtime. --webhook-secret also replaces the
 * webhook signing secret; the tenant must update its verifier at the same time, since events are
 * signed with the new secret from now on, including retries of events already queued.
 * The new key is printed once; only its hash is stored.
 */
import { PrismaClient } from '@prisma/client';
import { RotationError, rotateTenantKey } from '../src/tenants/key-rotation';

async function main() {
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith('--'));
  const graceFlag = args.find((a) => a.startsWith('--grace-hours='));
  const graceHours = graceFlag ? Number(graceFlag.split('=')[1]) : 0;
  const known = (a: string) => a === '--webhook-secret' || a.startsWith('--grace-hours=');
  const unknown = args.find((a) => a.startsWith('--') && !known(a));
  if (!id || unknown) {
    console.error(`Usage: pnpm tenant:rotate-key <tenantId> [--grace-hours=N] [--webhook-secret]${unknown ? `\nUnknown option: ${unknown}` : ''}`);
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const r = await rotateTenantKey(prisma, id, { graceHours, rotateWebhookSecret: args.includes('--webhook-secret') });
    console.log(`New API key:      ${r.apiKey}`);
    if (r.webhookSecret) console.log(`New webhook secret: ${r.webhookSecret}`);
    console.log(r.oldKeyValidUntil ? `The old key keeps working until ${r.oldKeyValidUntil.toISOString()}.` : 'The old key stopped working now.');
    console.log('Store these now; they cannot be shown again.');
  } catch (err) {
    console.error(err instanceof RotationError ? err.message : 'Could not rotate the key');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
