import { KMSClient } from '@aws-sdk/client-kms';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { BlobStore, LocalBlobStore, StoredObjectMissingError } from './blob-store';
import { EnvKeyProvider, KeyProvider, KeyUnavailableError, KmsKeyProvider, SealContext, StoredObjectCorruptError } from './keys';
import { S3BlobStore } from './s3-blob-store';

export { KeyUnavailableError, StoredObjectCorruptError, StoredObjectMissingError };

/** Optional injection tokens for ready-made parts (tests); normally both are built from configuration. */
export const BLOB_STORE = Symbol('BLOB_STORE');
export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

export interface DocumentStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** What an object is bound to: its own storage key (`tenant/session/uuid`), and its tenant and session in KMS. */
export function sealContext(key: string): SealContext {
  const [tenant, session] = key.split('/');
  return {
    aad: key,
    kmsContext: { app: 'verify-service', purpose: 'document', ...(tenant && session ? { tenant, session } : {}) },
  };
}

/**
 * Encrypts every object before it leaves the process and hands the ciphertext to a store: local
 * disk (development) or S3-compatible object storage (`STORAGE_DRIVER=s3`). The key is either the
 * master key from STORAGE_ENCRYPTION_KEY, or AWS KMS envelope encryption (STORAGE_KEY_PROVIDER=kms),
 * which is what production should use.
 */
@Injectable()
export class StorageService implements DocumentStorage {
  private readonly store: BlobStore;
  private readonly keys: KeyProvider;

  /** `store` and `keys` can be injected for tests; otherwise they are chosen from configuration. */
  constructor(config: ConfigService, @Optional() @Inject(BLOB_STORE) store?: BlobStore, @Optional() @Inject(KEY_PROVIDER) keys?: KeyProvider) {
    this.keys = keys ?? StorageService.keysFromConfig(config);
    this.store = store ?? StorageService.storeFromConfig(config);
  }

