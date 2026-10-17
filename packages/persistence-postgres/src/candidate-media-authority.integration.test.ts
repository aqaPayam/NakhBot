import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type {
  CandidateReservation,
  UserSessionActor,
  AccountDeletionLease,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { PostgresCandidateReservationStore } from './candidate-reservation-store.js';
import { PostgresCandidateDeliveryStore } from './candidate-delivery-store.js';
import { PostgresCandidatePresentationStore } from './candidate-presentation-store.js';
import {
  PostgresMediaDeliveryAuthorization,
  type MediaSourceAuthorityQuery,
} from './media-delivery-authorization.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresAccountReturnStore } from './account-return-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionProductStore } from './account-deletion-product-store.js';
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
  async function presentation(f: Fixture): Promise<PostgresCandidatePresentationStore> {
    const at = new Date();
    await database
      .insertInto('identity.telegram_identities')
      .values({
        user_id: f.actorUserId,
        telegram_user_id: String(700000000000 + Math.floor(Math.random() * 100000000000)),
        username: null,
        first_seen_at: at,
        last_seen_at: at,
      })
      .execute();
    return new PostgresCandidatePresentationStore(database, 'test', f.session);
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
    const retryQuery = {
      actor: { kind: 'user' as const, userId: f.actorUserId },
      requestId: randomUUID(),
      mode: 'guest_preview' as const,
    };
    const reservations = new PostgresCandidateReservationStore(database, f.session);
    expect(
      await reservations.reserveNext(retryQuery, {
        deliveryId: randomUUID(),
        eventId: randomUUID(),
        reservedAt: new Date(),
      }),
    ).toEqual(f.reservation);
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
    expect(
      await reservations.reserveNext(retryQuery, {
        deliveryId: randomUUID(),
        eventId: randomUUID(),
        reservedAt: new Date(),
      }),
    ).toEqual(f.reservation);
    expect(await counter()).toBe(1);
    expect(await f.store.isCurrent(grant)).toBe(true);
  });
  async function deliveredDetail(): Promise<{
    f: Fixture;
    store: PostgresCandidatePresentationStore;
  }> {
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: false })
      .execute();
    const f = await fixture(undefined, true),
      store = await presentation(f);
    await createReportPhoto(database, f.ownerUserId, false, new Uint8Array([4, 5, 6]));
    await new PostgresCandidateDeliveryStore(database).recordDelivered(
      { deliveryId: f.reservation.deliveryId, providerMessageId: '456' },
      {
        auditId: randomUUID(),
        deliveryEventId: randomUUID(),
        consumptionEventId: randomUUID(),
        processedAt: new Date(),
      },
    );
    return { f, store };
  }
  it('projects all current photos and details for the same delivered target without another consumption', async () => {
    const { f, store } = await deliveredDetail();
    await database
      .updateTable('profile.profiles')
      .set({ bio: 'Synthetic public biography', version: sql`version+1` })
      .where('user_id', '=', f.ownerUserId)
      .execute();
    const profileId = (
      await database
        .selectFrom('profile.profiles')
        .select('id')
        .where('user_id', '=', f.ownerUserId)
        .executeTakeFirstOrThrow()
    ).id;
    await sql`INSERT INTO profile.profile_optional_details(profile_id,height_cm,job_title) VALUES(${profileId}::uuid,180,'Synthetic public job') ON CONFLICT(profile_id) DO UPDATE SET height_cm=180,job_title='Synthetic public job'`.execute(
      database,
    );
    const profiles = await Promise.all(
      Array.from({ length: 5 }, () => store.detail(f.reservation.deliveryId)),
    );
    for (const p of profiles) {
      expect(p.photos).toHaveLength(2);
      expect(p.optional).toContainEqual({ labelKey: 'signup.ui.height_cm', value: 180 });
      expect(p.optional).toContainEqual({
        labelKey: 'signup.ui.job',
        value: 'Synthetic public job',
      });
      expect(p.bio).toBe('Synthetic public biography');
      expect(p.locationLabelKeys).toHaveLength(3);
      expect(p.name).toBeTruthy();
      expect(await store.detailIsCurrent(f.reservation.deliveryId, p)).toBe(true);
      expect(JSON.stringify(p)).not.toContain(f.ownerUserId);
    }
    const count = await database
      .selectFrom('identity.guest_preview_counters')
      .select('preview_count')
      .where('user_id', '=', f.actorUserId)
      .executeTakeFirstOrThrow();
    expect(count.preview_count).toBe(1);
    expect(
      await database
        .selectFrom('discovery.candidate_deliveries')
        .select('id')
        .where('viewer_user_id', '=', f.actorUserId)
        .execute(),
    ).toHaveLength(1);
  });
  it('denies pending, foreign and borrowed-session detail reads', async () => {
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: false })
      .execute();
    const f = await fixture(undefined, true),
      pending = await presentation(f);
    await expect(pending.detail(f.reservation.deliveryId)).rejects.toMatchObject({ status: 403 });
    await expect(pending.detail(randomUUID())).rejects.toMatchObject({ status: 403 });
    const { f: g, store } = await deliveredDetail();
    await expect(
      new PostgresCandidatePresentationStore(database, 'test', f.session).detail(
        g.reservation.deliveryId,
      ),
    ).rejects.toMatchObject({ status: 403 });
    const originalOwner = { ...g.session };
    const capturedStore = new PostgresCandidatePresentationStore(database, 'test', originalOwner);
    originalOwner.sessionGrantId = f.session.sessionGrantId;
    expect((await capturedStore.detail(g.reservation.deliveryId)).photos).toHaveLength(2);
    const snapshot = await store.detail(g.reservation.deliveryId);
    const borrowed = new PostgresCandidatePresentationStore(database, 'test', {
      ...g.session,
      sessionGrantId: f.session.sessionGrantId,
    });
    await expect(borrowed.detail(g.reservation.deliveryId)).rejects.toMatchObject({ status: 401 });
    await expect(
      borrowed.detailIsCurrent(g.reservation.deliveryId, snapshot),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('rejects changed text versions and rereads the new profile instead of caching private values', async () => {
    const { f, store } = await deliveredDetail(),
      before = await store.detail(f.reservation.deliveryId);
    await database
      .updateTable('profile.profiles')
      .set({ name: 'Updated synthetic name', version: sql`version+1` })
      .where('user_id', '=', f.ownerUserId)
      .execute();
    expect(await store.detailIsCurrent(f.reservation.deliveryId, before)).toBe(false);
    const after = await store.detail(f.reservation.deliveryId);
    expect(after.name).toBe('Updated synthetic name');
    expect(await store.detailIsCurrent(f.reservation.deliveryId, after)).toBe(true);
    const other = await deliveredDetail(),
      foreign = await other.store.detail(other.f.reservation.deliveryId);
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: true })
      .where('user_id', '=', f.ownerUserId)
      .execute();
    expect(await store.detailIsCurrent(f.reservation.deliveryId, after)).toBe(true);
    expect(await store.detailIsCurrent(f.reservation.deliveryId, foreign)).toBe(false);
  });
  it.each(['visibility', 'block', 'photo'] as const)(
    'fences full detail after current %s withdrawal',
    async (mode) => {
      const { f, store } = await deliveredDetail(),
        before = await store.detail(f.reservation.deliveryId);
      if (mode === 'visibility')
        await database
          .updateTable('identity.user_settings')
          .set({ visibility_enabled: false, version: sql`version+1` })
          .where('user_id', '=', f.ownerUserId)
          .execute();
      if (mode === 'block')
        await sql`INSERT INTO interaction.user_pair_states(user_low_id,user_high_id,state,reason_code,changed_at)
      VALUES(LEAST(${f.actorUserId}::uuid,${f.ownerUserId}::uuid),GREATEST(${f.actorUserId}::uuid,${f.ownerUserId}::uuid),'blocked','user_block',clock_timestamp())`.execute(
          database,
        );
      if (mode === 'photo')
        await sql`UPDATE media.profile_photos SET status='hidden',hidden_at=clock_timestamp(),is_primary=false,version=version+1,updated_at=clock_timestamp() WHERE id=${f.photoId}::uuid`.execute(
          database,
        );
      if (mode === 'photo')
        await expect(store.detailIsCurrent(f.reservation.deliveryId, before)).resolves.toBe(false);
      else expect(await store.detailIsCurrent(f.reservation.deliveryId, before)).toBe(false);
      await expect(store.detail(f.reservation.deliveryId)).rejects.toBeDefined();
    },
  );
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
        '000154_m9_preview_consumption_disposition.sql',
        '000155_m9_guest_preview_delivery.sql',
        '000156_m9_profile_detail_presentation.sql',
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
  it('admits exactly one provider-call under concurrent current-session attempts', async () => {
    const f = await fixture(),
      store = await presentation(f),
      card = await store.load(f.reservation.deliveryId);
    expect(card.state).toBe('ready');
    if (card.state !== 'ready') throw new Error('Presentation unavailable.');
    expect(card.name).toBeTruthy();
    expect(card.age).toBeGreaterThanOrEqual(18);
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.begin(f.reservation.deliveryId, card.source, card.profileVersion),
      ),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await store.load(f.reservation.deliveryId)).toEqual({ state: 'pending' });
    await expect(
      new PostgresCandidateDeliveryStore(database).recordDefinitiveFailure(
        {
          deliveryId: f.reservation.deliveryId,
          reasonCode: 'media_unavailable',
          onlyIfUnstarted: true,
        },
        { auditId: randomUUID(), eventId: randomUUID(), processedAt: new Date() },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await database
        .selectFrom('discovery.explore_consumptions')
        .selectAll()
        .where('viewer_user_id', '=', f.actorUserId)
        .execute(),
    ).toHaveLength(0);
  });
  it('does not substitute another receipt or use a revoked session for provider-call admission', async () => {
    const f = await fixture(),
      store = await presentation(f),
      card = await store.load(f.reservation.deliveryId);
    if (card.state !== 'ready') throw new Error('Presentation unavailable.');
    await expect(
      store.begin(
        f.reservation.deliveryId,
        { ...card.source, authorityId: randomUUID() },
        card.profileVersion,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await database
      .updateTable('profile.profiles')
      .set({ highlight: 'Changed before transport', version: sql<number>`version+1` })
      .where('user_id', '=', f.ownerUserId)
      .execute();
    expect(await store.begin(f.reservation.deliveryId, card.source, card.profileVersion)).toBe(
      false,
    );
    await new PostgresUserSessionStore(database).revoke(
      f.session,
      f.session.sessionGrantId,
      randomUUID(),
    );
    await expect(
      store.begin(f.reservation.deliveryId, card.source, card.profileVersion),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(
      (
        await database
          .selectFrom('discovery.candidate_deliveries')
          .select('attempt_count')
          .where('id', '=', f.reservation.deliveryId)
          .executeTakeFirstOrThrow()
      ).attempt_count,
    ).toBe(0);
  });
  it('does not erase a provider-call before its outcome is settled', async () => {
    const f = await fixture(),
      store = await presentation(f),
      card = await store.load(f.reservation.deliveryId);
    if (card.state !== 'ready') throw new Error('Presentation unavailable.');
    expect(await store.begin(f.reservation.deliveryId, card.source, card.profileVersion)).toBe(
      true,
    );
    const original = await database
      .selectFrom('discovery.candidate_deliveries')
      .selectAll()
      .where('id', '=', f.reservation.deliveryId)
      .executeTakeFirstOrThrow();
    try {
      await expect(
        database
          .deleteFrom('discovery.candidate_deliveries')
          .where('id', '=', f.reservation.deliveryId)
          .execute(),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      if (
        (await database
          .selectFrom('discovery.candidate_deliveries')
          .select('id')
          .where('id', '=', f.reservation.deliveryId)
          .executeTakeFirst()) === undefined
      )
        await database.insertInto('discovery.candidate_deliveries').values(original).execute();
    }
  });
  it.each(['accepted', 'rejected'] as const)(
    'holds actual product purge until late provider %s settlement preserves the guest counter',
    async (outcome) => {
      await sql`UPDATE identity.account_deletion_work SET available_at=clock_timestamp()+interval '1 day',lease_owner=NULL,lease_expires_at=NULL`.execute(
        database,
      );
      await database
        .updateTable('identity.user_settings')
        .set({ visibility_enabled: false })
        .execute();
      let deliveryId = '',
        userId = '';
      const root = await createDeletionFixture(database, async (viewer) => {
        userId = viewer;
        const target = await createMediaAuthorityFixture(database);
        const session = await actor(viewer);
        const reservation = await new PostgresCandidateReservationStore(
          database,
          session,
        ).reserveNext(
          {
            actor: { kind: 'user', userId: viewer },
            requestId: randomUUID(),
            mode: 'guest_preview',
          },
          { deliveryId: randomUUID(), eventId: randomUUID(), reservedAt: new Date() },
        );
        expect(reservation?.targetUserId).toBe(target.ownerUserId);
        deliveryId = reservation!.deliveryId;
        const store = new PostgresCandidatePresentationStore(database, 'test', session);
        const card = await store.load(deliveryId);
        if (card.state !== 'ready') throw new Error('Presentation unavailable.');
        expect(await store.begin(deliveryId, card.source, card.profileVersion)).toBe(true);
      });
      const work = new PostgresAccountDeletionWorkStore(database),
        checkpoints = new PostgresAccountDeletionCheckpointStore(database);
      const claim = async (): Promise<AccountDeletionLease> => {
        const leases = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 });
        expect(leases[0]?.deletionRecordId).toBe(root.recordId);
        return leases[0]!;
      };
      const shared = await claim();
      while ((await new PostgresAccountDeletionSharedStore(database).closeNext(shared)).hasMore) {
        /* bounded */
      }
      await checkpoints.finishShared(shared);
      await checkpoints.finishEvidence(await claim());
      const product = await claim(),
        products = new PostgresAccountDeletionProductStore(database);
      await expect(products.purgeNext(product)).rejects.toMatchObject({ status: 409 });
      expect(
        (
          await database
            .selectFrom('identity.guest_preview_counters')
            .select('preview_count')
            .where('user_id', '=', userId)
            .executeTakeFirstOrThrow()
        ).preview_count,
      ).toBe(0);
      const deliveries = new PostgresCandidateDeliveryStore(database);
      const input = { deliveryId, providerMessageId: '987' },
        effects = {
          auditId: randomUUID(),
          deliveryEventId: randomUUID(),
          consumptionEventId: randomUUID(),
          processedAt: new Date(),
        };
      if (outcome === 'accepted') {
        await expect(deliveries.recordDelivered(input, effects)).resolves.toMatchObject({
          replayed: false,
        });
        await expect(deliveries.recordDelivered(input, effects)).resolves.toMatchObject({
          replayed: true,
        });
      } else {
        const results = await Promise.allSettled([
          products.purgeNext(product),
          deliveries.recordDefinitiveFailure(
            { deliveryId, reasonCode: 'provider_rejected' },
            { auditId: randomUUID(), eventId: randomUUID(), processedAt: new Date() },
          ),
        ]);
        expect(results[1].status).toBe('fulfilled');
        if (results[0].status === 'rejected')
          expect(results[0].reason).toMatchObject({ status: 409 });
      }
      while ((await products.purgeNext(product)).hasMore) {
        /* bounded */
      }
      expect(
        (
          await database
            .selectFrom('identity.guest_preview_counters')
            .select('preview_count')
            .where('user_id', '=', userId)
            .executeTakeFirstOrThrow()
        ).preview_count,
      ).toBe(outcome === 'accepted' ? 1 : 0);
      expect(
        await database
          .selectFrom('discovery.candidate_deliveries')
          .select('id')
          .where('id', '=', deliveryId)
          .execute(),
      ).toHaveLength(0);
    },
  );
  it('allows account-first safety foreign-key reads while provider settlement waits for the Account', async () => {
    const f = await fixture(),
      store = await presentation(f),
      card = await store.load(f.reservation.deliveryId);
    if (card.state !== 'ready') throw new Error('Presentation unavailable.');
    expect(await store.begin(f.reservation.deliveryId, card.source, card.profileVersion)).toBe(
      true,
    );
    let enter: () => void = () => undefined,
      release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const holder = database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('identity.accounts')
        .select('user_id')
        .where('user_id', '=', f.ownerUserId)
        .forUpdate()
        .execute();
      enter();
      await gate;
      await tx
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', f.ownerUserId)
        .forKeyShare()
        .execute();
    });
    await ready;
    const settlement = new PostgresCandidateDeliveryStore(database).recordDelivered(
      {
        deliveryId: f.reservation.deliveryId,
        providerMessageId: '9988',
      },
      {
        auditId: randomUUID(),
        deliveryEventId: randomUUID(),
        consumptionEventId: randomUUID(),
        processedAt: new Date(),
      },
    );
    const outcomes = Promise.allSettled([holder, settlement]);
    try {
      let waiting = false;
      for (let n = 0; n < 100 && !waiting; n++) {
        waiting = (
          await sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
            AND query LIKE '%explore_consumptions%') AS waiting`.execute(database)
        ).rows[0]!.waiting;
        if (!waiting) await delay(25);
      }
      expect(waiting).toBe(true);
    } finally {
      release();
    }
    const results = await outcomes;
    const codes = results.map((result) => {
      if (result.status === 'fulfilled') return 'ok';
      const error: unknown = result.reason;
      return error instanceof Error && 'code' in error ? error.code : 'rejected';
    });
    expect(codes).toEqual(['ok', 'ok']);
    expect(
      (
        await database
          .selectFrom('discovery.candidate_deliveries')
          .select('state')
          .where('id', '=', f.reservation.deliveryId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('delivered');
  });
  it('preserves late accepted preview count through complete native deletion and approved Return', async () => {
    await sql`UPDATE identity.account_deletion_work SET available_at=clock_timestamp()+interval '1 day',lease_owner=NULL,lease_expires_at=NULL`.execute(
      database,
    );
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: false })
      .execute();
    let deliveryId = '',
      expiresAt = 0;
    const f = await createAccountReturnFixture(database, {
      beforeDeletion: async (viewer) => {
        const target = await createMediaAuthorityFixture(database),
          session = await actor(viewer);
        const reservation = await new PostgresCandidateReservationStore(
          database,
          session,
        ).reserveNext(
          {
            actor: { kind: 'user', userId: viewer },
            requestId: randomUUID(),
            mode: 'guest_preview',
          },
          { deliveryId: randomUUID(), eventId: randomUUID(), reservedAt: new Date() },
        );
        deliveryId = reservation!.deliveryId;
        const grant = await new PostgresMediaDeliveryAuthorization(database, 'test', {
          deliveryId,
          session,
        }).authorize({
          actor: { kind: 'user', userId: viewer },
          photoId: target.photoId,
          purpose: 'profile_card',
          requestedVariant: 'thumbnail',
          ttlSeconds: 10,
        });
        expiresAt = grant.expiresAt;
        const profile = await database
          .selectFrom('profile.profiles')
          .select('version')
          .where('user_id', '=', target.ownerUserId)
          .executeTakeFirstOrThrow();
        expect(
          await new PostgresCandidatePresentationStore(database, 'test', session).begin(
            deliveryId,
            {
              authorityId: grant.authorityId,
              audienceId: viewer,
              path: grant.deliveryPath,
              purpose: 'profile_card',
              variant: 'thumbnail',
              issuedAt: grant.issuedAt,
              expiresAt: grant.expiresAt,
            },
            profile.version,
          ),
        ).toBe(true);
      },
      beforeEvidenceCheckpoint: async (lease) => {
        expect(
          (
            await database
              .selectFrom('identity.accounts')
              .select('state')
              .where('user_id', '=', lease.userId)
              .executeTakeFirstOrThrow()
          ).state,
        ).toBe('deleted');
        await new PostgresCandidateDeliveryStore(database).recordDelivered(
          { deliveryId, providerMessageId: '98765' },
          {
            auditId: randomUUID(),
            deliveryEventId: randomUUID(),
            consumptionEventId: randomUUID(),
            processedAt: new Date(),
          },
        );
        // Use the real supported ten-second grant and its actual database clock;
        // do not rewrite expiry, provider observations, or the M8 grace checks.
        const deadline = Date.now() + 15000;
        while (
          !(
            await sql<{
              expired: boolean;
            }>`SELECT clock_timestamp()>=to_timestamp(${expiresAt}) AS expired`.execute(database)
          ).rows[0]!.expired
        ) {
          if (Date.now() >= deadline) throw new Error('Native grant grace did not expire.');
          await delay(100);
        }
      },
    });
    const id = randomUUID();
    await new PostgresAccountReturnStore(database, f.control).return({
      commandId: id,
      commandType: 'account.return',
      schemaVersion: 1,
      actor: { kind: 'user', userId: f.userId },
      requestId: id,
      idempotencyKey: id,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { expectedAccountVersion: f.version },
    });
    expect(
      (
        await database
          .selectFrom('identity.guest_preview_counters')
          .select('preview_count')
          .where('user_id', '=', f.userId)
          .executeTakeFirstOrThrow()
      ).preview_count,
    ).toBe(4);
    expect(
      await database
        .selectFrom('identity.accounts')
        .select(['state', 'product_epoch'])
        .where('user_id', '=', f.userId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: 'guest', product_epoch: 1 });
  });
});
