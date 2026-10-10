import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import {
  PostgresMediaDeliveryAuthorization,
  type MediaSourceAuthorityQuery,
} from './media-delivery-authorization.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createMediaAuthorityFixture } from './testing/media-authority-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 exact native media source authority', () => {
  let database: NakhDatabase, store: PostgresMediaDeliveryAuthorization;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_media_authority');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
    store = new PostgresMediaDeliveryAuthorization(database, 'test');
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  async function grant(purpose: 'owner_preview' | 'liked_by_blur' = 'owner_preview'): Promise<{
    source: Awaited<ReturnType<typeof createMediaAuthorityFixture>>;
    query: MediaSourceAuthorityQuery;
  }> {
    const source = await createMediaAuthorityFixture(database, purpose);
    const receipt = await store.authorize({
      actor: { kind: 'user', userId: source.actorUserId },
      photoId: source.photoId,
      purpose,
      requestedVariant: purpose === 'owner_preview' ? 'thumbnail' : 'blurred_preview',
    });
    return {
      source,
      query: {
        authorityId: receipt.authorityId,
        path: receipt.deliveryPath,
        audienceId: source.actorUserId,
        purpose,
        variant: receipt.variantType,
        issuedAt: receipt.issuedAt,
        expiresAt: receipt.expiresAt,
      },
    };
  }
  it('issues twenty distinct opaque receipts with original source and database expiry under contention', async () => {
    const source = await createMediaAuthorityFixture(database);
    const receipts = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.authorize({
          actor: { kind: 'user', userId: source.actorUserId },
          photoId: source.photoId,
          purpose: 'owner_preview',
          requestedVariant: 'thumbnail',
        }),
      ),
    );
    expect(new Set(receipts.map((row) => row.authorityId)).size).toBe(20);
    const rows = await database
      .selectFrom('media.delivery_grants')
      .selectAll()
      .where('actor_user_id', '=', source.actorUserId)
      .execute();
    expect(rows).toHaveLength(20);
    for (const row of rows)
      expect(row).toMatchObject({
        photo_id: source.photoId,
        asset_id: source.assetId,
        variant_id: source.variantId,
        actor_product_epoch: 0,
        owner_product_epoch: 0,
        like_id: null,
        environment: 'test',
      });
    expect(
      receipts.every(
        (row) => row.cachePolicy === 'no-store' && row.expiresAt - row.issuedAt === 60,
      ),
    ).toBe(true);
    const current = await Promise.all(
      receipts.map((row) =>
        store.isCurrent({
          authorityId: row.authorityId,
          audienceId: source.actorUserId,
          path: row.deliveryPath,
          purpose: 'owner_preview',
          variant: 'thumbnail',
          issuedAt: row.issuedAt,
          expiresAt: row.expiresAt,
        }),
      ),
    );
    expect(current).toEqual(Array<boolean>(20).fill(true));
  });
  it('denies borrowed authority and every changed signed binding or environment', async () => {
    const { query } = await grant();
    expect(await store.isCurrent(query)).toBe(true);
    for (const change of [
      { authorityId: randomUUID() },
      { audienceId: randomUUID() },
      { path: query.path + 'x' },
      { purpose: 'moderation_evidence' },
      { variant: 'blurred_preview' },
      { issuedAt: query.issuedAt - 1 },
      { expiresAt: query.expiresAt + 1 },
    ])
      expect(await store.isCurrent({ ...query, ...change })).toBe(false);
    expect(await new PostgresMediaDeliveryAuthorization(database, 'staging').isCurrent(query)).toBe(
      false,
    );
  });

  it.each(['fresh expiry', 'source closed'] as const)(
    'rechecks %s after an observed identity lock wait',
    async (mode) => {
      const source = await createMediaAuthorityFixture(database);
      let release = (): void => {},
        locked = (): void => {};
      const released = new Promise<void>((resolvePromise) => {
        release = resolvePromise;
      });
      const lockReady = new Promise<void>((resolvePromise) => {
        locked = resolvePromise;
      });
      let releasedAt = new Date();
      const holder = database.transaction().execute(async (tx) => {
        await tx
          .selectFrom('identity.users')
          .select('id')
          .where('id', '=', source.actorUserId)
          .forNoKeyUpdate()
          .execute();
        locked();
        await released;
        if (mode === 'source closed') {
          const at = new Date();
          await tx
            .updateTable('media.profile_photos')
            .set({
              status: 'deleted',
              is_primary: false,
              deleted_at: at,
              updated_at: at,
              version: 2,
            })
            .where('id', '=', source.photoId)
            .execute();
        }
        const clock = await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(tx);
        releasedAt = clock.rows[0]!.at;
      });
      await lockReady;
      const pending = store.authorize({
        actor: { kind: 'user', userId: source.actorUserId },
        photoId: source.photoId,
        purpose: 'owner_preview',
        requestedVariant: 'thumbnail',
        ttlSeconds: 10,
      });
      const result = pending.then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error: error as unknown }),
      );
      try {
        let observed = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const wait = await sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock') AS waiting`.execute(
            database,
          );
          if (wait.rows[0]?.waiting) {
            observed = true;
            break;
          }
          await delay(10);
        }
        expect(observed).toBe(true);
        await delay(1100);
      } finally {
        release();
        await holder;
      }
      const settled = await result;
      if (mode === 'fresh expiry') {
        expect(settled.error).toBeUndefined();
        expect(settled.value).toBeDefined();
        expect(settled.value!.issuedAt).toBeGreaterThanOrEqual(
          Math.floor(releasedAt.getTime() / 1000),
        );
        expect(settled.value!.expiresAt - settled.value!.issuedAt).toBe(10);
      } else {
        expect(settled.value).toBeUndefined();
        expect(settled.error).toMatchObject({ code: 'media_delivery_denied' });
        const count = await database
          .selectFrom('media.delivery_grants')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('owner_user_id', '=', source.ownerUserId)
          .executeTakeFirstOrThrow();
        expect(count.count).toBe('0');
      }
    },
  );

  it('expires and releases ordinary authority without making an old signed scope current again', async () => {
    const source = await createMediaAuthorityFixture(database);
    const receipt = await store.authorize({
      actor: { kind: 'user', userId: source.actorUserId },
      photoId: source.photoId,
      purpose: 'owner_preview',
      requestedVariant: 'thumbnail',
      ttlSeconds: 10,
    });
    const query = {
      authorityId: receipt.authorityId,
      audienceId: source.actorUserId,
      path: receipt.deliveryPath,
      purpose: 'owner_preview',
      variant: 'thumbnail',
      issuedAt: receipt.issuedAt,
      expiresAt: receipt.expiresAt,
    };
    expect(await store.isCurrent(query)).toBe(true);
    const clock = await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(database);
    await delay(Math.max(0, receipt.expiresAt * 1000 - clock.rows[0]!.at.getTime()) + 100);
    expect(await store.isCurrent(query)).toBe(false);
    const removed = await database
      .deleteFrom('media.delivery_grants')
      .where('id', '=', receipt.authorityId)
      .returning('id')
      .execute();
    expect(removed).toHaveLength(1);
    expect(await store.isCurrent(query)).toBe(false);
  });
  it('requires original epoch and variant ownership and forbids rebinding unexpired receipts', async () => {
    const { query } = await grant();
    const row = await database
      .selectFrom('media.delivery_grants')
      .selectAll()
      .where('id', '=', query.authorityId)
      .executeTakeFirstOrThrow();
    await expect(
      database
        .updateTable('media.delivery_grants')
        .set({ like_id: randomUUID() })
        .where('id', '=', row.id)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      database.deleteFrom('media.delivery_grants').where('id', '=', row.id).execute(),
    ).rejects.toMatchObject({ code: '55000' });
    for (const change of [
      { actor_product_epoch: 1 },
      { owner_product_epoch: 1 },
      { variant_id: randomUUID() },
      { photo_id: randomUUID() },
    ])
      await expect(
        database
          .insertInto('media.delivery_grants')
          .values({ ...row, id: randomUUID(), ...change })
          .execute(),
      ).rejects.toMatchObject({ code: '40001' });
    expect(await store.isCurrent(query)).toBe(true);
  });
  it('does not grant current-source authority to a generic administrator evidence request', async () => {
    const { source } = await grant();
    await expect(
      store.authorize({
        actor: { kind: 'admin', userId: source.actorUserId },
        photoId: source.photoId,
        purpose: 'moderation_evidence',
        requestedVariant: 'thumbnail',
      }),
    ).rejects.toMatchObject({ code: 'media_delivery_denied' });
  });
  it('does not revive an original grant when a closed Like is replaced by a new actionable Like', async () => {
    const { source, query } = await grant('liked_by_blur');
    expect(await store.isCurrent(query)).toBe(true);
    await database
      .updateTable('interaction.likes')
      .set({ status: 'cancelled_by_system', closed_at: new Date(), version: 2 })
      .where('id', '=', source.likeId!)
      .execute();
    expect(await store.isCurrent(query)).toBe(false);
    await database.deleteFrom('interaction.likes').where('id', '=', source.likeId!).execute();
    await database
      .insertInto('interaction.likes')
      .values({
        id: randomUUID(),
        sender_user_id: source.ownerUserId,
        receiver_user_id: source.actorUserId,
        status: 'active',
        created_at: new Date(),
        closed_at: null,
      })
      .execute();
    expect(await store.isCurrent(query)).toBe(false);
    const fresh = await store.authorize({
      actor: { kind: 'user', userId: source.actorUserId },
      photoId: source.photoId,
      purpose: 'liked_by_blur',
      requestedVariant: 'blurred_preview',
    });
    expect(fresh.authorityId).not.toBe(query.authorityId);
  });
  it('revokes an issued owner grant on a real tombstone and refuses new issuance', async () => {
    let issued: MediaSourceAuthorityQuery | undefined;
    let photoId = '';
    const deletion = await createDeletionFixture(database, async (userId) => {
      const source = await createMediaAuthorityFixture(database, 'owner_preview', userId);
      photoId = source.photoId;
      const receipt = await store.authorize({
        actor: { kind: 'user', userId },
        photoId,
        purpose: 'owner_preview',
        requestedVariant: 'thumbnail',
      });
      issued = {
        authorityId: receipt.authorityId,
        audienceId: userId,
        path: receipt.deliveryPath,
        purpose: 'owner_preview',
        variant: 'thumbnail',
        issuedAt: receipt.issuedAt,
        expiresAt: receipt.expiresAt,
      };
      expect(await store.isCurrent(issued)).toBe(true);
    });
    expect(issued).toBeDefined();
    expect(await store.isCurrent(issued!)).toBe(false);
    await expect(
      store.authorize({
        actor: { kind: 'user', userId: deletion.userId },
        photoId,
        purpose: 'owner_preview',
        requestedVariant: 'thumbnail',
      }),
    ).rejects.toMatchObject({ code: 'media_delivery_denied' });
    const record = await sql<{
      checkpoint_version: number;
    }>`SELECT checkpoint_version FROM identity.account_deletion_records WHERE id=${deletion.recordId}::uuid`.execute(
      database,
    );
    expect(record.rows[0]?.checkpoint_version).toBe(1);
  });
});
