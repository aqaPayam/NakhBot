import { createHash } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  captureStagingContext,
  type StagingReleaseContext,
  type ReleaseCustody,
} from './staging-release.js';

export type ReleaseCommand = (tool: string, args: readonly string[]) => Promise<string>;
function denied(): never {
  throw new Error('Release custody verification unavailable.');
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}
function errorKind(error: unknown, operation: string, name: string): boolean {
  if (error === null || typeof error !== 'object') return false;
  const value = error as { code?: unknown; stderr?: unknown };
  return (
    value.code === 254 &&
    typeof value.stderr === 'string' &&
    new RegExp(
      `^\\s*An error occurred \\(${name}\\) when calling the ${operation} operation:`,
      'u',
    ).test(value.stderr)
  );
}

/** Conditional writes and independent, size-bounded, version-bound S3 reads.
 * No raw provider errors or private evidence bodies are printed by this port. */
export type ReleaseBlobs = Readonly<{
  read: (key: string) => Promise<Buffer | undefined>;
  put: (key: string, body: Uint8Array) => Promise<'created' | 'existing'>;
}>;
type CustodyScope = Pick<StagingReleaseContext, 'accountId' | 'region' | 'cluster' | 'bucket'>;
function versionedObjects(
  input: CustodyScope,
  command: ReleaseCommand,
  directory: string,
  maxBytes: number,
  checked: (key: string) => string,
): ReleaseBlobs {
  const c = structuredClone(input);
  let sequence = 0;
  if (
    !/^[0-9]{12}$/u.test(c.accountId) ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/u.test(c.region) ||
    !/^[a-z][a-z0-9-]{1,19}-staging$/u.test(c.cluster) ||
    c.bucket !==
      c.cluster +
        '-release-' +
        createHash('sha256')
          .update(c.accountId + ':' + c.region)
          .digest('hex')
          .slice(0, 16)
  )
    denied();
  const base = ['--region', c.region, '--bucket', c.bucket, '--expected-bucket-owner', c.accountId];
  const custody: ReleaseBlobs = {
    read: async (key) => {
      checked(key);
      let head: Record<string, unknown>;
      try {
        head = record(
          JSON.parse(
            await command('aws', [
              's3api',
              'head-object',
              ...base,
              '--key',
              key,
              '--output',
              'json',
            ]),
          ) as unknown,
        );
      } catch (error) {
        if (errorKind(error, 'HeadObject', '404')) return undefined;
        throw error;
      }
      const length = head.ContentLength,
        version = head.VersionId;
      if (
        !Number.isSafeInteger(length) ||
        Number(length) < 1 ||
        Number(length) > maxBytes ||
        typeof version !== 'string' ||
        version.length < 1 ||
        version.length > 1024 ||
        version === 'null'
      )
        denied();
      const path = resolve(directory, `release-custody-read-${sequence++}.json`);
      try {
        const response = record(
          JSON.parse(
            await command('aws', [
              's3api',
              'get-object',
              ...base,
              '--key',
              key,
              '--version-id',
              version,
              '--checksum-mode',
              'ENABLED',
              path,
            ]),
          ) as unknown,
        );
        const body = await readFile(path);
        if (
          body.length !== length ||
          response.ContentLength !== length ||
          response.VersionId !== version ||
          response.ServerSideEncryption !== 'AES256' ||
          response.ChecksumSHA256 !== createHash('sha256').update(body).digest('base64')
        )
          denied();
        return body;
      } finally {
        await unlink(path).catch(() => undefined);
      }
    },
    put: async (key, inputBody) => {
      const body = Buffer.from(inputBody);
      checked(key);
      if (body.length > maxBytes || body.length === 0) denied();
      const path = resolve(directory, `release-custody-write-${sequence++}.json`);
      await writeFile(path, body, { flag: 'wx', mode: 0o600 });
      let result: 'created' | 'existing' = 'created';
      try {
        try {
          await command('aws', [
            's3api',
            'put-object',
            ...base,
            '--key',
            key,
            '--body',
            path,
            '--if-none-match',
            '*',
            '--checksum-algorithm',
            'SHA256',
            '--checksum-sha256',
            createHash('sha256').update(body).digest('base64'),
            '--server-side-encryption',
            'AES256',
            '--content-type',
            key.includes('/files/') ? 'application/octet-stream' : 'application/json',
          ]);
        } catch (error) {
          if (!errorKind(error, 'PutObject', 'PreconditionFailed')) throw error;
          result = 'existing';
        }
        const observed = await custody.read(key);
        if (!observed || !observed.equals(body)) denied();
        return result;
      } finally {
        await unlink(path).catch(() => undefined);
      }
    },
  };
  return custody;
}

export function stagingReleaseCustody(
  input: StagingReleaseContext,
  command: ReleaseCommand,
  directory: string,
): ReleaseCustody {
  const checked = (key: string): string => {
    if (
      !/^releases\/[a-f0-9]{40}\/[1-9][0-9]{0,19}\/[1-9][0-9]{0,8}\/(?:intent|held|drained|observed-(?:0|[1-9][0-9]?)|(?:migration|compatibility)-(?:prepared|started|succeeded)|healthy|activated|maintenance)\.json$/u.test(
        key,
      )
    )
      denied();
    return key;
  };
  const blobs = versionedObjects(captureStagingContext(input), command, directory, 262144, checked);
  return {
    read: async (key) => (await blobs.read(key))?.toString('utf8'),
    put: (key, body) => blobs.put(key, Buffer.from(body, 'utf8')),
  };
}
export function stagingArchiveCustody(
  input: CustodyScope,
  command: ReleaseCommand,
  directory: string,
): ReleaseBlobs {
  return versionedObjects(input, command, directory, 16777216, (key) => {
    if (
      !/^archives\/[a-f0-9]{40}\/[1-9][0-9]{0,19}\/[1-9][0-9]{0,8}\/(?:manifest\.json|manifest-bundle\.jsonl|complete\.json|files\/[a-f0-9]{64}\.bin)$/u.test(
        key,
      )
    )
      denied();
    return key;
  });
}
