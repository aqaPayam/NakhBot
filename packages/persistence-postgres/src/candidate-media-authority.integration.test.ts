import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { CandidateReservation, UserSessionActor } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { PostgresCandidateReservationStore } from './candidate-reservation-store.js';
import { PostgresCandidateDeliveryStore } from './candidate-delivery-store.js';
import {
  PostgresMediaDeliveryAuthorization,
  type MediaSourceAuthorityQuery,
} from './media-delivery-authorization.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresAccountReturnStore } from './account-return-store.js';
import { lockUserPair } from './pair-lock.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createMediaAuthorityFixture } from './testing/media-authority-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createAccountReturnFixture } from './testing/account-return-fixture.js';
import { createReportPhoto } from './testing/report-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M9 candidate-bound native media authority', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_candidate_media');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  async function actor(userId: string): Promise<UserSessionActor> {
    const grant = await new PostgresUserSessionStore(database).issue(
      { userId, productEpoch: 0 },
      randomUUID(),
    );
    if (grant === undefined) throw new Error('Session fixture unavailable.');
    return { kind: 'user', userId, productEpoch: 0, sessionGrantId: grant.id };
  }
  type Fixture = Awaited<ReturnType<typeof createMediaAuthorityFixture>> & {
    session: UserSessionActor;
    binding: { deliveryId: string; session: UserSessionActor };
    store: PostgresMediaDeliveryAuthorization;
    request: {
      actor: { kind: 'user'; userId: string };
      photoId: string;
      purpose: 'profile_card';
      requestedVariant: 'thumbnail';
    };
    reservation: CandidateReservation;
  };
  async function fixture(registeredOwner?: string, guest = false): Promise<Fixture> {
    const source = await createMediaAuthorityFixture(database, 'liked_by_blur', registeredOwner);
    const city = randomUUID(),
      code = 'candidate_' + city.replaceAll('-', '');
    await sql`INSERT INTO catalog.cities(id,province_id,code,label_key,display_order)
      VALUES(${city}::uuid,'20000000-0000-4000-8000-000000000111',${code},${'catalog.city.' + code},999)`.execute(
      database,
    );
    await sql`UPDATE profile.profiles SET city_id=${city}::uuid WHERE user_id IN (${source.actorUserId}::uuid,${source.ownerUserId}::uuid)`.execute(
      database,
    );
    await sql`INSERT INTO identity.user_settings(user_id,created_at,updated_at)
      VALUES(${source.ownerUserId}::uuid,clock_timestamp(),clock_timestamp()) ON CONFLICT DO NOTHING`.execute(
      database,
    );
    if (guest) {
      await sql`UPDATE identity.accounts SET state='guest',version=version+1 WHERE user_id=${source.actorUserId}::uuid`.execute(
        database,
      );
      await sql`INSERT INTO identity.guest_preview_counters(user_id,limit_count) VALUES(${source.actorUserId}::uuid,10)`.execute(
        database,
      );
    }
    const session = await actor(source.actorUserId);
    const reservation = await new PostgresCandidateReservationStore(database, session).reserveNext(
      {
        actor: { kind: 'user', userId: source.actorUserId },
        requestId: randomUUID(),
        mode: guest ? 'guest_preview' : 'explore',
      },
      { deliveryId: randomUUID(), eventId: randomUUID(), reservedAt: new Date() },
    );
    expect(reservation?.targetUserId).toBe(source.ownerUserId);
    if (reservation === undefined) throw new Error('Candidate fixture unavailable.');
    const binding = { deliveryId: reservation.deliveryId, session };
    const store = new PostgresMediaDeliveryAuthorization(database, 'test', binding);
    const request = {
      actor: { kind: 'user' as const, userId: source.actorUserId },
      photoId: source.photoId,
      purpose: 'profile_card' as const,
      requestedVariant: 'thumbnail' as const,
    };
    return { ...source, session, binding, store, request, reservation };
  }
  async function issue(f: Fixture): Promise<MediaSourceAuthorityQuery> {
    const grant = await f.store.authorize(f.request);
    return {
      authorityId: grant.authorityId,
      audienceId: f.actorUserId,
      path: grant.deliveryPath,
      purpose: f.request.purpose,
      variant: grant.variantType,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    };
  }
  it('delivers a native guest reservation without consuming quota until confirmed delivery', async () => {
    const f = await fixture(undefined, true),
      grant = await issue(f);
    expect(await f.store.isCurrent(grant)).toBe(true);
    const counter = async (): Promise<number> =>
      (
        await database
          .selectFrom('identity.guest_preview_counters')
          .select('preview_count')
          .where('user_id', '=', f.actorUserId)
          .executeTakeFirstOrThrow()
      ).preview_count;
    expect(await counter()).toBe(0);
    const store = new PostgresCandidateDeliveryStore(database);
    const command = { deliveryId: f.reservation.deliveryId, providerMessageId: '123' };
    const effects = {
      auditId: randomUUID(),
      deliveryEventId: randomUUID(),
      consumptionEventId: randomUUID(),
      processedAt: new Date(),
    };
    await expect(store.recordDelivered(command, effects)).resolves.toMatchObject({
      replayed: false,
    });
    await expect(store.recordDelivered(command, effects)).resolves.toMatchObject({
      replayed: true,
    });
    expect(await counter()).toBe(1);
    expect(await f.store.isCurrent(grant)).toBe(true);
  });
  it('issues concurrent opaque receipts for one native reservation without consuming it', async () => {
    const f = await fixture();
    const grants = await Promise.all(Array.from({ length: 10 }, () => issue(f)));
    expect(new Set(grants.map((g) => g.authorityId)).size).toBe(10);
    expect(await Promise.all(grants.map((g) => f.store.isCurrent(g)))).toEqual(
      Array<boolean>(10).fill(true),
    );
    const rows = await database
      .selectFrom('media.delivery_grants')
      .selectAll()
      .where('candidate_delivery_id', '=', f.reservation.deliveryId)
      .execute();
    expect(rows).toHaveLength(10);
    for (const row of rows)
      expect(row).toMatchObject({
        session_grant_id: f.session.sessionGrantId,
        candidate_delivery_id: f.reservation.deliveryId,
        photo_id: f.photoId,
        owner_product_epoch: 0,
        actor_product_epoch: 0,
        like_id: null,
      });
    expect(
      await database
        .selectFrom('discovery.explore_consumptions')
        .select('viewer_user_id')
        .where('viewer_user_id', '=', f.actorUserId)
        .execute(),
    ).toHaveLength(0);
  });
  it('denies unbound, borrowed, substituted and unsupported candidate requests', async () => {
    const f = await fixture();
    for (const binding of [
      undefined,
      { deliveryId: randomUUID(), session: f.session },
      { deliveryId: f.reservation.deliveryId, session: await actor(f.ownerUserId) },
    ]) {
      await expect(
        new PostgresMediaDeliveryAuthorization(database, 'test', binding).authorize(f.request),
      ).rejects.toMatchObject({ code: 'media_delivery_denied' });
    }
    await expect(f.store.authorize({ ...f.request, photoId: randomUUID() })).rejects.toMatchObject({
      code: 'media_delivery_denied',
    });
    await expect(
      f.store.authorize({ ...f.request, requestedVariant: 'blurred_preview' }),
    ).rejects.toMatchObject({ code: 'media_delivery_denied' });
    const grant = await issue(f);
    for (const change of [
      { audienceId: f.ownerUserId },
      { purpose: 'profile_detail' },
      { variant: 'blurred_preview' },
      { path: grant.path + 'x' },
    ])
      expect(await f.store.isCurrent({ ...grant, ...change })).toBe(false);
    expect(await new PostgresMediaDeliveryAuthorization(database, 'staging').isCurrent(grant)).toBe(
      false,
    );
  });
  it('captures the session, candidate and request before asynchronous lock waits', async () => {
    const f = await fixture();
    const request = structuredClone(f.request),
      binding = { deliveryId: f.binding.deliveryId, session: { ...f.session } };
    const store = new PostgresMediaDeliveryAuthorization(database, 'test', binding);
    binding.deliveryId = randomUUID();
    binding.session.userId = f.ownerUserId;
    const pending = store.authorize(request);
    request.photoId = randomUUID();
    request.actor.userId = f.ownerUserId;
    await expect(pending).resolves.toMatchObject({
      deliveryPath: `/media/${f.assetId}/thumbnail-v1.webp`,
    });
  });
  it('revokes existing receipts and new issuance on native session revocation', async () => {
    const f = await fixture(),
      grant = await issue(f);
    await new PostgresUserSessionStore(database).revoke(
      f.session,
      f.session.sessionGrantId,
      randomUUID(),
    );
    expect(await f.store.isCurrent(grant)).toBe(false);
    await expect(f.store.authorize(f.request)).rejects.toMatchObject({ status: 401 });
    const fresh = new PostgresMediaDeliveryAuthorization(database, 'test', {
      deliveryId: f.reservation.deliveryId,
      session: await actor(f.actorUserId),
    });
    await expect(fresh.authorize(f.request)).resolves.toMatchObject({ variantType: 'thumbnail' });
    expect(await fresh.isCurrent(grant)).toBe(false);
  });
  it('allows the same delivered candidate, but never a definitively failed candidate', async () => {
    const f = await fixture(),
      grant = await issue(f);
    await new PostgresCandidateDeliveryStore(database).recordDelivered(
      { deliveryId: f.reservation.deliveryId, providerMessageId: '123' },
      {
        auditId: randomUUID(),
        deliveryEventId: randomUUID(),
        consumptionEventId: randomUUID(),
        processedAt: new Date(),
      },
    );
    expect(await f.store.isCurrent(grant)).toBe(true);
    await expect(
      f.store.authorize({ ...f.request, purpose: 'profile_detail' }),
    ).resolves.toMatchObject({ variantType: 'thumbnail' });
    const failed = await fixture(),
      old = await issue(failed);
    await new PostgresCandidateDeliveryStore(database).recordDefinitiveFailure(
      { deliveryId: failed.reservation.deliveryId, reasonCode: 'provider_rejected' },
      { auditId: randomUUID(), eventId: randomUUID(), processedAt: new Date() },
    );
    expect(await failed.store.isCurrent(old)).toBe(false);
    await expect(failed.store.authorize(failed.request)).rejects.toMatchObject({
      code: 'media_delivery_denied',
    });
  });
  it('restricts cards to the primary photo and details to the same candidate owner', async () => {
    const f = await fixture();
    const second = await createReportPhoto(
      database,
      f.ownerUserId,
      false,
      new Uint8Array([4, 5, 6]),
    );
    await expect(f.store.authorize({ ...f.request, photoId: second })).rejects.toMatchObject({
      code: 'media_delivery_denied',
    });
    await expect(
      f.store.authorize({ ...f.request, photoId: second, purpose: 'profile_detail' }),
    ).resolves.toMatchObject({ variantType: 'thumbnail' });
  });
  it.each(['visibility', 'photo', 'block'] as const)(
    'rechecks current %s without extending signed authority',
    async (mode) => {
      const f = await fixture(),
        grant = await issue(f);
      if (mode === 'visibility')
        await sql`UPDATE identity.user_settings SET visibility_enabled=false,version=version+1 WHERE user_id=${f.ownerUserId}::uuid`.execute(
          database,
        );
      if (mode === 'photo')
        await sql`UPDATE media.profile_photos SET status='hidden',hidden_at=clock_timestamp(),is_primary=false,version=version+1,updated_at=clock_timestamp() WHERE id=${f.photoId}::uuid`.execute(
          database,
        );
      if (mode === 'block')
        await sql`INSERT INTO interaction.user_pair_states(user_low_id,user_high_id,state,reason_code,changed_at)
      VALUES(LEAST(${f.actorUserId}::uuid,${f.ownerUserId}::uuid),GREATEST(${f.actorUserId}::uuid,${f.ownerUserId}::uuid),'blocked','user_block',clock_timestamp())`.execute(
          database,
        );
      expect(await f.store.isCurrent(grant)).toBe(false);
      await expect(f.store.authorize(f.request)).rejects.toMatchObject({
        code: 'media_delivery_denied',
      });
    },
  );
  it('rechecks revocation after an observed shared pair-lock wait', async () => {
    const f = await fixture();
    let enter = (): void => {},
      release = (): void => {};
    const ready = new Promise<void>((r) => {
        enter = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const holder = database.transaction().execute(async (tx) => {
      await lockUserPair(tx, f.actorUserId, f.ownerUserId);
      enter();
      await gate;
    });
    await ready;
    const pending = f.store.authorize(f.request),
      denial = expect(pending).rejects.toMatchObject({ status: 401 });
    try {
      let waiting = false;
      for (let n = 0; n < 100 && !waiting; n++) {
        waiting = (
          await sql<{
            waiting: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event='advisory' AND pid<>pg_backend_pid() AND query LIKE '%lock_user_pair%') AS waiting`.execute(
            database,
          )
        ).rows[0]!.waiting;
        if (!waiting) await delay(25);
      }
      expect(waiting).toBe(true);
      await new PostgresUserSessionStore(database).revoke(
        f.session,
        f.session.sessionGrantId,
        randomUUID(),
      );
    } finally {
      release();
      await holder;
    }
    await denial;
    expect(
      await database
        .selectFrom('media.delivery_grants')
        .select('id')
        .where('candidate_delivery_id', '=', f.reservation.deliveryId)
        .execute(),
    ).toHaveLength(0);
  });
  it('revokes the original candidate and receipt on a real owner tombstone', async () => {
    let f: Fixture | undefined, grant: MediaSourceAuthorityQuery | undefined;
    await createDeletionFixture(database, async (owner) => {
      f = await fixture(owner);
      grant = await issue(f);
      expect(await f.store.isCurrent(grant)).toBe(true);
    });
    expect(f).toBeDefined();
    expect(grant).toBeDefined();
    expect(await f!.store.isCurrent(grant!)).toBe(false);
    await expect(f!.store.authorize(f!.request)).rejects.toMatchObject({
      code: 'media_delivery_denied',
    });
  });
  it('upgrades populated schema 152 without rewriting or invalidating retained manifests', async () => {
    const previous = await mkdtemp(join(tmpdir(), 'nakh-media-upgrade-'));
    const target = await createIsolatedTestDatabase(url!, 'm9_media_upgrade');
    let legacy: NakhDatabase | undefined;
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 152)
          await copyFile(join(resolve('migrations'), file), join(previous, file));
      await runMigrations(target.url, previous);
      legacy = createDatabase({
        url: target.url,
        poolMax: 4,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      const completed = await createAccountReturnFixture(legacy);
      const before = await sql`SELECT * FROM identity.data_retention_records ORDER BY id`.execute(
        legacy,
      );
      expect(before.rows.length).toBeGreaterThan(0);
      const old = (
        await sql<{ hash: string }>`SELECT identity.retention_registry_hash() AS hash`.execute(
          legacy,
        )
      ).rows[0]!.hash;
      expect((await runMigrations(target.url, resolve('migrations'))).applied).toEqual([
        '000153_m9_candidate_media_authority.sql',
      ]);
      await verifyMigrations(target.url, resolve('migrations/verify'));
      expect(
        (await sql`SELECT * FROM identity.data_retention_records ORDER BY id`.execute(legacy)).rows,
      ).toEqual(before.rows);
      expect(
        (
          await sql<{
            valid: boolean;
          }>`SELECT bool_and(identity.retention_record_valid(r)) AS valid FROM identity.data_retention_records r`.execute(
            legacy,
          )
        ).rows[0]!.valid,
      ).toBe(true);
      expect(
        (
          await sql<{ hash: string }>`SELECT identity.retention_registry_hash() AS hash`.execute(
            legacy,
          )
        ).rows[0]!.hash,
      ).not.toBe(old);
      expect((await runMigrations(target.url, resolve('migrations'))).applied).toHaveLength(0);
      const commandId = randomUUID();
      await expect(
        new PostgresAccountReturnStore(legacy, completed.control).return({
          commandId,
          requestId: commandId,
          idempotencyKey: commandId,
          commandType: 'account.return',
          schemaVersion: 1,
          actor: { kind: 'user', userId: completed.userId },
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: { expectedAccountVersion: completed.version },
        }),
      ).resolves.toMatchObject({ returned: true, replayed: false });
      expect(
        (
          await sql`SELECT state,product_epoch FROM identity.accounts WHERE user_id=${completed.userId}::uuid`.execute(
            legacy,
          )
        ).rows,
      ).toEqual([{ state: 'guest', product_epoch: 1 }]);
    } finally {
      await legacy?.destroy();
      await target.destroy();
      await rm(previous, { recursive: true, force: true });
    }
  });
});
