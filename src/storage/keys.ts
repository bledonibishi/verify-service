import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { decrypt as legacyDecrypt } from '../common/crypto';

/**
 * What an encrypted object is bound to. `aad` goes into AES-GCM as additional authenticated data
 * (here: the object's storage key), so a ciphertext moved to another key, session or tenant fails
 * to decrypt. `kmsContext` is the KMS encryption context: KMS refuses to decrypt a data key under
 * a different context, and it appears in the key's audit log.
 */
export interface SealContext {
  aad: string;
  kmsContext: Record<string, string>;
}

export interface KeyProvider {
  readonly name: 'env' | 'kms';
  seal(plaintext: Buffer, ctx: SealContext): Promise<Buffer>;
  /** Reads every format this deployment can still read, including older ones. */
  open(sealed: Buffer, ctx: SealContext): Promise<Buffer>;
  /**
   * True only when the object is in the format new writes use **and actually opens that way**. The
   * first bytes alone are not proof: an original-format object has a random IV that can begin with
   * a format marker by chance.
   */
  isCurrent(sealed: Buffer, ctx: SealContext): Promise<boolean>;
}

/** The key service refused, throttled or could not be reached. Retrying later may work; the data is not damaged. */
export class KeyUnavailableError extends Error {
  constructor(message = 'The encryption key service is unavailable') {
    super(message);
    this.name = 'KeyUnavailableError';
  }
}

/** The stored bytes do not verify (tampered with, moved, or encrypted for something else). */
export class StoredObjectCorruptError extends Error {
  constructor(message = 'Stored object failed verification') {
    super(message);
    this.name = 'StoredObjectCorruptError';
  }
}

// ---- formats ---------------------------------------------------------------------------------
// legacy : iv(12) | tag(16) | ciphertext                       master key, nothing bound
// VSE0   : "VSE0" | iv | tag | ciphertext                      master key, bound to the storage key
// VSE1   : "VSE1" | wrappedLen(2) | wrappedDEK | iv | tag | ct  per-object data key wrapped by KMS, bound
const V0 = Buffer.from('VSE0');
const V1 = Buffer.from('VSE1');
const IV = 12;
const TAG = 16;

export type Format = 'legacy' | 'env-v0' | 'kms-v1';
export const formatOf = (b: Buffer): Format => (b.subarray(0, 4).equals(V0) ? 'env-v0' : b.subarray(0, 4).equals(V1) ? 'kms-v1' : 'legacy');

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: string): { iv: Buffer; tag: Buffer; body: Buffer } {
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), body };
}

function gcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, body: Buffer, aad: string): Buffer {
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new StoredObjectCorruptError();
  }
}

/** The 32-byte master key from STORAGE_ENCRYPTION_KEY. Fine for development; see KmsKeyProvider for production. */
export class EnvKeyProvider implements KeyProvider {
  readonly name = 'env' as const;
  constructor(private readonly key: Buffer) {}

  async seal(plaintext: Buffer, ctx: SealContext): Promise<Buffer> {
    const { iv, tag, body } = gcmEncrypt(this.key, plaintext, ctx.aad);
    return Buffer.concat([V0, iv, tag, body]);
  }

  /** Opens the current (VSE0) format only. */
  openStrict(sealed: Buffer, ctx: SealContext): Buffer {
    if (formatOf(sealed) !== 'env-v0' || sealed.length < 4 + IV + TAG) throw new StoredObjectCorruptError();
    const b = sealed.subarray(4);
    return gcmDecrypt(this.key, b.subarray(0, IV), b.subarray(IV, IV + TAG), b.subarray(IV + TAG), ctx.aad);
  }

  /** The original format (no header), tried regardless of how the bytes begin. */
  openLegacy(sealed: Buffer): Buffer {
    try {
      return legacyDecrypt(this.key, sealed);
    } catch {
      throw new StoredObjectCorruptError();
    }
  }

