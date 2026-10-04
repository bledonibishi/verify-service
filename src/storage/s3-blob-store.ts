import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, ServerSideEncryption } from '@aws-sdk/client-s3';
import { BlobStore, StoredObjectMissingError, assertSafeKey } from './blob-store';

export interface S3Options {
  bucket: string;
  /** Optional folder inside the bucket, e.g. "prod/". */
  prefix?: string;
  /** `AES256` (SSE-S3, default), `aws:kms`, or `none` for S3-compatible servers without it. */
  serverSideEncryption?: 'AES256' | 'aws:kms' | 'none';
  kmsKeyId?: string;
}

type Sender = Pick<S3Client, 'send'>;

/**
 * S3 or any S3-compatible store (MinIO, R2, ...). Objects arrive already encrypted by the
 * service with AES-256-GCM; server-side encryption is a second layer on top.
 *
 * Erasure relies on the bucket having **versioning off**: with it on, a delete only adds a marker
 * and the old bytes survive. Delete is idempotent (S3 answers success for an absent key).
 */
export class S3BlobStore implements BlobStore {
  private readonly prefix: string;
  private readonly sse: ServerSideEncryption | undefined;

  constructor(
    private readonly client: Sender,
    private readonly opts: S3Options,
  ) {
    if (!opts.bucket) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
    this.prefix = S3BlobStore.normalizePrefix(opts.prefix);
    const mode = opts.serverSideEncryption ?? 'AES256';
    if (mode === 'aws:kms' && !opts.kmsKeyId) throw new Error('S3_KMS_KEY_ID is required for S3_SSE=aws:kms');
    this.sse = mode === 'none' ? undefined : (mode as ServerSideEncryption);
  }

  /** "" or "a/b/": no leading slash, one trailing slash, no empty, dot or parent components. */
  static normalizePrefix(raw: string | undefined): string {
    const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (trimmed === '') return '';
    if (trimmed.split('/').some((p) => p === '' || p === '.' || p === '..') || !/^[A-Za-z0-9._\/-]+$/.test(trimmed)) {
      throw new Error('S3_KEY_PREFIX may only contain letters, digits, ".", "_", "-" and single slashes');
    }
    return trimmed + '/';
  }

  private objectKey(key: string): string {
    assertSafeKey(key);
    return this.prefix + key;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: this.objectKey(key),
        Body: data,
        ContentType: 'application/octet-stream',
        ...(this.sse ? { ServerSideEncryption: this.sse } : {}),
        ...(this.sse === 'aws:kms' ? { SSEKMSKeyId: this.opts.kmsKeyId } : {}),
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: this.objectKey(key) }));
      if (!res.Body) throw new StoredObjectMissingError();
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      // Only errors that name a missing *object*. A 404 for a missing bucket (NoSuchBucket, a
      // misspelled S3_BUCKET) is a configuration failure and must not look like an erased document.
      // Note: without s3:ListBucket, S3 answers 403 AccessDenied for absent keys, which is why the
      // documented policy includes it.
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') throw new StoredObjectMissingError();
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.objectKey(key) }));
  }
}
