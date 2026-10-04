import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalBlobStore } from './blob-store';

describe('LocalBlobStore writes', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'blob-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('replaces an object in one step and leaves no temporary file behind', async () => {
    const store = new LocalBlobStore(dir);
    await store.put('t/s/o', Buffer.from('first'));
    await store.put('t/s/o', Buffer.from('second'));
    expect(readFileSync(join(dir, 't/s/o')).toString()).toBe('second');
    expect(readdirSync(join(dir, 't/s'))).toEqual(['o']);
  });

  it('keeps the old object and cleans up when a write cannot be completed', async () => {
    const store = new LocalBlobStore(dir);
    await store.put('t/s/ok', Buffer.from('keep me'));
    mkdirSync(join(dir, 't/s/blocked')); // a directory sits where the object should go: the final rename fails
    await expect(store.put('t/s/blocked', Buffer.from('x'))).rejects.toThrow();
    expect(readdirSync(join(dir, 't/s')).sort()).toEqual(['blocked', 'ok']); // no stray temp file
    expect(readFileSync(join(dir, 't/s/ok')).toString()).toBe('keep me');
    expect(existsSync(join(dir, 't/s/blocked'))).toBe(true);
  });
});
