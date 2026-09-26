import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { SendPredefinedQuestionCommand } from '@nakh/contracts';
import {
  createDatabase,
  PostgresChatStore,
  runMigrations,
  type NakhDatabase,
} from '@nakh/persistence-postgres';

import { roundRobinWork } from './load-smoke-order.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error('NAKH_TEST_DATABASE_URL is required for the M6 load smoke.');

const sessionCount = Number(process.env.NAKH_M6_LOAD_SESSIONS ?? '10');
const sendsPerSession = Number(process.env.NAKH_M6_LOAD_SENDS ?? '20');
if (!Number.isSafeInteger(sessionCount) || sessionCount < 5 || sessionCount > 50)
  throw new Error('NAKH_M6_LOAD_SESSIONS must be an integer between 5 and 50.');
if (!Number.isSafeInteger(sendsPerSession) || sendsPerSession < 20 || sendsPerSession > 100)
  throw new Error('NAKH_M6_LOAD_SENDS must be an integer between 20 and 100.');

type SessionFixture = Readonly<{
  firstUserId: string;
  secondUserId: string;
  firstLikeId: string;
  secondLikeId: string;
  matchId: string;
  chatSessionId: string;
}>;

type SendFixture = Readonly<{
  session: SessionFixture;
  command: SendPredefinedQuestionCommand;
  messageId: string;
  eventId: string;
}>;

type LoadPhase = 'setup' | 'first_send' | 'replay' | 'verification';

const artifactPath = resolve(process.cwd(), 'artifacts/m6-load-smoke.json');

