import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CreatePendingNakhWrite } from '@nakh/application';
import type { CreatePendingNakhCommand } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresPendingNakhStore } from './pending-nakh-store.js';

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
    .insertInto('profile.profiles')
    .values({
      id: randomUUID(),
      user_id: userId,
      name: 'Pending Nakh fixture',
      birth_year: new Date().getUTCFullYear() - 30,
      gender_option_id: manGenderId,
      gender_preference_id: everyonePreferenceId,
      relationship_goal_id: relationshipGoalId,
      country_id: countryId,
      province_id: provinceId,
      city_id: cityId,
      highlight: 'Pending Nakh fixture',
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

function command(
  senderUserId: string,
  targetUserId: string,
  idempotencyKey = `pending:${randomUUID()}`,
): CreatePendingNakhCommand {
  return {
    commandId: randomUUID(),
    commandType: 'nakh.create-pending',
    schemaVersion: 1,
    actor: { kind: 'user', userId: senderUserId },
    requestId: randomUUID(),
    idempotencyKey,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { targetUserId, text: 'A private hello 🌳', autoSettleAuthorized: true },
  };
}

function write(value: CreatePendingNakhCommand): CreatePendingNakhWrite {
  return {
    command: value,
    flowId: randomUUID(),
    pendingNakhId: randomUUID(),
    pendingPaymentId: randomUUID(),
    flowEventId: randomUUID(),
    pendingEventId: randomUUID(),
  };
}

function errorCode(reason: unknown): string | undefined {
  return reason instanceof ApplicationError ? reason.code : undefined;
}

describe.skipIf(databaseUrl === undefined)('M5 pending Nakh persistence', () => {
  let database: NakhDatabase;
  let store: PostgresPendingNakhStore;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 30,
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 10_000,
    });
    store = new PostgresPendingNakhStore(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('ACC-021 returns one stable result for twenty simultaneous command replays', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserId = await createActiveUser(database);
    const replayedCommand = command(senderUserId, receiverUserId, `pending:${randomUUID()}`);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.createPending(write(replayedCommand))),
    );
    expect(new Set(results.map((result) => result.pendingNakhId))).toHaveLength(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(19);

    const [flows, pending, payments, notifications] = await Promise.all([
      database
        .selectFrom('nakh.nakh_flows')
        .select('id')
        .where('sender_user_id', '=', senderUserId)
        .where('receiver_user_id', '=', receiverUserId)
        .execute(),
      database
        .selectFrom('nakh.pending_nakhes')
        .selectAll()
        .where('sender_user_id', '=', senderUserId)
        .execute(),
      database
        .selectFrom('billing.pending_payments')
        .selectAll()
        .where('user_id', '=', senderUserId)
        .where('reason', '=', 'send_nakh')
        .execute(),
      database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', '=', receiverUserId)
        .execute(),
    ]);
    expect(flows).toHaveLength(1);
    expect(pending).toHaveLength(1);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.expires_at).toEqual(pending[0]!.expires_at);
    expect(notifications).toHaveLength(0);
  });

  it('ACC-021 permits only one permanent flow across distinct concurrent commands', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserId = await createActiveUser(database);
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        store.createPending(write(command(senderUserId, receiverUserId))),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const failures = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
    );
    expect(failures).toHaveLength(19);
    expect(failures.every((failure) => errorCode(failure.reason) === 'nakh_flow_exists')).toBe(
      true,
    );
    expect(
      await database
        .selectFrom('nakh.nakh_flows')
        .select('id')
        .where('sender_user_id', '=', senderUserId)
        .where('receiver_user_id', '=', receiverUserId)
        .execute(),
    ).toHaveLength(1);
  });

  it('ACC-022 admits exactly five of twenty simultaneous pending targets', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserIds = await Promise.all(
      Array.from({ length: 20 }, () => createActiveUser(database)),
    );
    const attempts = await Promise.allSettled(
      receiverUserIds.map((receiverUserId) =>
        store.createPending(write(command(senderUserId, receiverUserId))),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(5);
    const failures = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
    );
    expect(failures).toHaveLength(15);
    expect(failures.every((failure) => errorCode(failure.reason) === 'nakh_quota_reached')).toBe(
      true,
    );

    const counter = await database
      .selectFrom('platform.user_counters')
      .select('pending_nakh_count')
      .where('user_id', '=', senderUserId)
      .executeTakeFirstOrThrow();
    const pending = await database
      .selectFrom('nakh.pending_nakhes')
      .select('id')
      .where('sender_user_id', '=', senderUserId)
      .where('status', '=', 'pending_payment')
      .execute();
    expect(counter.pending_nakh_count).toBe(5);
    expect(pending).toHaveLength(5);
  });
});
