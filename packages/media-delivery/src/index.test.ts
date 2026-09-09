import { describe, expect, it } from 'vitest';

import {
  HmacMediaDeliveryTokens,
  MediaDeliveryUrlSigner,
  type MediaDeliveryClaims,
} from './index.js';

const audienceId = '10000000-0000-4000-8000-000000000001';
const path = '/media/20000000-0000-4000-8000-000000000002/thumbnail-v1.webp';
const claims: MediaDeliveryClaims = {
  path,
  audienceId,
  purpose: 'profile_card',
  variant: 'thumbnail',
  issuedAt: 1_800_000_000,
  expiresAt: 1_800_000_060,
};
const oldKey = new Uint8Array(32).fill(1);
const currentKey = new Uint8Array(32).fill(2);

function tokens(currentKeyId = 'k2'): HmacMediaDeliveryTokens {
  return new HmacMediaDeliveryTokens({
    currentKeyId,
    keys: new Map([
      ['k1', oldKey],
      ['k2', currentKey],
    ]),
  });
}

describe('HmacMediaDeliveryTokens', () => {
  it('binds a short-lived token to path, audience, purpose, and rendition', () => {
    const codec = tokens();
    const token = codec.sign(claims);
    expect(codec.verify(token, { path, audienceId, now: claims.issuedAt })).toEqual(claims);
    for (const expected of [
      { path: path.replace('thumbnail', 'blurred-preview'), audienceId },
      { path, audienceId: '30000000-0000-4000-8000-000000000003' },
    ])
      expect(() => codec.verify(token, { ...expected, now: claims.issuedAt })).toThrow(
        'media_grant_invalid',
      );
  });

  it('rejects expiry and every signature or payload tamper', () => {
    const codec = tokens();
    const token = codec.sign(claims);
    expect(() => codec.verify(token, { path, audienceId, now: claims.expiresAt })).toThrow(
      'media_grant_invalid',
    );
    const [body, signature] = token.split('.');
    expect(() =>
      codec.verify(`${body}a.${signature}`, { path, audienceId, now: claims.issuedAt }),
    ).toThrow('media_grant_invalid');
    expect(() =>
      codec.verify(`${body}.${signature!.replace(/^./u, 'A')}`, {
        path,
        audienceId,
        now: claims.issuedAt,
      }),
    ).toThrow('media_grant_invalid');
  });

  it('accepts an old verification key while signing only with the current key', () => {
    const oldToken = tokens('k1').sign(claims);
    expect(tokens('k2').verify(oldToken, { path, audienceId, now: claims.issuedAt })).toEqual(
      claims,
    );
    const currentToken = tokens('k2').sign(claims);
    expect(() =>
      new HmacMediaDeliveryTokens({
        currentKeyId: 'k1',
        keys: new Map([['k1', oldKey]]),
      }).verify(currentToken, { path, audienceId, now: claims.issuedAt }),
    ).toThrow('media_grant_invalid');
  });

  it('enforces purpose/rendition combinations and the five-minute TTL ceiling', () => {
    expect(() => tokens().sign({ ...claims, purpose: 'liked_by_blur' })).toThrow(
      'media_grant_invalid',
    );
    expect(() => tokens().sign({ ...claims, expiresAt: claims.issuedAt + 301 })).toThrow(
      'media_grant_invalid',
    );
  });

  it('creates an HTTPS URL without placing claims in query fields', () => {
    const url = new URL(
      new MediaDeliveryUrlSigner('https://media.example.com', tokens()).sign(claims),
    );
    expect(url.origin).toBe('https://media.example.com');
    expect(url.pathname).toBe(path);
    expect([...url.searchParams.keys()]).toEqual(['token']);
  });
});