async function writeArtifact(report: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(resolve(process.cwd(), 'artifacts'), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function safeFailureCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'unexpected_error';
  const code = String(error.code);
  const allowed = new Set([
    'chat_unavailable',
    'conflict',
    'idempotency_conflict',
    'dependency_unavailable',
    '40P01',
    '55P03',
    '57014',
    '53300',
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '57P01',
  ]);
  return allowed.has(code) ? code : 'unexpected_error';
}

function command(actorUserId: string, questionId: string): SendPredefinedQuestionCommand {
  return {
    commandId: randomUUID(),
    commandType: 'chat.send-predefined-question',
    schemaVersion: 1,
    actor: { kind: 'user', userId: actorUserId },
    requestId: randomUUID(),
    idempotencyKey: `m6-load-send:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: {
      chatActionToken: `v1.ch.${'a'.repeat(16)}.${'b'.repeat(16)}`,
      questionId,
    },
  };
}

async function seedSessions(
  database: NakhDatabase,
  fixtures: readonly SessionFixture[],
): Promise<void> {
  const now = new Date();
  const userIds = fixtures.flatMap(({ firstUserId, secondUserId }) => [firstUserId, secondUserId]);
  await database
    .insertInto('identity.users')
    .values(
      userIds.map((id) => ({
        id,
        last_activity_at: now,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await database
    .insertInto('identity.accounts')
    .values(
      userIds.map((userId) => ({
        user_id: userId,
        state: 'active' as const,
        state_reason: null,
        state_changed_at: now,
      })),
    )
    .execute();
  await database
    .insertInto('notification.notification_preferences')
    .values(userIds.map((userId) => ({ user_id: userId, created_at: now, updated_at: now })))
    .execute();

  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('interaction.likes')
      .values(
        fixtures.flatMap((fixture) => [
          {
            id: fixture.firstLikeId,
            sender_user_id: fixture.firstUserId,
            receiver_user_id: fixture.secondUserId,
            status: 'closed_by_match' as const,
            created_at: now,
            closed_at: now,
          },
          {
            id: fixture.secondLikeId,
            sender_user_id: fixture.secondUserId,
            receiver_user_id: fixture.firstUserId,
            status: 'closed_by_match' as const,
            created_at: now,
            closed_at: now,
          },
        ]),
      )
      .execute();
    await transaction
      .insertInto('interaction.user_pair_states')
      .values(
        fixtures.map((fixture) => ({
          user_low_id: fixture.firstUserId,
          user_high_id: fixture.secondUserId,
          state: 'matched' as const,
          reason_code: 'mutual_like',
          changed_at: now,
        })),
      )
      .execute();
    await transaction
      .insertInto('matching.matches')
      .values(
        fixtures.map((fixture) => ({
          id: fixture.matchId,
          user_low_id: fixture.firstUserId,
          user_high_id: fixture.secondUserId,
          source: 'mutual_like' as const,
          source_like_a_id: fixture.firstLikeId,
          source_like_b_id: fixture.secondLikeId,
          source_nakh_id: null,
          status: 'active' as const,
          created_at: now,
          closed_at: null,
        })),
      )
      .execute();
    await transaction
      .insertInto('matching.match_participants')
      .values(
        fixtures.flatMap((fixture) => [
          { match_id: fixture.matchId, user_id: fixture.firstUserId, joined_at: now },
          { match_id: fixture.matchId, user_id: fixture.secondUserId, joined_at: now },
        ]),
      )
      .execute();
    await transaction
      .insertInto('chat.chat_sessions')
      .values(
        fixtures.map((fixture) => ({
          id: fixture.chatSessionId,
          match_id: fixture.matchId,
          status: 'active' as const,
          created_at: now,
          closed_at: null,
          closed_reason: null,
        })),
      )
      .execute();
    await transaction
      .insertInto('chat.chat_participants')
      .values(
        fixtures.flatMap((fixture) => [
          { chat_session_id: fixture.chatSessionId, user_id: fixture.firstUserId },
          { chat_session_id: fixture.chatSessionId, user_id: fixture.secondUserId },
        ]),
      )
      .execute();
  });
}

await runMigrations(databaseUrl, resolve(process.cwd(), 'migrations'));
const database = createDatabase({
  url: databaseUrl,
  poolMax: 60,
  statementTimeoutMs: 60_000,
  lockTimeoutMs: 30_000,
});

let phase: LoadPhase = 'setup';
let artifactWritten = false;
try {
  const fixtures: SessionFixture[] = Array.from({ length: sessionCount }, () => {
    const [firstUserId, secondUserId] = [randomUUID(), randomUUID()].sort();
    return {
      firstUserId: firstUserId!,
      secondUserId: secondUserId!,
      firstLikeId: randomUUID(),
      secondLikeId: randomUUID(),
      matchId: randomUUID(),
      chatSessionId: randomUUID(),
    };
  });
  const setupStartedAt = performance.now();
  await seedSessions(database, fixtures);
  const question = await database
    .selectFrom('chat.predefined_questions')
    .select('id')
    .where('is_active', '=', true)
    .orderBy('id')
    .executeTakeFirstOrThrow();
  const sends: SendFixture[] = roundRobinWork(fixtures, sendsPerSession, (session, index) => ({
    session,
    command: command(index % 2 === 0 ? session.firstUserId : session.secondUserId, question.id),
    messageId: randomUUID(),
    eventId: randomUUID(),
  }));
  const setupDurationMs = Math.round(performance.now() - setupStartedAt);
  const store = new PostgresChatStore(database);

  phase = 'first_send';
  const sendStartedAt = performance.now();
  const results = await Promise.all(
    sends.map((send) =>
      store.sendPredefined({
        command: send.command,
        chatSessionId: send.session.chatSessionId,
        messageId: send.messageId,
        eventId: send.eventId,
      }),
    ),
  );
  const sendDurationMs = Math.round(performance.now() - sendStartedAt);

  phase = 'replay';
  const replayStartedAt = performance.now();
  const replays = await Promise.all(
    sends.map((send) =>
      store.sendPredefined({
        command: send.command,
        chatSessionId: send.session.chatSessionId,
        messageId: randomUUID(),
        eventId: randomUUID(),
      }),
    ),
  );
  const replayDurationMs = Math.round(performance.now() - replayStartedAt);

  phase = 'verification';
  const sessionIds = fixtures.map(({ chatSessionId }) => chatSessionId);
  const messageIds = sends.map(({ messageId }) => messageId);
  const [sessions, messages, notifications, deliveries, outbox] = await Promise.all([
    database
      .selectFrom('chat.chat_sessions')
      .select(['id', 'next_sequence_number'])
      .where('id', 'in', sessionIds)
      .execute(),
    database
      .selectFrom('chat.chat_messages')
      .select(['id', 'chat_session_id', 'sequence_number'])
      .where('chat_session_id', 'in', sessionIds)
      .execute(),
    database
      .selectFrom('notification.notifications')
      .select('id')
      .where('notification_type', '=', 'new_chat_message')
      .where('deduplication_key', 'like', 'chat-message:%')
      .where(
        'user_id',
        'in',
        fixtures.flatMap(({ firstUserId, secondUserId }) => [firstUserId, secondUserId]),
      )
      .execute(),
    database
      .selectFrom('notification.notification_deliveries as delivery')
      .innerJoin(
        'notification.notifications as notification',
        'notification.id',
        'delivery.notification_id',
      )
      .select('delivery.id')
      .where(
        'notification.user_id',
        'in',
        fixtures.flatMap(({ firstUserId, secondUserId }) => [firstUserId, secondUserId]),
      )
      .where('notification.notification_type', '=', 'new_chat_message')
      .execute(),
    database
      .selectFrom('platform.outbox_events')
      .select('id')
      .where('aggregate_type', '=', 'chat_message')
      .where('aggregate_id', 'in', messageIds)
      .execute(),
  ]);

  const expectedCount = sessionCount * sendsPerSession;
  const failures: string[] = [];
  if (results.length !== expectedCount || results.some(({ replayed }) => replayed))
    failures.push('distinct first sends did not each commit exactly once');
  if (replays.length !== expectedCount || replays.some(({ replayed }) => !replayed))
    failures.push('duplicate commands did not all replay');
  if (
    new Set(results.map(({ message }) => message.messageId)).size !== expectedCount ||
    replays.some(({ message }, index) => message.messageId !== results[index]!.message.messageId)
  )
    failures.push('message identity changed across concurrent send replay');
  for (const fixture of fixtures) {
    const sequences = messages
      .filter(({ chat_session_id }) => chat_session_id === fixture.chatSessionId)
      .map(({ sequence_number }) => Number(sequence_number))
      .sort((left, right) => left - right);
    if (
      sequences.length !== sendsPerSession ||
      sequences.some((sequence, index) => sequence !== index + 1)
    )
      failures.push('a session did not allocate one contiguous sequence per committed send');
  }
  if (
    sessions.length !== sessionCount ||
    sessions.some(
      ({ next_sequence_number }) => next_sequence_number !== String(sendsPerSession + 1),
    )
  )
    failures.push('a session allocator did not finish immediately after its committed maximum');
  if (
    messages.length !== expectedCount ||
    notifications.length !== expectedCount ||
    deliveries.length !== expectedCount ||
    outbox.length !== expectedCount
  )
    failures.push('message, notification, delivery, or outbox cardinality drifted');
  if (sendDurationMs > 30_000 || replayDurationMs > 30_000)
    failures.push('concurrent sends or replays exceeded the 30000 ms budget');

  const report = {
    scenario: 'M6-CONCURRENT-SEND-LOAD',
    completed: true,
    sessionCount,
    sendsPerSession,
    concurrentSendAttempts: sends.length,
    replayAttempts: replays.length,
    messageCount: messages.length,
    notificationCount: notifications.length,
    deliveryCount: deliveries.length,
    outboxCount: outbox.length,
    setupDurationMs,
    sendDurationMs,
    replayDurationMs,
    failures,
  };
  await writeArtifact(report);
  artifactWritten = true;
  if (failures.length > 0) throw new Error(`M6 load smoke failed: ${failures.join('; ')}.`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  if (!artifactWritten)
    await writeArtifact({
      scenario: 'M6-CONCURRENT-SEND-LOAD',
      completed: false,
      sessionCount,
      sendsPerSession,
      failurePhase: phase,
      failureCode: safeFailureCode(error),
      failures: ['load_phase_failed'],
    });
  throw error;
} finally {
  await database.destroy();
}
