import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { SettlePendingNakhesHandler, type CreatePendingNakhWrite } from '@nakh/application';
import type { CreatePendingNakhCommand } from '@nakh/contracts';
import {
  createDatabase,
  PostgresPendingNakhSettlementStore,
  PostgresPendingNakhStore,
  runMigrations,
  type NakhDatabase,
} from '@nakh/persistence-postgres';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error('NAKH_TEST_DATABASE_URL is required for the M5 load smoke.');

const senderCount = Number(process.env.NAKH_M5_LOAD_SENDERS ?? '20');
const workersPerSender = Number(process.env.NAKH_M5_LOAD_WORKERS ?? '8');
if (!Number.isSafeInteger(senderCount) || senderCount < 10 || senderCount > 100)
  throw new Error('NAKH_M5_LOAD_SENDERS must be an integer between 10 and 100.');
if (!Number.isSafeInteger(workersPerSender) || workersPerSender < 2 || workersPerSender > 20)
  throw new Error('NAKH_M5_LOAD_WORKERS must be an integer between 2 and 20.');

const pendingPerSender = 5;
const expectedClosed = senderCount;
const expectedDelivered = senderCount * (pendingPerSender - 1);
const manGenderId = '20000000-0000-4000-8000-000000000001';
const everyonePreferenceId = '20000000-0000-4000-8000-000000000013';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';

type LoadUser = Readonly<{ userId: string; profileId: string }>;
type SenderFixture = Readonly<{
  sender: LoadUser;
  receivers: readonly LoadUser[];
  pendingNakhIds: readonly string[];
  triggerCreditTransactionId: string;
  causationId: string;
}>;

