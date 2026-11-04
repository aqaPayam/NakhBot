import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export function requireVpsRoot(): void {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error();
}
async function privateParent(path: string): Promise<void> {
  requireVpsRoot();
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error();
  let parent = dirname(path);
  for (;;) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error();
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
}
export async function openVpsPrivateInput(path: string, limit = 16384): Promise<FileHandle> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1048576) throw new Error();
  await privateParent(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== 0 ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.size < 1 ||
      info.size > limit
    )
      throw new Error();
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
export async function readVpsPrivateJson(path: string): Promise<unknown> {
  const file = await openVpsPrivateInput(path);
  try {
    const bytes = Buffer.alloc(16385);
    try {
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > 16384) throw new Error();
      return JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown;
    } finally {
      bytes.fill(0);
    }
  } finally {
    await file.close();
  }
}
export async function reserveVpsPrivateOutput(path: string): Promise<FileHandle> {
  await privateParent(path);
  return open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
}
