import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { encrypt as legacyEncrypt } from '../common/crypto';
import { LocalBlobStore } from './blob-store';
import { EnvKeyProvider, KeyUnavailableError, KmsKeyProvider, StoredObjectCorruptError, formatOf } from './keys';
import { StorageService, sealContext } from './storage.service';

/**
 * An in-memory stand-in for AWS KMS: no network, no credentials. Like the real service it refuses
 * to unwrap a data key under a different encryption context or key id, and its "master key" never
 * leaves this object.
 */
function fakeKms(keyId = 'arn:aws:kms:eu-central-1:111122223333:key/test') {
  const master = randomBytes(32);
  const log: { op: 'generate' | 'decrypt'; context: Record<string, string>; keyId?: string }[] = [];
  const state: { fail?: string; issuedKeys: Buffer[]; returned: Uint8Array[] } = { issuedKeys: [], returned: [] };
  const aadOf = (c: Record<string, string> | undefined) => Buffer.from(JSON.stringify(Object.entries(c ?? {}).sort()));
  const client = {
    send: async (cmd: unknown) => {
      if (state.fail) throw Object.assign(new Error(state.fail), { name: state.fail });
      if (cmd instanceof GenerateDataKeyCommand) {
        const input = cmd.input;
        log.push({ op: 'generate', context: input.EncryptionContext as Record<string, string>, keyId: input.KeyId });
        const dek = randomBytes(32);
        state.issuedKeys.push(Buffer.from(dek));
        const iv = randomBytes(12);
        const c = createCipheriv('aes-256-gcm', master, iv);
        c.setAAD(aadOf(input.EncryptionContext as Record<string, string>));
        const blob = Buffer.concat([iv, c.update(dek), c.final(), c.getAuthTag()]);
        const out = new Uint8Array(dek);
        state.returned.push(out);
        return { Plaintext: out, CiphertextBlob: new Uint8Array(blob) };
      }
      if (cmd instanceof DecryptCommand) {
        const input = cmd.input;
        log.push({ op: 'decrypt', context: input.EncryptionContext as Record<string, string>, keyId: input.KeyId });
        try {
          if (input.KeyId !== keyId) throw new Error('wrong key');
          const blob = Buffer.from(input.CiphertextBlob as Uint8Array);
          const d = createDecipheriv('aes-256-gcm', master, blob.subarray(0, 12));
          d.setAAD(aadOf(input.EncryptionContext as Record<string, string>));
          d.setAuthTag(blob.subarray(blob.length - 16));
          const dek = Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
          const out = new Uint8Array(dek);
          state.returned.push(out);
          return { Plaintext: out };
        } catch {
          throw Object.assign(new Error('invalid'), { name: 'InvalidCiphertextException' });
        }
      }
      throw new Error('unexpected command');
    },
  };
  return { client: client as never, log, state, keyId };
}

const KEY = 'tenant-1/session-1/object-1';
const ctx = (key = KEY) => sealContext(key);
const secret = Buffer.from('a very recognisable passport photo');