  private static masterKey(config: ConfigService, required: boolean): EnvKeyProvider | undefined {
    const raw = config.get<string>('STORAGE_ENCRYPTION_KEY');
    if (!raw) {
      if (required) throw new Error('STORAGE_ENCRYPTION_KEY is required');
      return undefined;
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('STORAGE_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    return new EnvKeyProvider(key);
  }

  private static keysFromConfig(config: ConfigService): KeyProvider {
    const provider = config.get<string>('STORAGE_KEY_PROVIDER') || 'env';
    if (provider === 'env') return this.masterKey(config, true)!;
    if (provider !== 'kms') throw new Error(`Unknown STORAGE_KEY_PROVIDER "${provider}"`);

    const keyId = config.get<string>('KMS_KEY_ID');
    if (!keyId) throw new Error('KMS_KEY_ID is required when STORAGE_KEY_PROVIDER=kms');
    const region = config.get<string>('KMS_REGION') || config.get<string>('S3_REGION') || config.get<string>('AWS_REGION');
    if (!region) throw new Error('KMS_REGION is required when STORAGE_KEY_PROVIDER=kms');
    // Dedicated KMS_* keys if either is set (then both are required and used alone), else the storage
    // user's S3_* pair (both or neither), else a role. Fields are never mixed between the two.
    const kmsId = config.get<string>('KMS_ACCESS_KEY_ID');
    const kmsSecret = config.get<string>('KMS_SECRET_ACCESS_KEY');
    const s3Id = config.get<string>('S3_ACCESS_KEY_ID');
    const s3Secret = config.get<string>('S3_SECRET_ACCESS_KEY');
    let id: string | undefined;
    let secret: string | undefined;
    if (kmsId || kmsSecret) {
      if (!kmsId || !kmsSecret) throw new Error('Set both KMS_ACCESS_KEY_ID and KMS_SECRET_ACCESS_KEY, or neither');
      [id, secret] = [kmsId, kmsSecret];
    } else if (s3Id || s3Secret) {
      if (!s3Id || !s3Secret) throw new Error('Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither');
      [id, secret] = [s3Id, s3Secret];
    }
    if (!id && config.get<string>('AWS_ACCESS_KEY_ID')) {
      throw new Error('AWS_ACCESS_KEY_ID is set (used by face matching) but no KMS_ACCESS_KEY_ID or S3_ACCESS_KEY_ID: set dedicated keys for encryption, or run under an IAM role without AWS_ACCESS_KEY_ID in its environment');
    }
    const cache = parseInt(config.get<string>('KMS_DEK_CACHE_SECONDS') ?? '', 10);
    return new KmsKeyProvider(new KMSClient({ region, ...(id && secret ? { credentials: { accessKeyId: id, secretAccessKey: secret } } : {}) }), {
      keyId,
      // Off unless asked for: see KmsOptions.cacheSeconds for what a cache costs in revocation and audit
      cacheSeconds: Number.isFinite(cache) && cache >= 0 ? cache : 0,
      // Only to read (and re-encrypt) objects written before KMS was switched on
      legacy: this.masterKey(config, false),
    });
  }

  private static storeFromConfig(config: ConfigService): BlobStore {
    const driver = config.get<string>('STORAGE_DRIVER') ?? 'local';
    if (driver === 'local') return new LocalBlobStore(config.get<string>('STORAGE_LOCAL_DIR') ?? './storage');
    if (driver !== 's3') throw new Error(`Unknown STORAGE_DRIVER "${driver}"`);

    const region = config.get<string>('S3_REGION');
    if (!region) throw new Error('S3_REGION is required when STORAGE_DRIVER=s3');
    const accessKeyId = config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('S3_SECRET_ACCESS_KEY');
    if (!!accessKeyId !== !!secretAccessKey) throw new Error('Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither');
    if (!accessKeyId && config.get<string>('AWS_ACCESS_KEY_ID')) {
      // With no dedicated keys the SDK would silently use AWS_ACCESS_KEY_ID, which belongs to the
      // face-match user and has no S3 permission. Refuse, rather than fail later with AccessDenied.
      throw new Error('AWS_ACCESS_KEY_ID is set (used by face matching) but S3_ACCESS_KEY_ID is not: set the dedicated S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or run storage under an IAM role without AWS_ACCESS_KEY_ID in its environment');
    }
    const sse = config.get<string>('S3_SSE') ?? 'AES256';
    if (!['AES256', 'aws:kms', 'none'].includes(sse)) throw new Error('S3_SSE must be AES256, aws:kms or none');

    const client = new S3Client({
      region,
      // Dedicated S3_* keys keep storage permissions apart from the face-match user. Without them the
      // SDK default chain applies (an IAM role in production); AWS_ACCESS_KEY_ID is refused above.
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      ...(config.get<string>('S3_ENDPOINT') ? { endpoint: config.get<string>('S3_ENDPOINT') } : {}),
      forcePathStyle: config.get<string>('S3_FORCE_PATH_STYLE') === 'true',
    });
    return new S3BlobStore(client, {
      bucket: config.get<string>('S3_BUCKET') ?? '',
      prefix: config.get<string>('S3_KEY_PREFIX'),
      serverSideEncryption: sse as 'AES256' | 'aws:kms' | 'none',
      kmsKeyId: config.get<string>('S3_KMS_KEY_ID'),
    });
  }

  /** Which kind of key protects new objects. */
  get keyProvider(): 'env' | 'kms' {
    return this.keys.name;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.store.put(key, await this.keys.seal(data, sealContext(key)));
  }

  async get(key: string): Promise<Buffer> {
    return this.keys.open(await this.store.get(key), sealContext(key));
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(key);
  }

  /** Without changing anything: is this object missing, already current, or in an older format? */
  async inspect(key: string): Promise<'missing' | 'current' | 'stale'> {
    try {
      const raw = await this.store.get(key);
      return (await this.keys.isCurrent(raw, sealContext(key))) ? 'current' : 'stale';
    } catch (err) {
      if (err instanceof StoredObjectMissingError) return 'missing';
      throw err;
    }
  }

  /**
   * Re-encrypts one object into the current format (older master-key objects, or objects from
   * before KMS was enabled). Safe to repeat. The caller must hold the session's row lock so a
   * concurrent erasure cannot be undone by this write.
   */
  async rewrap(key: string): Promise<'missing' | 'current' | 'rewrapped'> {
    let raw: Buffer;
    try {
      raw = await this.store.get(key);
    } catch (err) {
      if (err instanceof StoredObjectMissingError) return 'missing';
      throw err;
    }
    if (await this.keys.isCurrent(raw, sealContext(key))) return 'current';
    const plaintext = await this.keys.open(raw, sealContext(key));
    await this.store.put(key, await this.keys.seal(plaintext, sealContext(key)));
    return 'rewrapped';
  }
}
