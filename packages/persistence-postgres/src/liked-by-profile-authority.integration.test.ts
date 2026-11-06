import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  UserSessionActor,
  SpendCreditsForPaidActionWrite,
  StoredFeatureUnlock,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { PostgresPaidActionStore } from './paid-action-store.js';
import { PostgresLikedByMediaAuthorization } from './liked-by-media-authorization.js';
import { PostgresLikedByProfileStore } from './liked-by-profile-store.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { createMediaAuthorityFixture } from './testing/media-authority-fixture.js';
import { createReportPhoto, createReportUser } from './testing/report-fixture.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { lockUserPair } from './pair-lock.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { SystemClock } from '@nakh/domain';
import { SystemIdGenerator } from './foundation-store.js';
import {
  PostgresTelegramLikedByDeliveryStore,
  type TelegramLikedByDeliveryInput,
} from './telegram-liked-by-delivery-store.js';
import { PostgresLikedByStore } from './liked-by-store.js';
import { PostgresInteractionStore } from './interaction-store.js';
import { readLikedByAccess } from './liked-by-action-source.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M9 exact-unlock Like profile authority', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_like_profile');
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
  async function session(userId: string): Promise<UserSessionActor> {
    const grant = await new PostgresUserSessionStore(database).issue(
      { userId, productEpoch: 0 },
      randomUUID(),
    );
    if (!grant) throw new Error('Synthetic session unavailable');
    return { kind: 'user', userId, productEpoch: 0, sessionGrantId: grant.id };
  }
  type Fixture = Omit<Awaited<ReturnType<typeof createMediaAuthorityFixture>>, 'likeId'> & {
    likeId: string;
    owner: UserSessionActor;
    unlock: StoredFeatureUnlock;
    media: PostgresLikedByMediaAuthorization;
    store: PostgresLikedByProfileStore;
    paid: PostgresPaidActionStore;
    write: SpendCreditsForPaidActionWrite;
    request: {
      actor: { kind: 'user'; userId: string };
      photoId: string;
      purpose: 'profile_detail';
      requestedVariant: 'thumbnail';
    };
  };
  async function fixture(registeredOwner?: string): Promise<Fixture> {
    const source = await createMediaAuthorityFixture(database, 'liked_by_blur', registeredOwner);
    if (!source.likeId) throw new Error('Synthetic Like unavailable');
    const owner = await session(source.actorUserId),
      now = new Date();
    await database
      .insertInto('identity.telegram_identities')
      .values({
        user_id: source.actorUserId,
        telegram_user_id: String(700000000000 + Math.floor(Math.random() * 100000000000)),
        username: null,
        first_seen_at: now,
        last_seen_at: now,
      })
      .execute();
    await database
      .insertInto('billing.credit_accounts')
      .values({ user_id: source.actorUserId, created_at: now, updated_at: now })
      .execute();
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: source.actorUserId, created_at: now, updated_at: now })
      .execute();
    await new PostgresCreditLedgerStore(database).append({
      transactionId: randomUUID(),
      userId: source.actorUserId,
      transactionType: 'admin_adjustment',
      amount: 100n,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
    const write = {
      featureUnlockId: randomUUID(),
      creditTransactionId: randomUUID(),
      outboxEventId: randomUUID(),
      userId: source.actorUserId,
      target: { type: 'like' as const, targetId: source.likeId },
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    };
    const paid = new PostgresPaidActionStore(database, owner);
    const unlock = await paid.spendCredits(write);
    const media = new PostgresLikedByMediaAuthorization(
      database,
      'test',
      owner,
      source.likeId,
      unlock.id,
    );
    const store = new PostgresLikedByProfileStore(database, 'test', owner);
    const request = {
      actor: { kind: 'user' as const, userId: source.actorUserId },
      photoId: source.photoId,
      purpose: 'profile_detail' as const,
      requestedVariant: 'thumbnail' as const,
    };
    return { ...source, likeId: source.likeId, owner, unlock, media, store, request, paid, write };
  }
  async function revoke(f: Fixture): Promise<void> {
    await sql`UPDATE interaction.feature_unlocks SET status='revoked',revoked_at=clock_timestamp(),revoked_reason='test_revocation',version=version+1 WHERE id=${f.unlock.id}::uuid`.execute(
      database,
    );
  }
  it('loads the full transient projection and every current photo only for the exact owned unlock', async () => {
    const f = await fixture();
    const extra = await createReportPhoto(
      database,
      f.ownerUserId,
      false,
      new Uint8Array([4, 5, 6]),
    );
    const detail = await f.store.detail(f.unlock.id);
    expect(detail.name).toBe('Private report fixture');
    expect(detail.bio).toBe('Private report bio');
    expect(detail.photos.map((p) => p.photoId)).toEqual([f.photoId, extra]);
    expect(await f.store.detailIsCurrent(f.unlock.id, detail)).toBe(true);
    const rows = await database
      .selectFrom('media.delivery_grants')
      .select(['feature_unlock_id', 'session_grant_id', 'like_id', 'candidate_delivery_id'])
      .where('feature_unlock_id', '=', f.unlock.id)
      .execute();
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (r) =>
          r.feature_unlock_id === f.unlock.id &&
          r.session_grant_id === f.owner.sessionGrantId &&
          r.like_id === f.likeId &&
          r.candidate_delivery_id === null,
      ),
    ).toBe(true);
    const telegram = await database
      .selectFrom('identity.telegram_identities')
      .select('telegram_user_id')
      .where('user_id', '=', f.actorUserId)
      .executeTakeFirstOrThrow();
    expect(detail.telegramUserId).toBe(telegram.telegram_user_id);
    await expect(f.store.detail(randomUUID())).rejects.toMatchObject({ status: 403 });
  });
  it('rejects another payer, a random unlock and an unlock belonging to a different Like', async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      new PostgresLikedByProfileStore(database, 'test', other.owner).detail(f.unlock.id),
    ).rejects.toBeDefined();
    for (const id of [randomUUID(), other.unlock.id]) {
      const media = new PostgresLikedByMediaAuthorization(database, 'test', f.owner, f.likeId, id);
      await expect(media.authorize(f.request)).rejects.toMatchObject({ status: 403 });
    }
  });
  it('does not turn a locked blur grant into full profile access', async () => {
    const f = await fixture();
    const blur = new PostgresLikedByMediaAuthorization(database, 'test', f.owner, f.likeId);
    await expect(blur.authorize(f.request)).rejects.toBeDefined();
    const grant = await blur.authorize({
      ...f.request,
      purpose: 'liked_by_blur',
      requestedVariant: 'blurred_preview',
    });
    expect(grant.variantType).toBe('blurred_preview');
    const source = {
      authorityId: grant.authorityId,
      audienceId: f.actorUserId,
      path: grant.deliveryPath,
      purpose: 'liked_by_blur',
      variant: grant.variantType,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    };
    expect(await blur.isCurrent(source)).toBe(true);
    await new PostgresUserSessionStore(database).revoke(
      f.owner,
      f.owner.sessionGrantId,
      randomUUID(),
    );
    expect(await blur.isCurrent(source)).toBe(false);
  });
  it('revokes cached media and private reads when the exact unlock is revoked', async () => {
    const f = await fixture(),
      detail = await f.store.detail(f.unlock.id);
    await revoke(f);
    expect(await f.media.isCurrent(detail.photos[0]!.source)).toBe(false);
    await expect(f.store.detail(f.unlock.id)).rejects.toBeDefined();
    await expect(f.media.authorize(f.request)).rejects.toBeDefined();
    await expect(f.paid.spendCredits(f.write)).rejects.toMatchObject({
      code: 'unlock_unavailable',
    });
    expect(
      BigInt(
        (
          await database
            .selectFrom('billing.credit_accounts')
            .select('balance')
            .where('user_id', '=', f.actorUserId)
            .executeTakeFirstOrThrow()
        ).balance,
      ),
    ).toBe(96n);
  });
  it('keeps the original session revoked even after a fresh sign-in', async () => {
    const f = await fixture(),
      detail = await f.store.detail(f.unlock.id);
    await new PostgresUserSessionStore(database).revoke(
      f.owner,
      f.owner.sessionGrantId,
      randomUUID(),
    );
    const fresh = await session(f.actorUserId);
    expect(fresh.sessionGrantId).not.toBe(f.owner.sessionGrantId);
    expect(await f.media.isCurrent(detail.photos[0]!.source)).toBe(false);
    await expect(f.store.detail(f.unlock.id)).rejects.toBeDefined();
    expect(
      (await new PostgresLikedByProfileStore(database, 'test', fresh).detail(f.unlock.id)).name,
    ).toBe(detail.name);
  });
  it('preserves a sent Like when its sender hides their profile or changes preferences', async () => {
    const f = await fixture();
    await database
      .insertInto('identity.user_settings')
      .values({
        user_id: f.ownerUserId,
        visibility_enabled: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await sql`UPDATE profile.profiles SET gender_preference_id='20000000-0000-4000-8000-000000000011',version=version+1 WHERE user_id=${f.ownerUserId}::uuid`.execute(
      database,
    );
    const detail = await f.store.detail(f.unlock.id);
    expect(await f.store.detailIsCurrent(f.unlock.id, detail)).toBe(true);
  });
  it('denies account restrictions and hidden inboxes before cached access', async () => {
    for (const change of ['restricted', 'invisible'] as const) {
      const f = await fixture(),
        detail = await f.store.detail(f.unlock.id);
      if (change === 'restricted')
        await sql`UPDATE identity.accounts SET state='restricted',version=version+1 WHERE user_id=${f.ownerUserId}::uuid`.execute(
          database,
        );
      if (change === 'invisible')
        await sql`UPDATE identity.user_settings SET visibility_enabled=false,version=version+1 WHERE user_id=${f.actorUserId}::uuid`.execute(
          database,
        );
      expect(await f.media.isCurrent(detail.photos[0]!.source)).toBe(false);
      await expect(f.store.detail(f.unlock.id)).rejects.toBeDefined();
    }
  });
  it('invalidates the source on rejection or a closed Like without selecting another one', async () => {
    for (const change of ['reject', 'close'] as const) {
      const f = await fixture(),
        detail = await f.store.detail(f.unlock.id);
      if (change === 'close')
        await sql`UPDATE interaction.likes SET status='cancelled_by_system',version=version+1,closed_at=clock_timestamp() WHERE id=${f.likeId}::uuid`.execute(
          database,
        );
      else
        await database
          .insertInto('interaction.not_interested')
          .values({
            id: randomUUID(),
            sender_user_id: f.actorUserId,
            receiver_user_id: f.ownerUserId,
            source: 'liked_by',
            created_at: new Date(),
          })
          .execute();
      expect(await f.media.isCurrent(detail.photos[0]!.source)).toBe(false);
      await expect(f.store.detail(f.unlock.id)).rejects.toBeDefined();
    }
  });
  it('checks text version and the exact complete photo set before subsequent sends', async () => {
    const f = await fixture(),
      detail = await f.store.detail(f.unlock.id);
    await sql`UPDATE profile.profiles SET bio='Changed private bio',version=version+1 WHERE user_id=${f.ownerUserId}::uuid`.execute(
      database,
    );
    expect(await f.store.detailIsCurrent(f.unlock.id, detail)).toBe(false);
    const newer = await f.store.detail(f.unlock.id);
    await createReportPhoto(database, f.ownerUserId, false, new Uint8Array([7, 8, 9]));
    expect(await f.store.detailIsCurrent(f.unlock.id, newer)).toBe(false);
    await sql`UPDATE media.profile_photos SET status='hidden',hidden_at=clock_timestamp(),is_primary=false,version=version+1,updated_at=clock_timestamp() WHERE id=${f.photoId}::uuid`.execute(
      database,
    );
    expect(await f.media.isCurrent(detail.photos[0]!.source)).toBe(false);
  });
  it('charges once under concurrent requests and never grants from a balance alone', async () => {
    const f = await fixture();
    const receipts = await Promise.all(
      Array.from({ length: 12 }, () =>
        f.paid.spendCredits({
          ...f.write,
          featureUnlockId: randomUUID(),
          creditTransactionId: randomUUID(),
          outboxEventId: randomUUID(),
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(new Set(receipts.map((r) => r.id))).toEqual(new Set([f.unlock.id]));
    const account = await database
      .selectFrom('billing.credit_accounts')
      .select('balance')
      .where('user_id', '=', f.actorUserId)
      .executeTakeFirstOrThrow();
    expect(BigInt(account.balance)).toBe(96n);
    const stranger = await createReportUser(database, true);
    await expect(
      new PostgresLikedByProfileStore(database, 'test', await session(stranger)).detail(
        f.unlock.id,
      ),
    ).rejects.toBeDefined();
  });
  it('rejects a forged raw database grant without a current original unlock', async () => {
    const f = await fixture();
    const detail = await f.store.detail(f.unlock.id);
    const original = await database
      .selectFrom('media.delivery_grants')
      .selectAll()
      .where('id', '=', detail.photos[0]!.authority.authorityId)
      .executeTakeFirstOrThrow();
    await expect(
      database
        .insertInto('media.delivery_grants')
        .values({ ...original, id: randomUUID(), feature_unlock_id: randomUUID() })
        .execute(),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      database
        .insertInto('media.delivery_grants')
        .values({ ...original, id: randomUUID(), session_grant_id: randomUUID() })
        .execute(),
    ).rejects.toMatchObject({ code: '40001' });
  });
  it('revokes the exact Like and grant on a real native owner deletion', async () => {
    let original: Fixture | undefined,
      source: Awaited<ReturnType<PostgresLikedByProfileStore['detail']>> | undefined;
    await createDeletionFixture(database, async (owner) => {
      original = await fixture(owner);
      source = await original.store.detail(original.unlock.id);
      expect(await original.media.isCurrent(source.photos[0]!.source)).toBe(true);
    });
    expect(await original!.media.isCurrent(source!.photos[0]!.source)).toBe(false);
    await expect(original!.store.detail(original!.unlock.id)).rejects.toBeDefined();
  });
  it('rechecks unlock revocation after an observed shared pair-lock wait', async () => {
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
    const pending = f.media.authorize(f.request),
      denial = expect(pending).rejects.toMatchObject({ status: 403 });
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
      await revoke(f);
    } finally {
      release();
      await holder;
    }
    await denial;
    expect(
      await database
        .selectFrom('media.delivery_grants')
        .select('id')
        .where('feature_unlock_id', '=', f.unlock.id)
        .execute(),
    ).toHaveLength(0);
  });
  async function deliveryInput(f: Fixture, full = false): Promise<TelegramLikedByDeliveryInput> {
    const identity = await database
      .selectFrom('identity.telegram_identities')
      .select('telegram_user_id')
      .where('user_id', '=', f.actorUserId)
      .executeTakeFirstOrThrow();
    return {
      botId: '12345',
      updateId: String(Math.floor(Math.random() * 1000000000)),
      userId: f.actorUserId,
      productEpoch: f.owner.productEpoch,
      telegramUserId: identity.telegram_user_id,
      requestId: randomUUID(),
      sessionGrantId: f.owner.sessionGrantId,
      callbackQueryId: 'native-current-entry',
      ...(full ? { sourceLikeId: f.likeId, featureUnlockId: f.unlock.id } : {}),
    };
  }
  function deliveries(): PostgresTelegramLikedByDeliveryStore {
    return new PostgresTelegramLikedByDeliveryStore(
      database,
      new SystemIdGenerator(),
      new SystemClock(),
    );
  }
  it('enqueues twenty modern first-page callback replays once with original session and no rendered body', async () => {
    const f = await fixture(),
      input = await deliveryInput(f),
      store = deliveries();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.enqueue(input)));
    expect(new Set(results.map((r) => r.deliveryId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const row = await database
      .selectFrom('channel_telegram.liked_by_delivery_requests')
      .selectAll()
      .where('id', '=', results[0]!.deliveryId)
      .executeTakeFirstOrThrow();
    expect(row.session_grant_id).toBe(f.owner.sessionGrantId);
    expect(row.cursor).toBeNull();
    expect(row.profile_version).toBeNull();
    expect(row.source_like_id).toBeNull();
    expect(row.feature_unlock_id).toBeNull();
    expect(JSON.stringify(row)).not.toContain('Private report');
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('payload')
        .where('aggregate_id', '=', row.id)
        .execute(),
    ).toEqual([{ payload: { deliveryId: row.id } }]);
    await expect(store.enqueue({ ...input, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });
  it('freezes the first full-profile version and allows terminal settlement after original session revocation', async () => {
    const f = await fixture(),
      input = await deliveryInput(f, true),
      store = deliveries(),
      result = await store.enqueue(input);
    const owner = randomUUID(),
      claim = (await store.claimBatch({ owner, leaseMs: 30000, limit: 100 })).find(
        (c) => c.id === result.deliveryId,
      )!;
    expect(claim).toMatchObject({
      sessionGrantId: f.owner.sessionGrantId,
      sourceLikeId: f.likeId,
      featureUnlockId: f.unlock.id,
    });
    const settlement = { id: claim.id, owner, attemptCount: claim.attemptCount };
    const p = await database
      .selectFrom('profile.profiles')
      .select('version')
      .where('user_id', '=', f.ownerUserId)
      .executeTakeFirstOrThrow();
    expect(await store.bindProfileVersion(settlement, p.version)).toBe('bound');
    expect(await store.bindProfileVersion(settlement, p.version)).toBe('bound');
    const receipt = { ...settlement, messageKey: 'detail:' + 'a'.repeat(43), providerMessageId: 7 };
    expect(await store.recordMessageReceipt(receipt)).toMatchObject({ outcome: 'recorded' });
    expect(await store.recordMessageReceipt(receipt)).toMatchObject({ outcome: 'replayed' });
    await sql`UPDATE profile.profiles SET version=version+1 WHERE user_id=${f.ownerUserId}::uuid`.execute(
      database,
    );
    expect(await store.bindProfileVersion(settlement, p.version + 1)).toBe('version_changed');
    await expect(
      database
        .updateTable('channel_telegram.liked_by_delivery_requests')
        .set({ profile_version: p.version + 1 })
        .where('id', '=', claim.id)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      database
        .updateTable('channel_telegram.liked_by_delivery_requests')
        .set({ session_grant_id: randomUUID() })
        .where('id', '=', claim.id)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await new PostgresUserSessionStore(database).revoke(
      f.owner,
      f.owner.sessionGrantId,
      randomUUID(),
    );
    expect(await store.markFailed({ ...settlement, errorCode: 'identity_unavailable' })).toBe(true);
  });
  it('rejects a borrowed original unlock and a fresh sign-in substituted into an old request', async () => {
    const f = await fixture(),
      other = await fixture(),
      input = await deliveryInput(f, true),
      store = deliveries();
    await expect(
      store.enqueue({ ...input, featureUnlockId: other.unlock.id }),
    ).rejects.toBeDefined();
    await expect(store.enqueue({ ...input, sourceLikeId: other.likeId })).rejects.toBeDefined();
    await store.enqueue(input);
    const newer = await session(f.actorUserId);
    await expect(
      store.enqueue({ ...input, sessionGrantId: newer.sessionGrantId }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await new PostgresUserSessionStore(database).revoke(
      f.owner,
      f.owner.sessionGrantId,
      randomUUID(),
    );
    await expect(store.enqueue(input)).rejects.toMatchObject({ status: 401 });
  });
  it('captures enqueue inputs before any asynchronous lookup', async () => {
    const f = await fixture(),
      input = await deliveryInput(f, true),
      original = structuredClone(input),
      store = deliveries();
    const pending = store.enqueue(input);
    Object.assign(input, {
      sessionGrantId: randomUUID(),
      sourceLikeId: randomUUID(),
      requestId: randomUUID(),
    });
    const result = await pending,
      row = await database
        .selectFrom('channel_telegram.liked_by_delivery_requests')
        .selectAll()
        .where('id', '=', result.deliveryId)
        .executeTakeFirstOrThrow();
    expect(row.session_grant_id).toBe(original.sessionGrantId);
    expect(row.source_like_id).toBe(original.sourceLikeId);
    expect(row.request_id).toBe(original.requestId);
  });
  it('guards raw modern queue inserts and refuses captured-session page reads after revocation', async () => {
    const f = await fixture(),
      input = await deliveryInput(f),
      store = deliveries();
    const row = await store.enqueue(input);
    const stored = await database
      .selectFrom('channel_telegram.liked_by_delivery_requests')
      .selectAll()
      .where('id', '=', row.deliveryId)
      .executeTakeFirstOrThrow();
    await expect(
      database
        .insertInto('channel_telegram.liked_by_delivery_requests')
        .values({
          ...stored,
          id: randomUUID(),
          update_id: String(Number(stored.update_id) + 1),
          session_grant_id: randomUUID(),
        })
        .execute(),
    ).rejects.toMatchObject({ code: '40001' });
    const pages = new PostgresLikedByStore(database, f.owner),
      query = {
        actor: { kind: 'user' as const, userId: f.actorUserId },
        requestId: randomUUID(),
        limit: 8,
      };
    expect(
      (await pages.readActionablePage(query, undefined, 0)).rows.some((r) => r.likeId === f.likeId),
    ).toBe(true);
    await new PostgresUserSessionStore(database).revoke(
      f.owner,
      f.owner.sessionGrantId,
      randomUUID(),
    );
    await session(f.actorUserId);
    await expect(pages.readActionablePage(query, undefined, 0)).rejects.toMatchObject({
      status: 403,
    });
  });
  it('checks original enqueue session after an observed full-view pair-lock wait', async () => {
    const f = await fixture(),
      input = await deliveryInput(f, true),
      store = deliveries();
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
    const pending = store.enqueue(input),
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
        f.owner,
        f.owner.sessionGrantId,
        randomUUID(),
      );
    } finally {
      release();
      await holder;
    }
    await denial;
    expect(
      await database
        .selectFrom('channel_telegram.liked_by_delivery_requests')
        .select('id')
        .where('bot_id', '=', input.botId)
        .where('update_id', '=', input.updateId)
        .execute(),
    ).toHaveLength(0);
  });
  function interaction(f: Fixture): PostgresInteractionStore {
    return new PostgresInteractionStore(database, f.owner, undefined, {
      likeId: f.likeId,
      unlockId: f.unlock.id,
    });
  }
  async function senderSettings(f: Fixture): Promise<void> {
    await database
      .insertInto('identity.user_settings')
      .values({
        user_id: f.ownerUserId,
        visibility_enabled: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((c) => c.column('user_id').doUpdateSet({ visibility_enabled: false }))
      .execute();
  }
  it('matches an unlocked original Like once across twenty Like Back retries even if its sender is hidden', async () => {
    const f = await fixture();
    await senderSettings(f);
    expect(await readLikedByAccess(database, f.owner, f.likeId)).toMatchObject({
      targetUserId: f.ownerUserId,
      unlockId: f.unlock.id,
      balance: '96',
    });
    const command = {
      commandType: 'interaction.send-like' as const,
      schemaVersion: 1 as const,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      actor: { kind: 'user' as const, userId: f.actorUserId },
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { targetUserId: f.ownerUserId },
    };
    const effects = {
      likeId: randomUUID(),
      matchId: randomUUID(),
      chatSessionId: randomUUID(),
      auditId: randomUUID(),
      likeEventId: randomUUID(),
      likeClosedEventId: randomUUID(),
      matchEventId: randomUUID(),
      consumptionEventId: randomUUID(),
      occurredAt: new Date(),
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        interaction(f).sendLike(command, { ...effects, likeId: randomUUID() }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.outcome === 'matched')).toBe(true);
    expect(
      await database
        .selectFrom('matching.matches')
        .select('id')
        .where('id', '=', effects.matchId)
        .execute(),
    ).toHaveLength(1);
    await new PostgresUserSessionStore(database).revoke(
      f.owner,
      f.owner.sessionGrantId,
      randomUUID(),
    );
    await session(f.actorUserId);
    await expect(interaction(f).sendLike(command, effects)).rejects.toMatchObject({ status: 401 });
  });
  it('dismisses the exact unlocked original Like silently and replays without requiring its now-closed scope', async () => {
    const f = await fixture();
    await senderSettings(f);
    const command = {
      commandType: 'interaction.mark-not-interested' as const,
      schemaVersion: 1 as const,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      actor: { kind: 'user' as const, userId: f.actorUserId },
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { targetUserId: f.ownerUserId, source: 'liked_by' as const },
    };
    const effects = {
      rejectionId: randomUUID(),
      auditId: randomUUID(),
      rejectionEventId: randomUUID(),
      likeClosedEventId: randomUUID(),
      consumptionEventId: randomUUID(),
      occurredAt: new Date(),
    };
    await expect(
      new PostgresInteractionStore(database).markNotInterested(command, effects),
    ).rejects.toMatchObject({ code: 'interaction_unavailable' });
    expect((await interaction(f).markNotInterested(command, effects)).outcome).toBe('rejected');
    expect((await interaction(f).markNotInterested(command, effects)).replayed).toBe(true);
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('event_type')
      .where('correlation_id', '=', command.requestId)
      .execute();
    expect(events.some((e) => e.event_type.includes('notification'))).toBe(false);
    expect(
      (
        await database
          .selectFrom('interaction.likes')
          .select('status')
          .where('id', '=', f.likeId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('closed_by_not_interested');
  });
});