describe('KmsKeyProvider', () => {
  const make = (over: Partial<ConstructorParameters<typeof KmsKeyProvider>[1]> = {}) => {
    const kms = fakeKms();
    const provider = new KmsKeyProvider(kms.client, { keyId: kms.keyId, ...over });
    return { kms, provider };
  };

  it('stores a wrapped data key next to the ciphertext, never the plaintext key or the data', async () => {
    const { kms, provider } = make();
    const sealed = await provider.seal(secret, ctx());
    expect(formatOf(sealed)).toBe('kms-v1');
    expect(sealed.includes(secret)).toBe(false);
    for (const dek of kms.state.issuedKeys) expect(sealed.includes(dek)).toBe(false); // only the wrapped copy is stored
    expect(await provider.open(sealed, ctx())).toEqual(secret);
  });

  it('uses a fresh data key for every object', async () => {
    const { kms, provider } = make();
    const a = await provider.seal(secret, ctx());
    const b = await provider.seal(secret, ctx());
    expect(a.equals(b)).toBe(false);
    expect(kms.state.issuedKeys).toHaveLength(2);
    expect(kms.state.issuedKeys[0].equals(kms.state.issuedKeys[1])).toBe(false);
  });

  it('binds data keys to the tenant and session in the KMS encryption context, and to our key id', async () => {
    const { kms, provider } = make();
    const sealed = await provider.seal(secret, ctx());
    await provider.open(sealed, ctx());
    expect(kms.log[0]).toMatchObject({ op: 'generate', keyId: kms.keyId, context: { app: 'verify-service', purpose: 'document', tenant: 'tenant-1', session: 'session-1' } });
    expect(kms.log[1]).toMatchObject({ op: 'decrypt', keyId: kms.keyId, context: { tenant: 'tenant-1', session: 'session-1' } });
  });

  it('will not open an object under another tenant or session, even with the right ciphertext', async () => {
    const { provider } = make({ cacheSeconds: 0 });
    const sealed = await provider.seal(secret, ctx());
    await expect(provider.open(sealed, ctx('tenant-2/session-1/object-1'))).rejects.toBeInstanceOf(StoredObjectCorruptError);
    await expect(provider.open(sealed, ctx('tenant-1/session-2/object-1'))).rejects.toBeInstanceOf(StoredObjectCorruptError);
    // Same tenant and session but a different object name: the GCM binding to the storage key refuses it
    await expect(provider.open(sealed, ctx('tenant-1/session-1/object-2'))).rejects.toBeInstanceOf(StoredObjectCorruptError);
  });

  it('detects tampering with the ciphertext, the tag, the wrapped key or the header', async () => {
    const { provider } = make({ cacheSeconds: 0 });
    const sealed = await provider.seal(secret, ctx());
    for (const at of [sealed.length - 1, 6, 8, 5]) {
      const bad = Buffer.from(sealed);
      bad[at] ^= 0xff;
      await expect(provider.open(bad, ctx())).rejects.toThrow();
    }
    await expect(provider.open(sealed.subarray(0, 20), ctx())).rejects.toThrow();
    await expect(provider.open(Buffer.concat([Buffer.from('VSE1'), Buffer.from([0, 0])]), ctx())).rejects.toThrow();
  });

  it('keeps a data key briefly, so reading one document several times asks KMS once', async () => {
    let t = 1_000_000;
    const { kms, provider } = make({ cacheSeconds: 60, now: () => t });
    const sealed = await provider.seal(secret, ctx());
    for (let i = 0; i < 3; i++) await provider.open(sealed, ctx());
    expect(kms.log.filter((l) => l.op === 'decrypt')).toHaveLength(1);
    t += 61_000;
    await provider.open(sealed, ctx()); // expired: asks again
    expect(kms.log.filter((l) => l.op === 'decrypt')).toHaveLength(2);
  });

  it('never serves a cached key for a different context', async () => {
    const { kms, provider } = make({ cacheSeconds: 60 });
    const sealed = await provider.seal(secret, ctx());
    await provider.open(sealed, ctx());
    await expect(provider.open(sealed, ctx('tenant-2/session-1/object-1'))).rejects.toThrow();
    expect(kms.log.filter((l) => l.op === 'decrypt')).toHaveLength(2); // the second attempt went to KMS, which refused
  });

  it('can turn the cache off, forget it on demand, and bounds its size', async () => {
    const off = make({ cacheSeconds: 0 });
    const sealed = await off.provider.seal(secret, ctx());
    await off.provider.open(sealed, ctx());
    await off.provider.open(sealed, ctx());
    expect(off.kms.log.filter((l) => l.op === 'decrypt')).toHaveLength(2);

    const on = make({ cacheSeconds: 60 });
    const s2 = await on.provider.seal(secret, ctx());
    await on.provider.open(s2, ctx());
    on.provider.clearCache();
    await on.provider.open(s2, ctx());
    expect(on.kms.log.filter((l) => l.op === 'decrypt')).toHaveLength(2);

    const small = make({ cacheSeconds: 60, maxCached: 2 });
    const objs = await Promise.all([1, 2, 3].map((i) => small.provider.seal(secret, ctx(`t/s/o${i}`))));
    for (const [i, o] of objs.entries()) await small.provider.open(o, ctx(`t/s/o${i + 1}`));
    await small.provider.open(objs[0], ctx('t/s/o1')); // evicted by the third: asks again
    expect(small.kms.log.filter((l) => l.op === 'decrypt')).toHaveLength(4);
  });

  it.each(['AccessDeniedException', 'DisabledException', 'KMSInvalidStateException', 'ThrottlingException', 'KeyUnavailableException', 'CredentialsProviderError'])(
    'treats %s as "key service unavailable", not as damaged data',
    async (failure) => {
      const { kms, provider } = make({ cacheSeconds: 0 });
      const sealed = await provider.seal(secret, ctx());
      kms.state.fail = failure;
      await expect(provider.open(sealed, ctx())).rejects.toBeInstanceOf(KeyUnavailableError);
      await expect(provider.seal(secret, ctx())).rejects.toBeInstanceOf(KeyUnavailableError);
      kms.state.fail = undefined;
      expect(await provider.open(sealed, ctx())).toEqual(secret); // the data was never touched
    },
  );

  it('treats an unknown failure (network, timeout) as unavailable too, with no details of the call', async () => {
    const { kms, provider } = make({ cacheSeconds: 0 });
    const sealed = await provider.seal(secret, ctx());
    kms.state.fail = 'TimeoutError';
    const err = await provider.open(sealed, ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(KeyUnavailableError);
    expect(JSON.stringify(err) + err.message).not.toContain('tenant-1');
  });

  describe('no cache by default: revocation is immediate and every read is audited', () => {
    it('asks KMS on every read, and a revoked key stops reads at once', async () => {
      const { kms, provider } = make(); // default settings
      const sealed = await provider.seal(secret, ctx());
      for (let i = 0; i < 3; i++) await provider.open(sealed, ctx());
      expect(kms.log.filter((l) => l.op === 'decrypt')).toHaveLength(3); // one audit event per read
      kms.state.fail = 'AccessDeniedException'; // access revoked
      await expect(provider.open(sealed, ctx())).rejects.toBeInstanceOf(KeyUnavailableError);
    });

    it('with an opt-in cache, reads continue for that long after revocation (and are not logged), then stop', async () => {
      let t = 1_000_000;
      const { kms, provider } = make({ cacheSeconds: 30, now: () => t });
      const sealed = await provider.seal(secret, ctx());
      await provider.open(sealed, ctx());
      kms.state.fail = 'AccessDeniedException';
      expect(await provider.open(sealed, ctx())).toEqual(secret); // the documented cost of caching
      expect(kms.log.filter((l) => l.op === 'decrypt')).toHaveLength(1);
      t += 31_000;
      await expect(provider.open(sealed, ctx())).rejects.toBeInstanceOf(KeyUnavailableError);
    });

    it('is off unless KMS_DEK_CACHE_SECONDS says otherwise', () => {
      const config = (v: Record<string, string>) => ({ get: (k: string) => v[k] }) as unknown as ConfigService;
      const base = { STORAGE_KEY_PROVIDER: 'kms', KMS_KEY_ID: 'alias/x', KMS_REGION: 'eu-central-1' };
      const ttl = (extra: Record<string, string>) => (new StorageService(config({ ...base, ...extra })) as unknown as { keys: { ttlMs: number } }).keys.ttlMs;
      expect(ttl({})).toBe(0);
      expect(ttl({ KMS_DEK_CACHE_SECONDS: 'abc' })).toBe(0);
      expect(ttl({ KMS_DEK_CACHE_SECONDS: '-5' })).toBe(0);
      expect(ttl({ KMS_DEK_CACHE_SECONDS: '45' })).toBe(45_000);
    });
  });

  describe('data-key lifetime', () => {
    it('zeroes the key material it was handed by the service', async () => {
      const { kms, provider } = make();
      const sealed = await provider.seal(secret, ctx());
      await provider.open(sealed, ctx());
      expect(kms.state.returned.length).toBeGreaterThanOrEqual(2); // generate and decrypt
      for (const arr of kms.state.returned) expect([...arr].every((b) => b === 0)).toBe(true);
    });

    it('never lets an eviction or expiry zero a key another read is using', async () => {
      let t = 1_000_000;
      const { provider } = make({ cacheSeconds: 1, maxCached: 1, now: () => t });
      const objs = await Promise.all([1, 2, 3, 4].map((i) => provider.seal(secret, ctx(`t/s/o${i}`))));
      for (let round = 0; round < 5; round++) {
        t += round % 2 ? 2000 : 0; // some rounds expire everything mid-flight
        const reads = await Promise.all(objs.flatMap((o, i) => [provider.open(o, ctx(`t/s/o${i + 1}`)), provider.open(o, ctx(`t/s/o${i + 1}`))]));
        for (const r of reads) expect(r).toEqual(secret); // before the fix a shared, zeroed key made some of these fail
      }
    });

    it('serves a cached key as a copy, so using it never damages the cached one', async () => {
      const { provider } = make({ cacheSeconds: 60 });
      const sealed = await provider.seal(secret, ctx());
      for (let i = 0; i < 4; i++) expect(await provider.open(sealed, ctx())).toEqual(secret);
    });
  });

  it('needs a key id', () => {
    expect(() => new KmsKeyProvider(fakeKms().client, { keyId: '' })).toThrow('KMS_KEY_ID');
  });

  describe('objects written before KMS was switched on', () => {
    const master = randomBytes(32);
    const legacy = () => new EnvKeyProvider(master);
    const oldObject = () => legacyEncrypt(master, secret); // the original format: no header, nothing bound

    it('can still be read when the old master key is supplied, and are reported as not current', async () => {
      const { provider } = make({ legacy: legacy() });
      const old = oldObject();
      expect(await provider.open(old, ctx())).toEqual(secret);
      expect(await provider.isCurrent(old, ctx())).toBe(false);
      expect(await provider.isCurrent(await provider.seal(secret, ctx()), ctx())).toBe(true);
      const v0 = await legacy().seal(secret, ctx());
      expect(await provider.open(v0, ctx())).toEqual(secret);
      expect(await provider.isCurrent(v0, ctx())).toBe(false);
    });

    it('say clearly what is missing when the old key is not supplied', async () => {
      const { provider } = make();
      await expect(provider.open(oldObject(), ctx())).rejects.toThrow('STORAGE_ENCRYPTION_KEY');
    });

    // An original-format object has a random 12-byte IV, so its first four bytes can equal a marker by chance
    const craftedLegacy = (marker: string) => {
      const iv = Buffer.concat([Buffer.from(marker), randomBytes(8)]);
      const c = createCipheriv('aes-256-gcm', master, iv);
      const ct = Buffer.concat([c.update(secret), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    };

    it('are never mistaken for current just because their first bytes look like a marker', async () => {
      const { provider } = make({ legacy: legacy() });
      const looksKms = craftedLegacy('VSE1');
      expect(formatOf(looksKms)).toBe('kms-v1');
      expect(await provider.isCurrent(looksKms, ctx())).toBe(false); // it does not actually open as KMS
      expect(await provider.open(looksKms, ctx())).toEqual(secret);
      const env = legacy();
      const looksV0 = craftedLegacy('VSE0');
      expect(formatOf(looksV0)).toBe('env-v0');
      expect(await env.isCurrent(looksV0, ctx())).toBe(false);
      expect(await env.open(looksV0, ctx())).toEqual(secret);
      // ...and a damaged object is not "current" either
      const real = await provider.seal(secret, ctx());
      const bad = Buffer.from(real);
      bad[bad.length - 1] ^= 1;
      expect(await provider.isCurrent(bad, ctx())).toBe(false);
    });

    it('reports an unreachable key service as an error, not as "stale" or "current"', async () => {
      const { kms, provider } = make({ legacy: legacy() });
      const sealed = await provider.seal(secret, ctx());
      kms.state.fail = 'ThrottlingException';
      await expect(provider.isCurrent(sealed, ctx())).rejects.toBeInstanceOf(KeyUnavailableError);
    });

    it('survive the one-in-four-billion case of starting with the KMS marker', async () => {
      const { provider } = make({ legacy: legacy() });
      // A legacy object is iv|tag|ct, so craft one whose random IV happens to start with "VSE1"
      const iv = Buffer.concat([Buffer.from('VSE1'), randomBytes(8)]);
      const c = createCipheriv('aes-256-gcm', master, iv);
      const ct = Buffer.concat([c.update(secret), c.final()]);
      const blob = Buffer.concat([iv, c.getAuthTag(), ct]);
      expect(formatOf(blob)).toBe('kms-v1');
      expect(await provider.open(blob, ctx())).toEqual(secret);
    });
  });
});

describe('EnvKeyProvider', () => {
  const key = randomBytes(32);

  it('binds new objects to their storage key', async () => {
    const p = new EnvKeyProvider(key);
    const sealed = await p.seal(secret, ctx());
    expect(formatOf(sealed)).toBe('env-v0');
    expect(sealed.includes(secret)).toBe(false);
    expect(await p.open(sealed, ctx())).toEqual(secret);
    await expect(p.open(sealed, ctx('tenant-9/session-9/object-9'))).rejects.toBeInstanceOf(StoredObjectCorruptError); // a moved object
  });

  it('still reads the original format, and says what to do with a KMS object', async () => {
    const p = new EnvKeyProvider(key);
    expect(await p.open(legacyEncrypt(key, secret), ctx())).toEqual(secret);
    expect(await p.isCurrent(legacyEncrypt(key, secret), ctx())).toBe(false);
    await expect(p.open(await new KmsKeyProvider(fakeKms().client, { keyId: 'k' }).seal(secret, ctx()), ctx())).rejects.toThrow('STORAGE_KEY_PROVIDER=kms');
  });

  it('rejects the wrong key and tampered bytes', async () => {
    const p = new EnvKeyProvider(key);
    const sealed = await p.seal(secret, ctx());
    await expect(new EnvKeyProvider(randomBytes(32)).open(sealed, ctx())).rejects.toBeInstanceOf(StoredObjectCorruptError);
    const bad = Buffer.from(sealed);
    bad[bad.length - 1] ^= 1;
    await expect(p.open(bad, ctx())).rejects.toBeInstanceOf(StoredObjectCorruptError);
  });
});

describe('StorageService with KMS', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'kms-store-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const config = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as unknown as ConfigService;

  it('writes only KMS-wrapped ciphertext to the store and reads it back', async () => {
    const kms = fakeKms();
    const storage = new StorageService(config({}), new LocalBlobStore(dir), new KmsKeyProvider(kms.client, { keyId: kms.keyId }));
    expect(storage.keyProvider).toBe('kms');
    await storage.put(KEY, secret);
    const onDisk = readFileSync(join(dir, KEY));
    expect(formatOf(onDisk)).toBe('kms-v1');
    expect(onDisk.includes(secret)).toBe(false);
    expect(await storage.get(KEY)).toEqual(secret);
    expect(await storage.inspect(KEY)).toBe('current');
    await storage.delete(KEY);
    expect(await storage.inspect(KEY)).toBe('missing');
  });

  it('answers "key unavailable" while the key service is down, and recovers without losing anything', async () => {
    const kms = fakeKms();
    const storage = new StorageService(config({}), new LocalBlobStore(dir), new KmsKeyProvider(kms.client, { keyId: kms.keyId, cacheSeconds: 0 }));
    await storage.put(KEY, secret);
    kms.state.fail = 'AccessDeniedException';
    await expect(storage.get(KEY)).rejects.toBeInstanceOf(KeyUnavailableError);
    await expect(storage.put('t/s/other', secret)).rejects.toBeInstanceOf(KeyUnavailableError);
    expect(existsSync(join(dir, 't'))).toBe(false); // a failed seal wrote nothing
    kms.state.fail = undefined;
    expect(await storage.get(KEY)).toEqual(secret);
  });

  describe('rewrap', () => {
    it('moves old-format objects to the current format, once, and leaves current ones alone', async () => {
      const master = randomBytes(32);
      const store = new LocalBlobStore(dir);
      const kms = fakeKms();
      await store.put(KEY, legacyEncrypt(master, secret)); // as written before KMS
      const storage = new StorageService(config({}), store, new KmsKeyProvider(kms.client, { keyId: kms.keyId, legacy: new EnvKeyProvider(master) }));
      expect(await storage.inspect(KEY)).toBe('stale');
      expect(await storage.rewrap(KEY)).toBe('rewrapped');
      expect(formatOf(readFileSync(join(dir, KEY)))).toBe('kms-v1');
      expect(await storage.get(KEY)).toEqual(secret);
      expect(await storage.rewrap(KEY)).toBe('current');
      expect(await storage.rewrap('t/s/never-existed')).toBe('missing');
    });

    it('leaves the old object untouched when it cannot be re-encrypted', async () => {
      const master = randomBytes(32);
      const store = new LocalBlobStore(dir);
      const kms = fakeKms();
      const old = legacyEncrypt(master, secret);
      await store.put(KEY, old);
      const storage = new StorageService(config({}), store, new KmsKeyProvider(kms.client, { keyId: kms.keyId, legacy: new EnvKeyProvider(master) }));
      kms.state.fail = 'ThrottlingException';
      await expect(storage.rewrap(KEY)).rejects.toBeInstanceOf(KeyUnavailableError);
      expect(readFileSync(join(dir, KEY)).equals(old)).toBe(true);
    });
  });
});

describe('storage configuration', () => {
  const base = { STORAGE_KEY_PROVIDER: 'kms', KMS_KEY_ID: 'alias/verify', KMS_REGION: 'eu-central-1' };
  const config = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as unknown as ConfigService;
  const build = (v: Record<string, string>) => new StorageService(config({ STORAGE_DRIVER: 'local', ...v }));

  it('builds a KMS provider from settings, and does not need the master key', () => {
    expect(build(base).keyProvider).toBe('kms');
    expect(build({ ...base, KMS_ACCESS_KEY_ID: 'a', KMS_SECRET_ACCESS_KEY: 'b' }).keyProvider).toBe('kms');
    expect(build({ ...base, S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' }).keyProvider).toBe('kms');
    expect(build({ ...base, STORAGE_ENCRYPTION_KEY: randomBytes(32).toString('base64') }).keyProvider).toBe('kms'); // kept to read old objects
    expect(build({ STORAGE_ENCRYPTION_KEY: randomBytes(32).toString('base64') }).keyProvider).toBe('env');
  });

  it.each([
    [{ KMS_KEY_ID: '' }, 'KMS_KEY_ID'],
    [{ KMS_REGION: '' }, 'KMS_REGION'],
    [{ KMS_ACCESS_KEY_ID: 'only-one' }, 'both KMS_ACCESS_KEY_ID and KMS_SECRET_ACCESS_KEY'],
    [{ KMS_SECRET_ACCESS_KEY: 'only-secret' }, 'both KMS_ACCESS_KEY_ID and KMS_SECRET_ACCESS_KEY'],
    // A partial KMS pair is never completed from the S3 pair
    [{ KMS_ACCESS_KEY_ID: 'kms-id', S3_ACCESS_KEY_ID: 's3-id', S3_SECRET_ACCESS_KEY: 's3-secret' }, 'both KMS_ACCESS_KEY_ID and KMS_SECRET_ACCESS_KEY'],
    [{ KMS_SECRET_ACCESS_KEY: 'kms-secret', S3_ACCESS_KEY_ID: 's3-id', S3_SECRET_ACCESS_KEY: 's3-secret' }, 'both KMS_ACCESS_KEY_ID and KMS_SECRET_ACCESS_KEY'],
    [{ S3_ACCESS_KEY_ID: 'only-s3-id' }, 'both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY'],
    [{ AWS_ACCESS_KEY_ID: 'face-user' }, 'AWS_ACCESS_KEY_ID'],
    [{ STORAGE_KEY_PROVIDER: 'vault' }, 'STORAGE_KEY_PROVIDER'],
    [{ STORAGE_KEY_PROVIDER: 'env', STORAGE_ENCRYPTION_KEY: '' }, 'STORAGE_ENCRYPTION_KEY'],
    [{ STORAGE_KEY_PROVIDER: 'kms', STORAGE_ENCRYPTION_KEY: 'c2hvcnQ=' }, 'must be 32 bytes'],
  ])('refuses bad settings %j', (extra, message) => {
    expect(() => build({ ...base, ...extra })).toThrow(message);
  });
});

/**
 * Two (or more) KMS keys in one stand-in service. Like the real one, a data key wrapped by one key is
 * refused with IncorrectKeyException when another key is named, and each key's wrapped blobs carry
 * their key (the real ciphertext blob does too).
 */
function fakeKmsKeys(ids: string[]) {
  const masters = new Map(ids.map((id) => [id, randomBytes(32)]));
  const aadOf = (c: Record<string, string> | undefined) => Buffer.from(JSON.stringify(Object.entries(c ?? {}).sort()));
  const asked: string[] = [];
  const err = (name: string) => Object.assign(new Error(name), { name });
  const client = {
    send: async (cmd: unknown) => {
      if (cmd instanceof GenerateDataKeyCommand) {
        const id = cmd.input.KeyId as string;
        const master = masters.get(id);
        if (!master) throw err('NotFoundException');
        const dek = randomBytes(32);
        const iv = randomBytes(12);
        const c = createCipheriv('aes-256-gcm', master, iv);
        c.setAAD(aadOf(cmd.input.EncryptionContext as Record<string, string>));
        const body = Buffer.concat([c.update(dek), c.final(), c.getAuthTag()]);
        const tag = Buffer.from(id);
        return { Plaintext: new Uint8Array(dek), CiphertextBlob: new Uint8Array(Buffer.concat([Buffer.from([tag.length]), tag, iv, body])) };
      }
      if (cmd instanceof DecryptCommand) {
        const id = cmd.input.KeyId as string;
        asked.push(id);
        const blob = Buffer.from(cmd.input.CiphertextBlob as Uint8Array);
        const wrappedBy = blob.subarray(1, 1 + blob[0]).toString();
        if (wrappedBy !== id) throw err('IncorrectKeyException');
        const master = masters.get(id);
        if (!master) throw err('NotFoundException');
        try {
          const rest = blob.subarray(1 + blob[0]);
          const d = createDecipheriv('aes-256-gcm', master, rest.subarray(0, 12));
          d.setAAD(aadOf(cmd.input.EncryptionContext as Record<string, string>));
          d.setAuthTag(rest.subarray(rest.length - 16));
          return { Plaintext: new Uint8Array(Buffer.concat([d.update(rest.subarray(12, rest.length - 16)), d.final()])) };
        } catch {
          throw err('InvalidCiphertextException');
        }
      }
      throw new Error('unexpected command');
    },
  };
  return { client: client as never, asked };
}

describe('changing the KMS key', () => {
  const ctxOf = () => ctx();
  const config = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as unknown as ConfigService;

  it('data written under the old key is still readable when the old key is listed as previous', async () => {
    const kms = fakeKmsKeys(['key-old', 'key-new']);
    const sealedOld = await new KmsKeyProvider(kms.client, { keyId: 'key-old' }).seal(secret, ctxOf());
    const now = new KmsKeyProvider(kms.client, { keyId: 'key-new', previousKeyIds: ['key-old'] });
    expect((await now.open(sealedOld, ctxOf())).equals(secret)).toBe(true);
    expect(kms.asked).toEqual(['key-new', 'key-old']); // the current key is tried first
    // readable, but not "current": storage:reencrypt must still move it to the new key
    expect(await now.isCurrent(sealedOld, ctxOf())).toBe(false);
    expect(await now.isCurrent(await now.seal(secret, ctxOf()), ctxOf())).toBe(true);
  });

  it('new data is always sealed with the current key only', async () => {
    const kms = fakeKmsKeys(['key-old', 'key-new']);
    const now = new KmsKeyProvider(kms.client, { keyId: 'key-new', previousKeyIds: ['key-old'] });
    const sealed = await now.seal(secret, ctxOf());
    expect((await new KmsKeyProvider(kms.client, { keyId: 'key-new' }).open(sealed, ctxOf())).equals(secret)).toBe(true);
    await expect(new KmsKeyProvider(kms.client, { keyId: 'key-old' }).open(sealed, ctxOf())).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('without the old key listed, objects are "unavailable with a hint", never reported as corrupt', async () => {
    const kms = fakeKmsKeys(['key-old', 'key-new']);
    const sealedOld = await new KmsKeyProvider(kms.client, { keyId: 'key-old' }).seal(secret, ctxOf());
    const err = await new KmsKeyProvider(kms.client, { keyId: 'key-new' }).open(sealedOld, ctxOf()).catch((e) => e);
    expect(err).toBeInstanceOf(KeyUnavailableError);
    expect(err).not.toBeInstanceOf(StoredObjectCorruptError);
    expect(err.message).toContain('KMS_PREVIOUS_KEY_IDS');
  });

  it('real damage is still reported as corrupt, with or without previous keys', async () => {
    const kms = fakeKmsKeys(['key-old', 'key-new']);
    const p = new KmsKeyProvider(kms.client, { keyId: 'key-new', previousKeyIds: ['key-old'] });
    const sealed = await p.seal(secret, ctxOf());
    const bad = Buffer.from(sealed);
    bad[bad.length - 1] ^= 1; // flips a bit in the encrypted body
    await expect(p.open(bad, ctxOf())).rejects.toBeInstanceOf(StoredObjectCorruptError);
    // and a context for a different session still fails, under any key
    await expect(p.open(sealed, ctx('tenant-1/other-session/object-1'))).rejects.toBeInstanceOf(StoredObjectCorruptError);
  });

  it('is read from KMS_PREVIOUS_KEY_IDS, separated by commas or spaces', () => {
    const svc = new StorageService(
      config({ STORAGE_KEY_PROVIDER: 'kms', KMS_KEY_ID: 'alias/new', KMS_REGION: 'eu-central-1', KMS_PREVIOUS_KEY_IDS: 'arn:aws:kms:eu-central-1:1:key/a, alias/b  alias/c' }),
      new LocalBlobStore(mkdtempSync(join(tmpdir(), 'prev-'))),
    );
    const keys = (svc as unknown as { keys: { opts: { previousKeyIds?: string[] } } }).keys;
    expect(keys.opts.previousKeyIds).toEqual(['arn:aws:kms:eu-central-1:1:key/a', 'alias/b', 'alias/c']);
  });
});
