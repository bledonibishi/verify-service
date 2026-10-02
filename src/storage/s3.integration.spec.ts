// Runs the real AWS SDK against a local S3-compatible server (MinIO). It is skipped unless
// S3_TEST_ENDPOINT is set, and it never uses real AWS: `docker compose up -d s3mock`, then
//   S3_TEST_ENDPOINT=http://localhost:9100 pnpm jest src/storage/s3.integration
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'crypto';
import { StoredObjectMissingError } from './blob-store';
import { StorageService } from './storage.service';

const endpoint = process.env.S3_TEST_ENDPOINT;
const describeIf = endpoint ? describe : describe.skip;

describeIf('S3 storage against a local S3-compatible server', () => {
  const bucket = `verify-test-${randomUUID().slice(0, 8)}`;
  const creds = { accessKeyId: process.env.S3_TEST_ACCESS_KEY ?? 'test', secretAccessKey: process.env.S3_TEST_SECRET_KEY ?? 'test' };
  let storage: StorageService;

  beforeAll(async () => {
    const admin = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: creds });
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    const values: Record<string, string> = {
      STORAGE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      STORAGE_DRIVER: 's3',
      S3_BUCKET: bucket,
      S3_REGION: 'us-east-1',
      S3_ENDPOINT: endpoint!,
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: creds.accessKeyId,
      S3_SECRET_ACCESS_KEY: creds.secretAccessKey,
      S3_SSE: 'none', // local S3 servers have no KMS; AWS uses the default AES256
      S3_KEY_PREFIX: 'it',
    };
    storage = new StorageService({ get: (k: string) => values[k] } as unknown as ConfigService);
  });

  it('puts, gets and deletes through the real SDK', async () => {
    const data = randomBytes(2 * 1024 * 1024); // an image-sized object
    const key = `tenant/${randomUUID()}/${randomUUID()}`;
    await storage.put(key, data);
    expect(Buffer.compare(await storage.get(key), data)).toBe(0);
    await storage.delete(key);
    await expect(storage.get(key)).rejects.toBeInstanceOf(StoredObjectMissingError);
    await storage.delete(key); // idempotent
  });

  it('reports an object that never existed as missing', async () => {
    await expect(storage.get(`tenant/${randomUUID()}/${randomUUID()}`)).rejects.toBeInstanceOf(StoredObjectMissingError);
  });
});