  async open(sealed: Buffer, ctx: SealContext): Promise<Buffer> {
    const f = formatOf(sealed);
    if (f === 'kms-v1') {
      // An original-format object can begin with any four bytes, including this marker
      try {
        return this.openLegacy(sealed);
      } catch {
        throw new Error('This object is encrypted with KMS; set STORAGE_KEY_PROVIDER=kms to read it');
      }
    }
    if (f === 'legacy') return this.openLegacy(sealed);
    try {
      return this.openStrict(sealed, ctx);
    } catch (err) {
      // ...or an original-format object whose random IV happens to start with "VSE0"
      try {
        return this.openLegacy(sealed);
      } catch {
        throw err;
      }
    }
  }

  async isCurrent(sealed: Buffer, ctx: SealContext): Promise<boolean> {
    try {
      this.openStrict(sealed, ctx);
      return true;
    } catch {
      return false;
    }
  }
}

type Kms = Pick<KMSClient, 'send'>;

export interface KmsOptions {
  /** Key id, ARN or alias of the symmetric KMS key. */
  keyId: string;
  /**
   * How long an unwrapped data key may stay in memory, in seconds. **0 (the default) turns the cache
   * off**, which is what makes revocation immediate and puts one KMS Decrypt event in the audit log
   * for every read. A positive value trades both for fewer KMS calls: keys read within that time are
   * served from memory, so revoking access takes up to that long to bite, and those reads are not logged.
   */
  cacheSeconds?: number;
  maxCached?: number;
  /** The master key, only so objects written before KMS was switched on can still be read (and re-encrypted). */
  legacy?: EnvKeyProvider;
  now?: () => number;
}

const UNAVAILABLE = new Set([
  'AccessDeniedException', 'DisabledException', 'KMSInvalidStateException', 'KeyUnavailableException', 'NotFoundException',
  'ThrottlingException', 'LimitExceededException', 'KMSInternalException', 'DependencyTimeoutException', 'ServiceUnavailableException',
  'CredentialsProviderError', 'UnrecognizedClientException', 'ExpiredTokenException', 'InvalidGrantTokenException',
]);
const CORRUPT = new Set(['InvalidCiphertextException', 'IncorrectKeyException', 'InvalidKeyUsageException']);

/**
 * Envelope encryption with AWS KMS. Every object gets its own random data key; KMS wraps it, and
 * only the wrapped copy is stored next to the ciphertext. The key that protects data keys never
 * leaves KMS, every unwrap is written to the key's CloudTrail log, and the key can be disabled or
 * revoked to cut off decryption at once. A stolen database, disk or bucket (even together with
 * the app's configuration) holds nothing that decrypts without a call to KMS.
 */
