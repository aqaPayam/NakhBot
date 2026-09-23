import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  analyzeM5QueryTables,
  createDatabase,
  explainM5Queries,
  runMigrations,
  type NakhDatabase,
  withM5SyntheticPlanSession,
} from '@nakh/persistence-postgres';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error('NAKH_TEST_DATABASE_URL is required for the M5 query-plan gate.');

const volume = Number(process.env.NAKH_M5_PLAN_VOLUME ?? '5000');
if (!Number.isSafeInteger(volume) || volume < 1_000 || volume > 50_000)
  throw new Error('NAKH_M5_PLAN_VOLUME must be an integer between 1000 and 50000.');

const batchSize = 250;
const dueCount = Math.max(100, Math.floor(volume / 50));
const dayMs = 24 * 60 * 60_000;
const now = new Date();
const expiredCreatedAt = new Date(now.getTime() - 15 * dayMs);
const reminderCreatedAt = new Date(now.getTime() - 3 * dayMs);
const freshCreatedAt = new Date(now.getTime() - 60 * 60_000);
const focalSenderId = randomUUID();
const focalReceiverId = randomUUID();
const reconciliationCursor = '80000000-0000-4000-8000-000000000000';

type PendingFixture = Readonly<{
  flowId: string;
  pendingNakhId: string;
  paymentId: string;
  receiverId: string;
  createdAt: Date;
  expiresAt: Date;
}>;

type DeliveredFixture = Readonly<{
  flowId: string;
  nakhId: string;
  creditTransactionId: string;
  historyId: string;
  senderId: string;
  sentAt: Date;
  expiresAt: Date;
}>;

function chunks<T>(values: readonly T[]): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize)
    result.push(values.slice(index, index + batchSize));
  return result;
}

function sha256Fixture(): string {
  return 'a'.repeat(64);
}

function planDocument(value: unknown): Readonly<Record<string, unknown>> {
  const candidate: unknown = Array.isArray(value) ? (value as readonly unknown[]).at(0) : value;
  if (candidate === null || typeof candidate !== 'object')
    throw new Error('M5 query plan did not return a JSON plan document.');
  return candidate as Readonly<Record<string, unknown>>;
}

function planFailure(name: string, value: unknown, requiredIndex: string): string | undefined {
  const document = planDocument(value);
  const executionTime = document['Execution Time'];
  if (typeof executionTime !== 'number' || executionTime > 1_500)
    return `${name} exceeded its 1500 ms execution budget.`;
  if (!JSON.stringify(document).includes(`"Index Name":"${requiredIndex}"`))
    return `${name} did not use ${requiredIndex}.`;
  return undefined;
}

async function seedFixtures(
  database: NakhDatabase,
  pending: readonly PendingFixture[],
  delivered: readonly DeliveredFixture[],
): Promise<void> {
  await withM5SyntheticPlanSession(database, async (connection) => {
    // These are synthetic cardinality fixtures. Disabling trigger execution on this dedicated
    // session avoids exercising lifecycle work already covered by the integration suite.
    const userIds = [
      ...new Set([
        focalSenderId,
        focalReceiverId,
        ...pending.map((fixture) => fixture.receiverId),
        ...delivered.map((fixture) => fixture.senderId),
      ]),
    ];
    for (const batch of chunks(userIds)) {
      await connection
        .insertInto('identity.users')
        .values(
          batch.map((id) => ({
            id,
            last_activity_at: now,
            created_at: now,
            updated_at: now,
          })),
        )
        .execute();
      await connection
        .insertInto('platform.user_counters')
        .values(batch.map((userId) => ({ user_id: userId })))
        .execute();
    }

    for (const batch of chunks(pending)) {
      await connection
        .insertInto('nakh.nakh_flows')
        .values(
          batch.map((fixture) => ({
            id: fixture.flowId,
            sender_user_id: focalSenderId,
            receiver_user_id: fixture.receiverId,
            created_at: fixture.createdAt,
          })),
        )
        .execute();
      await connection
        .insertInto('billing.pending_payments')
        .values(
          batch.map((fixture) => ({
            id: fixture.paymentId,
            user_id: focalSenderId,
            reason: 'send_nakh' as const,
            target_type: 'pending_nakh' as const,
            target_id: fixture.pendingNakhId,
            funding_type: 'telegram_stars' as const,
            required_credits: null,
            required_stars: '2',
            package_code_snapshot: null,
            package_credit_amount_snapshot: null,
            status: 'pending' as const,
            idempotency_key: `m5-plan-payment:${fixture.paymentId}`,
            request_hash: sha256Fixture(),
            created_at: fixture.createdAt,
            expires_at: fixture.expiresAt,
            resolved_at: null,
          })),
        )
        .execute();
      await connection
        .insertInto('nakh.pending_nakhes')
        .values(
          batch.map((fixture) => ({
            id: fixture.pendingNakhId,
            nakh_flow_id: fixture.flowId,
            sender_user_id: focalSenderId,
            text: 'Synthetic M5 plan fixture',
            status: 'pending_payment' as const,
            pending_payment_id: fixture.paymentId,
            auto_settle_authorized_at: fixture.createdAt,
            authorization_source: 'explore' as const,
            authorized_at: fixture.createdAt,
            created_at: fixture.createdAt,
            expires_at: fixture.expiresAt,
            paid_at: null,
            cancelled_at: null,
            expired_at: null,
            closed_at: null,
            cancel_resolution: null,
            reminder_count: 0,
            last_reminder_at: null,
            idempotency_key: `m5-plan-pending:${fixture.pendingNakhId}`,
            request_hash: sha256Fixture(),
          })),
        )
        .execute();
    }

    for (const batch of chunks(delivered)) {
      await connection
        .insertInto('nakh.nakh_flows')
        .values(
          batch.map((fixture) => ({
            id: fixture.flowId,
            sender_user_id: fixture.senderId,
            receiver_user_id: focalReceiverId,
            created_at: fixture.sentAt,
          })),
        )
        .execute();
      await connection
        .insertInto('nakh.nakhes')
        .values(
          batch.map((fixture) => ({
            id: fixture.nakhId,
            nakh_flow_id: fixture.flowId,
            sender_user_id: fixture.senderId,
            receiver_user_id: focalReceiverId,
            text: 'Synthetic M5 plan fixture',
            funding_type: 'credits' as const,
            credit_transaction_id: fixture.creditTransactionId,
            payment_record_id: null,
            status: 'sent' as const,
            sent_at: fixture.sentAt,
            expires_at: fixture.expiresAt,
            seen_at: null,
            accepted_at: null,
            rejected_at: null,
            expired_at: null,
            closed_at: null,
          })),
        )
        .execute();
      await connection
        .insertInto('nakh.nakh_status_history')
        .values(
          batch.map((fixture) => ({
            id: fixture.historyId,
            nakh_id: fixture.nakhId,
            nakh_version: 1,
            from_status: null,
            to_status: 'sent' as const,
            reason_code: 'synthetic_plan_fixture',
            changed_by_user_id: fixture.senderId,
            request_id: randomUUID(),
            changed_at: fixture.sentAt,
          })),
        )
        .execute();
    }
  });
}

