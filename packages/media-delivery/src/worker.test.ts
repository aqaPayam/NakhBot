import { describe, expect, it, vi } from 'vitest';

import {
  HmacMediaAudienceCredentials,
  HmacMediaDeliveryTokens,
  MediaDeliveryUrlSigner,
} from './index.js';
import { createMediaEdge, type MediaEdgeEnvironment } from './worker.js';

const viewer = '10000000-0000-4000-8000-000000000001';
const asset = '20000000-0000-4000-8000-000000000002';
const origin = 'https://media.example.com';
const mediaKey = new Uint8Array(32).fill(7);
const audienceKey = new Uint8Array(32).fill(9);

function encoded(key: Uint8Array): string {
  return Buffer.from(key).toString('base64url');
}

function environment(overrides: Partial<MediaEdgeEnvironment> = {}): MediaEdgeEnvironment {
  return {
    NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED: 'true',
    NAKH_MEDIA_ORIGIN: origin,
    NAKH_MEDIA_ENVIRONMENT: 'staging',
    NAKH_MEDIA_SIGNING_KEYS: JSON.stringify({ 'media-v1': encoded(mediaKey) }),
    NAKH_MEDIA_AUDIENCE_KEYS: JSON.stringify({ 'audience-v1': encoded(audienceKey) }),
    NAKH_MEDIA_BUCKET: {
      get: vi.fn().mockResolvedValue({
        body: new Blob([Uint8Array.from([1, 2, 3])]).stream(),
        size: 3,
      }),
    },
    ...overrides,
  };
}

describe('deployable private media edge', () => {
  it('reads no keys and returns an indistinguishable denial while disabled', async () => {
    const disabled = {
      NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED: 'false',
      get NAKH_MEDIA_SIGNING_KEYS(): string {
        throw new Error('must not read signing keys');
      },
      get NAKH_MEDIA_AUDIENCE_KEYS(): string {
        throw new Error('must not read audience keys');
      },
    } as MediaEdgeEnvironment;
    const response = await createMediaEdge(disabled).fetch(new Request(`${origin}/media/test`));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('authenticates both tokens, maps one private object, and forbids blur caching', async () => {
    const now = Math.floor(Date.now() / 1_000);
    const mediaUrl = new MediaDeliveryUrlSigner(
      origin,
      new HmacMediaDeliveryTokens({
        currentKeyId: 'media-v1',
        keys: new Map([['media-v1', mediaKey]]),
      }),
    ).sign({
      path: `/media/${asset}/blurred-preview-v1.webp`,
      audienceId: viewer,
      purpose: 'liked_by_blur',
      variant: 'blurred_preview',
      issuedAt: now,
      expiresAt: now + 60,
    });
    const audience = await new HmacMediaAudienceCredentials(
      origin,
      { currentKeyId: 'audience-v1', keys: new Map([['audience-v1', audienceKey]]) },
      60,
    ).tokenFor(viewer);
    const get = vi.fn().mockResolvedValue({
      body: new Blob([Uint8Array.from([1, 2, 3])]).stream(),
      size: 3,
    });
    const bindings = environment({ NAKH_MEDIA_BUCKET: { get } });
    const response = await createMediaEdge(bindings).fetch(
      new Request(mediaUrl, { headers: { authorization: `Bearer ${audience}` } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(get).toHaveBeenCalledWith(`variants/staging/${asset}/blurred-preview-v1.webp`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('rejects malformed activation, environment, and key rings before serving', () => {
    expect(() =>
      createMediaEdge(environment({ NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED: 'yes' })),
    ).toThrow('activation flag');
    expect(() => createMediaEdge(environment({ NAKH_MEDIA_ENVIRONMENT: 'preview' }))).toThrow(
      'edge environment',
    );
    expect(() => createMediaEdge(environment({ NAKH_MEDIA_SIGNING_KEYS: '{}' }))).toThrow(
      'key ring',
    );
  });
});
