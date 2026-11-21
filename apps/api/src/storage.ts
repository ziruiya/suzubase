import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<{ sha256: string; bytes: number }>;
  read(key: string, sha256: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export function contentHash(data: Buffer) {
  return createHash('sha256').update(data).digest('hex');
}

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private readonly root: string) {}

  private path(key: string) {
    const uuid = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
    if (!new RegExp(`^${uuid}/${uuid}/${uuid}/[1-9][0-9]{0,8}$`).test(key)) throw new Error('Invalid storage key');
    return resolve(this.root, key);
  }

  async put(key: string, data: Buffer) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const staging = path + '.' + randomUUID();
    try {
      const file = await open(staging, 'wx', 0o600);
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      await link(staging, path);
      return { sha256: contentHash(data), bytes: data.length };
    } finally {
      await rm(staging, { force: true });
    }
  }

  async read(key: string, sha256: string) {
    const data = await readFile(this.path(key));
    if (contentHash(data) !== sha256) throw new Error('Stored attachment checksum mismatch');
    return data;
  }

  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}