function pendingCommand(senderUserId: string, targetUserId: string): CreatePendingNakhCommand {
  return {
    commandId: randomUUID(),
    commandType: 'nakh.create-pending',
    schemaVersion: 1,
    actor: { kind: 'user', userId: senderUserId },
    requestId: randomUUID(),
    idempotencyKey: `m5-load-pending:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: {
      targetUserId,
      text: 'Synthetic M5 FIFO load fixture',
      autoSettleAuthorized: true,
    },
  };
}

function pendingWrite(command: CreatePendingNakhCommand): CreatePendingNakhWrite {
  return {
    command,
    flowId: randomUUID(),
    pendingNakhId: randomUUID(),
    pendingPaymentId: randomUUID(),
    flowEventId: randomUUID(),
    pendingEventId: randomUUID(),
  };
}

async function seedActiveUsers(
  database: NakhDatabase,
  count: number,
): Promise<readonly LoadUser[]> {
  const now = new Date();
  const users = Array.from({ length: count }, () => ({
    userId: randomUUID(),
    profileId: randomUUID(),
  }));
  await database
    .insertInto('identity.users')
    .values(
      users.map(({ userId }) => ({
        id: userId,
        last_activity_at: now,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await database
    .insertInto('identity.accounts')
    .values(
      users.map(({ userId }) => ({
        user_id: userId,
        state: 'active' as const,
        state_reason: null,
        state_changed_at: now,
      })),
    )
    .execute();
  await database
    .insertInto('identity.user_settings')
    .values(users.map(({ userId }) => ({ user_id: userId, created_at: now, updated_at: now })))
    .execute();
  await database
    .insertInto('billing.credit_accounts')
    .values(users.map(({ userId }) => ({ user_id: userId, created_at: now, updated_at: now })))
    .execute();
  await database
    .insertInto('notification.notification_preferences')
    .values(users.map(({ userId }) => ({ user_id: userId, created_at: now, updated_at: now })))
    .execute();
  await database
    .insertInto('profile.profiles')
    .values(
      users.map(({ userId, profileId }) => ({
        id: profileId,
        user_id: userId,
        name: 'Synthetic M5 load fixture',
        birth_year: now.getUTCFullYear() - 30,
        gender_option_id: manGenderId,
        gender_preference_id: everyonePreferenceId,
        relationship_goal_id: relationshipGoalId,
        country_id: countryId,
        province_id: provinceId,
        city_id: cityId,
        highlight: 'Synthetic M5 load fixture',
        bio: null,
        completion_status: 'complete' as const,
        ever_completed: true,
        completed_at: now,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  return users;
}

async function increaseCredits(
  database: NakhDatabase,
  senderUserId: string,
  amount: bigint,
): Promise<string> {
  const transactionId = randomUUID();
  const now = new Date();
  await database.transaction().execute(async (transaction) => {
    const account = await transaction
      .selectFrom('billing.credit_accounts')
      .select(['balance', 'version'])
      .where('user_id', '=', senderUserId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const balanceBefore = BigInt(account.balance);
    const balanceAfter = balanceBefore + amount;
    const version = account.version + 1;
    await transaction
      .insertInto('billing.credit_transactions')
      .values({
        id: transactionId,
        credit_account_id: senderUserId,
        user_id: senderUserId,
        account_version: version,
        transaction_type: 'admin_adjustment',
        amount: amount.toString(),
        balance_before: balanceBefore.toString(),
        balance_after: balanceAfter.toString(),
        payment_record_id: null,
        pending_payment_id: null,
        feature_unlock_id: null,
        nakh_id: null,
        idempotency_key: `m5-load-credit:${transactionId}`,
        correlation_id: transactionId,
        created_at: now,
      })
      .execute();
    await transaction
      .updateTable('billing.credit_accounts')
      .set({ balance: balanceAfter.toString(), version, updated_at: now })
      .where('user_id', '=', senderUserId)
      .where('version', '=', account.version)
      .executeTakeFirstOrThrow();
  });
  return transactionId;
}

await runMigrations(databaseUrl, resolve(process.cwd(), 'migrations'));
const database = createDatabase({
  url: databaseUrl,
  poolMax: 40,
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 20_000,
});

try {
  const users = await seedActiveUsers(database, senderCount * (pendingPerSender + 1));
  const pendingStore = new PostgresPendingNakhStore(database);
  const fixtures: SenderFixture[] = [];
  const setupStartedAt = performance.now();

  for (let senderIndex = 0; senderIndex < senderCount; senderIndex += 1) {
    const offset = senderIndex * (pendingPerSender + 1);
    const sender = users[offset]!;
    const receivers = users.slice(offset + 1, offset + pendingPerSender + 1);
    const created = await Promise.all(
      receivers.map((receiver) => {
        const command = pendingCommand(sender.userId, receiver.userId);
        return pendingStore.createPending(pendingWrite(command));
      }),
    );
    await database
      .updateTable('identity.accounts')
      .set({
        state: 'restricted',
        state_reason: 'synthetic_load_restriction',
        state_changed_at: new Date(),
        version: 2,
      })
      .where('user_id', '=', receivers[0]!.userId)
      .executeTakeFirstOrThrow();
    fixtures.push({
      sender,
      receivers,
      pendingNakhIds: created.map(({ pendingNakhId }) => pendingNakhId),
      triggerCreditTransactionId: await increaseCredits(database, sender.userId, 8n),
      causationId: randomUUID(),
    });
  }
  const setupDurationMs = Math.round(performance.now() - setupStartedAt);

  const settlement = new SettlePendingNakhesHandler(
    new PostgresPendingNakhSettlementStore(database),
    { uuid: randomUUID },
  );
  const settlementStartedAt = performance.now();
  const results = await Promise.all(
    fixtures.flatMap((fixture) =>
      Array.from({ length: workersPerSender }, () =>
        settlement.execute({
          senderUserId: fixture.sender.userId,
          triggerCreditTransactionId: fixture.triggerCreditTransactionId,
          causationId: fixture.causationId,
        }),
      ),
    ),
  );
  const settlementDurationMs = Math.round(performance.now() - settlementStartedAt);

  const senderIds = fixtures.map(({ sender }) => sender.userId);
  const receiverIds = fixtures.flatMap(({ receivers }) => receivers.map(({ userId }) => userId));
  const pendingNakhIds = fixtures.flatMap(({ pendingNakhIds }) => pendingNakhIds);
  const [pending, payments, delivered, spends, accounts, counters, notifications] =
    await Promise.all([
      database
        .selectFrom('nakh.pending_nakhes')
        .select(['id', 'status'])
        .where('id', 'in', pendingNakhIds)
        .execute(),
      database
        .selectFrom('billing.pending_payments')
        .select(['target_id', 'status'])
        .where('target_id', 'in', pendingNakhIds)
        .execute(),
      database
        .selectFrom('nakh.nakhes')
        .select(['id', 'sender_user_id', 'receiver_user_id'])
        .where('sender_user_id', 'in', senderIds)
        .execute(),
      database
        .selectFrom('billing.credit_transactions')
        .select('id')
        .where('user_id', 'in', senderIds)
        .where('transaction_type', '=', 'spend_nakh')
        .execute(),
      database
        .selectFrom('billing.credit_accounts')
        .select(['user_id', 'balance'])
        .where('user_id', 'in', senderIds)
        .execute(),
      database
        .selectFrom('platform.user_counters')
        .select(['user_id', 'pending_nakh_count'])
        .where('user_id', 'in', senderIds)
        .execute(),
      database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', 'in', receiverIds)
        .where('notification_type', '=', 'nakh_received')
        .execute(),
    ]);

  const closedCount = pending.filter(({ status }) => status === 'closed_by_system').length;
  const paidCount = pending.filter(({ status }) => status === 'paid_and_sent').length;
  const pendingPaymentCount = pending.filter(({ status }) => status === 'pending_payment').length;
  const cancelledPaymentCount = payments.filter(({ status }) => status === 'cancelled').length;
  const paidPaymentCount = payments.filter(({ status }) => status === 'paid').length;
  const resultClosedCount = results.reduce((total, result) => total + result.closedCount, 0);
  const resultDeliveredCount = results.reduce((total, result) => total + result.deliveredCount, 0);
  const invalidStop = results.some(
    ({ stopped }) => stopped === 'insufficient_credits' || stopped === 'external_funding',
  );
  const failures: string[] = [];
  if (closedCount !== expectedClosed || resultClosedCount !== expectedClosed)
    failures.push('invalid-oldest rows were not closed exactly once');
  if (paidCount !== expectedDelivered || resultDeliveredCount !== expectedDelivered)
    failures.push('eligible rows were not delivered exactly once');
  if (pendingPaymentCount !== 0) failures.push('the settled queues were not empty');
  if (cancelledPaymentCount !== expectedClosed || paidPaymentCount !== expectedDelivered)
    failures.push('payment intent terminal states do not match FIFO outcomes');
  if (
    delivered.length !== expectedDelivered ||
    spends.length !== expectedDelivered ||
    notifications.length !== expectedDelivered
  )
    failures.push('delivery, spend, or notification cardinality drifted');
  if (accounts.length !== senderCount || accounts.some(({ balance }) => balance !== '0'))
    failures.push('sender balances did not settle to zero');
  if (
    counters.length !== senderCount ||
    counters.some(({ pending_nakh_count: count }) => count !== 0)
  )
    failures.push('sender pending counters did not settle to zero');
  if (invalidStop) failures.push('a worker stopped before the funded FIFO queue was drained');
  if (settlementDurationMs > 30_000)
    failures.push('concurrent FIFO settlement exceeded its 30000 ms budget');

  const report = {
    scenario: 'ACC-024/M5-FIFO-CONCURRENCY-LOAD',
    senderCount,
    pendingCount: pendingNakhIds.length,
    workersPerSender,
    workerAttempts: results.length,
    closedCount,
    deliveredCount: delivered.length,
    spendCount: spends.length,
    notificationCount: notifications.length,
    setupDurationMs,
    settlementDurationMs,
    failures,
  };
  await mkdir(resolve(process.cwd(), 'artifacts'), { recursive: true });
  await writeFile(
    resolve(process.cwd(), 'artifacts/m5-load-smoke.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (failures.length > 0) throw new Error(`M5 load smoke failed: ${failures.join('; ')}.`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await database.destroy();
}
