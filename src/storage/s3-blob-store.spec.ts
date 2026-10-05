import { DeleteObjectCommand, GetBucketVersioningCommand, GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { StoredObjectMissingError } from './blob-store';
import { ErasureNotVerifiableError, S3BlobStore } from './s3-blob-store';
import { StorageService } from './storage.service';

/** An in-memory stand-in for S3: no network, no credentials. */
function fakeS3(opts: { versioning?: 'Enabled' | 'Suspended'; versioningError?: string; pageSize?: number } = {}) {
  const objects = new Map<string, Buffer>();
  // For a versioned bucket: every version and delete marker, by key
  const versions: { key: string; id: string; marker: boolean }[] = [];
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
      if (command instanceof GetBucketVersioningCommand) {
        sent.push({ cmd: 'getVersioning', input: c.input });
        if (opts.versioningError) throw Object.assign(new Error(opts.versioningError), { name: opts.versioningError });
        return opts.versioning ? { Status: opts.versioning } : {};
      }
      if (command instanceof ListObjectVersionsCommand) {
        sent.push({ cmd: 'listVersions', input: c.input });
        const prefix = c.input.Prefix as string;
        const all = versions.filter((v) => v.key.startsWith(prefix));
        const start = c.input.VersionIdMarker ? all.findIndex((v) => v.id === c.input.VersionIdMarker) + 1 : 0;
        const size = opts.pageSize ?? 1000;
        const page = all.slice(start, start + size);
        const truncated = start + size < all.length;
        return {
          Versions: page.filter((v) => !v.marker).map((v) => ({ Key: v.key, VersionId: v.id })),
          DeleteMarkers: page.filter((v) => v.marker).map((v) => ({ Key: v.key, VersionId: v.id })),
          IsTruncated: truncated,
          NextKeyMarker: truncated ? page[page.length - 1].key : undefined,
          NextVersionIdMarker: truncated ? page[page.length - 1].id : undefined,
        };
      }
      if (command instanceof DeleteObjectCommand) {
        sent.push({ cmd: 'delete', input: c.input });
        if (c.input.VersionId) {
          const i = versions.findIndex((v) => v.key === c.input.Key && v.id === c.input.VersionId);
          if (i >= 0) versions.splice(i, 1);
          return {};
        }
        objects.delete(bucketKey); // like S3: success even when the key is absent
        if (opts.versioning) versions.push({ key: c.input.Key as string, id: `m${versions.length}`, marker: true }); // only a marker
        return {};
      }
      throw new Error('unexpected command');
    },
  };
  return { client: client as never, objects, sent, versions };
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

  it('does not mistake a missing or misspelled bucket for an erased document', async () => {
    const noBucket = { send: async () => { throw Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }); } };
    await expect(new S3BlobStore(noBucket as never, { bucket: 'typo' }).get('a/b/c')).rejects.toMatchObject({ name: 'NoSuchBucket' });
    // A bare 404 whose name does not say "object" is not proof either
    const odd = { send: async () => { throw Object.assign(new Error('x'), { name: 'SomethingElse', $metadata: { httpStatusCode: 404 } }); } };
    await expect(new S3BlobStore(odd as never, { bucket: 'b' }).get('a/b/c')).rejects.not.toBeInstanceOf(StoredObjectMissingError);
  });

  it.each([
    ['/', ''],
    ['//', ''],
    ['  ', ''],
    [undefined, ''],
    ['prod', 'prod/'],
    ['/prod/eu/', 'prod/eu/'],
  ])('normalises the prefix %j to %j', async (prefix, expected) => {
    expect(S3BlobStore.normalizePrefix(prefix)).toBe(expected);
    const { client, objects } = fakeS3();
    await new S3BlobStore(client, { bucket: 'b', prefix }).put('t/s/1', Buffer.from('x'));
    expect([...objects.keys()]).toEqual([`b/${expected}t/s/1`]); // never a key that starts with a slash
  });

  it.each(['a//b', 'a/../b', './a', 'a/./b', 'a b', 'a\nb', '..'])('rejects the prefix %j', (prefix) => {
    expect(() => S3BlobStore.normalizePrefix(prefix)).toThrow('S3_KEY_PREFIX');
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
    it('refuses to fall back to the face-match user’s AWS keys', () => {
      expect(() => new StorageService(config({ ...base, AWS_ACCESS_KEY_ID: 'face-user' }))).toThrow('AWS_ACCESS_KEY_ID');
      // Dedicated keys make that irrelevant, and so does being on a role (no AWS_ACCESS_KEY_ID at all)
      expect(() => new StorageService(config({ ...base, AWS_ACCESS_KEY_ID: 'face-user', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' }))).not.toThrow();
      expect(() => new StorageService(config({ ...base, AWS_ACCESS_KEY_ID: '' }))).not.toThrow();
    });
    it('keeps local disk as the default', () => {
      expect(() => new StorageService(config({ STORAGE_ENCRYPTION_KEY: KEY }))).not.toThrow();
    });
  });
});

describe('S3BlobStore erasure and bucket versioning', () => {
  const put = async (store: S3BlobStore, versions: ReturnType<typeof fakeS3>['versions'], key: string, n: number) => {
    for (let i = 0; i < n; i++) versions.push({ key: `b/${key}`.replace('b/', ''), id: `v${versions.length}`, marker: false });
    await store.put(key, Buffer.from('x'));
  };

  it('deletes with one request when the bucket is not versioned, and asks only once in a while', async () => {
    const s3 = fakeS3();
    const store = new S3BlobStore(s3.client, { bucket: 'b' });
    await store.put('a/1', Buffer.from('x'));
    await store.put('a/2', Buffer.from('x'));
    await store.delete('a/1');
    await store.delete('a/2');
    expect(s3.sent.filter((c) => c.cmd === 'getVersioning')).toHaveLength(1); // cached
    expect(s3.sent.filter((c) => c.cmd === 'delete')).toHaveLength(2);
    expect(s3.sent.some((c) => c.cmd === 'listVersions')).toBe(false);
  });

  it.each(['Enabled', 'Suspended'] as const)('removes every version and marker of the object when versioning is %s', async (versioning) => {
    const s3 = fakeS3({ versioning });
    const store = new S3BlobStore(s3.client, { bucket: 'b', prefix: 'p' });
    await put(store, s3.versions, 'p/doc', 3);
    s3.versions.push({ key: 'p/doc', id: 'marker-1', marker: true });
    s3.versions.push({ key: 'p/doc2', id: 'other', marker: false }); // a different object that shares the start of the name
    await store.delete('doc');
    expect(s3.versions.map((v) => v.key)).toEqual(['p/doc2']); // only the other object is left
    expect(s3.sent.filter((c) => c.cmd === 'delete').every((c) => c.input.VersionId)).toBe(true); // by version id, never a bare delete
  });

  it('follows pages of versions', async () => {
    const s3 = fakeS3({ versioning: 'Enabled', pageSize: 2 });
    const store = new S3BlobStore(s3.client, { bucket: 'b' });
    await put(store, s3.versions, 'doc', 5);
    await store.delete('doc');
    expect(s3.versions.filter((v) => v.key === 'doc')).toHaveLength(0);
  });

  it('is idempotent for an object that is already gone', async () => {
    const s3 = fakeS3({ versioning: 'Enabled' });
    const store = new S3BlobStore(s3.client, { bucket: 'b' });
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
  });

  it('refuses to claim an erasure it cannot verify, and deletes nothing', async () => {
    const s3 = fakeS3({ versioningError: 'AccessDenied' });
    const store = new S3BlobStore(s3.client, { bucket: 'b' });
    await store.put('doc', Buffer.from('x'));
    const err = await store.delete('doc').catch((e) => e);
    expect(err).toBeInstanceOf(ErasureNotVerifiableError);
    expect(err.message).toContain('s3:GetBucketVersioning');
    expect(s3.sent.some((c) => c.cmd === 'delete')).toBe(false);
  });

  it('treats a server without versioning support (not implemented) as unversioned', async () => {
    const s3 = fakeS3({ versioningError: 'NotImplemented' });
    const store = new S3BlobStore(s3.client, { bucket: 'b' });
    await store.put('doc', Buffer.from('x'));
    await store.delete('doc');
    expect(s3.objects.size).toBe(0);
  });

  it('can be told not to ask (versioning known to be off, permission not granted)', async () => {
    const s3 = fakeS3({ versioningError: 'AccessDenied' });
    const store = new S3BlobStore(s3.client, { bucket: 'b', versioningCheck: 'off' });
    await store.put('doc', Buffer.from('x'));
    await store.delete('doc');
    expect(s3.sent.some((c) => c.cmd === 'getVersioning')).toBe(false);
    expect(s3.objects.size).toBe(0);
  });

  it('is configured from S3_VERSIONING_CHECK', () => {
    const svc = (v: Record<string, string>) =>
      new StorageService(config({ STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_REGION: 'eu-central-1', STORAGE_ENCRYPTION_KEY: KEY, ...v }));
    const optsOf = (s: StorageService) => ((s as unknown as { store: { opts: { versioningCheck: string } } }).store.opts.versioningCheck);
    expect(optsOf(svc({}))).toBe('auto');
    expect(optsOf(svc({ S3_VERSIONING_CHECK: 'off' }))).toBe('off');
  });
});
