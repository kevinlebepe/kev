import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { Config } from './config.js';
import { s3Store } from './s3.js';

// Where recordings are kept. The local disk store suits one server and
// development. Several API servers need shared storage: set the S3 settings
// and recordings go to an S3 compatible service instead (s3.ts).

export interface ObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  /** Null when the object does not exist. */
  get(key: string): Promise<{ stream: Readable; size: number } | null>;
  /** Removing something already gone is not an error. */
  delete(key: string): Promise<void>;
}

const KEY = /^[A-Za-z0-9/_.-]+$/;

export function diskStore(root: string): ObjectStore {
  const base = resolve(root);
  const path = (key: string) => {
    if (!KEY.test(key) || key.includes('..')) throw new Error(`Invalid storage key: ${key}`);
    const full = resolve(join(base, key));
    if (!full.startsWith(base + sep)) throw new Error(`Invalid storage key: ${key}`);
    return full;
  };
  return {
    async put(key, body) {
      const full = path(key);
      await mkdir(dirname(full), { recursive: true });
      // Write then rename, so a reader never sees half a file.
      const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, full);
    },
    async get(key) {
      const full = path(key);
      try {
        const s = await stat(full);
        return { stream: createReadStream(full), size: s.size };
      } catch {
        return null;
      }
    },
    async delete(key) {
      await rm(path(key), { force: true });
    },
  };
}

/** Keeps objects in memory. For tests. */
export function memoryStore(): ObjectStore & { keys(): string[] } {
  const objects = new Map<string, Buffer>();
  return {
    async put(key, body) {
      objects.set(key, Buffer.from(body));
    },
    async get(key) {
      const body = objects.get(key);
      if (!body) return null;
      const { Readable } = await import('node:stream');
      return { stream: Readable.from([body]), size: body.length };
    },
    async delete(key) {
      objects.delete(key);
    },
    keys: () => [...objects.keys()],
  };
}

/** The store the configuration asks for: S3 when a bucket is set, otherwise local disk. */
export function storeFromConfig(config: Config): ObjectStore {
  const s3 = config.s3;
  if (s3) return s3Store(s3);
  return diskStore(config.recordingDir);
}
