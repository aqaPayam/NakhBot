import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readVpsLaunchReadiness } from '../vps-launch-readiness.js';

async function privateParent(path: string): Promise<void> {
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
async function readPrivateJson(path: string): Promise<unknown> {
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
      info.size > 16384
    )
      throw new Error();
    const bytes = Buffer.alloc(16385);
    const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 16384) throw new Error();
    return JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8')) as unknown;
  } finally {
    await file.close();
  }
}
async function main(): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error();
  const paths = process.argv.slice(2);
  if (paths.length !== 2 || !paths.every(isAbsolute)) throw new Error();
  const binding = await readPrivateJson(paths[0]!);
  await privateParent(paths[1]!);
  const output = await open(
    paths[1]!,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const receipt = await readVpsLaunchReadiness(binding, readPrivateJson);
    await output.writeFile(JSON.stringify(receipt) + '\n');
    await output.sync();
  } finally {
    await output.close();
  }
  process.stdout.write('Private VPS readiness recorded; launch remains unauthorized.\n');
}
main().catch(() => {
  process.stderr.write('Private VPS readiness unavailable.\n');
  process.exitCode = 1;
});
