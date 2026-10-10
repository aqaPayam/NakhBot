import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig, type AppConfig } from '@nakh/config';
import {
  HmacMediaAudienceCredentials,
  HmacMediaDeliveryTokens,
  MediaDeliveryUrlSigner,
} from '@nakh/media-delivery';
import { createMediaEdge } from '../../../packages/media-delivery/src/worker.js';
import {
  PostgresMediaDeliveryAuthorization,
  createDatabase,
  runMigrations,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createMediaAuthorityFixture } from '../../../packages/persistence-postgres/src/testing/media-authority-fixture.js';
import { createDeletionFixture } from '../../../packages/persistence-postgres/src/testing/deletion-fixture.js';
import { ApiModule } from './app.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
const origin = 'https://media.example.com',
  endpoint = 'https://api.example.com/internal/media/source-authority';
const signingKey = new Uint8Array(32).fill(7),
  audienceKey = new Uint8Array(32).fill(9);
describe.skipIf(url === undefined)('production media API/native/edge composition', () => {
  let database: NakhDatabase,
    app: NestFastifyApplication,
    store: PostgresMediaDeliveryAuthorization,
    config: AppConfig;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_media_api');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
    store = new PostgresMediaDeliveryAuthorization(database, 'test');
    vi.stubEnv('M8_MEDIA_SIGNING_KEY', Buffer.from(signingKey).toString('base64url'));
    vi.stubEnv('M8_MEDIA_AUDIENCE_KEY', Buffer.from(audienceKey).toString('base64url'));
    config = parseConfig({
      NAKH_ENV: 'test',
      NAKH_SERVICE_NAME: 'api',
      NAKH_DATABASE_URL: isolated.url,
      NAKH_REDIS_URL: 'redis://test',
      NAKH_TELEGRAM_BOT_TOKEN_REF: 'fake',
      NAKH_TELEGRAM_WEBHOOK_SECRET: '12345678901234567890123456789012',
      NAKH_R2_ENDPOINT: 'https://r2.invalid',
      NAKH_R2_BUCKET: 'test',
      NAKH_R2_ACCESS_KEY_REF: 'fake',
      NAKH_R2_SECRET_KEY_REF: 'fake',
      NAKH_MEDIA_CDN_HOST: 'media.example.com',
      NAKH_MEDIA_SIGNING_KEY_REF: 'M8_MEDIA_SIGNING_KEY',
      NAKH_MEDIA_AUDIENCE_KEY_REF: 'M8_MEDIA_AUDIENCE_KEY',
      NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED: 'true',
      NAKH_DATABASE_POOL_MAX: '24',
      NAKH_DATABASE_LOCK_TIMEOUT_MS: '10000',
    });
    app = await NestFactory.create<NestFastifyApplication>(
      ApiModule.register(config, pino({ enabled: false })),
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
    await database?.destroy();
    await isolated?.destroy();
    vi.unstubAllEnvs();
  });
  const authorityFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(endpoint);
    const response = await app.inject({
      method: 'POST',
      url: '/internal/media/source-authority',
      headers: Object.fromEntries(request.headers),
      payload: await request.text(),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: {
        'content-type': String(response.headers['content-type']),
        'cache-control': String(response.headers['cache-control']),
      },
    });
  };
  async function delivery(
    source: Awaited<ReturnType<typeof createMediaAuthorityFixture>>,
    purpose: 'owner_preview' | 'liked_by_blur' = 'owner_preview',
  ): Promise<Request> {
    const receipt = await store.authorize({
      actor: { kind: 'user', userId: source.actorUserId },
      photoId: source.photoId,
      purpose,
      requestedVariant: purpose === 'owner_preview' ? 'thumbnail' : 'blurred_preview',
    });
    const mediaUrl = new MediaDeliveryUrlSigner(
      origin,
      new HmacMediaDeliveryTokens({
        currentKeyId: config.media.signingKeyId,
        keys: new Map([[config.media.signingKeyId, signingKey]]),
      }),
    ).sign({
      authorityId: receipt.authorityId,
      path: receipt.deliveryPath,
      audienceId: source.actorUserId,
      purpose,
      variant: receipt.variantType,
      issuedAt: receipt.issuedAt,
      expiresAt: receipt.expiresAt,
    });
    const audience = await new HmacMediaAudienceCredentials(origin, {
      currentKeyId: config.media.audienceKeyId,
      keys: new Map([[config.media.audienceKeyId, audienceKey]]),
    }).tokenFor(source.actorUserId);
    return new Request(mediaUrl, { headers: { authorization: 'Bearer ' + audience } });
  }
  function edge(
    get: () => Promise<{ body: ReadableStream<Uint8Array>; size: number }>,
  ): ReturnType<typeof createMediaEdge> {
    return createMediaEdge(
      {
        NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED: 'true',
        NAKH_MEDIA_ORIGIN: origin,
        NAKH_MEDIA_ENVIRONMENT: 'test',
        NAKH_MEDIA_SIGNING_KEYS: JSON.stringify({
          [config.media.signingKeyId]: Buffer.from(signingKey).toString('base64url'),
        }),
        NAKH_MEDIA_AUDIENCE_KEYS: JSON.stringify({
          [config.media.audienceKeyId]: Buffer.from(audienceKey).toString('base64url'),
        }),
        NAKH_MEDIA_AUTHORITY_URL: endpoint,
        NAKH_MEDIA_BUCKET: { get },
      },
      authorityFetch,
    );
  }
  it('serves twenty concurrent authorized requests through real signed audience, HTTP controller and native source checks', async () => {
    const source = await createMediaAuthorityFixture(database, 'liked_by_blur');
    const request = await delivery(source, 'liked_by_blur');
    const originalReceipts = await database
      .selectFrom('media.delivery_grants')
      .selectAll()
      .where('actor_user_id', '=', source.actorUserId)
      .execute();
    expect(originalReceipts).toHaveLength(1);
    const get = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ body: new Blob([new Uint8Array([1, 2, 3])]).stream(), size: 3 }),
      );
    const runtime = edge(get);
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => runtime.fetch(request.clone())),
    );
    expect(
      responses.every(
        (response) =>
          response.status === 200 && response.headers.get('cache-control') === 'no-store',
      ),
    ).toBe(true);
    const bodies = await Promise.all(responses.map((response) => response.arrayBuffer()));
    expect(bodies.every((body) => Buffer.from(body).equals(Buffer.from([1, 2, 3])))).toBe(true);
    expect(get).toHaveBeenCalledTimes(20);
    const replayedReceipts = await database
      .selectFrom('media.delivery_grants')
      .selectAll()
      .where('actor_user_id', '=', source.actorUserId)
      .execute();
    expect(replayedReceipts).toEqual(originalReceipts);
    const token = new URL(request.url).searchParams.get('token')!;
    const allowed = await app.inject({
      method: 'POST',
      url: '/internal/media/source-authority',
      headers: { authorization: request.headers.get('authorization')! },
      payload: { path: new URL(request.url).pathname, token },
    });
    expect(allowed.json()).toEqual({ allowed: true });
    expect(allowed.headers['cache-control']).toBe('no-store');
    const forged = await app.inject({
      method: 'POST',
      url: '/internal/media/source-authority',
      payload: { path: new URL(request.url).pathname, token },
    });
    expect(forged.json()).toEqual({ allowed: false });
  });
  it('revokes a signed owner URL and cancels bytes when a real deletion commits during a storage wait', async () => {
    let release = (): void => {},
      started = (): void => {};
    const released = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const storageStarted = new Promise<void>((resolvePromise) => {
      started = resolvePromise;
    });
    const cancel = vi.fn<() => void>();
    const body = new ReadableStream<Uint8Array>({ cancel: () => cancel() }, { highWaterMark: 0 });
    const get = vi.fn().mockImplementation(async () => {
      started();
      await released;
      return { body, size: 3 };
    });
    const runtime = edge(get);
    let pending: Promise<Response> | undefined, original: Request | undefined;
    await createDeletionFixture(database, async (userId) => {
      const source = await createMediaAuthorityFixture(database, 'owner_preview', userId);
      original = await delivery(source);
      pending = runtime.fetch(original.clone());
      await storageStarted;
    });
    release();
    const response = await pending!;
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(cancel).toHaveBeenCalledOnce();
    const again = await runtime.fetch(original!.clone());
    expect(again.status).toBe(404);
    expect(get).toHaveBeenCalledOnce();
  });
});
