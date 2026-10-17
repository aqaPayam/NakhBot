import { describe, expect, it, vi, type Mock } from 'vitest';
import type { MediaSourceAuthorityQuery, NakhDatabase } from '@nakh/persistence-postgres';
import { parseConfig } from '@nakh/config';
import {
  HmacMediaAudienceCredentials,
  HmacMediaDeliveryTokens,
  EdgeHmacMediaAudienceAuthenticator,
} from '@nakh/media-delivery';
import { MediaSourceAuthorityVerifier, createMediaAuthorityApi } from './m8-media-authority-api.js';

const origin = 'https://media.example.com',
  actor = '10000000-0000-4000-8000-000000000001';
const signingKey = new Uint8Array(32).fill(7),
  audienceKey = new Uint8Array(32).fill(9);
const issuedAt = 1_800_000_000;
function fixture(): {
  verifier: MediaSourceAuthorityVerifier;
  token: string;
  authorization: Promise<string>;
  path: string;
  current: Mock<(input: MediaSourceAuthorityQuery) => Promise<boolean>>;
  advance: () => void;
} {
  let now = issuedAt;
  const tokens = new HmacMediaDeliveryTokens({
    currentKeyId: 'k1',
    keys: new Map([['k1', signingKey]]),
  });
  const current = vi
    .fn<(input: MediaSourceAuthorityQuery) => Promise<boolean>>()
    .mockResolvedValue(true);
  const audience = new EdgeHmacMediaAudienceAuthenticator(
    origin,
    new Map([['a1', audienceKey]]),
    () => now,
  );
  const path = '/media/20000000-0000-4000-8000-000000000002/thumbnail-v1.webp';
  const token = tokens.sign({
    authorityId: '30000000-0000-4000-8000-000000000003',
    path,
    audienceId: actor,
    purpose: 'owner_preview',
    variant: 'thumbnail',
    issuedAt,
    expiresAt: issuedAt + 60,
  });
  const authorization = new HmacMediaAudienceCredentials(
    origin,
    { currentKeyId: 'a1', keys: new Map([['a1', audienceKey]]) },
    10,
    () => now,
  )
    .tokenFor(actor)
    .then((value) => 'Bearer ' + value);
  return {
    verifier: new MediaSourceAuthorityVerifier(
      origin,
      tokens,
      audience,
      { isCurrent: current },
      () => now,
    ),
    token,
    authorization,
    path,
    current,
    advance: () => {
      now += 11;
    },
  };
}
describe('media source API authentication', () => {
  it('activates native media authority for Guest Preview independently of Liked By delivery', () => {
    const config = parseConfig({
      NAKH_ENV: 'test',
      NAKH_SERVICE_NAME: 'api',
      NAKH_DATABASE_URL: 'postgresql://test',
      NAKH_REDIS_URL: 'redis://test',
      NAKH_TELEGRAM_BOT_TOKEN_REF: 'fake',
      NAKH_TELEGRAM_WEBHOOK_SECRET: '1'.repeat(32),
      NAKH_R2_ENDPOINT: 'https://r2.invalid',
      NAKH_R2_BUCKET: 'test',
      NAKH_R2_ACCESS_KEY_REF: 'fake',
      NAKH_R2_SECRET_KEY_REF: 'fake',
      NAKH_MEDIA_CDN_HOST: 'media.example.com',
      NAKH_MEDIA_SIGNING_KEY_REF: 'SIGNING_KEY',
      NAKH_MEDIA_AUDIENCE_KEY_REF: 'AUDIENCE_KEY',
      NAKH_TELEGRAM_GUEST_PREVIEW_ENABLED: 'true',
      NAKH_TELEGRAM_SIGNUP_ENABLED: 'true',
      NAKH_TELEGRAM_START_DELIVERY_ENABLED: 'true',
      NAKH_MEDIA_INGESTION_ENABLED: 'true',
    });
    expect(config.telegram.likedByDeliveryEnabled).toBe(false);
    expect(
      createMediaAuthorityApi(config, {} as NakhDatabase, (reference) =>
        Buffer.from(reference === 'SIGNING_KEY' ? signingKey : audienceKey).toString('base64url'),
      ),
    ).toHaveLength(1);
  });
  it('binds original source authority to the actual signed grant and independent audience credential', async () => {
    const f = fixture();
    expect(await f.verifier.check(await f.authorization, { path: f.path, token: f.token })).toBe(
      true,
    );
    expect(f.current).toHaveBeenCalledWith(
      expect.objectContaining({
        audienceId: actor,
        authorityId: '30000000-0000-4000-8000-000000000003',
        path: f.path,
      }),
    );
  });
  it('does not reach native authority for missing identity, forged grants, wrong paths or extra input', async () => {
    const f = fixture(),
      authorization = await f.authorization;
    for (const [header, body] of [
      [undefined, { path: f.path, token: f.token }],
      [authorization, { path: f.path, token: f.token + 'x' }],
      [authorization, { path: f.path + 'x', token: f.token }],
      [authorization, { path: f.path, token: f.token, audienceId: actor }],
    ] as const)
      expect(await f.verifier.check(header, body)).toBe(false);
    expect(f.current).not.toHaveBeenCalled();
  });
  it('fails closed when native authority is unavailable or the audience expires during its wait', async () => {
    const f = fixture(),
      authorization = await f.authorization;
    f.current.mockRejectedValueOnce(new Error('synthetic native outage'));
    expect(await f.verifier.check(authorization, { path: f.path, token: f.token })).toBe(false);
    f.current.mockImplementationOnce(() => {
      f.advance();
      return Promise.resolve(true);
    });
    expect(await f.verifier.check(authorization, { path: f.path, token: f.token })).toBe(false);
  });
});
