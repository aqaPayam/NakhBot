import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HmacMediaDeliveryTokens, MediaDeliveryUrlSigner } from './index.js';
import {
  CloudflarePrivateMediaWorker,
  EdgeHmacMediaDeliveryTokens,
  type PrivateR2Object,
} from './edge.js';
import { EdgeHttpMediaSourceAuthority } from './authority-edge.js';

const actor = '10000000-0000-4000-8000-000000000001';
const asset = '20000000-0000-4000-8000-000000000002';
const authorityId = '30000000-0000-4000-8000-000000000003';
const origin = 'https://media.example.com',
  issuedAt = 1_800_000_000;
const key = new Uint8Array(32).fill(7);
const claims = {
  authorityId,
  path: `/media/${asset}/thumbnail-v1.webp`,
  audienceId: actor,
  purpose: 'owner_preview' as const,
  variant: 'thumbnail' as const,
  issuedAt,
  expiresAt: issuedAt + 60,
};
const codec = new HmacMediaDeliveryTokens({ currentKeyId: 'k1', keys: new Map([['k1', key]]) });
const request = (): Request =>
  new Request(new MediaDeliveryUrlSigner(origin, codec).sign(claims), {
    headers: { authorization: 'Bearer synthetic' },
  });
function latch(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function edge(
  get: () => Promise<PrivateR2Object | null>,
  current: () => Promise<boolean>,
  now: () => number = () => issuedAt,
): CloudflarePrivateMediaWorker {
  return new CloudflarePrivateMediaWorker({
    origin,
    environment: 'test',
    tokens: new EdgeHmacMediaDeliveryTokens(new Map([['k1', key]])),
    audience: { authenticate: () => Promise.resolve(actor) },
    authority: { isCurrent: current },
    bucket: { get },
    now,
  });
}
describe('current source authority at every media boundary', () => {
  it('never reaches private storage when current native authority is denied or unavailable', async () => {
    for (const current of [
      () => Promise.resolve(false),
      () => Promise.reject(new Error('synthetic authority outage')),
    ]) {
      const get = vi.fn().mockResolvedValue({ body: new Uint8Array([1]), size: 1 });
      const response = await edge(get, current).fetch(request());
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(get).not.toHaveBeenCalled();
    }
  });
  it.each(['source revoked', 'grant expired'] as const)(
    'cancels an object after a provider wait when %s',
    async (reason) => {
      const started = latch(),
        release = latch();
      let current = true,
        now = issuedAt;
      const cancel = vi.fn<() => void>();
      const body = new ReadableStream<Uint8Array>({ cancel: () => cancel() }, { highWaterMark: 0 });
      const responsePromise = edge(
        async () => {
          started.release();
          await release.promise;
          return { body, size: 1 };
        },
        () => Promise.resolve(current),
        () => now,
      ).fetch(request());
      await started.promise;
      if (reason === 'source revoked') current = false;
      else now = claims.expiresAt;
      release.release();
      const response = await responsePromise;
      expect(response.status).toBe(404);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it('rechecks authority after a delayed stream read and returns no revoked chunk', async () => {
    const started = latch(),
      release = latch();
    let current = true;
    const cancel = vi.fn<() => void>();
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          started.release();
          await release.promise;
          controller.enqueue(new Uint8Array([19]));
        },
        cancel: () => cancel(),
      },
      { highWaterMark: 0 },
    );
    const response = await edge(
      () => Promise.resolve({ body, size: 1 }),
      () => Promise.resolve(current),
    ).fetch(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const bytes = response.arrayBuffer();
    const rejected = expect(bytes).rejects.toThrow('media_delivery_revoked');
    await started.promise;
    current = false;
    release.release();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not wait for unfinished provider cleanup before denying a revoked object', async () => {
    let current = true;
    const cancel = vi
      .fn<() => Promise<void>>()
      .mockImplementation(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const response = await edge(
      () => {
        current = false;
        return Promise.resolve({ body, size: 1 });
      },
      () => Promise.resolve(current),
    ).fetch(request());
    expect(response.status).toBe(404);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects legacy signature-only grants even with a valid old signing key', async () => {
    const body = Buffer.from(
      JSON.stringify([
        1,
        'k1',
        claims.path,
        actor,
        claims.purpose,
        claims.variant,
        issuedAt,
        claims.expiresAt,
      ]),
    ).toString('base64url');
    const token = body + '.' + createHmac('sha256', key).update(body).digest('base64url');
    expect(() =>
      codec.verify(token, { path: claims.path, audienceId: actor, now: issuedAt }),
    ).toThrow('media_grant_invalid');
    await expect(
      new EdgeHmacMediaDeliveryTokens(new Map([['k1', key]])).verify(token, {
        path: claims.path,
        audienceId: actor,
        now: issuedAt,
      }),
    ).rejects.toThrow('media_grant_invalid');
  });
  it('uses a bounded fixed HTTPS request and rejects redirects, malformed or cacheable authority replies', async () => {
    for (const url of [
      'http://api.example.com/internal/media/source-authority',
      'https://api.example.com:444/internal/media/source-authority',
      'https://user@api.example.com/internal/media/source-authority',
      'https://api.example.com/internal/media/source-authority?next=x',
    ])
      expect(() => new EdgeHttpMediaSourceAuthority(url)).toThrow('media_authority_invalid');
    for (const reply of [
      () => new Response('{}', { status: 302 }),
      () =>
        new Response('{"allowed":true}', {
          headers: { 'content-type': 'application/json', 'cache-control': 'private' },
        }),
      () =>
        new Response('{"allowed":true,"unexpected":1}', {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        }),
      () =>
        new Response(' '.repeat(65), {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        }),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(reply()));
      const client = new EdgeHttpMediaSourceAuthority(
        'https://api.example.com/internal/media/source-authority',
        fetcher,
      );
      expect(await client.isCurrent(request(), claims)).toBe(false);
      expect(fetcher).toHaveBeenCalledWith(
        'https://api.example.com/internal/media/source-authority',
        expect.objectContaining({
          redirect: 'error',
          cache: 'no-store',
          method: 'POST',
        }),
      );
      expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    }
  });
});
