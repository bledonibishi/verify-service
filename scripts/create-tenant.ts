/**
 * Usage: pnpm tenant:create "<name>" [webhookUrl] [options]
 *   --auto-approve  --face-threshold=90  --liveness-threshold=90
 *   --doc-retention-days=30  --record-retention-days=1825  --evidence-export
 * Prints the API key and webhook secret once; only the key's hash is stored.
 */
import { PrismaClient } from '@prisma/client';
import { randomToken, sha256 } from '../src/common/crypto';
import { DEFAULT_SETTINGS, SETTINGS_USAGE, checkRetention, parseTenantFlags } from '../src/tenants/settings';

async function main() {
  let parsed;
  try {
    parsed = parseTenantFlags(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const [name, webhookUrl] = parsed.positional;
  if (!name) {
    console.error(`Usage: pnpm tenant:create "<name>" [webhookUrl] ${SETTINGS_USAGE}`);
    process.exit(1);
  }
  const settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
  try {
    checkRetention(settings);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const prisma = new PrismaClient();
  const apiKey = `vk_${randomToken()}`;
  const webhookSecret = `whsec_${randomToken()}`;
  const tenant = await prisma.tenant.create({
    data: { name, apiKeyHash: sha256(apiKey), webhookUrl: webhookUrl ?? null, webhookSecret, ...settings },
  });
  console.log(`Tenant:           ${tenant.name} (${tenant.id})`);
  console.log(`Auto-approve:     ${tenant.autoApprove ? 'on' : 'off'}`);
  console.log(`Face threshold:   ${tenant.faceMatchThreshold}`);
  console.log(`Liveness min:     ${tenant.livenessMinConfidence}`);
  console.log(`Documents kept:   ${tenant.documentRetentionDays} days after the decision`);
  console.log(`Records kept:     ${tenant.recordRetentionDays} days after the decision`);
  console.log(`Evidence export:  ${tenant.evidenceExport ? 'on' : 'off'}`);
  console.log(`API key:          ${apiKey}`);
  console.log(`Webhook secret:   ${webhookSecret}`);
  console.log('Store these now; the API key cannot be shown again.');
  await prisma.$disconnect();
}

main();
