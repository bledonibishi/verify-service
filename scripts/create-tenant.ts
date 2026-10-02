/**
 * Usage: pnpm tenant:create "<name>" [webhookUrl] [--auto-approve]
 * Prints the API key and webhook secret once; only the key's hash is stored.
 */
import { PrismaClient } from '@prisma/client';
import { randomToken, sha256 } from '../src/common/crypto';

async function main() {
  const args = process.argv.slice(2);
  const autoApprove = args.includes('--auto-approve');
  const [name, webhookUrl] = args.filter((a) => !a.startsWith('--'));
  if (!name) {
    console.error('Usage: pnpm tenant:create "<name>" [webhookUrl] [--auto-approve]');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  const apiKey = `vk_${randomToken()}`;
  const webhookSecret = `whsec_${randomToken()}`;
  const tenant = await prisma.tenant.create({
    data: { name, apiKeyHash: sha256(apiKey), webhookUrl: webhookUrl ?? null, webhookSecret, autoApprove },
  });
  console.log(`Tenant:         ${tenant.name} (${tenant.id})`);
  console.log(`Auto-approve:  ${tenant.autoApprove ? 'on' : 'off'}`);
  console.log(`API key:        ${apiKey}`);
  console.log(`Webhook secret: ${webhookSecret}`);
  console.log('Store these now; the API key cannot be shown again.');
  await prisma.$disconnect();
}

main();
