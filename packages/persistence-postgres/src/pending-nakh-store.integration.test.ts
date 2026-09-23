import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  CancelPendingNakhWrite,
  CreatePendingNakhWrite,
  EditPendingNakhWrite,
} from '@nakh/application';
import { RunNakhMaintenanceBatchHandler, SettlePendingNakhesHandler } from '@nakh/application';
import type {
  CancelPendingNakhCommand,
  CreatePendingNakhCommand,
  EditPendingNakhCommand,
  PendingNakhCancelResolution,
} from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresNakhMaintenanceStore } from './nakh-maintenance-store.js';
import { PostgresPendingNakhStore } from './pending-nakh-store.js';
import { PostgresPendingNakhSettlementStore } from './pending-nakh-settlement-store.js';

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

function editCommand(
  senderUserId: string,
  pendingNakhId: string,
  expectedVersion: number,
  text: string,
): EditPendingNakhCommand {
  return {
    commandId: randomUUID(),
    commandType: 'nakh.edit-pending',
    schemaVersion: 1,
    actor: { kind: 'user', userId: senderUserId },
    requestId: randomUUID(),
    idempotencyKey: `edit:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { pendingNakhId, text, expectedVersion },
  };
}

function editWrite(value: EditPendingNakhCommand): EditPendingNakhWrite {
  return { command: value, pendingEventId: randomUUID() };
}

function cancelCommand(
  senderUserId: string,
  pendingNakhId: string,
  resolution: PendingNakhCancelResolution,
  idempotencyKey = `cancel:${randomUUID()}`,
): CancelPendingNakhCommand {
  return {
    commandId: randomUUID(),
    commandType: 'nakh.cancel-pending',
    schemaVersion: 1,
    actor: { kind: 'user', userId: senderUserId },
    requestId: randomUUID(),
    idempotencyKey,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { pendingNakhId, resolution, expectedVersion: 1 },
  };
}

function cancelWrite(value: CancelPendingNakhCommand): CancelPendingNakhWrite {
  return {
    command: value,
    interactionId: randomUUID(),
    matchId: randomUUID(),
    chatSessionId: randomUUID(),
    interactionEventId: randomUUID(),
    likeClosedEventId: randomUUID(),
    matchEventId: randomUUID(),
    pendingEventId: randomUUID(),
    auditId: randomUUID(),
  };
}

function errorCode(reason: unknown): string | undefined {
  return reason instanceof ApplicationError ? reason.code : undefined;
}

async function increaseCredits(
  database: NakhDatabase,
  userId: string,
  amount: bigint,
): Promise<string> {
  const transactionId = randomUUID();
  await database.transaction().execute(async (transaction) => {
    const account = await transaction
      .selectFrom('billing.credit_accounts')
      .select(['balance', 'version'])
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const balanceBefore = BigInt(account.balance);
    const balanceAfter = balanceBefore + amount;
    const version = account.version + 1;
    await transaction
      .insertInto('billing.credit_transactions')
      .values({
        id: transactionId,
        credit_account_id: userId,
        user_id: userId,
        account_version: version,
        transaction_type: 'admin_adjustment',
        amount: amount.toString(),
        balance_before: balanceBefore.toString(),
        balance_after: balanceAfter.toString(),
        payment_record_id: null,
        pending_payment_id: null,
        feature_unlock_id: null,
        nakh_id: null,
        idempotency_key: `test-credit:${transactionId}`,
        correlation_id: transactionId,
      })
      .execute();
    await transaction
      .updateTable('billing.credit_accounts')
      .set({ balance: balanceAfter.toString(), version, updated_at: new Date() })
      .where('user_id', '=', userId)
      .where('version', '=', account.version)
      .executeTakeFirstOrThrow();
  });
  return transactionId;
}

async function insertPendingFixture(
  database: NakhDatabase,
  senderUserId: string,
  receiverUserId: string,
  createdAt: Date,
): Promise<Readonly<{ pendingNakhId: string; pendingPaymentId: string }>> {
  const flowId = randomUUID();
  const pendingNakhId = randomUUID();
  const pendingPaymentId = randomUUID();
  const expiresAt = new Date(createdAt.getTime() + 14 * 24 * 60 * 60 * 1_000);
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('nakh.nakh_flows')
      .values({
        id: flowId,
        sender_user_id: senderUserId,
        receiver_user_id: receiverUserId,
        created_at: createdAt,
      })
      .execute();
    await transaction
      .insertInto('billing.pending_payments')
      .values({
        id: pendingPaymentId,
        user_id: senderUserId,
        reason: 'send_nakh',
        target_type: 'pending_nakh',
        target_id: pendingNakhId,
        funding_type: 'telegram_stars',
        required_credits: null,
        required_stars: '2',
        package_code_snapshot: null,
        package_credit_amount_snapshot: null,
        idempotency_key: `maintenance-payment:${pendingPaymentId}`,
        request_hash: 'a'.repeat(64),
        created_at: createdAt,
        expires_at: expiresAt,
        resolved_at: null,
      })
      .execute();
    await transaction
      .insertInto('nakh.pending_nakhes')
      .values({
        id: pendingNakhId,
        nakh_flow_id: flowId,
        sender_user_id: senderUserId,
        text: 'A scheduled Pending Nakh',
        pending_payment_id: pendingPaymentId,
        auto_settle_authorized_at: createdAt,
        authorization_source: 'explore',
        authorized_at: createdAt,
        created_at: createdAt,
        expires_at: expiresAt,
        paid_at: null,
        cancelled_at: null,
        expired_at: null,
        closed_at: null,
        cancel_resolution: null,
        last_reminder_at: null,
        idempotency_key: `maintenance-pending:${pendingNakhId}`,
        request_hash: 'b'.repeat(64),
      })
      .execute();
    await transaction
      .updateTable('platform.user_counters')
      .set({
        pending_nakh_count: 1,
        version: 2,
        updated_at: new Date(),
      })
      .where('user_id', '=', senderUserId)
      .where('pending_nakh_count', '=', 0)
      .executeTakeFirstOrThrow();
  });
  return { pendingNakhId, pendingPaymentId };
}

async function insertDeliveredFixture(
  database: NakhDatabase,
  senderUserId: string,
  receiverUserId: string,
  sentAt: Date,
): Promise<string> {
  await increaseCredits(database, senderUserId, 2n);
  const flowId = randomUUID();
  const nakhId = randomUUID();
  const creditTransactionId = randomUUID();
  const expiresAt = new Date(sentAt.getTime() + 14 * 24 * 60 * 60 * 1_000);
  await database.transaction().execute(async (transaction) => {
    const account = await transaction
      .selectFrom('billing.credit_accounts')
      .select(['balance', 'version'])
      .where('user_id', '=', senderUserId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto('nakh.nakh_flows')
      .values({
        id: flowId,
        sender_user_id: senderUserId,
        receiver_user_id: receiverUserId,
        created_at: sentAt,
      })
      .execute();
    await transaction
      .insertInto('nakh.nakhes')
      .values({
        id: nakhId,
        nakh_flow_id: flowId,
        sender_user_id: senderUserId,
        receiver_user_id: receiverUserId,
        text: 'An independently expiring delivered Nakh',
        funding_type: 'credits',
        credit_transaction_id: creditTransactionId,
        payment_record_id: null,
        sent_at: sentAt,
        expires_at: expiresAt,
        seen_at: null,
        accepted_at: null,
        rejected_at: null,
        expired_at: null,
        closed_at: null,
      })
      .execute();
    await transaction
      .insertInto('nakh.nakh_status_history')
      .values({
        id: randomUUID(),
        nakh_id: nakhId,
        nakh_version: 1,
        from_status: null,
        to_status: 'sent',
        reason_code: 'credit_funded',
        changed_by_user_id: senderUserId,
        request_id: randomUUID(),
        changed_at: sentAt,
      })
      .execute();
    await transaction
      .insertInto('billing.credit_transactions')
      .values({
        id: creditTransactionId,
        credit_account_id: senderUserId,
        user_id: senderUserId,
        account_version: account.version + 1,
        transaction_type: 'spend_nakh',
        amount: '-2',
        balance_before: account.balance,
        balance_after: '0',
        payment_record_id: null,
        pending_payment_id: null,
        feature_unlock_id: null,
        nakh_id: nakhId,
        idempotency_key: `maintenance-spend:${nakhId}`,
        correlation_id: randomUUID(),
        created_at: sentAt,
      })
      .execute();
    await transaction
      .updateTable('billing.credit_accounts')
      .set({ balance: '0', version: account.version + 1, updated_at: new Date() })
      .where('user_id', '=', senderUserId)
      .where('version', '=', account.version)
      .executeTakeFirstOrThrow();
  });
  return nakhId;
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

    const [senderPage, receiverPage] = await Promise.all([
      store.readSenderPage({
        actor: { kind: 'user', userId: senderUserId },
        requestId: randomUUID(),
        limit: 10,
      }),
      store.readSenderPage({
        actor: { kind: 'user', userId: receiverUserId },
        requestId: randomUUID(),
        limit: 10,
      }),
    ]);
    expect(senderPage.totalCount).toBe(1);
    expect(senderPage.rows).toHaveLength(1);
    expect(senderPage.rows[0]).toMatchObject({
      pendingNakhId: pending[0]!.id,
      text: replayedCommand.data.text,
    });
    expect(JSON.stringify(senderPage)).not.toContain(receiverUserId);
    expect(receiverPage).toEqual({ totalCount: 0, rows: [], hasMore: false });
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

  it('edits once across command replay without changing payment, deadline, quota, or receiver facts', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserId = await createActiveUser(database);
    const created = await store.createPending(write(command(senderUserId, receiverUserId)));
    const before = await database
      .selectFrom('nakh.pending_nakhes')
      .selectAll()
      .where('id', '=', created.pendingNakhId)
      .executeTakeFirstOrThrow();
    const replayedCommand = editCommand(
      senderUserId,
      created.pendingNakhId,
      1,
      'Edited private hello 🌲',
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.editPending(editWrite(replayedCommand))),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(19);
    expect(new Set(results.map((result) => result.version))).toEqual(new Set([2]));

    const [after, payment, counter, notifications, events] = await Promise.all([
      database
        .selectFrom('nakh.pending_nakhes')
        .selectAll()
        .where('id', '=', created.pendingNakhId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('billing.pending_payments')
        .selectAll()
        .where('id', '=', before.pending_payment_id)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('platform.user_counters')
        .select('pending_nakh_count')
        .where('user_id', '=', senderUserId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', '=', receiverUserId)
        .execute(),
      database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('aggregate_id', '=', created.pendingNakhId)
        .where('event_type', '=', 'nakh.pending-updated.v1')
        .execute(),
    ]);
    expect(after).toMatchObject({ text: 'Edited private hello 🌲', version: 2 });
    expect(after.expires_at).toEqual(before.expires_at);
    expect(after.pending_payment_id).toBe(before.pending_payment_id);
    expect(payment.expires_at).toEqual(before.expires_at);
    expect(counter.pending_nakh_count).toBe(1);
    expect(notifications).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it('serializes stale concurrent edits and preserves sender ownership', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserId = await createActiveUser(database);
    const strangerUserId = await createActiveUser(database);
    const created = await store.createPending(write(command(senderUserId, receiverUserId)));
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        store.editPending(
          editWrite(
            editCommand(senderUserId, created.pendingNakhId, 1, `Concurrent edit ${index}`),
          ),
        ),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const failures = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
    );
    expect(failures).toHaveLength(19);
    expect(failures.every((failure) => errorCode(failure.reason) === 'version_conflict')).toBe(
      true,
    );
    await expect(
      store.editPending(
        editWrite(editCommand(strangerUserId, created.pendingNakhId, 2, 'Forged edit')),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cancels to one Like across replay and closes every still-pending funding fact', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserId = await createActiveUser(database);
    const created = await store.createPending(write(command(senderUserId, receiverUserId)));
    const pending = await database
      .selectFrom('nakh.pending_nakhes')
      .select(['pending_payment_id', 'nakh_flow_id'])
      .where('id', '=', created.pendingNakhId)
      .executeTakeFirstOrThrow();
    const paymentRecordId = randomUUID();
    await database
      .insertInto('billing.payment_records')
      .values({
        id: paymentRecordId,
        user_id: senderUserId,
        pending_payment_id: pending.pending_payment_id,
        payment_type: 'pay_pending_action',
        paid_action_reason: 'send_nakh',
        credit_package_id: null,
        package_code_snapshot: null,
        package_credit_amount_snapshot: null,
        stars_amount: '2',
        provider: 'telegram_stars',
        provider_environment: 'test',
        provider_bot_id_digest: 'a'.repeat(64),
        invoice_payload_digest: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        invoice_payload_ciphertext: new Uint8Array(32),
        invoice_payload_key_id: 'test',
        provider_payment_id: null,
        idempotency_key: `invoice:${randomUUID()}`,
        request_hash: 'b'.repeat(64),
        paid_at: null,
        failed_at: null,
        cancelled_at: null,
        expired_at: null,
        refunded_at: null,
      })
      .execute();
    const replayed = cancelCommand(
      senderUserId,
      created.pendingNakhId,
      'converted_to_like',
      `cancel:${randomUUID()}`,
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.cancelPending(cancelWrite(replayed))),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(19);
    expect(new Set(results.map((result) => result.version))).toEqual(new Set([2]));

    const [terminal, intent, invoice, counter, likes, rejections, flows, consumption, facts] =
      await Promise.all([
        database
          .selectFrom('nakh.pending_nakhes')
          .selectAll()
          .where('id', '=', created.pendingNakhId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('billing.pending_payments')
          .selectAll()
          .where('id', '=', pending.pending_payment_id)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('billing.payment_records')
          .selectAll()
          .where('id', '=', paymentRecordId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('platform.user_counters')
          .select('pending_nakh_count')
          .where('user_id', '=', senderUserId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('interaction.likes')
          .selectAll()
          .where('sender_user_id', '=', senderUserId)
          .where('receiver_user_id', '=', receiverUserId)
          .execute(),
        database
          .selectFrom('interaction.not_interested')
          .select('id')
          .where('sender_user_id', '=', senderUserId)
          .where('receiver_user_id', '=', receiverUserId)
          .execute(),
        database
          .selectFrom('nakh.nakh_flows')
          .select('id')
          .where('id', '=', pending.nakh_flow_id)
          .execute(),
        database
          .selectFrom('discovery.explore_consumptions')
          .select('reason')
          .where('viewer_user_id', '=', senderUserId)
          .where('target_user_id', '=', receiverUserId)
          .execute(),
        database
          .selectFrom('platform.outbox_events')
          .select('event_type')
          .where('causation_id', '=', replayed.commandId)
          .execute(),
      ]);
    expect(terminal).toMatchObject({
      status: 'cancelled',
      cancel_resolution: 'converted_to_like',
      version: 2,
    });
    expect(terminal.cancelled_at).not.toBeNull();
    expect(intent).toMatchObject({ status: 'cancelled', version: 2 });
    expect(invoice).toMatchObject({ status: 'pending', version: 1 });
    expect(invoice.cancelled_at).toBeNull();
    expect(counter.pending_nakh_count).toBe(0);
    expect(likes).toHaveLength(1);
    expect(rejections).toHaveLength(0);
    expect(flows).toHaveLength(1);
    expect(consumption).toEqual([{ reason: 'nakh_flow' }]);
    expect(facts.map((fact) => fact.event_type).sort()).toEqual([
      'interaction.like-created.v1',
      'nakh.cancelled.v1',
    ]);
  });

  it('converts to Not Interested, closes a received Like, and never notifies the target', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserId = await createActiveUser(database);
    const created = await store.createPending(write(command(senderUserId, receiverUserId)));
    const receivedLikeId = randomUUID();
    await database
      .insertInto('interaction.likes')
      .values({
        id: receivedLikeId,
        sender_user_id: receiverUserId,
        receiver_user_id: senderUserId,
        status: 'active',
        created_at: new Date(),
        closed_at: null,
      })
      .execute();
    const result = await store.cancelPending(
      cancelWrite(
        cancelCommand(senderUserId, created.pendingNakhId, 'converted_to_not_interested'),
      ),
    );
    expect(result).toMatchObject({ status: 'cancelled', version: 2, replayed: false });
    const [rejection, receivedLike, matches, notifications] = await Promise.all([
      database
        .selectFrom('interaction.not_interested')
        .selectAll()
        .where('sender_user_id', '=', senderUserId)
        .where('receiver_user_id', '=', receiverUserId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('interaction.likes')
        .selectAll()
        .where('id', '=', receivedLikeId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('matching.matches')
        .select('id')
        .where('user_low_id', 'in', [senderUserId, receiverUserId])
        .where('user_high_id', 'in', [senderUserId, receiverUserId])
        .execute(),
      database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', '=', receiverUserId)
        .execute(),
    ]);
    expect(rejection.source).toBe('cancelled_pending_nakh');
    expect(receivedLike).toMatchObject({ status: 'closed_by_not_interested', version: 2 });
    expect(matches).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it('ACC-027 serializes competing cancellation resolutions into exactly one terminal shape', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserId = await createActiveUser(database);
    const created = await store.createPending(write(command(senderUserId, receiverUserId)));
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        store.cancelPending(
          cancelWrite(
            cancelCommand(
              senderUserId,
              created.pendingNakhId,
              index % 2 === 0 ? 'converted_to_like' : 'converted_to_not_interested',
            ),
          ),
        ),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const failures = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
    );
    expect(failures).toHaveLength(19);
    expect(failures.every((failure) => errorCode(failure.reason) === 'nakh_terminal')).toBe(true);

    const [terminal, likes, rejections, nakhes, notifications, counter] = await Promise.all([
      database
        .selectFrom('nakh.pending_nakhes')
        .select(['status', 'cancel_resolution'])
        .where('id', '=', created.pendingNakhId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('interaction.likes')
        .select('id')
        .where('sender_user_id', '=', senderUserId)
        .where('receiver_user_id', '=', receiverUserId)
        .execute(),
      database
        .selectFrom('interaction.not_interested')
        .select('id')
        .where('sender_user_id', '=', senderUserId)
        .where('receiver_user_id', '=', receiverUserId)
        .execute(),
      database
        .selectFrom('nakh.nakhes')
        .select('id')
        .where('sender_user_id', '=', senderUserId)
        .where('receiver_user_id', '=', receiverUserId)
        .execute(),
      database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', '=', receiverUserId)
        .execute(),
      database
        .selectFrom('platform.user_counters')
        .select('pending_nakh_count')
        .where('user_id', '=', senderUserId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(terminal.status).toBe('cancelled');
    expect(likes.length + rejections.length).toBe(1);
    expect(terminal.cancel_resolution).toBe(
      likes.length === 1 ? 'converted_to_like' : 'converted_to_not_interested',
    );
    expect(nakhes).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(counter.pending_nakh_count).toBe(0);
  });

  it('ACC-024 settles strictly FIFO across duplicate workers without spending on an invalid oldest row', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserIds = await Promise.all(
      Array.from({ length: 3 }, () => createActiveUser(database)),
    );
    const pending = [];
    for (const receiverUserId of receiverUserIds) {
      pending.push(await store.createPending(write(command(senderUserId, receiverUserId))));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }

    await database
      .updateTable('identity.accounts')
      .set({
        state: 'restricted',
        state_reason: 'test_restriction',
        state_changed_at: new Date(),
        version: 2,
      })
      .where('user_id', '=', receiverUserIds[0]!)
      .executeTakeFirstOrThrow();
    const triggerCreditTransactionId = await increaseCredits(database, senderUserId, 2n);
    const settlement = new SettlePendingNakhesHandler(
      new PostgresPendingNakhSettlementStore(database),
      { uuid: randomUUID },
    );
    const causationId = randomUUID();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        settlement.execute({ senderUserId, triggerCreditTransactionId, causationId }),
      ),
    );

    const [rows, intents, delivered, spends, account, counter, receiverNotifications] =
      await Promise.all([
        database
          .selectFrom('nakh.pending_nakhes')
          .select(['id', 'pending_payment_id', 'status'])
          .where(
            'id',
            'in',
            pending.map(({ pendingNakhId }) => pendingNakhId),
          )
          .execute(),
        database
          .selectFrom('billing.pending_payments')
          .select(['target_id', 'status'])
          .where(
            'target_id',
            'in',
            pending.map(({ pendingNakhId }) => pendingNakhId),
          )
          .execute(),
        database
          .selectFrom('nakh.nakhes')
          .select(['nakh_flow_id', 'receiver_user_id', 'funding_type'])
          .where('sender_user_id', '=', senderUserId)
          .execute(),
        database
          .selectFrom('billing.credit_transactions')
          .select(['pending_payment_id', 'amount'])
          .where('user_id', '=', senderUserId)
          .where('transaction_type', '=', 'spend_nakh')
          .execute(),
        database
          .selectFrom('billing.credit_accounts')
          .select('balance')
          .where('user_id', '=', senderUserId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('platform.user_counters')
          .select('pending_nakh_count')
          .where('user_id', '=', senderUserId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('notification.notifications')
          .select(['user_id', 'notification_type'])
          .where('user_id', 'in', receiverUserIds)
          .where('notification_type', '=', 'nakh_received')
          .execute(),
      ]);
    const statusById = new Map(rows.map((row) => [row.id, row.status]));
    const intentByTarget = new Map(intents.map((row) => [row.target_id, row.status]));
    expect(pending.map(({ pendingNakhId }) => statusById.get(pendingNakhId))).toEqual([
      'closed_by_system',
      'paid_and_sent',
      'pending_payment',
    ]);
    expect(pending.map(({ pendingNakhId }) => intentByTarget.get(pendingNakhId))).toEqual([
      'cancelled',
      'paid',
      'pending',
    ]);
    expect(delivered).toEqual([
      expect.objectContaining({
        receiver_user_id: receiverUserIds[1],
        funding_type: 'credits',
      }),
    ]);
    expect(spends).toEqual([{ pending_payment_id: pending[1]!.fundingIntentId, amount: '-2' }]);
    expect(account.balance).toBe('0');
    expect(counter.pending_nakh_count).toBe(1);
    expect(receiverNotifications).toEqual([
      { user_id: receiverUserIds[1], notification_type: 'nakh_received' },
    ]);

    await expect(
      settlement.execute({ senderUserId, triggerCreditTransactionId, causationId }),
    ).resolves.toMatchObject({
      deliveredCount: 0,
      closedCount: 0,
      stopped: 'insufficient_credits',
    });
  });

  it('ACC-029 independently expires both clocks and sends each due reminder once', async () => {
    const now = Date.now();
    const expiredPendingSender = await createActiveUser(database);
    const expiredPendingReceiver = await createActiveUser(database);
    const reminderSender = await createActiveUser(database);
    const reminderReceiver = await createActiveUser(database);
    const deliveredSender = await createActiveUser(database);
    const deliveredReceiver = await createActiveUser(database);
    const expiredPending = await insertPendingFixture(
      database,
      expiredPendingSender,
      expiredPendingReceiver,
      new Date(now - 15 * 24 * 60 * 60 * 1_000),
    );
    const reminderPending = await insertPendingFixture(
      database,
      reminderSender,
      reminderReceiver,
      new Date(now - 3 * 24 * 60 * 60 * 1_000),
    );
    const deliveredNakhId = await insertDeliveredFixture(
      database,
      deliveredSender,
      deliveredReceiver,
      new Date(now - 16 * 24 * 60 * 60 * 1_000),
    );
    const maintenance = new RunNakhMaintenanceBatchHandler(
      new PostgresNakhMaintenanceStore(database),
    );

    await Promise.all(Array.from({ length: 10 }, () => maintenance.execute(100)));

    const [pending, payment, counter, reminder, delivered, history, notifications, events] =
      await Promise.all([
        database
          .selectFrom('nakh.pending_nakhes')
          .select(['status', 'expired_at'])
          .where('id', '=', expiredPending.pendingNakhId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('billing.pending_payments')
          .select(['status', 'resolved_at'])
          .where('id', '=', expiredPending.pendingPaymentId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('platform.user_counters')
          .select('pending_nakh_count')
          .where('user_id', '=', expiredPendingSender)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('nakh.pending_nakhes')
          .select(['status', 'reminder_count', 'last_reminder_at'])
          .where('id', '=', reminderPending.pendingNakhId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('nakh.nakhes')
          .select(['status', 'expired_at'])
          .where('id', '=', deliveredNakhId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('nakh.nakh_status_history')
          .select(['nakh_version', 'from_status', 'to_status', 'reason_code'])
          .where('nakh_id', '=', deliveredNakhId)
          .orderBy('nakh_version')
          .execute(),
        database
          .selectFrom('notification.notifications')
          .select(['user_id', 'notification_type', 'payload'])
          .where('notification_type', '=', 'pending_nakh_payment_reminder')
          .where('user_id', 'in', [reminderSender, reminderReceiver])
          .execute(),
        database
          .selectFrom('platform.outbox_events')
          .select(['aggregate_id', 'event_type'])
          .where('aggregate_id', 'in', [
            expiredPending.pendingNakhId,
            reminderPending.pendingNakhId,
            deliveredNakhId,
          ])
          .where('event_type', 'in', [
            'nakh.status-changed.v1',
            'nakh.pending-reminder-requested.v1',
          ])
          .execute(),
      ]);
    expect(pending.status).toBe('expired');
    expect(pending.expired_at).not.toBeNull();
    expect(payment.status).toBe('expired');
    expect(payment.resolved_at).not.toBeNull();
    expect(counter.pending_nakh_count).toBe(0);
    expect(reminder).toMatchObject({ status: 'pending_payment', reminder_count: 1 });
    expect(reminder.last_reminder_at).not.toBeNull();
    expect(delivered.status).toBe('expired');
    expect(delivered.expired_at).not.toBeNull();
    expect(history).toEqual([
      expect.objectContaining({ nakh_version: 1, from_status: null, to_status: 'sent' }),
      {
        nakh_version: 2,
        from_status: 'sent',
        to_status: 'expired',
        reason_code: 'deadline_elapsed',
      },
    ]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      user_id: reminderSender,
      notification_type: 'pending_nakh_payment_reminder',
    });
    expect(notifications[0]!.payload).toMatchObject({
      pendingNakhId: reminderPending.pendingNakhId,
      reminderNumber: 1,
    });
    expect(events).toEqual(
      expect.arrayContaining([
        { aggregate_id: expiredPending.pendingNakhId, event_type: 'nakh.status-changed.v1' },
        {
          aggregate_id: reminderPending.pendingNakhId,
          event_type: 'nakh.pending-reminder-requested.v1',
        },
        { aggregate_id: deliveredNakhId, event_type: 'nakh.status-changed.v1' },
      ]),
    );

    await expect(maintenance.execute(100)).resolves.toEqual({
      pendingExpired: { examined: 0, changed: 0 },
      deliveredExpired: { examined: 0, changed: 0 },
      remindersSent: { examined: 0, changed: 0 },
      hasMore: false,
    });
  });
});
