import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  analyzeM6QueryTables,
  createDatabase,
  explainM6Queries,
  runMigrations,
  type NakhDatabase,
  withM6SyntheticPlanSession,
} from '@nakh/persistence-postgres';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error('NAKH_TEST_DATABASE_URL is required for the M6 query-plan gate.');

const volume = Number(process.env.NAKH_M6_PLAN_VOLUME ?? '5000');
if (!Number.isSafeInteger(volume) || volume < 1_000 || volume > 20_000)
  throw new Error('NAKH_M6_PLAN_VOLUME must be an integer between 1000 and 20000.');

const batchSize = 250;
const now = new Date();
const old = new Date(now.getTime() - 60 * 60_000);
const orderedUserIds = [randomUUID(), randomUUID()].sort();
const userLowId = orderedUserIds[0]!;
const userHighId = orderedUserIds[1]!;
const sourceLikeAId = randomUUID();
const sourceLikeBId = randomUUID();
const matchId = randomUUID();
const chatSessionId = randomUUID();
const reconciliationCursor = '00000000-0000-4000-8000-000000000001';

type MessageFixture = Readonly<{ id: string; sequenceNumber: string }>;
type DeliveryFixture = Readonly<{
  notificationId: string;
  deliveryId: string;
  expiredCall: boolean;
}>;
type SnapshotFixture = Readonly<{
  reportId: string;
  messageId: string;
}>;

function chunks<T>(values: readonly T[]): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize)
    result.push(values.slice(index, index + batchSize));
  return result;
}

function planDocument(value: unknown): Readonly<Record<string, unknown>> {
  const candidate: unknown = Array.isArray(value) ? (value as readonly unknown[]).at(0) : value;
  if (candidate === null || typeof candidate !== 'object')
    throw new Error('M6 query plan did not return a JSON plan document.');
  return candidate as Readonly<Record<string, unknown>>;
}

function planFailure(name: string, value: unknown, requiredIndex?: string): string | undefined {
  const document = planDocument(value);
  const executionTime = document['Execution Time'];
  if (typeof executionTime !== 'number' || executionTime > 1_500)
    return `${name} exceeded its 1500 ms execution budget.`;
  if (
    requiredIndex !== undefined &&
    !JSON.stringify(document).includes(`"Index Name":"${requiredIndex}"`)
  )
    return `${name} did not use ${requiredIndex}.`;
  return undefined;
}

async function seedFixtures(
  database: NakhDatabase,
  messages: readonly MessageFixture[],
  deliveries: readonly DeliveryFixture[],
  snapshots: readonly SnapshotFixture[],
): Promise<void> {
  await withM6SyntheticPlanSession(database, async (connection) => {
    await connection
      .insertInto('identity.users')
      .values([
        { id: userLowId, last_activity_at: now, created_at: now, updated_at: now },
        { id: userHighId, last_activity_at: now, created_at: now, updated_at: now },
      ])
      .execute();
    await connection
      .insertInto('interaction.likes')
      .values([
        {
          id: sourceLikeAId,
          sender_user_id: userLowId,
          receiver_user_id: userHighId,
          status: 'closed_by_match',
          created_at: old,
          closed_at: old,
        },
        {
          id: sourceLikeBId,
          sender_user_id: userHighId,
          receiver_user_id: userLowId,
          status: 'closed_by_match',
          created_at: old,
          closed_at: old,
        },
      ])
      .execute();
    await connection
      .insertInto('matching.matches')
      .values({
        id: matchId,
        user_low_id: userLowId,
        user_high_id: userHighId,
        source: 'mutual_like',
        source_like_a_id: sourceLikeAId,
        source_like_b_id: sourceLikeBId,
        source_nakh_id: null,
        status: 'active',
        created_at: old,
        closed_at: null,
      })
      .execute();
    await connection
      .insertInto('matching.match_participants')
      .values([
        { match_id: matchId, user_id: userLowId, joined_at: old },
        { match_id: matchId, user_id: userHighId, joined_at: old },
      ])
      .execute();
    await connection
      .insertInto('chat.chat_sessions')
      .values({
        id: chatSessionId,
        match_id: matchId,
        status: 'active',
        next_sequence_number: String(messages.length + 1),
        created_at: old,
        closed_at: null,
        closed_reason: null,
      })
      .execute();
    await connection
      .insertInto('chat.chat_participants')
      .values([
        { chat_session_id: chatSessionId, user_id: userLowId },
        { chat_session_id: chatSessionId, user_id: userHighId },
      ])
      .execute();

    for (const batch of chunks(messages))
      await connection
        .insertInto('chat.chat_messages')
        .values(
          batch.map((message, index) => ({
            id: message.id,
            chat_session_id: chatSessionId,
            sender_user_id: Number(message.sequenceNumber) % 2 === 0 ? userLowId : userHighId,
            message_type: 'text' as const,
            text: 'Synthetic M6 query-plan fixture',
            predefined_question_id: null,
            predefined_answer_id: null,
            system_arguments: null,
            sequence_number: message.sequenceNumber,
            created_at: new Date(old.getTime() + index),
          })),
        )
        .execute();

    for (const batch of chunks(deliveries)) {
      await connection
        .insertInto('notification.notifications')
        .values(
          batch.map((fixture) => ({
            id: fixture.notificationId,
            user_id: userHighId,
            notification_type: 'new_chat_message' as const,
            category: 'chat' as const,
            title_key: 'notification.new_chat_message.title',
            body_key: 'notification.new_chat_message.body',
            payload: { chatSessionId, messageId: messages[0]!.id },
            status: 'unread' as const,
            deduplication_key: `m6-plan:${fixture.notificationId}`,
            created_at: old,
            read_at: null,
          })),
        )
        .execute();
      await connection
        .insertInto('notification.notification_deliveries')
        .values(
          batch.map((fixture) => ({
            id: fixture.deliveryId,
            notification_id: fixture.notificationId,
            channel: 'telegram' as const,
            status: 'pending' as const,
            attempt_number: fixture.expiredCall ? 1 : 0,
            next_attempt_at: old,
            sent_at: null,
            failed_at: null,
            failure_code: null,
            provider_delivery_key: null,
            provider_progress: fixture.expiredCall
              ? ('call_started' as const)
              : ('not_started' as const),
            lease_owner: fixture.expiredCall ? 'm6-plan-worker' : null,
            lease_expires_at: fixture.expiredCall ? old : null,
            fence_token: fixture.expiredCall ? '1' : '0',
            quarantined_at: null,
            created_at: old,
            updated_at: old,
          })),
        )
        .execute();
    }

    for (const batch of chunks(snapshots))
      await connection
        .insertInto('chat.chat_message_snapshot_requests')
        .values(
          batch.map((fixture) => ({
            report_id: fixture.reportId,
            chat_session_id: chatSessionId,
            original_message_id: fixture.messageId,
            requested_at: old,
            captured_at: null,
          })),
        )
        .execute();
  });
}