await runMigrations(databaseUrl, resolve(process.cwd(), 'migrations'));
const database = createDatabase({
  url: databaseUrl,
  poolMax: 10,
  statementTimeoutMs: 60_000,
  lockTimeoutMs: 10_000,
});

try {
  const pending: PendingFixture[] = Array.from({ length: volume }, (_, index) => {
    const createdAt =
      index < dueCount
        ? expiredCreatedAt
        : index < dueCount * 2
          ? reminderCreatedAt
          : freshCreatedAt;
    return {
      flowId: randomUUID(),
      pendingNakhId: randomUUID(),
      paymentId: randomUUID(),
      receiverId: index === 0 ? focalReceiverId : randomUUID(),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 14 * dayMs),
    };
  });
  const delivered: DeliveredFixture[] = Array.from({ length: volume }, (_, index) => {
    const sentAt = index < dueCount ? expiredCreatedAt : freshCreatedAt;
    return {
      flowId: randomUUID(),
      nakhId: randomUUID(),
      creditTransactionId: randomUUID(),
      historyId: randomUUID(),
      senderId: randomUUID(),
      sentAt,
      expiresAt: new Date(sentAt.getTime() + 14 * dayMs),
    };
  });
  await seedFixtures(database, pending, delivered);
  await analyzeM5QueryTables(database);
  const plans = await explainM5Queries(database, {
    senderUserId: focalSenderId,
    receiverUserId: pending[0]!.receiverId,
    afterCreatedAt: new Date(freshCreatedAt.getTime() + 1),
    afterPendingNakhId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    afterSentAt: new Date(freshCreatedAt.getTime() + 1),
    afterNakhId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    reconciliationCursor,
  });
  const requirements = {
    flowLookup: 'nakh_flows_sender_user_id_receiver_user_id_key',
    settlementFifo: 'pending_nakhes_sender_fifo_idx',
    pendingSenderPage: 'pending_nakhes_sender_fifo_idx',
    receivedInbox: 'nakhes_receiver_inbox_idx',
    sentStatusPage: 'nakhes_sender_status_idx',
    pendingExpiry: 'pending_nakhes_expiry_idx',
    pendingReminder: 'pending_nakhes_reminder_idx',
    deliveredExpiry: 'nakhes_expiry_idx',
    flowReconciliation: 'nakh_flows_pkey',
    counterReconciliation: 'user_counters_pkey',
    pendingReconciliation: 'pending_nakhes_pkey',
    deliveredReconciliation: 'nakhes_pkey',
  } as const;
  const artifact = {
    schemaVersion: 1,
    fixture: { pendingRows: volume, deliveredRows: volume, dueRowsPerLifecycle: dueCount },
    maximumExecutionMs: 1_500,
    requiredIndexes: requirements,
    plans,
  };
  await mkdir(resolve(process.cwd(), 'artifacts'), { recursive: true });
  await writeFile(
    resolve(process.cwd(), 'artifacts/m5-query-plans.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  );
  const failures = Object.entries(requirements).flatMap(([name, requiredIndex]) => {
    const failure = planFailure(name, plans[name], requiredIndex);
    return failure === undefined ? [] : [failure];
  });
  if (failures.length > 0) throw new Error(`M5 query-plan gate failed: ${failures.join(' ')}`);
  process.stdout.write(
    `${JSON.stringify({ scenario: 'M5-PRODUCTION-QUERY-PLAN', volume, dueCount, queries: Object.keys(requirements) })}\n`,
  );
} finally {
  await database.destroy();
}
