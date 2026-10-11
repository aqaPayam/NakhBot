import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationType } from '@nakh/domain';
import type { NotificationDeliveryLease, SpendCreditsForPaidActionWrite } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import {
  createReportChat,
  createReportLike,
  createReportMessage,
  createReportNakh,
  createReportPhoto,
  createReportUnmatch,
  createReportUser,
} from './testing/report-fixture.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { PostgresPaidActionStore } from './paid-action-store.js';
import { PostgresPendingNakhStore } from './pending-nakh-store.js';
import { PostgresNotificationStore } from './notification-store.js';
import { PostgresNotificationDeliveryStore } from './notification-delivery-store.js';
import { PostgresUnmatchStore } from './unmatch-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
const productTypes = [
  'new_chat_message',
  'like_received',
  'nakh_received',
  'pending_nakh_payment_reminder',
  'match_created',
  'liked_by_profile_unlocked',
  'chat_unlocked',
  'safety_notice',
] as const satisfies readonly NotificationType[];
type ProductType = (typeof productTypes)[number];

describe.skipIf(url === undefined)('M8 exact notification product scopes', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let notices: PostgresNotificationStore, deliveries: PostgresNotificationDeliveryStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_notice_scopes');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 25,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
    notices = new PostgresNotificationStore(database);
    deliveries = new PostgresNotificationDeliveryStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });

  async function prepare(userId: string): Promise<void> {
    const at = new Date();
    await database
      .insertInto('identity.user_settings')
      .values({ user_id: userId, created_at: at, updated_at: at })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: true })
      .where('user_id', '=', userId)
      .execute();
    await database
      .insertInto('billing.credit_accounts')
      .values({ user_id: userId, created_at: at, updated_at: at })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: userId, created_at: at, updated_at: at })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
    await database
      .updateTable('notification.notification_preferences')
      .set({ chat_enabled: true, like_enabled: true, nakh_enabled: true, match_enabled: true })
      .where('user_id', '=', userId)
      .execute();
    await database
      .insertInto('identity.telegram_identities')
      .values({
        user_id: userId,
        telegram_user_id: String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000)),
        username: null,
        first_seen_at: at,
        last_seen_at: at,
      })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
    await createReportPhoto(database, userId);
  }

  async function activeOwner(owner: string, template: string): Promise<void> {
    const profile = await database
      .selectFrom('profile.profiles')
      .selectAll()
      .where('user_id', '=', template)
      .executeTakeFirstOrThrow();
    await database
      .insertInto('profile.profiles')
      .values({ ...profile, id: randomUUID(), user_id: owner })
      .execute();
    await database
      .updateTable('identity.accounts')
      .set({ state: 'active', version: sql<number>`version+1` })
      .where('user_id', '=', owner)
      .execute();
    await prepare(owner);
  }

  async function record(
    userId: string,
    type: NotificationType,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<NotificationDeliveryLease> {
    const cause = randomUUID();
    const recorded = await notices.record({
      userId,
      type,
      titleKey: `notification.${type}.title`,
      bodyKey: `notification.${type}.body`,
      payload,
      deduplicationKey: `m8-scope:${cause}`,
      correlationId: cause,
      causationId: cause,
    });
    const workerId = `scope:${randomUUID()}`;
    const claim = (await deliveries.claimDue({ workerId, limit: 100, leaseMs: 120000 })).find(
      (row) => row.deliveryId === recorded.telegramDeliveryId,
    );
    expect(claim).toBeDefined();
    return { deliveryId: claim!.deliveryId, leaseOwner: workerId, fenceToken: claim!.fenceToken };
  }

  async function unlock(
    userId: string,
    target: SpendCreditsForPaidActionWrite['target'],
  ): Promise<string> {
    await new PostgresCreditLedgerStore(database).append({
      transactionId: randomUUID(),
      userId,
      transactionType: 'admin_adjustment',
      amount: 10n,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
    const write: SpendCreditsForPaidActionWrite = {
      userId,
      target,
      featureUnlockId: randomUUID(),
      creditTransactionId: randomUUID(),
      outboxEventId: randomUUID(),
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    };
    return (await new PostgresPaidActionStore(database).spendCredits(write)).id;
  }

  async function source(
    type: ProductType,
    recipient: string,
    other: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    switch (type) {
      case 'new_chat_message': {
        const chat = await createReportChat(database, recipient, other);
        const [low, high] = [recipient, other].sort() as [string, string];
        await database
          .insertInto('interaction.user_pair_states')
          .values({
            user_low_id: low,
            user_high_id: high,
            state: 'matched',
            reason_code: 'match',
            changed_at: new Date(),
          })
          .execute();
        return {
          chatSessionId: chat.chatSessionId,
          messageId: await createReportMessage(database, chat.chatSessionId, other),
        };
      }
      case 'like_received':
        return { likeId: await createReportLike(database, recipient, other) };
      case 'nakh_received':
        return { nakhId: await createReportNakh(database, recipient, other) };
      case 'pending_nakh_payment_reminder': {
        const id = randomUUID();
        const result = await new PostgresPendingNakhStore(database).createPending({
          flowId: randomUUID(),
          pendingNakhId: randomUUID(),
          pendingPaymentId: randomUUID(),
          flowEventId: randomUUID(),
          pendingEventId: randomUUID(),
          command: {
            commandType: 'nakh.create-pending',
            schemaVersion: 1,
            commandId: id,
            requestId: randomUUID(),
            idempotencyKey: id,
            actor: { kind: 'user', userId: recipient },
            occurredAt: new Date().toISOString(),
            locale: 'en',
            data: {
              targetUserId: other,
              text: 'Synthetic pending notification scope',
              autoSettleAuthorized: true,
            },
          },
        });
        return { pendingNakhId: result.pendingNakhId };
      }
      case 'liked_by_profile_unlocked': {
        const likeId = await createReportLike(database, recipient, other);
        return { featureUnlockId: await unlock(recipient, { type: 'like', targetId: likeId }) };
      }
      case 'match_created':
        return { matchId: (await createReportChat(database, recipient, other)).matchId };
      case 'chat_unlocked':
      case 'safety_notice': {
        const chat = await createReportChat(database, recipient, other);
        const [low, high] = [recipient, other].sort() as [string, string];
        await database
          .insertInto('interaction.user_pair_states')
          .values({
            user_low_id: low,
            user_high_id: high,
            state: 'matched',
            reason_code: 'match',
            changed_at: new Date(),
          })
          .execute();
        return {
          featureUnlockId: await unlock(recipient, { type: 'match', targetId: chat.matchId }),
        };
      }
    }
  }

  async function snapshot(
    users: readonly string[],
    lease: NotificationDeliveryLease,
  ): Promise<readonly (readonly unknown[])[]> {
    return Promise.all([
      database
        .selectFrom('notification.notification_deliveries')
        .selectAll()
        .where('id', '=', lease.deliveryId)
        .execute(),
      database
        .selectFrom('billing.credit_accounts')
        .selectAll()
        .where('user_id', 'in', users)
        .orderBy('user_id')
        .execute(),
      database
        .selectFrom('billing.credit_transactions')
        .selectAll()
        .where('user_id', 'in', users)
        .orderBy('id')
        .execute(),
      database
        .selectFrom('interaction.feature_unlocks')
        .selectAll()
        .where('payer_user_id', 'in', users)
        .orderBy('id')
        .execute(),
      database
        .selectFrom('interaction.likes')
        .selectAll()
        .where('sender_user_id', 'in', users)
        .where('receiver_user_id', 'in', users)
        .orderBy('id')
        .execute(),
      database
        .selectFrom('matching.matches')
        .selectAll()
        .where('user_low_id', 'in', users)
        .where('user_high_id', 'in', users)
        .orderBy('id')
        .execute(),
      database
        .selectFrom('nakh.pending_nakhes')
        .selectAll()
        .where('sender_user_id', 'in', users)
        .orderBy('id')
        .execute(),
      database
        .selectFrom('nakh.nakhes')
        .selectAll()
        .where('sender_user_id', 'in', users)
        .where('receiver_user_id', 'in', users)
        .orderBy('id')
        .execute(),
    ]);
  }

  it.each(productTypes)(
    'denies twenty-way %s delivery after exact counterpart deletion',
    async (type) => {
      const recipient = await createReportUser(database, true),
        outsider = await createReportUser(database, true);
      await prepare(recipient);
      await prepare(outsider);
      let lease!: NotificationDeliveryLease;
      const fixture = await createDeletionFixture(database, async (owner) => {
        await activeOwner(owner, recipient);
        const payload = await source(type, recipient, owner);
        lease = await record(recipient, type, payload);
        expect(await deliveries.loadTelegramProjection(lease)).toBeDefined();
        const borrowed = await record(outsider, type, payload);
        expect(await deliveries.loadTelegramProjection(borrowed)).toBeUndefined();
        expect(await deliveries.markProviderCallStarted(borrowed)).toBe(false);
      });
      const before = await snapshot([recipient, fixture.userId], lease);
      await Promise.all(
        Array.from({ length: 20 }, async () => {
          expect(await deliveries.loadTelegramProjection(lease)).toBeUndefined();
          expect(await deliveries.markProviderCallStarted(lease)).toBe(false);
        }),
      );
      expect(await snapshot([recipient, fixture.userId], lease)).toEqual(before);
      const unrelated = await record(outsider, 'safety_notice', { cause: randomUUID() });
      expect(await deliveries.loadTelegramProjection(unrelated)).toBeDefined();
      expect(await deliveries.markProviderCallStarted(unrelated)).toBe(true);
    },
  );

  async function corruptEpoch(userId: string, epoch: number): Promise<void> {
    await database.connection().execute(async (connection) => {
      await sql`SET session_replication_role=replica`.execute(connection);
      try {
        await sql`UPDATE identity.accounts SET product_epoch=${epoch} WHERE user_id=${userId}::uuid`.execute(
          connection,
        );
      } finally {
        await sql`SET session_replication_role=origin`.execute(connection);
      }
    });
  }
  it.each([
    'new_chat_message',
    'like_received',
    'match_created',
    'liked_by_profile_unlocked',
    'chat_unlocked',
    'safety_notice',
  ] as const)(
    'denies original %s authority borrowed from a later counterpart life',
    async (type) => {
      const recipient = await createReportUser(database, true),
        other = await createReportUser(database, true);
      await prepare(recipient);
      await prepare(other);
      const payload = await source(type, recipient, other);
      const lease = await record(recipient, type, payload);
      expect(await deliveries.loadTelegramProjection(lease)).toBeDefined();
      const original = await snapshot([recipient, other], lease);
      await corruptEpoch(other, 1);
      try {
        const attempts = await Promise.all(
          Array.from({ length: 20 }, async () => ({
            projection: await deliveries.loadTelegramProjection(lease),
          })),
        );
        for (const attempt of attempts) expect(attempt.projection).toBeUndefined();
        expect(await deliveries.markProviderCallStarted(lease)).toBe(false);
      } finally {
        await corruptEpoch(other, 0);
      }
      expect(await snapshot([recipient, other], lease)).toEqual(original);
      expect(await deliveries.loadTelegramProjection(lease)).toBeDefined();
    },
  );
  it('denies an original generic critical notice after its recipient life changes', async () => {
    const recipient = await createReportUser(database, true);
    await prepare(recipient);
    const lease = await record(recipient, 'safety_notice', { cause: randomUUID() });
    expect(await deliveries.loadTelegramProjection(lease)).toBeDefined();
    const original = await snapshot([recipient], lease);
    await corruptEpoch(recipient, 1);
    try {
      const attempts = await Promise.all(
        Array.from({ length: 20 }, () => deliveries.loadTelegramProjection(lease)),
      );
      for (const projection of attempts) expect(projection).toBeUndefined();
      expect(await deliveries.markProviderCallStarted(lease)).toBe(false);
    } finally {
      await corruptEpoch(recipient, 0);
    }
    expect(await snapshot([recipient], lease)).toEqual(original);
    expect(await deliveries.loadTelegramProjection(lease)).toBeDefined();
  });

  it('rechecks original source lives after waiting for the counterpart Account lock', async () => {
    const first = await createPreparedUser(),
      second = await createPreparedUser();
    const lease = await record(
      first,
      'match_created',
      await source('match_created', first, second),
    );
    expect(await deliveries.loadTelegramProjection(lease)).toBeDefined();
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('identity.accounts')
        .select('user_id')
        .where('user_id', '=', second)
        .forUpdate()
        .execute();
      acquired();
      await barrier;
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await sql`UPDATE identity.accounts SET product_epoch=1 WHERE user_id=${second}::uuid`.execute(
        tx,
      );
    });
    await ready;
    const admission = deliveries.markProviderCallStarted(lease);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting = (
          await sql<{
            waiting: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%identity%accounts%') AS waiting`.execute(
            database,
          )
        ).rows[0]!.waiting;
        if (waiting) break;
        await delay(20);
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await writer;
    }
    try {
      expect(await admission).toBe(false);
    } finally {
      await corruptEpoch(second, 0);
    }
    expect(await deliveries.loadTelegramProjection(lease)).toBeDefined();
    expect(await deliveries.markProviderCallStarted(lease)).toBe(true);
  });

  it('preserves original replay but denies cached history borrowing a later recipient life', async () => {
    const userId = await createPreparedUser();
    const cause = randomUUID();
    const write = {
      userId,
      type: 'safety_notice' as const,
      titleKey: 'notification.safety_notice.title',
      bodyKey: 'notification.safety_notice.body',
      payload: { cause },
      deduplicationKey: `life-replay:${cause}`,
      correlationId: cause,
      causationId: cause,
    };
    const first = await notices.record(write);
    const original = await snapshot([userId], {
      deliveryId: first.telegramDeliveryId!,
      leaseOwner: 'unused',
      fenceToken: '1',
    });
    await corruptEpoch(userId, 1);
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => notices.record(write)),
      );
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected')
          expect(result.reason).toMatchObject({ code: 'idempotency_conflict' });
      }
    } finally {
      await corruptEpoch(userId, 0);
    }
    expect(await notices.record(write)).toEqual({ ...first, replayed: true });
    expect(
      await snapshot([userId], {
        deliveryId: first.telegramDeliveryId!,
        leaseOwner: 'unused',
        fenceToken: '1',
      }),
    ).toEqual(original);
    expect(
      await database
        .selectFrom('notification.notifications')
        .selectAll()
        .where('deduplication_key', '=', write.deduplicationKey)
        .execute(),
    ).toHaveLength(1);
  });

  it('denies recipient-life mutation while allowing the original read transition', async () => {
    const userId = await createPreparedUser();
    const lease = await record(userId, 'safety_notice', { cause: randomUUID() });
    const delivery = await database
      .selectFrom('notification.notification_deliveries')
      .select('notification_id')
      .where('id', '=', lease.deliveryId)
      .executeTakeFirstOrThrow();
    await expect(
      database
        .updateTable('notification.notifications')
        .set({ status: 'read', read_at: new Date(), version: 2, product_epoch: 1 })
        .where('id', '=', delivery.notification_id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await database
      .updateTable('notification.notifications')
      .set({ status: 'read', read_at: new Date(), version: 2 })
      .where('id', '=', delivery.notification_id)
      .execute();
    expect(
      await database
        .selectFrom('notification.notifications')
        .select(['status', 'product_epoch', 'version'])
        .where('id', '=', delivery.notification_id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'read', product_epoch: 0, version: 2 });
  });

  it('stamps new births under the current recipient lock and rejects a forged life', async () => {
    const userId = await createPreparedUser();
    const values = {
      id: randomUUID(),
      user_id: userId,
      notification_type: 'safety_notice' as const,
      category: 'safety' as const,
      title_key: 'notification.safety_notice.title',
      body_key: 'notification.safety_notice.body',
      payload: {},
      deduplication_key: null,
      read_at: null,
    };
    await expect(
      database
        .insertInto('notification.notifications')
        .values({ ...values, product_epoch: 2 })
        .execute(),
    ).rejects.toMatchObject({ code: '40001' });
    // Isolated corruption evidence only; this is not a verified return.
    await corruptEpoch(userId, 1);
    try {
      await database.insertInto('notification.notifications').values(values).execute();
      expect(
        await database
          .selectFrom('notification.notifications')
          .select('product_epoch')
          .where('id', '=', values.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ product_epoch: 1 });
    } finally {
      await corruptEpoch(userId, 0);
    }
  });

  it('settles an already admitted original provider outcome once after recipient-life change', async () => {
    const userId = await createPreparedUser();
    const lease = await record(userId, 'safety_notice', { cause: randomUUID() });
    const original = await database
      .selectFrom('notification.notification_deliveries')
      .selectAll()
      .where('id', '=', lease.deliveryId)
      .executeTakeFirstOrThrow();
    expect(await deliveries.markProviderCallStarted(lease)).toBe(true);
    await corruptEpoch(userId, 1);
    try {
      expect(await deliveries.loadTelegramProjection(lease)).toBeUndefined();
      expect(await deliveries.markProviderCallStarted(lease)).toBe(false);
      const write = {
        ...lease,
        attemptNumber: original.attempt_number,
        outcome: 'sent' as const,
        providerMessageKey: `telegram:${randomUUID()}`,
      };
      expect(await deliveries.settle(write)).toBe(true);
      expect(await deliveries.settle(write)).toBe(false);
      const notice = await database
        .selectFrom('notification.notifications')
        .select('product_epoch')
        .where('id', '=', original.notification_id)
        .executeTakeFirstOrThrow();
      expect(notice.product_epoch).toBe(0);
    } finally {
      await corruptEpoch(userId, 0);
    }
  });

  it('preserves an exact terminal closure notice to the survivor after counterpart deletion', async () => {
    const recipient = await createReportUser(database, true);
    await prepare(recipient);
    let lease!: NotificationDeliveryLease;
    await createDeletionFixture(database, async (owner) => {
      await activeOwner(owner, recipient);
      const chat = await createReportUnmatch(database, owner, recipient);
      lease = await record(recipient, 'chat_closed', { matchId: chat.matchId });
      expect(await deliveries.loadTelegramProjection(lease)).toBeDefined();
    });
    expect(await deliveries.loadTelegramProjection(lease)).toBeDefined();
    await corruptEpoch(recipient, 1);
    try {
      expect(await deliveries.loadTelegramProjection(lease)).toBeUndefined();
      expect(await deliveries.markProviderCallStarted(lease)).toBe(false);
    } finally {
      await corruptEpoch(recipient, 0);
    }
    expect(await deliveries.loadTelegramProjection(lease)).toBeDefined();
    expect(await deliveries.markProviderCallStarted(lease)).toBe(true);
    expect(await deliveries.markProviderCallStarted(lease)).toBe(false);
  });

  it.each(['chat_unlocked', 'safety_notice'] as const)(
    'rechecks the exact %s grant after normal unmatch',
    async (type) => {
      const first = await createReportUser(database, true),
        second = await createReportUser(database, true);
      await prepare(first);
      await prepare(second);
      const payload = await source(type, first, second);
      const grant = await database
        .selectFrom('interaction.feature_unlocks')
        .select('match_id')
        .where('id', '=', String(payload.featureUnlockId))
        .executeTakeFirstOrThrow();
      const lease = await record(first, type, payload);
      expect(await deliveries.loadTelegramProjection(lease)).toBeDefined();
      const id = randomUUID();
      await new PostgresUnmatchStore(database).unmatch({
        matchId: grant.match_id!,
        eventId: randomUUID(),
        command: {
          commandType: 'matching.unmatch',
          schemaVersion: 1,
          commandId: id,
          requestId: randomUUID(),
          idempotencyKey: id,
          actor: { kind: 'user', userId: first },
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: { matchActionToken: 'fixture' },
        },
      });
      expect(await deliveries.loadTelegramProjection(lease)).toBeUndefined();
      expect(await deliveries.markProviderCallStarted(lease)).toBe(false);
    },
  );

  it.each(productTypes.filter((type) => type !== 'safety_notice'))(
    'rejects malformed %s references',
    async (type) => {
      const user = await createReportUser(database, true);
      await prepare(user);
      const lease = await record(user, type, { cause: randomUUID() });
      expect(await deliveries.loadTelegramProjection(lease)).toBeUndefined();
      expect(await deliveries.markProviderCallStarted(lease)).toBe(false);
    },
  );

  it('denies an invalid unlock warning while preserving a generic critical safety notice', async () => {
    const user = await createReportUser(database, true);
    await prepare(user);
    const invalid = await record(user, 'safety_notice', { featureUnlockId: 'invalid' });
    expect(await deliveries.loadTelegramProjection(invalid)).toBeUndefined();
    expect(await deliveries.markProviderCallStarted(invalid)).toBe(false);
    const generic = await record(user, 'safety_notice', { cause: randomUUID() });
    expect(await deliveries.loadTelegramProjection(generic)).toBeDefined();
    expect(await deliveries.markProviderCallStarted(generic)).toBe(true);
  });

  it('rechecks a rendered Match notice after normal unmatch', async () => {
    const first = await createReportUser(database, true),
      second = await createReportUser(database, true);
    await prepare(first);
    await prepare(second);
    const chat = await createReportChat(database, first, second);
    const [low, high] = [first, second].sort() as [string, string];
    await database
      .insertInto('interaction.user_pair_states')
      .values({
        user_low_id: low,
        user_high_id: high,
        state: 'matched',
        reason_code: 'match',
        changed_at: new Date(),
      })
      .execute();
    const lease = await record(first, 'match_created', { matchId: chat.matchId });
    expect(await deliveries.loadTelegramProjection(lease)).toBeDefined();
    const id = randomUUID();
    await new PostgresUnmatchStore(database).unmatch({
      matchId: chat.matchId,
      eventId: randomUUID(),
      command: {
        commandType: 'matching.unmatch',
        schemaVersion: 1,
        commandId: id,
        requestId: randomUUID(),
        idempotencyKey: id,
        actor: { kind: 'user', userId: first },
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { matchActionToken: 'fixture' },
      },
    });
    expect(await deliveries.loadTelegramProjection(lease)).toBeUndefined();
    expect(await deliveries.markProviderCallStarted(lease)).toBe(false);
    const borrowedClosure = await record(await createPreparedUser(), 'chat_closed', {
      matchId: chat.matchId,
    });
    expect(await deliveries.loadTelegramProjection(borrowedClosure)).toBeUndefined();
    expect(await deliveries.markProviderCallStarted(borrowedClosure)).toBe(false);
  });

  async function createPreparedUser(): Promise<string> {
    const user = await createReportUser(database, true);
    await prepare(user);
    return user;
  }
});
