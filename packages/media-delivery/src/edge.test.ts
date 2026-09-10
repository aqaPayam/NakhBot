import { describe, expect, it, vi } from 'vitest';

import {
  HmacMediaDeliveryTokens,
  MediaDeliveryUrlSigner,
  type MediaDeliveryClaims,
} from './index.js';
import {
  CloudflarePrivateMediaWorker,
  EdgeHmacMediaDeliveryTokens,
  type PrivateR2Bucket,
} from './edge.js';

const audienceId = '10000000-0000-4000-8000-000000000001';
const assetId = '20000000-0000-4000-8000-000000000002';
const path = `/media/${assetId}/thumbnail-v1.webp`;
const now = 1_800_000_000;
const key = new Uint8Array(32).fill(7);
type WorkerFixture = Readonly<{
  get: PrivateR2Bucket['get'];
  worker: CloudflarePrivateMediaWorker;
}>;

function signedUrl(overrides: Partial<MediaDeliveryClaims> = {}): string {
  const claims: MediaDeliveryClaims = {
    path,
    audienceId,
    purpose: 'profile_card',
    variant: 'thumbnail',
    issuedAt: now,
    expiresAt: now + 60,
    ...overrides,
  };
  return new MediaDeliveryUrlSigner(
    'https://media.example.com',
    new HmacMediaDeliveryTokens({ currentKeyId: 'k1', keys: new Map([['k1', key]]) }),
  ).sign(claims);
}

function worker(
  input: Readonly<{ audienceId?: string | null; get?: PrivateR2Bucket['get'] }> = {},
): WorkerFixture {
  const get: PrivateR2Bucket['get'] =
    input.get ?? vi.fn().mockResolvedValue({ body: new Uint8Array([1, 2, 3]), size: 3 });
  return {
    get,
    worker: new CloudflarePrivateMediaWorker({
      origin: 'https://media.example.com',
      environment: 'production',
      tokens: new EdgeHmacMediaDeliveryTokens(new Map([['k1', key]])),
      audience: {
        authenticate: () =>
          Promise.resolve(input.audienceId === undefined ? audienceId : input.audienceId),
      },
      bucket: { get },
      now: () => now,
    }),
  };
}

describe('CloudflarePrivateMediaWorker', () => {
  it('verifies a backend token and maps only its logical path to the private R2 key', async () => {
    const edge = worker();
    const response = await edge.worker.fetch(new Request(signedUrl()));
    expect(response.status).toBe(200);
    expect(await response.arrayBuffer()).toEqual(Uint8Array.from([1, 2, 3]).buffer);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('private, max-age=60');
    expect(edge.get).toHaveBeenCalledWith(`variants/production/${assetId}/thumbnail-v1.webp`);
  });

  it('fails closed before R2 for a different viewer, token tamper, or extra query input', async () => {
    const cases = [
      { request: new Request(signedUrl()), audience: '30000000-0000-4000-8000-000000000003' },
      { request: new Request(`${signedUrl()}x`), audience: audienceId },
      { request: new Request(`${signedUrl()}&key=attacker`), audience: audienceId },
    ];
    for (const item of cases) {
      const edge = worker({ audienceId: item.audience });
      const response = await edge.worker.fetch(item.request);
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(edge.get).not.toHaveBeenCalled();
    }
  });

  it('uses indistinguishable denial for unauthenticated, missing, wrong-origin, and non-GET access', async () => {
    const missing = vi.fn().mockResolvedValue(null);
    const cases = [
      { edge: worker({ audienceId: null }), request: new Request(signedUrl()) },
      { edge: worker({ get: missing }), request: new Request(signedUrl()) },
      {
        edge: worker(),
        request: new Request(signedUrl().replace('media.example.com', 'attacker.example')),
      },
      { edge: worker(), request: new Request(signedUrl(), { method: 'POST' }) },
    ];
    for (const item of cases) expect((await item.edge.worker.fetch(item.request)).status).toBe(404);
  });

  it('never caches moderation evidence', async () => {
    const edge = worker();
    const response = await edge.worker.fetch(
      new Request(signedUrl({ purpose: 'moderation_evidence' })),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
