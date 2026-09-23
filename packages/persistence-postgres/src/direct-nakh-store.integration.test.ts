import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type CreateDirectNakhWrite, ViewNakhProfileHandler } from '@nakh/application';
import type { CreateDirectNakhCommand, ViewNakhProfileCommand } from '@nakh/contracts';
import { ApplicationError, DELIVERED_NAKH_LIFETIME_MS } from '@nakh/domain';

import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresDeliveredNakhStore } from './delivered-nakh-store.js';
import { PostgresDirectNakhStore } from './direct-nakh-store.js';
import { runMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const manGenderId = '20000000-0000-4000-8000-000000000001';
const everyonePreferenceId = '20000000-0000-4000-8000-000000000013';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';

async function createActiveUser(database: NakhDatabase): Promise<string> {
  const userId = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('identity.accounts')
    .values({ user_id: userId, state: 'active', state_reason: null, state_changed_at: now })
    .execute();
  await database
    .insertInto('identity.user_settings')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('billing.credit_accounts')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('notification.notification_preferences')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('profile.profiles')
    .values({
      id: randomUUID(),
      user_id: userId,
      name: 'Direct Nakh fixture',
      birth_year: new Date().getUTCFullYear() - 30,
      gender_option_id: manGenderId,
      gender_preference_id: everyonePreferenceId,
      relationship_goal_id: relationshipGoalId,
      country_id: countryId,
      province_id: provinceId,
      city_id: cityId,
      highlight: 'Direct Nakh fixture',
      bio: null,
      completion_status: 'complete',
      ever_completed: true,
      completed_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return userId;
}

async function grantCredits(database: NakhDatabase, userId: string, amount: bigint): Promise<void> {
  await new PostgresCreditLedgerStore(database).append({
    transactionId: randomUUID(),
    userId,
    transactionType: 'admin_adjustment',
    amount,
    idempotencyKey: `direct-fixture:${randomUUID()}`,
    correlationId: randomUUID(),
  });
}

function command(
  senderUserId: string,
  targetUserId: string,
  idempotencyKey = `direct:${randomUUID()}`,
): CreateDirectNakhCommand {
  return {
    commandId: randomUUID(),
    commandType: 'nakh.create-direct',
    schemaVersion: 1,
    actor: { kind: 'user', userId: senderUserId },
    requestId: randomUUID(),
    idempotencyKey,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { targetUserId, text: 'A funded private hello 🌳' },
  };
}

function write(value: CreateDirectNakhCommand): CreateDirectNakhWrite {
  return {
    command: value,
    flowId: randomUUID(),
    nakhId: randomUUID(),
    creditTransactionId: randomUUID(),
    historyId: randomUUID(),
    flowEventId: randomUUID(),
    deliveredEventId: randomUUID(),
  };
}

function viewCommand(
  receiverUserId: string,
  nakhId: string,
  idempotencyKey = `view-nakh:${randomUUID()}`,
): ViewNakhProfileCommand {
  return {
    commandId: randomUUID(),
    commandType: 'nakh.view-profile',
    schemaVersion: 1,
    actor: { kind: 'user', userId: receiverUserId },
    requestId: randomUUID(),
    idempotencyKey,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { nakhId, expectedVersion: 1 },
  };
}

function errorCode(reason: unknown): string | undefined {
  return reason instanceof ApplicationError ? reason.code : undefined;
}

describe.skipIf(databaseUrl === undefined)('M5 direct credit Nakh persistence', () => {
  let database: NakhDatabase;
  let store: PostgresDirectNakhStore;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 30,
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 10_000,
    });
    store = new PostgresDirectNakhStore(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('creates one funded delivery and notification across twenty command replays', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserId = await createActiveUser(database);
    await grantCredits(database, senderUserId, 10n);
    const replayedCommand = command(senderUserId, receiverUserId);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.createDirect(write(replayedCommand))),
    );
    expect(new Set(results.map((result) => result.nakhId))).toHaveLength(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(19);

    const nakhId = results[0]!.nakhId;
    const [nakh, history, spends, notifications, account, pending] = await Promise.all([
      database.selectFrom('nakh.nakhes').selectAll().where('id', '=', nakhId).executeTakeFirst(),
      database
        .selectFrom('nakh.nakh_status_history')
        .selectAll()
        .where('nakh_id', '=', nakhId)
        .execute(),
      database
        .selectFrom('billing.credit_transactions')
        .selectAll()
        .where('nakh_id', '=', nakhId)
        .execute(),
      database
        .selectFrom('notification.notifications')
        .selectAll()
        .where('user_id', '=', receiverUserId)
        .where('notification_type', '=', 'nakh_received')
        .execute(),
      database
        .selectFrom('billing.credit_accounts')
        .select(['balance', 'version'])
        .where('user_id', '=', senderUserId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('nakh.pending_nakhes')
        .select('id')
        .where('sender_user_id', '=', senderUserId)
        .execute(),
    ]);
    expect(nakh).toMatchObject({
      sender_user_id: senderUserId,
      receiver_user_id: receiverUserId,
      funding_type: 'credits',
      status: 'sent',
    });
    expect(nakh!.expires_at.getTime() - nakh!.sent_at.getTime()).toBe(DELIVERED_NAKH_LIFETIME_MS);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ nakh_version: 1, from_status: null, to_status: 'sent' });
    expect(spends).toHaveLength(1);
    expect(spends[0]).toMatchObject({ transaction_type: 'spend_nakh', amount: '-2' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.payload).toEqual({ nakhId });
    expect(account).toEqual({ balance: '8', version: 3 });
    expect(pending).toHaveLength(0);
  });

  it('serializes exact balance across two targets so only one delivery can commit', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserIds = await Promise.all([
      createActiveUser(database),
      createActiveUser(database),
    ]);
    await grantCredits(database, senderUserId, 2n);
    const attempts = await Promise.allSettled(
      receiverUserIds.map((receiverUserId) =>
        store.createDirect(write(command(senderUserId, receiverUserId))),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const failures = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
    );
    expect(failures).toHaveLength(1);
    expect(errorCode(failures[0]!.reason)).toBe('insufficient_credits');
    expect(
      await database
        .selectFrom('nakh.nakhes')
        .select('id')
        .where('sender_user_id', '=', senderUserId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('billing.credit_accounts')
        .select('balance')
        .where('user_id', '=', senderUserId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ balance: '0' });
  });

  it('returns only owner read models and records first receiver view once across replays', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserId = await createActiveUser(database);
    const strangerUserId = await createActiveUser(database);
    await grantCredits(database, senderUserId, 2n);
    const delivered = await store.createDirect(write(command(senderUserId, receiverUserId)));
    const deliveredStore = new PostgresDeliveredNakhStore(database);

    const [sentPage, receivedPage, senderDetail, receiverDetail] = await Promise.all([
      deliveredStore.readPage(senderUserId, 'sent', 10),
      deliveredStore.readPage(receiverUserId, 'received', 10),
      deliveredStore.readDetail(senderUserId, delivered.nakhId),
      deliveredStore.readDetail(receiverUserId, delivered.nakhId),
    ]);
    expect(sentPage).toMatchObject({
      totalCount: 1,
      rows: [{ nakhId: delivered.nakhId, direction: 'sent', status: 'sent' }],
    });
    expect(receivedPage).toMatchObject({
      totalCount: 1,
      rows: [{ nakhId: delivered.nakhId, direction: 'received', status: 'sent' }],
    });
    expect(senderDetail).toMatchObject({ nakhId: delivered.nakhId, direction: 'sent' });
    expect(receiverDetail).toMatchObject({ nakhId: delivered.nakhId, direction: 'received' });
    await expect(deliveredStore.readDetail(strangerUserId, delivered.nakhId)).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    );

    const handler = new ViewNakhProfileHandler(deliveredStore, { uuid: randomUUID });
    const replayedCommand = viewCommand(receiverUserId, delivered.nakhId);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => handler.execute(replayedCommand)),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(19);
    expect(new Set(results.map((result) => result.changedAt))).toHaveLength(1);

    const [nakh, actions, history, events] = await Promise.all([
      database
        .selectFrom('nakh.nakhes')
        .select(['status', 'seen_at', 'version'])
        .where('id', '=', delivered.nakhId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('nakh.nakh_receiver_actions')
        .select(['receiver_user_id', 'action_type'])
        .where('nakh_id', '=', delivered.nakhId)
        .execute(),
      database
        .selectFrom('nakh.nakh_status_history')
        .select(['nakh_version', 'from_status', 'to_status'])
        .where('nakh_id', '=', delivered.nakhId)
        .orderBy('nakh_version')
        .execute(),
      database
        .selectFrom('platform.outbox_events')
        .select('payload')
        .where('aggregate_id', '=', delivered.nakhId)
        .where('event_type', '=', 'nakh.status-changed.v1')
        .execute(),
    ]);
    expect(nakh).toMatchObject({ status: 'seen', version: 2 });
    expect(nakh.seen_at).not.toBeNull();
    expect(actions).toEqual([{ receiver_user_id: receiverUserId, action_type: 'view_profile' }]);
    expect(history).toEqual([
      { nakh_version: 1, from_status: null, to_status: 'sent' },
      { nakh_version: 2, from_status: 'sent', to_status: 'seen' },
    ]);
    expect(events).toEqual([{ payload: { nakhId: delivered.nakhId, status: 'seen' } }]);
  });
});