export class KmsKeyProvider implements KeyProvider {
  readonly name = 'kms' as const;
  private readonly cache = new Map<string, { key: Buffer; expires: number }>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(
    private readonly client: Kms,
    private readonly opts: KmsOptions,
  ) {
    if (!opts.keyId) throw new Error('KMS_KEY_ID is required when STORAGE_KEY_PROVIDER=kms');
    this.ttlMs = Math.max(0, opts.cacheSeconds ?? 0) * 1000;
    this.max = opts.maxCached ?? 200;
    this.now = opts.now ?? Date.now;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const name = (err as Error).name;
      if (CORRUPT.has(name)) throw new StoredObjectCorruptError();
      // Anything else (network, timeouts, the cases above) is "try again later", never a verdict on the data
      throw new KeyUnavailableError(UNAVAILABLE.has(name) ? `The encryption key service refused or could not complete the request (${name})` : undefined);
    }
  }

  async seal(plaintext: Buffer, ctx: SealContext): Promise<Buffer> {
    const res = await this.call(() =>
      this.client.send(new GenerateDataKeyCommand({ KeyId: this.opts.keyId, KeySpec: 'AES_256', EncryptionContext: ctx.kmsContext })),
    );
    if (!res.Plaintext || !res.CiphertextBlob) throw new KeyUnavailableError();
    const dek = Buffer.from(res.Plaintext);
    res.Plaintext.fill(0); // the SDK's own copy too
    const wrapped = Buffer.from(res.CiphertextBlob);
    try {
      const { iv, tag, body } = gcmEncrypt(dek, plaintext, ctx.aad);
      const len = Buffer.alloc(2);
      len.writeUInt16BE(wrapped.length);
      return Buffer.concat([V1, len, wrapped, iv, tag, body]);
    } finally {
      dek.fill(0); // the plaintext data key is not kept
    }
  }

  async open(sealed: Buffer, ctx: SealContext): Promise<Buffer> {
    if (formatOf(sealed) === 'kms-v1') {
      try {
        return await this.openStrict(sealed, ctx);
      } catch (err) {
        // A master-key object whose random IV happens to start with the same four bytes (1 in 4 billion)
        if (!this.opts.legacy) throw err;
        try {
          return this.opts.legacy.openLegacy(sealed);
        } catch {
          throw err;
        }
      }
    }
    if (!this.opts.legacy) {
      throw new Error('This object was written before KMS was enabled; set STORAGE_ENCRYPTION_KEY to the old master key so it can be read and re-encrypted');
    }
    return this.opts.legacy.open(sealed, ctx);
  }

  /** Opens the KMS format only. The data key's lifetime belongs to this call: it is zeroed afterwards. */
  async openStrict(sealed: Buffer, ctx: SealContext): Promise<Buffer> {
    const wrappedLen = sealed.length >= 6 && formatOf(sealed) === 'kms-v1' ? sealed.readUInt16BE(4) : 0;
    const start = 6 + wrappedLen;
    if (wrappedLen === 0 || sealed.length < start + IV + TAG) throw new StoredObjectCorruptError();
    const wrapped = sealed.subarray(6, start);
    const iv = sealed.subarray(start, start + IV);
    const tag = sealed.subarray(start + IV, start + IV + TAG);
    const body = sealed.subarray(start + IV + TAG);
    const dek = await this.unwrap(wrapped, ctx);
    try {
      return gcmDecrypt(dek, iv, tag, body, ctx.aad);
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Unwraps a data key and hands the caller **its own copy** (to be zeroed after use). With the
   * cache on, a separate copy is what is remembered, so an expiry or eviction can never zero a key
   * another read is in the middle of using.
   */
  private async unwrap(wrapped: Buffer, ctx: SealContext): Promise<Buffer> {
    // The context is part of the cache key: a hit can never serve a key for a different tenant or session
    const id = createHash('sha256').update(wrapped).update('\0').update(JSON.stringify(Object.entries(ctx.kmsContext).sort())).digest('hex');
    const hit = this.cache.get(id);
    if (hit && hit.expires > this.now()) return Buffer.from(hit.key);
    if (hit) this.drop(id);

    const res = await this.call(() =>
      this.client.send(new DecryptCommand({ CiphertextBlob: wrapped, KeyId: this.opts.keyId, EncryptionContext: ctx.kmsContext })),
    );
    if (!res.Plaintext) throw new KeyUnavailableError();
    const key = Buffer.from(res.Plaintext);
    res.Plaintext.fill(0);
    if (this.ttlMs > 0) {
      if (this.cache.size >= this.max) this.drop(this.cache.keys().next().value as string); // oldest first
      this.cache.set(id, { key: Buffer.from(key), expires: this.now() + this.ttlMs });
    }
    return key;
  }

  private drop(id: string) {
    this.cache.get(id)?.key.fill(0);
    this.cache.delete(id);
  }

  /** Forget every cached data key. */
  clearCache() {
    for (const id of [...this.cache.keys()]) this.drop(id);
  }

  async isCurrent(sealed: Buffer, ctx: SealContext): Promise<boolean> {
    try {
      (await this.openStrict(sealed, ctx)).fill(0);
      return true;
    } catch (err) {
      // Not being able to reach KMS says nothing about the object: let the caller see that
      if (err instanceof KeyUnavailableError) throw err;
      return false;
    }
  }
}
