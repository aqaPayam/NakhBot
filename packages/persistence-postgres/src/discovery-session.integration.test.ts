import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InteractionStore, UserSessionActor } from '@nakh/application';
import type {
  SaveExploreFilterCommand,
  SendLikeCommand,
  MarkNotInterestedCommand,
} from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresExploreFilterStore } from './explore-filter-store.js';
import { PostgresCandidateReservationStore } from './candidate-reservation-store.js';
import { PostgresCandidateDeliveryStore } from './candidate-delivery-store.js';
import { PostgresInteractionStore } from './interaction-store.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresAccountReturnStore } from './account-return-store.js';
import { lockUserPair } from './pair-lock.js';
import { seedValidMedia } from './media-fixtures.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createAccountReturnFixture } from './testing/account-return-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
const man = '20000000-0000-4000-8000-000000000001';
const woman = '20000000-0000-4000-8000-000000000002';
const men = '20000000-0000-4000-8000-000000000011';
const women = '20000000-0000-4000-8000-000000000012';
const province = '20000000-0000-4000-8000-000000000111';
function envelope(userId: string): Omit<SendLikeCommand, 'commandType' | 'data'> & {
  actor: { kind: 'user'; userId: string };
} {
  const id = randomUUID();
  return {
    commandId: id,
    requestId: id,
    schemaVersion: 1,
    actor: { kind: 'user', userId },
    idempotencyKey: id,
    occurredAt: new Date().toISOString(),
    locale: 'en',
  };
}
function like(userId: string, targetUserId: string): SendLikeCommand {
  return { ...envelope(userId), commandType: 'interaction.send-like', data: { targetUserId } };
}
function reject(userId: string, targetUserId: string): MarkNotInterestedCommand {
  return {
    ...envelope(userId),
    commandType: 'interaction.mark-not-interested',
    data: { targetUserId, source: 'explore' },
  };
}
function likeEffects(): Parameters<InteractionStore['sendLike']>[1] {
  return {
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
}
function rejectEffects(): Parameters<InteractionStore['markNotInterested']>[1] {
  return {
    rejectionId: randomUUID(),
    auditId: randomUUID(),
    rejectionEventId: randomUUID(),
    likeClosedEventId: randomUUID(),
    consumptionEventId: randomUUID(),
    occurredAt: new Date(),
  };
}
function filter(userId: string, cityId: string): SaveExploreFilterCommand {
  return {
    ...envelope(userId),
    commandType: 'discovery.save-explore-filter',
    data: { targetGenderOptionIds: [woman], minAge: 18, maxAge: 80, cityId },
  };
}
function filterEffects(): Parameters<PostgresExploreFilterStore['saveFilter']>[1] {
  return { auditId: randomUUID(), eventId: randomUUID(), processedAt: new Date() };
}
function reservationEffects(): Parameters<PostgresCandidateReservationStore['reserveNext']>[1] {
  return { deliveryId: randomUUID(), eventId: randomUUID(), reservedAt: new Date() };
}

describe.skipIf(url === undefined)('native sessions at public discovery boundaries', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_discovery_sessions');
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

  async function user(cityId: string, female = false): Promise<string> {
    const id = randomUUID(),
      profileId = randomUUID();
    await sql`INSERT INTO identity.users(id,last_activity_at,created_at,updated_at)
      VALUES(${id}::uuid,clock_timestamp(),clock_timestamp(),clock_timestamp())`.execute(database);
    await sql`INSERT INTO identity.accounts(user_id,state,state_changed_at)
      VALUES(${id}::uuid,'active',clock_timestamp())`.execute(database);
    await sql`INSERT INTO identity.user_settings(user_id,created_at,updated_at)
      VALUES(${id}::uuid,clock_timestamp(),clock_timestamp())`.execute(database);
    await sql`INSERT INTO profile.profiles(id,user_id,name,birth_year,gender_option_id,gender_preference_id,
      relationship_goal_id,country_id,province_id,city_id,highlight,completion_status,ever_completed,
      completed_at,created_at,updated_at) VALUES(${profileId}::uuid,${id}::uuid,'Session fixture',
      ${new Date().getUTCFullYear() - 30},${female ? woman : man}::uuid,${female ? men : women}::uuid,
      '20000000-0000-4000-8000-000000000021'::uuid,'20000000-0000-4000-8000-000000000101'::uuid,
      ${province}::uuid,${cityId}::uuid,'Session fixture','complete',true,
      clock_timestamp(),clock_timestamp(),clock_timestamp())`.execute(database);
    const asset = await seedValidMedia(database, id);
    await sql`INSERT INTO media.profile_photos(id,profile_id,asset_id,status,is_primary,display_order,created_at,updated_at)
      VALUES(${randomUUID()}::uuid,${profileId}::uuid,${asset}::uuid,'visible',true,0,clock_timestamp(),clock_timestamp())`.execute(
      database,
    );
    return id;
  }
  async function pair(): Promise<{ cityId: string; a: string; b: string }> {
    const cityId = randomUUID(),
      code = 'session_' + cityId.replaceAll('-', '');
    await sql`INSERT INTO catalog.cities(id,province_id,code,label_key,display_order)
      VALUES(${cityId}::uuid,${province}::uuid,${code},${'catalog.city.' + code},999)`.execute(
      database,
    );
    return { cityId, a: await user(cityId), b: await user(cityId, true) };
  }
  async function actor(userId: string): Promise<UserSessionActor> {
    const grant = await new PostgresUserSessionStore(database).issue(
      { userId, productEpoch: 0 },
      randomUUID(),
    );
    if (grant === undefined) throw new Error('Native session fixture unavailable.');
    return { kind: 'user', userId, productEpoch: 0, sessionGrantId: grant.id };
  }
  async function revoke(value: UserSessionActor): Promise<void> {
    await new PostgresUserSessionStore(database).revoke(
      { userId: value.userId, productEpoch: value.productEpoch },
      value.sessionGrantId,
      randomUUID(),
    );
  }

  it('binds concurrent requests to their original reservation after delivery and refuses revoked replay', async () => {
    const f = await pair(),
      session = await actor(f.a);
    const store = new PostgresCandidateReservationStore(database, session);
    const requests = Array.from({ length: 10 }, () => ({
      actor: { kind: 'user' as const, userId: f.a },
      requestId: randomUUID(),
      mode: 'explore' as const,
    }));
    const reservations = await Promise.all(
      requests.map((q) => store.reserveNext(q, reservationEffects())),
    );
    const first = reservations[0]!;
    expect(first?.targetUserId).toBe(f.b);
    expect(reservations.every((r) => r?.deliveryId === first.deliveryId)).toBe(true);
    await new PostgresCandidateDeliveryStore(database).recordDelivered(
      { deliveryId: first.deliveryId, providerMessageId: '9101' },
      {
        auditId: randomUUID(),
        deliveryEventId: randomUUID(),
        consumptionEventId: randomUUID(),
        processedAt: new Date(),
      },
    );
    const nextTarget = await user(f.cityId, true);
    expect(
      await Promise.all(requests.map((q) => store.reserveNext(q, reservationEffects()))),
    ).toEqual(Array.from({ length: 10 }, () => first));
    const receipts = await database
      .selectFrom('platform.idempotency_records')
      .select(['response_json', 'status'])
      .where('actor_user_id', '=', f.a)
      .where('scope', '=', 'discovery.reserve-candidate')
      .execute();
    expect(receipts).toHaveLength(10);
    expect(
      receipts.every(
        (r) =>
          r.status === 'completed' &&
          JSON.stringify(r.response_json) === JSON.stringify({ deliveryId: first.deliveryId }),
      ),
    ).toBe(true);
    const next = await store.reserveNext(
      { ...requests[0]!, requestId: randomUUID() },
      reservationEffects(),
    );
    expect(next?.targetUserId).toBe(nextTarget);
    await expect(
      new PostgresCandidateReservationStore(database, await actor(f.b)).reserveNext(
        requests[0]!,
        reservationEffects(),
      ),
    ).rejects.toMatchObject({ status: 401 });
    await revoke(session);
    await expect(store.reserveNext(requests[0]!, reservationEffects())).rejects.toMatchObject({
      status: 401,
    });
  });

  it('keeps definitive failure and changed request payloads bound to the original command', async () => {
    const f = await pair(),
      session = await actor(f.a);
    const store = new PostgresCandidateReservationStore(database, session);
    const query = {
      actor: { kind: 'user' as const, userId: f.a },
      requestId: randomUUID(),
      mode: 'explore' as const,
    };
    const first = await store.reserveNext(query, reservationEffects());
    expect(first).toBeDefined();
    await new PostgresCandidateDeliveryStore(database).recordDefinitiveFailure(
      { deliveryId: first!.deliveryId, reasonCode: 'provider_rejected' },
      { auditId: randomUUID(), eventId: randomUUID(), processedAt: new Date() },
    );
    expect(await store.reserveNext(query, reservationEffects())).toEqual(first);
    await expect(
      store.reserveNext({ ...query, filterVersion: 2 }, reservationEffects()),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const next = await store.reserveNext(
      { ...query, requestId: randomUUID() },
      reservationEffects(),
    );
    expect(next?.targetUserId).toBe(f.b);
    expect(next?.deliveryId).not.toBe(first!.deliveryId);
    expect(
      await database
        .selectFrom('discovery.explore_consumptions')
        .selectAll()
        .where('viewer_user_id', '=', f.a)
        .execute(),
    ).toHaveLength(0);
  });

  it('does not turn cached empty or purged results into a new selection', async () => {
    const f = await pair(),
      session = await actor(f.a);
    const store = new PostgresCandidateReservationStore(database, session);
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: false })
      .where('user_id', '=', f.b)
      .execute();
    const empty = {
      actor: { kind: 'user' as const, userId: f.a },
      requestId: randomUUID(),
      mode: 'explore' as const,
    };
    expect(await store.reserveNext(empty, reservationEffects())).toBeUndefined();
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: true })
      .where('user_id', '=', f.b)
      .execute();
    expect(await store.reserveNext(empty, reservationEffects())).toBeUndefined();
    const query = { ...empty, requestId: randomUUID() };
    const first = await store.reserveNext(query, reservationEffects());
    await new PostgresCandidateDeliveryStore(database).recordDefinitiveFailure(
      { deliveryId: first!.deliveryId, reasonCode: 'provider_rejected' },
      { auditId: randomUUID(), eventId: randomUUID(), processedAt: new Date() },
    );
    // Model the absence of an already purged original. This is a replay test,
    // not evidence of the separate deletion saga's provider cleanup. Restore
    // its source afterward: an unowned outbox event must block publication.
    const original = await database
      .selectFrom('discovery.candidate_deliveries')
      .selectAll()
      .where('id', '=', first!.deliveryId)
      .executeTakeFirstOrThrow();
    try {
      await database
        .deleteFrom('discovery.candidate_deliveries')
        .where('id', '=', first!.deliveryId)
        .execute();
      expect(await store.reserveNext(query, reservationEffects())).toBeUndefined();
    } finally {
      await database.insertInto('discovery.candidate_deliveries').values(original).execute();
    }
    expect(
      await store.reserveNext({ ...empty, requestId: randomUUID() }, reservationEffects()),
    ).toMatchObject({ targetUserId: f.b });
  });

  it('saves one filter under retries and rejects revoked and borrowed grants before cached replies', async () => {
    const f = await pair(),
      a = await actor(f.a),
      b = await actor(f.b),
      command = filter(f.a, f.cityId);
    const store = new PostgresExploreFilterStore(database, a);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.saveFilter(command, filterEffects())),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.version === 1)).toBe(true);
    await expect(
      new PostgresExploreFilterStore(database, b).saveFilter(command, filterEffects()),
    ).rejects.toMatchObject({ status: 401 });
    await revoke(a);
    await expect(store.saveFilter(command, filterEffects())).rejects.toMatchObject({ status: 401 });
    await expect(
      new PostgresExploreFilterStore(database, await actor(f.a)).saveFilter(
        command,
        filterEffects(),
      ),
    ).resolves.toMatchObject({ version: 1, replayed: true });
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('event_type', '=', 'discovery.filter-saved.v1')
        .where('aggregate_id', '=', f.a)
        .execute(),
    ).toHaveLength(1);
  });

  it('requires the current owner for new reservations, live reservation retries and empty pools', async () => {
    const f = await pair(),
      a = await actor(f.a),
      b = await actor(f.b);
    const query = {
      actor: { kind: 'user' as const, userId: f.a },
      requestId: randomUUID(),
      mode: 'explore' as const,
    };
    const store = new PostgresCandidateReservationStore(database, a);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.reserveNext(query, reservationEffects())),
    );
    expect(results.every((r) => r?.targetUserId === f.b)).toBe(true);
    expect(new Set(results.map((r) => r?.deliveryId)).size).toBe(1);
    await expect(
      new PostgresCandidateReservationStore(database, b).reserveNext(query, reservationEffects()),
    ).rejects.toMatchObject({ status: 401 });
    await revoke(a);
    await expect(store.reserveNext(query, reservationEffects())).rejects.toMatchObject({
      status: 401,
    });
    const empty = await pair(),
      emptyActor = await actor(empty.a);
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: false })
      .where('user_id', '=', empty.b)
      .execute();
    const emptyStore = new PostgresCandidateReservationStore(database, emptyActor);
    const emptyQuery = {
      ...query,
      actor: { kind: 'user' as const, userId: empty.a },
      requestId: randomUUID(),
    };
    await expect(emptyStore.reserveNext(emptyQuery, reservationEffects())).resolves.toBeUndefined();
    await revoke(emptyActor);
    await expect(emptyStore.reserveNext(emptyQuery, reservationEffects())).rejects.toMatchObject({
      status: 401,
    });
  });

  it('serializes opposite bound Likes into one Match and rejects revoked cached results', async () => {
    const f = await pair(),
      a = await actor(f.a),
      b = await actor(f.b);
    const first = like(f.a, f.b),
      second = like(f.b, f.a);
    const left = new PostgresInteractionStore(database, a),
      right = new PostgresInteractionStore(database, b);
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => left.sendLike(first, likeEffects())),
      ...Array.from({ length: 5 }, () => right.sendLike(second, likeEffects())),
    ]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(2);
    expect(new Set(results.flatMap((r) => (r.matchId === undefined ? [] : [r.matchId]))).size).toBe(
      1,
    );
    expect(
      await database
        .selectFrom('matching.matches')
        .select('id')
        .where('user_low_id', '=', [f.a, f.b].sort()[0]!)
        .where('user_high_id', '=', [f.a, f.b].sort()[1]!)
        .execute(),
    ).toHaveLength(1);
    await revoke(a);
    await expect(left.sendLike(first, likeEffects())).rejects.toMatchObject({ status: 401 });
    await expect(
      new PostgresInteractionStore(database, b).sendLike(first, likeEffects()),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('records one bound rejection and fences its replay after session revocation', async () => {
    const f = await pair(),
      a = await actor(f.a),
      command = reject(f.a, f.b);
    const store = new PostgresInteractionStore(database, a);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.markNotInterested(command, rejectEffects())),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    await revoke(a);
    await expect(store.markNotInterested(command, rejectEffects())).rejects.toMatchObject({
      status: 401,
    });
    expect(
      await database
        .selectFrom('interaction.not_interested')
        .select('id')
        .where('sender_user_id', '=', f.a)
        .where('receiver_user_id', '=', f.b)
        .execute(),
    ).toHaveLength(1);
  });

  it('captures the original owner and command before asynchronous database admission', async () => {
    const f = await pair(),
      original = await actor(f.a),
      other = await actor(f.b);
    const mutableOwner = { ...original },
      command = like(f.a, f.b);
    const store = new PostgresInteractionStore(database, mutableOwner);
    Object.assign(mutableOwner, other);
    const pending = store.sendLike(command, likeEffects());
    command.actor.userId = f.b;
    command.data.targetUserId = f.a;
    await expect(pending).resolves.toMatchObject({ outcome: 'liked', replayed: false });
    expect(
      await database
        .selectFrom('interaction.likes')
        .select('sender_user_id')
        .where('receiver_user_id', '=', f.b)
        .where('sender_user_id', '=', f.a)
        .execute(),
    ).toHaveLength(1);
  });

  it('keeps a real pre-deletion product session unusable after approved Return', async () => {
    let old: UserSessionActor | undefined;
    const originalRequestId = randomUUID();
    const f = await createAccountReturnFixture(database, {
      beforeDeletion: async (userId) => {
        old = await actor(userId);
        await new PostgresCandidateReservationStore(database, old).reserveNext(
          {
            actor: { kind: 'user', userId },
            requestId: originalRequestId,
            mode: 'guest_preview',
          },
          reservationEffects(),
        );
      },
    });
    const commandId = randomUUID();
    await new PostgresAccountReturnStore(database, f.control).return({
      ...envelope(f.userId),
      commandId,
      requestId: commandId,
      idempotencyKey: commandId,
      commandType: 'account.return',
      data: { expectedAccountVersion: f.version },
    });
    if (old === undefined) throw new Error('Missing original product session.');
    expect(
      await database
        .selectFrom('platform.idempotency_records')
        .select('id')
        .where('actor_user_id', '=', f.userId)
        .where('scope', '=', 'discovery.reserve-candidate')
        .execute(),
    ).toHaveLength(0);
    await expect(
      new PostgresExploreFilterStore(database, old).saveFilter(
        filter(f.userId, '20000000-0000-4000-8000-000000000121'),
        filterEffects(),
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      new PostgresCandidateReservationStore(database, old).reserveNext(
        {
          actor: { kind: 'user', userId: f.userId },
          requestId: originalRequestId,
          mode: 'guest_preview',
        },
        reservationEffects(),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rechecks native revocation after waiting for the shared pair lock', async () => {
    const f = await pair(),
      a = await actor(f.a);
    let entered: () => void = () => undefined,
      release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = database.transaction().execute(async (tx) => {
      await lockUserPair(tx, f.a, f.b);
      entered();
      await gate;
    });
    await ready;
    const pending = new PostgresInteractionStore(database, a).sendLike(
      like(f.a, f.b),
      likeEffects(),
    );
    const denial = expect(pending).rejects.toMatchObject({ status: 401 });
    try {
      await revoke(a);
    } finally {
      release();
      await holder;
    }
    await denial;
    expect(
      await database
        .selectFrom('interaction.likes')
        .select('id')
        .where('sender_user_id', '=', f.a)
        .where('receiver_user_id', '=', f.b)
        .execute(),
    ).toHaveLength(0);
  });
});
