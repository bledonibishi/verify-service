import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { BlobStore, StoredObjectMissingError, assertSafeKey } from './blob-store';

export interface S3Options {
  bucket: string;
  /** Optional folder inside the bucket, e.g. "prod/". */
  prefix?: string;
  /** `AES256` (SSE-S3, default), `aws:kms`, or `none` for S3-compatible servers without it. */
  serverSideEncryption?: 'AES256' | 'aws:kms' | 'none';
  kmsKeyId?: string;
  /**
   * `auto` (default): before erasing, ask the bucket whether versioning is on and, if it is, remove
   * every version and delete marker of the object, so erasure is real. `off`: skip the question,
   * for operators who have confirmed versioning is off and do not grant `s3:GetBucketVersioning`.
   */
  versioningCheck?: 'auto' | 'off';
}

/** Erasure could not be done properly, or could not be verified; the caller keeps the record and retries. */
export class ErasureNotVerifiableError extends Error {
  constructor(readonly reason: string) {
    super(`Cannot erase safely: ${reason}`);
    this.name = 'ErasureNotVerifiableError';
  }
}

const VERSIONING_CACHE_MS = 5 * 60_000;

type Sender = Pick<S3Client, 'send'>;

/**
 * S3 or any S3-compatible store (MinIO, R2, ...). Objects arrive already encrypted by the
 * service with AES-256-GCM; server-side encryption is a second layer on top.
 *
 * Erasure: with versioning **off** (the recommended setting) a delete removes the object. With it
 * on, a plain delete would only add a marker and the old bytes would survive, so delete first asks
 * the bucket (cached for a few minutes) and, if versioning is on or suspended, removes every
 * version and marker of the object. If the bucket cannot be asked (missing `s3:GetBucketVersioning`)
 * delete fails rather than pretend, unless `versioningCheck: 'off'`. Delete is idempotent.
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

  private versioning?: { versioned: boolean; until: number };

  private async isVersioned(): Promise<boolean> {
    if (this.opts.versioningCheck === 'off') return false;
    if (this.versioning && this.versioning.until > Date.now()) return this.versioning.versioned;
    try {
      const res = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.opts.bucket }));
      const versioned = res.Status === 'Enabled' || res.Status === 'Suspended';
      this.versioning = { versioned, until: Date.now() + VERSIONING_CACHE_MS };
      return versioned;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      // S3-compatible servers without versioning support answer "not implemented": no versions to leave behind
      if (e.name === 'NotImplemented' || e.$metadata?.httpStatusCode === 501) return false;
      throw new ErasureNotVerifiableError(`the bucket's versioning status could not be read (${e.name ?? 'error'}); grant s3:GetBucketVersioning or set S3_VERSIONING_CHECK=off if versioning is known to be off`);
    }
  }

  async delete(key: string): Promise<void> {
    const objectKey = this.objectKey(key);
    if (!(await this.isVersioned())) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: objectKey }));
      return;
    }
    // Versioned bucket: delete every version and marker of exactly this key
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectVersionsCommand({ Bucket: this.opts.bucket, Prefix: objectKey, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }),
      );
      for (const v of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
        if (v.Key !== objectKey || !v.VersionId) continue; // a longer key that merely starts with this one
        await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: objectKey, VersionId: v.VersionId }));
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker !== undefined || versionIdMarker !== undefined);
  }
}
