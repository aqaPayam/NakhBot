import { describe, expect, it } from 'vitest';
import lock from '../../../deploy/telemetry/collector-image-lock.json' with { type: 'json' };
import { prepareCollectorImage } from './collector-image.js';
import { collectorStartupDiagnostic } from './m7-collector-startup.js';

type Image = { id: string; digests: string[] | null };
const immutable = `${lock.mirrorRepository}@${lock.indexDigest}`;
const image = (platform: keyof typeof lock.platforms = 'linux/amd64'): Image => ({
  id: lock.platforms[platform].configDigest,
  digests: [`amazon/aws-otel-collector@${lock.indexDigest}`],
});
function failure(stderr: string): Error {
  return Object.assign(new Error('private-provider-marker'), { code: 1, stderr });
}
function fixture(
  options: Readonly<{
    platform?: string;
    cache?: Image;
    pulled?: Image;
    tagged?: Image;
    inspectOutput?: string;
    inspectError?: Error;
    pullFailures?: readonly Error[];
  }> = {},
): {
  calls: string[][];
  docker: (args: readonly string[]) => Promise<string>;
  pulls: () => number;
} {
  const calls: string[][] = [];
  let pulls = 0,
    tagged = false;
  return {
    calls,
    pulls: () => pulls,
    docker: async (args: readonly string[]): Promise<string> => {
      await Promise.resolve();
      calls.push([...args]);
      if (args[0] === 'info') return options.platform ?? 'linux/x86_64';
      if (args[0] === 'pull') {
        const error = options.pullFailures?.[pulls];
        pulls++;
        if (error !== undefined) throw error;
        return '';
      }
      if (args[0] === 'tag') {
        tagged = true;
        return '';
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        if (options.inspectError !== undefined) throw options.inspectError;
        if (options.inspectOutput !== undefined) return options.inspectOutput;
        if (args.at(-1) === lock.configuredImage) {
          const value = tagged ? (options.tagged ?? image()) : options.cache;
          if (value === undefined)
            throw failure('Error response from daemon: No such image: fixture');
          return JSON.stringify(value);
        }
        return JSON.stringify(options.pulled ?? image());
      }
      throw new Error('Unexpected fixture command');
    },
  };
}
describe('immutable collector acquisition', () => {
  it.each(['linux/amd64', 'linux/x86_64', 'linux/arm64', 'linux/aarch64'])(
    'reuses only verified native-platform bits for %s',
    async (platform) => {
      const canonical =
        platform === 'linux/arm64' || platform === 'linux/aarch64' ? 'linux/arm64' : 'linux/amd64';
      const f = fixture({ platform, cache: image(canonical) });
      expect(
        await prepareCollectorImage(lock.configuredImage, f.docker, () =>
          Promise.reject(new Error('no wait')),
        ),
      ).toEqual({
        platform: canonical,
        expectedIndexDigest: lock.indexDigest,
        manifestDigest: lock.indexDigest,
        configDigest: lock.platforms[canonical].configDigest,
        source: 'verified_local_image',
      });
      expect(f.pulls()).toBe(0);
      expect(f.calls).toHaveLength(2);
    },
  );
  it('pulls the identical immutable official image and verifies it before tagging the configured name', async () => {
    const f = fixture();
    const result = await prepareCollectorImage(lock.configuredImage, f.docker, () =>
      Promise.reject(new Error('no wait')),
    );
    expect(result.source).toBe('official_immutable_mirror');
    expect(f.calls.filter((c) => c[0] === 'pull')).toEqual([
      ['pull', '--platform', 'linux/amd64', immutable],
    ]);
    expect(f.calls.findIndex((c) => c[0] === 'tag')).toBe(4);
    expect(f.calls[4]).toEqual(['tag', immutable, lock.configuredImage]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-provider-marker');
  });
  it.each([
    { id: 'sha256:' + '0'.repeat(64), digests: image().digests },
    { id: image().id, digests: ['private.invalid/other@' + lock.indexDigest] },
    { id: image().id, digests: null },
  ])('fetches the approved digest instead of trusting a stale or unproven cache', async (cache) => {
    const f = fixture({ cache });
    expect(
      (await prepareCollectorImage(lock.configuredImage, f.docker, () => Promise.resolve())).source,
    ).toBe('official_immutable_mirror');
    expect(f.pulls()).toBe(1);
  });
  it.each([
    { id: 'sha256:' + '0'.repeat(64), digests: image().digests },
    { id: image().id, digests: ['amazon/aws-otel-collector@sha256:' + '0'.repeat(64)] },
  ])('rejects an unverified pull without tagging or another attempt', async (pulled) => {
    const f = fixture({ pulled });
    const error = await prepareCollectorImage(lock.configuredImage, f.docker, () =>
      Promise.reject(new Error('no retry')),
    ).catch((e) => e as unknown);
    expect(collectorStartupDiagnostic(error).failureKind).toBe('image_integrity_failed');
    expect(f.pulls()).toBe(1);
    expect(f.calls.some((c) => c[0] === 'tag')).toBe(false);
  });
  it('rechecks the configured tag after the verified pull', async () => {
    const f = fixture({ tagged: { ...image(), id: 'sha256:' + '0'.repeat(64) } });
    await expect(
      prepareCollectorImage(lock.configuredImage, f.docker, () =>
        Promise.reject(new Error('no retry')),
      ),
    ).rejects.toThrow('integrity');
    expect(f.pulls()).toBe(1);
  });
  it.each([
    '403 access denied',
    'x509: certificate expired',
    'digest mismatch',
    'error getting credentials',
  ])('never retries or bypasses %s', async (stderr) => {
    const error = failure(stderr),
      f = fixture({ pullFailures: [error] });
    await expect(
      prepareCollectorImage(lock.configuredImage, f.docker, () =>
        Promise.reject(new Error('no retry')),
      ),
    ).rejects.toBe(error);
    expect(f.pulls()).toBe(1);
    expect(f.calls.some((c) => c[0] === 'tag')).toBe(false);
  });
  it('does not mistake a denial containing missing-image text for a cache miss', async () => {
    const error = failure('403 access denied; No such image'),
      f = fixture({ inspectError: error });
    await expect(
      prepareCollectorImage(lock.configuredImage, f.docker, () => Promise.resolve()),
    ).rejects.toBe(error);
    expect(f.pulls()).toBe(0);
  });
  it.each([
    'not-json',
    '{"id":"wrong","digests":[]}',
    '{"id":"sha256:' + '0'.repeat(64) + '","digests":{},"private":"marker"}',
  ])('fails closed on malformed image inspection', async (inspectOutput) => {
    const f = fixture({ inspectOutput });
    await expect(
      prepareCollectorImage(lock.configuredImage, f.docker, () => Promise.resolve()),
    ).rejects.toThrow('integrity');
    expect(f.pulls()).toBe(0);
  });
  it('keeps exactly three recognized transient pulls and bounded waits', async () => {
    const f = fixture({
        pullFailures: [failure('503 Service Unavailable'), failure('connection reset')],
      }),
      waits: number[] = [];
    await prepareCollectorImage(
      lock.configuredImage,
      f.docker,
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      () => 0,
    );
    expect(f.pulls()).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });
  it('fails after three persistent mirror throttles', async () => {
    const error = failure('429 Too Many Requests'),
      f = fixture({ pullFailures: [error, error, error] }),
      waits: number[] = [];
    await expect(
      prepareCollectorImage(
        lock.configuredImage,
        f.docker,
        (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
        () => 0,
      ),
    ).rejects.toBe(error);
    expect(f.pulls()).toBe(3);
    expect(waits).toEqual([60000, 120000]);
    expect(f.calls.some((c) => c[0] === 'tag')).toBe(false);
  });
  it.each(['windows/amd64', 'linux/unknown', 'private-host-marker'])(
    'rejects unsupported platforms before acquisition',
    async (platform) => {
      const f = fixture({ platform });
      await expect(
        prepareCollectorImage(lock.configuredImage, f.docker, () => Promise.resolve()),
      ).rejects.toThrow('platform unavailable');
      expect(f.calls).toHaveLength(1);
    },
  );
  it('rejects another image or version before touching Docker', async () => {
    const f = fixture();
    await expect(
      prepareCollectorImage('private.invalid/image:latest', f.docker, () => Promise.resolve()),
    ).rejects.toThrow('integrity');
    expect(f.calls).toHaveLength(0);
  });
});
