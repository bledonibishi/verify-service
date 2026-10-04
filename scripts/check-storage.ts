/**
 * Usage: pnpm storage:check
 * Writes, reads back and deletes one small random object through the configured storage driver
 * (STORAGE_DRIVER, S3_*), using your .env. It prints only pass/fail per step, never keys or content.
 * Run it yourself when you set up a bucket; the automated tests never contact real AWS.
 */
import { randomBytes, randomUUID } from 'crypto';
import { StorageService, StoredObjectMissingError } from '../src/storage/storage.service';

import { existsSync } from 'fs';

// A missing .env is fine (the real environment is used); one that exists but cannot be loaded is not,
// because the check would then silently test the default local storage instead of your bucket.
if (existsSync('.env')) {
  if (typeof process.loadEnvFile !== 'function') {
    console.error('This check needs Node 20.12 or newer to read .env');
    process.exit(1);
  }
  process.loadEnvFile('.env');
}

async function step(name: string, run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
    console.log(`  ok    ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${(err as Error).name}${(err as { Code?: string }).Code ? ` (${(err as { Code?: string }).Code})` : ''}`);
    return false;
  }
}

async function main() {
  const driver = process.env.STORAGE_DRIVER ?? 'local';
  console.log(`Storage driver: ${driver}${driver === 's3' ? ` in ${process.env.S3_REGION ?? '(no region)'}` : ''}`);
  let storage: StorageService;
  try {
    storage = new StorageService({ get: (k: string) => process.env[k] } as never);
  } catch (err) {
    console.log(`  FAIL  configuration: ${(err as Error).message}`);
    process.exit(1);
  }

  const data = randomBytes(256 * 1024);
  const key = `healthcheck/${randomUUID()}/${randomUUID()}`;
  const results = [
    await step('write an encrypted object', () => storage.put(key, data)),
    await step('read it back and compare', async () => {
      if (Buffer.compare(await storage.get(key), data) !== 0) throw new Error('content differs');
    }),
    await step('delete it', () => storage.delete(key)),
    await step('confirm it is gone', async () => {
      try {
        await storage.get(key);
      } catch (err) {
        if (err instanceof StoredObjectMissingError) return;
        throw err;
      }
      throw new Error('still readable after delete');
    }),
    await step('delete again (must be harmless)', () => storage.delete(key)),
  ];
  if (results.every(Boolean)) {
    console.log('All checks passed.');
    if (driver === 's3') console.log('Also confirm in the AWS console that bucket versioning is OFF; otherwise deleted objects survive as old versions.');
  } else {
    console.log('Some checks failed. 403 usually means the IAM policy or bucket name is wrong: S3_BUCKET must be the full bucket name, and the policy needs s3:ListBucket on the bucket as well as Put/Get/DeleteObject on its objects (without it, a missing object looks like AccessDenied).');
    process.exit(1);
  }
}

main();
