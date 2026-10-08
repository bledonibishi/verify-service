import { NotFoundException } from '@nestjs/common';
import { readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

const cache = new Map<string, { data: Buffer; mtime: number }>();

/**
 * A file produced by pnpm build (the Tailwind stylesheet, the face check widget). Kept in memory,
 * but re-read when the file on disk changes (a cheap stat per request), so a rebuild shows up
 * without restarting the service; a missing file is looked for again on the next request.
 */
export function builtFile(dir: string, name: string, missing: string): Buffer {
  const path = join(resolve(dir), name);
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    cache.delete(path);
    throw new NotFoundException(missing);
  }
  const hit = cache.get(path);
  if (hit && hit.mtime === mtime) return hit.data;
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    throw new NotFoundException(missing);
  }
  cache.set(path, { data, mtime });
  return data;
}