async function deleteFixtures(database: NakhDatabase): Promise<void> {
  await withM6SyntheticPlanSession(database, async (connection) => {
    await connection
      .deleteFrom('chat.chat_message_snapshot_requests')
      .where('chat_session_id', '=', chatSessionId)
      .execute();
    await connection
      .deleteFrom('notification.notification_deliveries')
      .where(
        'notification_id',
        'in',
        connection
          .selectFrom('notification.notifications')
          .select('id')
          .where('deduplication_key', 'like', 'm6-plan:%'),
      )
      .execute();
    await connection
      .deleteFrom('notification.notifications')
      .where('deduplication_key', 'like', 'm6-plan:%')
      .execute();
    await connection
      .deleteFrom('chat.chat_messages')
      .where('chat_session_id', '=', chatSessionId)
      .execute();
    await connection
      .deleteFrom('chat.chat_participants')
      .where('chat_session_id', '=', chatSessionId)
      .execute();
    await connection.deleteFrom('chat.chat_sessions').where('id', '=', chatSessionId).execute();
    await connection
      .deleteFrom('matching.match_participants')
      .where('match_id', '=', matchId)
      .execute();
    await connection.deleteFrom('matching.matches').where('id', '=', matchId).execute();
    await connection
      .deleteFrom('interaction.likes')
      .where('id', 'in', [sourceLikeAId, sourceLikeBId])
      .execute();
    await connection
      .deleteFrom('identity.users')
      .where('id', 'in', [userLowId, userHighId])
      .execute();
  });
}

await runMigrations(databaseUrl, resolve(process.cwd(), 'migrations'));
const database = createDatabase({
  url: databaseUrl,
  poolMax: 10,
  statementTimeoutMs: 60_000,
  lockTimeoutMs: 10_000,
});
const messages: MessageFixture[] = Array.from({ length: volume }, (_, index) => ({
  id: randomUUID(),
  sequenceNumber: String(index + 1),
}));
const deliveries: DeliveryFixture[] = Array.from({ length: volume }, (_, index) => ({
  notificationId: randomUUID(),
  deliveryId: randomUUID(),
  expiredCall: index >= Math.floor(volume / 2),
}));
const snapshots: SnapshotFixture[] = messages.slice(0, Math.min(volume, 1_000)).map((message) => ({
  reportId: randomUUID(),
  messageId: message.id,
}));

try {
  await seedFixtures(database, messages, deliveries, snapshots);
  await analyzeM6QueryTables(database);
  const plans = await explainM6Queries(database, {
    chatSessionId,
    beforeSequenceNumber: String(volume + 1),
    reconciliationCursor,
  });
  const requirements: Readonly<Record<string, string | undefined>> = {
    historyPage: 'chat_messages_session_page_idx',
    sessionCleanup: 'chat_messages_session_page_idx',
    cleanupCandidates: undefined,
    dueDeliveryClaim: 'notification_deliveries_due_claim_idx',
    expiredCallLease: 'notification_deliveries_expired_call_idx',
    pendingSnapshots: 'chat_snapshot_requests_pending_idx',
    sessionReconciliation: undefined,
    messageReconciliation: 'chat_messages_pkey',
    unmatchReconciliation: undefined,
    deliveryReconciliation: 'notification_deliveries_pkey',
  };
  const artifact = {
    schemaVersion: 1,
    fixture: {
      messageRows: messages.length,
      notificationDeliveryRows: deliveries.length,
      pendingSnapshotRows: snapshots.length,
    },
    maximumExecutionMs: 1_500,
    requiredIndexes: requirements,
    plans,
  };
  await mkdir(resolve(process.cwd(), 'artifacts'), { recursive: true });
  await writeFile(
    resolve(process.cwd(), 'artifacts/m6-query-plans.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  );
  const failures = Object.entries(requirements).flatMap(([name, requiredIndex]) => {
    const failure = planFailure(name, plans[name], requiredIndex);
    return failure === undefined ? [] : [failure];
  });
  if (failures.length > 0) throw new Error(`M6 query-plan gate failed: ${failures.join(' ')}`);
  process.stdout.write(
    `${JSON.stringify({ scenario: 'M6-PRODUCTION-QUERY-PLAN', volume, queries: Object.keys(requirements) })}\n`,
  );
} finally {
  try {
    await deleteFixtures(database);
  } finally {
    await database.destroy();
  }
}
