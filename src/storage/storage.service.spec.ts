import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StorageService } from './storage.service';

function make(dir: string, key = randomBytes(32).toString('base64')) {
  const values: Record<string, string> = { STORAGE_ENCRYPTION_KEY: key, STORAGE_LOCAL_DIR: dir };
  return new StorageService({ get: (k: string) => values[k] } as unknown as ConfigService);
}

describe('StorageService', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'verify-storage-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stores data encrypted at rest and reads it back', async () => {
    const storage = make(dir);
    const data = Buffer.from('id-card-image');
    await storage.put('t/s/doc', data);

    const onDisk = readFileSync(join(dir, 't/s/doc'));
    expect(onDisk.includes(data)).toBe(false);
    expect((await storage.get('t/s/doc')).equals(data)).toBe(true);
  });

  it('deletes objects', async () => {
    const storage = make(dir);
    await storage.put('t/s/doc', Buffer.from('x'));
    await storage.delete('t/s/doc');
    expect(readdirSync(join(dir, 't/s'))).toHaveLength(0);
  });

  it('blocks path traversal', async () => {
    await expect(make(dir).put('../escape', Buffer.from('x'))).rejects.toThrow('Invalid storage key');
  });

  it('requires a valid 32-byte key', () => {
    expect(() => make(dir, '')).toThrow();
    expect(() => make(dir, Buffer.from('short').toString('base64'))).toThrow('32 bytes');
  });
});
