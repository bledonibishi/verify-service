import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decrypt, encrypt } from '../common/crypto';

import { S3Client } from '@aws-sdk/client-s3';
import { BlobStore, LocalBlobStore, StoredObjectMissingError } from './blob-store';
import { S3BlobStore } from './s3-blob-store';

export { StoredObjectMissingError };

/** Optional injection token for a ready-made store (tests); normally the store is built from configuration. */
export const BLOB_STORE = Symbol('BLOB_STORE');

export interface DocumentStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/**
 * Encrypts every object with AES-256-GCM before it leaves the process, then hands the ciphertext
 * to a store: local disk (development) or S3-compatible object storage (`STORAGE_DRIVER=s3`).
 */
@Injectable()
export class StorageService implements DocumentStorage {
  private readonly key: Buffer;
  private readonly store: BlobStore;

  /** `store` can be injected for tests; otherwise it is chosen from configuration. */
  constructor(config: ConfigService, @Optional() @Inject(BLOB_STORE) store?: BlobStore) {
    const raw = config.get<string>('STORAGE_ENCRYPTION_KEY');
    if (!raw) throw new Error('STORAGE_ENCRYPTION_KEY is required');
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('STORAGE_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    }
    this.key = key;
    this.store = store ?? StorageService.storeFromConfig(config);
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

  async put(key: string, data: Buffer): Promise<void> {
    await this.store.put(key, encrypt(this.key, data));
  }

  async get(key: string): Promise<Buffer> {
    return decrypt(this.key, await this.store.get(key));
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(key);
  }
}
