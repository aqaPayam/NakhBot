import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stagingReleaseCustody, type ReleaseCommand } from './staging-release-custody.js';
import { stagingContext } from './testing/staging-release-context.js';

async function fixture(): Promise<{
  directory: string;
  calls: Array<readonly string[]>;
  body: string;
  key: string;
  objects: Map<string, string>;
  fault: { head?: 'unknown' | 'huge'; checksum?: boolean; version?: boolean; unknownPut?: boolean };
  port: ReturnType<typeof stagingReleaseCustody>;
  close: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'nakh-release-custody-')),
    context = stagingContext(),
    calls: Array<readonly string[]> = [],
    objects = new Map<string, string>();
  const fault: {
    head?: 'unknown' | 'huge';
    checksum?: boolean;
    version?: boolean;
    unknownPut?: boolean;
  } = {};
  const body = JSON.stringify({
      sourceSha: context.sourceSha,
      proof: 'synthetic protocol evidence',
    }),
    key = `releases/${context.sourceSha}/123/1/intent.json`;
  const command: ReleaseCommand = async (tool, args) => {
    expect(tool).toBe('aws');
    calls.push([...args]);
    const value = (name: string): string => args[args.indexOf(name) + 1]!;
    expect(value('--expected-bucket-owner')).toBe(context.accountId);
    expect(value('--bucket')).toBe(context.bucket);
    const key = value('--key');
    if (args[1] === 'head-object') {
      if (fault.head === 'unknown')
        throw Object.assign(new Error('PRIVATE_CUSTODY_ERROR'), {
          code: 254,
          stderr:
            'An error occurred (AccessDenied) when calling the HeadObject operation: PRIVATE_DETAIL',
        });
      const b = objects.get(key);
      if (b === undefined)
        throw Object.assign(new Error('missing'), {
          code: 254,
          stderr: '\nAn error occurred (404) when calling the HeadObject operation: Not Found',
        });
      return JSON.stringify({
        ContentLength: fault.head === 'huge' ? 262145 : Buffer.byteLength(b),
        VersionId: 'version-1',
      });
    }
    if (args[1] === 'put-object') {
      expect(value('--if-none-match')).toBe('*');
      expect(value('--server-side-encryption')).toBe('AES256');
      const b = await readFile(value('--body'), 'utf8');
      expect(value('--checksum-sha256')).toBe(createHash('sha256').update(b).digest('base64'));
      if (objects.has(key))
        throw Object.assign(new Error('exists'), {
          code: 254,
          stderr:
            'An error occurred (PreconditionFailed) when calling the PutObject operation: exists',
        });
      objects.set(key, b);
      if (fault.unknownPut) throw new Error('PRIVATE_UNKNOWN_UPLOAD');
      return '{}';
    }
    if (args[1] === 'get-object') {
      expect(value('--version-id')).toBe('version-1');
      expect(value('--checksum-mode')).toBe('ENABLED');
      const b = objects.get(key)!;
      await writeFile(args.at(-1)!, b, 'utf8');
      return JSON.stringify({
        ContentLength: Buffer.byteLength(b),
        VersionId: fault.version ? 'foreign-version' : 'version-1',
        ServerSideEncryption: 'AES256',
        ChecksumSHA256: fault.checksum ? 'wrong' : createHash('sha256').update(b).digest('base64'),
      });
    }
    throw new Error('Unexpected custody command');
  };
  return {
    directory,
    calls,
    body,
    key,
    objects,
    fault,
    port: stagingReleaseCustody(context, command, directory),
    close: async () => {
      expect(await readdir(directory)).toEqual([]);
      await rmdir(directory);
    },
  };
}
describe('protected release S3 command boundary', () => {
  it('uses conditional checksum uploads and independently reads the immutable version before acceptance', async () => {
    const f = await fixture();
    try {
      expect(await f.port.put(f.key, f.body)).toBe('created');
      expect(await f.port.read(f.key)).toBe(f.body);
      expect(await f.port.put(f.key, f.body)).toBe('existing');
      expect(f.calls.filter((a) => a[1] === 'get-object').length).toBeGreaterThanOrEqual(3);
    } finally {
      await f.close();
    }
  });
  it('never overwrites an existing different record and converges concurrent identical creates', async () => {
    const f = await fixture();
    try {
      const results = await Promise.all([f.port.put(f.key, f.body), f.port.put(f.key, f.body)]);
      expect(results.sort()).toEqual(['created', 'existing']);
      await expect(f.port.put(f.key, '{"different":true}')).rejects.toThrow();
      expect(f.objects.get(f.key)).toBe(f.body);
    } finally {
      await f.close();
    }
  });
  it('preserves an uncertain uploaded record without treating the lost acknowledgement as success', async () => {
    const f = await fixture();
    try {
      f.fault.unknownPut = true;
      await expect(f.port.put(f.key, f.body)).rejects.toThrow();
      expect(f.objects.get(f.key)).toBe(f.body);
      f.fault.unknownPut = false;
      expect(await f.port.read(f.key)).toBe(f.body);
      expect(await f.port.put(f.key, f.body)).toBe('existing');
    } finally {
      await f.close();
    }
  });
  it('distinguishes definitive object absence from provider denial and rejects foreign keys before commands', async () => {
    const f = await fixture();
    try {
      expect(await f.port.read(f.key)).toBeUndefined();
      f.fault.head = 'unknown';
      await expect(f.port.read(f.key)).rejects.toThrow();
      const count = f.calls.length;
      await expect(f.port.read('../../PRIVATE')).rejects.toThrow();
      expect(f.calls).toHaveLength(count);
    } finally {
      await f.close();
    }
  });
  it('bounds downloads before fetching a body and rejects wrong checksum or version', async () => {
    for (const kind of ['size', 'checksum', 'version'] as const) {
      const f = await fixture();
      try {
        f.objects.set(f.key, f.body);
        if (kind === 'size') f.fault.head = 'huge';
        else f.fault[kind] = true;
        await expect(f.port.read(f.key)).rejects.toThrow();
        if (kind === 'size') expect(f.calls.some((a) => a[1] === 'get-object')).toBe(false);
      } finally {
        await f.close();
      }
    }
  });
});
