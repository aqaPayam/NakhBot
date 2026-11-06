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
});
