import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';
import { decrypt, encrypt } from '../common/crypto';

/**
 * Storage adapter contract. The local-disk implementation below is for development;
 * an S3 adapter can implement the same methods later.
 */
export interface DocumentStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Encrypts every object with AES-256-GCM before it touches disk. */
@Injectable()
export class StorageService implements DocumentStorage {
  private readonly key: Buffer;
  private readonly root: string;

  constructor(config: ConfigService) {
    const raw = config.get<string>('STORAGE_ENCRYPTION_KEY');
    if (!raw) throw new Error('STORAGE_ENCRYPTION_KEY is required');
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('STORAGE_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    }
    this.key = key;
    this.root = resolve(config.get<string>('STORAGE_LOCAL_DIR') ?? './storage');
  }

  private path(key: string): string {
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + '/')) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.path(key);
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, encrypt(this.key, data), { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    return decrypt(this.key, await fs.readFile(this.path(key)));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.path(key), { force: true });
  }
}
