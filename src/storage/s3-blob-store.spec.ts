import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { StoredObjectMissingError } from './blob-store';
import { S3BlobStore } from './s3-blob-store';
import { StorageService } from './storage.service';

/** An in-memory stand-in for S3: no network, no credentials. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const sent: { cmd: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: async (command: unknown) => {
      const c = command as { input: Record<string, unknown> };
      const bucketKey = `${c.input.Bucket}/${c.input.Key}`;
      if (command instanceof PutObjectCommand) {
        sent.push({ cmd: 'put', input: c.input });
        objects.set(bucketKey, Buffer.from(c.input.Body as Buffer));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        sent.push({ cmd: 'get', input: c.input });
        const body = objects.get(bucketKey);
        if (!body) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      if (command instanceof DeleteObjectCommand) {
        sent.push({ cmd: 'delete', input: c.input });
        objects.delete(bucketKey); // like S3: success even when the key is absent
        return {};
      }
      throw new Error('unexpected command');
    },
  };
  return { client: client as never, objects, sent };
}

const config = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as unknown as ConfigService;
const KEY = randomBytes(32).toString('base64');

describe('S3BlobStore', () => {
  it('stores under the bucket and optional prefix, with server-side encryption', async () => {
    const { client, objects, sent } = fakeS3();
    const store = new S3BlobStore(client, { bucket: 'b', prefix: '/prod/' });
    await store.put('tenant/session/abc', Buffer.from('bytes'));
    expect([...objects.keys()]).toEqual(['b/prod/tenant/session/abc']);
    expect(sent[0].input).toMatchObject({ Bucket: 'b', ServerSideEncryption: 'AES256', ContentType: 'application/octet-stream' });
    await expect(store.get('tenant/session/abc')).resolves.toEqual(Buffer.from('bytes'));
  });

  it('supports KMS and turning SSE off for S3-compatible servers', async () => {
    const kms = fakeS3();
    await new S3BlobStore(kms.client, { bucket: 'b', serverSideEncryption: 'aws:kms', kmsKeyId: 'key-1' }).put('a/b/c', Buffer.from('x'));
    expect(kms.sent[0].input).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'key-1' });
    const none = fakeS3();
    await new S3BlobStore(none.client, { bucket: 'b', serverSideEncryption: 'none' }).put('a/b/c', Buffer.from('x'));
    expect(none.sent[0].input).not.toHaveProperty('ServerSideEncryption');
    expect(() => new S3BlobStore(none.client, { bucket: 'b', serverSideEncryption: 'aws:kms' })).toThrow('S3_KMS_KEY_ID');
    expect(() => new S3BlobStore(none.client, { bucket: '' })).toThrow('S3_BUCKET');
  });

  it('reports a missing object as StoredObjectMissingError, the type readers already handle', async () => {
    const store = new S3BlobStore(fakeS3().client, { bucket: 'b' });
    await expect(store.get('tenant/session/never')).rejects.toBeInstanceOf(StoredObjectMissingError);
  });

  it('does not turn other failures into "missing"', async () => {
    const denied = { send: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }); } };
    await expect(new S3BlobStore(denied as never, { bucket: 'b' }).get('a/b/c')).rejects.toMatchObject({ name: 'AccessDenied' });
  });

  it('deletes idempotently, so a retried erasure can finish', async () => {
    const { client, objects } = fakeS3();
    const store = new S3BlobStore(client, { bucket: 'b' });
    await store.put('a/b/c', Buffer.from('x'));
    await store.delete('a/b/c');
    await store.delete('a/b/c');
    expect(objects.size).toBe(0);
  });

  it.each(['', '../x', '/abs/key', 'a/../b', 'a//b', 'a/./b', 'a b', 'a\nb', 'x'.repeat(400)])('refuses an unsafe key (%#)', async (key) => {
    const store = new S3BlobStore(fakeS3().client, { bucket: 'b' });
    await expect(store.put(key, Buffer.from('x'))).rejects.toThrow('Invalid storage key');
    await expect(store.get(key)).rejects.toThrow('Invalid storage key');
    await expect(store.delete(key)).rejects.toThrow('Invalid storage key');
  });
});

describe('StorageService over S3', () => {
  it('only ever hands S3 ciphertext, and round-trips through it', async () => {
    const { client, objects } = fakeS3();
    const storage = new StorageService(config({ STORAGE_ENCRYPTION_KEY: KEY }), new S3BlobStore(client, { bucket: 'b' }));
    const secret = Buffer.from('a very recognisable passport photo');
    await storage.put('t/s/1', secret);
    const stored = [...objects.values()][0];
    expect(stored.includes(secret)).toBe(false); // nothing readable reaches the bucket
    expect(stored.length).toBeGreaterThan(secret.length);
    await expect(storage.get('t/s/1')).resolves.toEqual(secret);
  });

  it('detects tampering with a stored object', async () => {
    const { client, objects } = fakeS3();
    const storage = new StorageService(config({ STORAGE_ENCRYPTION_KEY: KEY }), new S3BlobStore(client, { bucket: 'b' }));
    await storage.put('t/s/1', Buffer.from('payload'));
    const [k, v] = [...objects.entries()][0];
    v[v.length - 1] ^= 0xff;
    objects.set(k, v);
    await expect(storage.get('t/s/1')).rejects.toThrow();
  });

  it('surfaces a missing object as StoredObjectMissingError', async () => {
    const storage = new StorageService(config({ STORAGE_ENCRYPTION_KEY: KEY }), new S3BlobStore(fakeS3().client, { bucket: 'b' }));
    await expect(storage.get('t/s/none')).rejects.toBeInstanceOf(StoredObjectMissingError);
  });

  describe('configuration', () => {
    const base = { STORAGE_ENCRYPTION_KEY: KEY, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_REGION: 'eu-central-1' };
    it('builds an S3 store from environment-style settings', () => {
      expect(() => new StorageService(config(base))).not.toThrow();
      expect(() => new StorageService(config({ ...base, S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' }))).not.toThrow();
    });
    it.each([
      [{ S3_REGION: '' }, 'S3_REGION'],
      [{ S3_BUCKET: '' }, 'S3_BUCKET'],
      [{ S3_ACCESS_KEY_ID: 'only-one' }, 'both S3_ACCESS_KEY_ID'],
      [{ S3_SSE: 'weird' }, 'S3_SSE'],
      [{ STORAGE_DRIVER: 'floppy' }, 'STORAGE_DRIVER'],
    ])('refuses bad settings %j', (extra, message) => {
      expect(() => new StorageService(config({ ...base, ...extra }))).toThrow(message);
    });
    it('keeps local disk as the default', () => {
      expect(() => new StorageService(config({ STORAGE_ENCRYPTION_KEY: KEY }))).not.toThrow();
    });
  });
});
