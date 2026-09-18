import { describe, expect, it, vi } from 'vitest';

import {
  CloudflarePrivateMediaWorker,
  EdgeHmacMediaAudienceAuthenticator,
  EdgeHmacMediaDeliveryTokens,
} from './edge.js';
import {
  HmacMediaAudienceCredentials,
  HmacMediaDeliveryTokens,
  MediaDeliveryUrlSigner,
} from './index.js';

const viewer = '10000000-0000-4000-8000-000000000001';
const other = '30000000-0000-4000-8000-000000000003';
const asset = '20000000-0000-4000-8000-000000000002';
const now = 1_800_000_000;
const audienceKey = new Uint8Array(32).fill(9);
const mediaKey = new Uint8Array(32).fill(7);

function issuer(key = audienceKey): HmacMediaAudienceCredentials {
  return new HmacMediaAudienceCredentials(
    'https://media.example.com',
    { currentKeyId: 'a1', keys: new Map([['a1', key]]) },
    60,
    () => now,
  );
}

function signedMediaUrl(audienceId = viewer): string {
  return new MediaDeliveryUrlSigner(
    'https://media.example.com',
    new HmacMediaDeliveryTokens({ currentKeyId: 'm1', keys: new Map([['m1', mediaKey]]) }),
  ).sign({
    path: `/media/${asset}/blurred-preview-v1.webp`,
    audienceId,
    purpose: 'liked_by_blur',
    variant: 'blurred_preview',
    issuedAt: now,
    expiresAt: now + 60,
  });
}

describe('private media audience credentials', () => {
  it('authenticates a gateway-minted viewer at the edge before private R2 access', async () => {
    const get = vi.fn().mockResolvedValue({ body: new Uint8Array([1, 2]), size: 2 });
    const worker = new CloudflarePrivateMediaWorker({
      origin: 'https://media.example.com',
      environment: 'production',
      tokens: new EdgeHmacMediaDeliveryTokens(new Map([['m1', mediaKey]])),
      audience: new EdgeHmacMediaAudienceAuthenticator(
        'https://media.example.com',
        new Map([['a1', audienceKey]]),
        () => now,
      ),
      bucket: { get },
      now: () => now,
    });
    const credential = await issuer().tokenFor(viewer);
    const response = await worker.fetch(
      new Request(signedMediaUrl(), { headers: { authorization: `Bearer ${credential}` } }),
    );
    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith(`variants/production/${asset}/blurred-preview-v1.webp`);
    expect(await response.arrayBuffer()).toEqual(Uint8Array.from([1, 2]).buffer);

    get.mockClear();
    const stolen = await worker.fetch(
      new Request(signedMediaUrl(other), { headers: { authorization: `Bearer ${credential}` } }),
    );
    expect(stolen.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects spoofed headers, tampering, expiry, and wrong signing keys', async () => {
    const issued = await issuer().tokenFor(viewer);
    const edge = new EdgeHmacMediaAudienceAuthenticator(
      'https://media.example.com',
      new Map([['a1', audienceKey]]),
      () => now,
    );
    const request = (header?: string): Request =>
      new Request(signedMediaUrl(), {
        headers: header === undefined ? { 'x-user-id': viewer } : { authorization: header },
      });
    expect(await edge.authenticate(request())).toBeNull();
    expect(await edge.authenticate(request(`Bearer ${issued}x`))).toBeNull();
    expect(await edge.authenticate(request(`Basic ${issued}`))).toBeNull();
    expect(await edge.authenticate(request(`Bearer ${issued},Bearer ${issued}`))).toBeNull();
    expect(await edge.authenticate(request(`Bearer ${issued}`))).toBe(viewer);
    expect(
      await new EdgeHmacMediaAudienceAuthenticator(
        'https://media.example.com',
        new Map([['a1', new Uint8Array(32).fill(8)]]),
        () => now,
      ).authenticate(request(`Bearer ${issued}`)),
    ).toBeNull();
    expect(
      await new EdgeHmacMediaAudienceAuthenticator(
        'https://media.example.com',
        new Map([['a1', audienceKey]]),
        () => now + 60,
      ).authenticate(request(`Bearer ${issued}`)),
    ).toBeNull();
    expect(
      await new EdgeHmacMediaAudienceAuthenticator(
        'https://other.example.com',
        new Map([['a1', audienceKey]]),
        () => now,
      ).authenticate(request(`Bearer ${issued}`)),
    ).toBeNull();
  });

  it('uses fresh nonces, strict audience IDs, and a bounded rotation window', async () => {
    const first = await issuer().tokenFor(viewer);
    const second = await issuer().tokenFor(viewer);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThan(512);
    expect(() => issuer().tokenFor('not-a-viewer')).toThrow();
    expect(
      () =>
        new HmacMediaAudienceCredentials('http://media.example.com', {
          currentKeyId: 'a1',
          keys: new Map([['a1', audienceKey]]),
        }),
    ).toThrow();
    const rotated = new EdgeHmacMediaAudienceAuthenticator(
      'https://media.example.com',
      new Map([
        ['a1', audienceKey],
        ['a2', new Uint8Array(32).fill(3)],
      ]),
      () => now,
    );
    expect(
      await rotated.authenticate(
        new Request(signedMediaUrl(), { headers: { authorization: `Bearer ${first}` } }),
      ),
    ).toBe(viewer);
    expect(
      () =>
        new HmacMediaAudienceCredentials('https://media.example.com', {
          currentKeyId: 'a1',
          keys: new Map([['a1', new Uint8Array(31)]]),
        }),
    ).toThrow();
  });
});
