/**
 * Usage: pnpm storage:reencrypt [--dry-run] [--tenant=<tenantId>]
 * Re-encrypts every stored document into the format the current settings use (for example after
 * switching STORAGE_KEY_PROVIDER from "env" to "kms"). Keep STORAGE_ENCRYPTION_KEY set while you
 * run it so the old objects can be read. Safe to repeat; prints counts only.
 */
import { PrismaClient } from '@prisma/client';
import { existsSync } from 'fs';
import { reencryptAll } from '../src/storage/reencrypt';
import { StorageService } from '../src/storage/storage.service';

if (existsSync('.env')) {
  if (typeof process.loadEnvFile !== 'function') {
    console.error('This needs Node 20.12 or newer to read .env');
    process.exit(1);
  }
  process.loadEnvFile('.env');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const tenantId = process.argv.find((a) => a.startsWith('--tenant='))?.slice('--tenant='.length);
  let storage: StorageService;
  try {
    storage = new StorageService({ get: (k: string) => process.env[k] } as never);
  } catch (err) {
    console.error(`Configuration problem: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`Key provider: ${storage.keyProvider}${dryRun ? ' (dry run: nothing is written)' : ''}`);
  const prisma = new PrismaClient();
  try {
    const r = await reencryptAll(prisma, storage, { dryRun, tenantId });
    console.log(`${dryRun ? 'Would re-encrypt' : 'Re-encrypted'}: ${r.rewrapped} documents, ${r.secretsRewrapped} authenticator secrets   already current: ${r.current}   missing: ${r.missing}   failed: ${r.failed}`);
    if (r.failed > 0) {
      console.log('Some documents failed and were left unchanged. Check the key service and run again.');
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
