import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  CaptureReportedMessagesCommand,
  ChangeChatMuteCommand,
  CleanupChatCommand,
  MarkChatReadCommand,
  SendPredefinedAnswerCommand,
  SendPredefinedQuestionCommand,
  SendTextMessageCommand,
  UnmatchCommand,
} from '@nakh/contracts';

import { PostgresChatRetentionStore } from './chat-retention-store.js';
import { PostgresChatStore } from './chat-store.js';
import { PostgresChatStateStore } from './chat-state-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresPaidActionStore } from './paid-action-store.js';
import { PostgresUnmatchStore } from './unmatch-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

type ChatFixture = Readonly<{
  firstUserId: string;
  secondUserId: string;
  matchId: string;
  chatSessionId: string;
}>;

async function createUser(database: NakhDatabase): Promise<string> {
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
    .insertInto('notification.notification_preferences')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('billing.credit_accounts')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  return userId;
}

function questionCommand(
  actorUserId: string,
  questionId: string,
  idempotencyKey = `chat-question:${randomUUID()}`,
): SendPredefinedQuestionCommand {
  return {
    commandId: randomUUID(),
    commandType: 'chat.send-predefined-question',
    schemaVersion: 1,
    actor: { kind: 'user', userId: actorUserId },
    requestId: randomUUID(),
    idempotencyKey,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: {
      chatActionToken: `v1.ch.${'a'.repeat(16)}.${'b'.repeat(16)}`,
      questionId,
    },
  };
}

function answerCommand(
  actorUserId: string,
  questionId: string,
  answerId: string,
): SendPredefinedAnswerCommand {
  return {
    commandId: randomUUID(),
    commandType: 'chat.send-predefined-answer',
    schemaVersion: 1,
    actor: { kind: 'user', userId: actorUserId },
    requestId: randomUUID(),
    idempotencyKey: `chat-answer:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: {
      chatActionToken: `v1.ch.${'c'.repeat(16)}.${'d'.repeat(16)}`,
      questionId,
      answerId,
    },
  };
}

function textCommand(actorUserId: string): SendTextMessageCommand {
  return {
    commandId: randomUUID(),
    commandType: 'chat.send-text',
    schemaVersion: 1,
    actor: { kind: 'user', userId: actorUserId },
    requestId: randomUUID(),
    idempotencyKey: `chat-text:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: {
      chatActionToken: `v1.ch.${'e'.repeat(16)}.${'f'.repeat(16)}`,
      text: 'Café\nhello',
    },
  };
}

function markReadCommand(actorUserId: string, sequenceNumber: string): MarkChatReadCommand {
  return {
    commandId: randomUUID(),
    commandType: 'chat.mark-read',
    schemaVersion: 1,
    actor: { kind: 'user', userId: actorUserId },
    requestId: randomUUID(),
    idempotencyKey: `chat-read:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: {
      chatActionToken: `v1.ch.${'g'.repeat(16)}.${'h'.repeat(16)}`,
      throughSequenceNumber: sequenceNumber,
    },
  };
}

function muteCommand(
  actorUserId: string,
  muted: boolean,
  expectedVersion: number,
): ChangeChatMuteCommand {
  return {
    commandId: randomUUID(),
    commandType: 'chat.change-mute',
    schemaVersion: 1,
    actor: { kind: 'user', userId: actorUserId },
    requestId: randomUUID(),
    idempotencyKey: `chat-mute:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: {
      chatActionToken: `v1.ch.${'i'.repeat(16)}.${'j'.repeat(16)}`,
      muted,
      expectedVersion,
    },
  };
}

function unmatchCommand(actorUserId: string): UnmatchCommand {
  return {
    commandId: randomUUID(),
    commandType: 'matching.unmatch',
    schemaVersion: 1,
    actor: { kind: 'user', userId: actorUserId },
    requestId: randomUUID(),
    idempotencyKey: `unmatch:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: {
      matchActionToken: `v1.mt.${'k'.repeat(16)}.${'l'.repeat(16)}`,
      reasonCode: 'not_a_fit',
    },
  };
}

function captureMessagesCommand(
  reportId: string,
  chatSessionId: string,
  messageIds: readonly string[],
): CaptureReportedMessagesCommand {
  return {
    commandId: randomUUID(),
    commandType: 'chat.capture-reported-messages',
    schemaVersion: 1,
    actor: { kind: 'system', userId: '00000000-0000-4000-8000-000000000001' },
    requestId: randomUUID(),
    idempotencyKey: `chat-snapshot:${reportId}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { reportId, chatSessionId, messageIds: [...messageIds] },
  };
}

function cleanupChatCommand(chatSessionId: string): CleanupChatCommand {
  return {
    commandId: randomUUID(),
    commandType: 'chat.cleanup',
    schemaVersion: 1,
    actor: { kind: 'system', userId: '00000000-0000-4000-8000-000000000001' },
    requestId: randomUUID(),
    idempotencyKey: `chat-cleanup:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { chatSessionId, deleteBatchSize: 100 },
  };
}

async function createChatFixture(database: NakhDatabase): Promise<ChatFixture> {
  const users = [await createUser(database), await createUser(database)].sort();
  const firstUserId = users[0]!;
  const secondUserId = users[1]!;
  const firstLikeId = randomUUID();
  const secondLikeId = randomUUID();
  const matchId = randomUUID();
  const chatSessionId = randomUUID();
  const now = new Date();

  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('interaction.likes')
      .values([
        {
          id: firstLikeId,
          sender_user_id: firstUserId,
          receiver_user_id: secondUserId,
          status: 'closed_by_match',
          created_at: now,
          closed_at: now,
        },
        {
          id: secondLikeId,
          sender_user_id: secondUserId,
          receiver_user_id: firstUserId,
          status: 'closed_by_match',
          created_at: now,
          closed_at: now,
        },
      ])
      .execute();
    await transaction
      .insertInto('interaction.user_pair_states')
      .values({
        user_low_id: firstUserId,
        user_high_id: secondUserId,
        state: 'matched',
        reason_code: 'mutual_like',
        changed_at: now,
      })
      .execute();
    await transaction
      .insertInto('matching.matches')
      .values({
        id: matchId,
        user_low_id: firstUserId,
        user_high_id: secondUserId,
        source: 'mutual_like',
        source_like_a_id: firstLikeId,
        source_like_b_id: secondLikeId,
        source_nakh_id: null,
        status: 'active',
        created_at: now,
        closed_at: null,
      })
      .execute();
    await transaction
      .insertInto('matching.match_participants')
      .values([
        { match_id: matchId, user_id: firstUserId, joined_at: now },
        { match_id: matchId, user_id: secondUserId, joined_at: now },
      ])
      .execute();
    await transaction
      .insertInto('chat.chat_sessions')
      .values({
        id: chatSessionId,
        match_id: matchId,
        status: 'active',
        created_at: now,
        closed_at: null,
        closed_reason: null,
      })
      .execute();
    await transaction
      .insertInto('chat.chat_participants')
      .values([
        {
          chat_session_id: chatSessionId,
          user_id: firstUserId,
          last_read_at: null,
          last_read_sequence_number: null,
          muted_at: null,
          unlock_safety_warning_shown_at: null,
        },
        {
          chat_session_id: chatSessionId,
          user_id: secondUserId,
          last_read_at: null,
          last_read_sequence_number: null,
          muted_at: null,
          unlock_safety_warning_shown_at: null,
        },
      ])
      .execute();
  });
  return { firstUserId, secondUserId, matchId, chatSessionId };
}

async function reserveAndInsert(
  database: NakhDatabase,
  input: Readonly<{
    chatSessionId: string;
    senderUserId: string;
    messageId: string;
    messageType: 'predefined_question' | 'predefined_answer';
    sequenceNumber: string;
    questionId?: string;
    answerId?: string;
  }>,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const session = await transaction
      .selectFrom('chat.chat_sessions')
      .select(['next_sequence_number', 'version'])
      .where('id', '=', input.chatSessionId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    expect(session.next_sequence_number).toBe(input.sequenceNumber);
    await transaction
      .updateTable('chat.chat_sessions')
      .set({
        next_sequence_number: String(BigInt(input.sequenceNumber) + 1n),
        version: session.version + 1,
      })
      .where('id', '=', input.chatSessionId)
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto('chat.chat_messages')
      .values({
        id: input.messageId,
        chat_session_id: input.chatSessionId,
        sender_user_id: input.senderUserId,
        message_type: input.messageType,
        text: null,
        predefined_question_id: input.questionId ?? null,
        predefined_answer_id: input.answerId ?? null,
        system_arguments: null,
        sequence_number: input.sequenceNumber,
      })
      .execute();
  });
}

describe.skipIf(databaseUrl === undefined)('M6 chat catalog and message foundation', () => {
  let database: NakhDatabase;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 20,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('installs the ten canonical prompt sets with one question and 4–5 owned answers', async () => {
    const rows = await database
      .selectFrom('chat.predefined_question_sets as question_set')
      .innerJoin(
        'chat.predefined_questions as question',
        'question.question_set_id',
        'question_set.id',
      )
      .innerJoin('chat.predefined_answers as answer', 'answer.question_id', 'question.id')
      .select(['question_set.code as set_code', 'question.id as question_id'])
      .select((expression) => expression.fn.count('answer.id').as('answer_count'))
      .where('question_set.is_active', '=', true)
      .where('question.is_active', '=', true)
      .where('answer.is_active', '=', true)
      .groupBy(['question_set.code', 'question.id', 'question_set.display_order'])
      .orderBy('question_set.display_order')
      .execute();

    expect(rows.map((row) => row.set_code)).toEqual([
      'relationship_intent',
      'ideal_first_date',
      'chat_frequency',
      'social_energy',
      'weekend_habits',
      'calls_or_texting',
      'important_values',
      'meeting_in_person',
      'relationship_pace',
      'current_life_focus',
    ]);
    expect(rows.map((row) => Number(row.answer_count))).toEqual([5, 5, 4, 5, 5, 5, 5, 4, 4, 5]);
    expect(new Set(rows.map((row) => row.question_id)).size).toBe(10);
  });

  it('allocates immutable typed messages and advances participant read state monotonically', async () => {
    const fixture = await createChatFixture(database);
    const question = await database
      .selectFrom('chat.predefined_question_sets as question_set')
      .innerJoin(
        'chat.predefined_questions as question',
        'question.question_set_id',
        'question_set.id',
      )
      .select('question.id')
      .where('question_set.code', '=', 'relationship_intent')
      .executeTakeFirstOrThrow();
    const answer = await database
      .selectFrom('chat.predefined_answers')
      .select('id')
      .where('question_id', '=', question.id)
      .orderBy('display_order')
      .executeTakeFirstOrThrow();
    const questionMessageId = randomUUID();
    const answerMessageId = randomUUID();

    await reserveAndInsert(database, {
      chatSessionId: fixture.chatSessionId,
      senderUserId: fixture.firstUserId,
      messageId: questionMessageId,
      messageType: 'predefined_question',
      sequenceNumber: '1',
      questionId: question.id,
    });
    await reserveAndInsert(database, {
      chatSessionId: fixture.chatSessionId,
      senderUserId: fixture.secondUserId,
      messageId: answerMessageId,
      messageType: 'predefined_answer',
      sequenceNumber: '2',
      answerId: answer.id,
    });

    const readAt = new Date();
    await database
      .updateTable('chat.chat_participants')
      .set({ last_read_at: readAt, last_read_sequence_number: '2', version: 2 })
      .where('chat_session_id', '=', fixture.chatSessionId)
      .where('user_id', '=', fixture.firstUserId)
      .executeTakeFirstOrThrow();

    const messages = await database
      .selectFrom('chat.chat_messages')
      .select(['id', 'message_type', 'sequence_number'])
      .where('chat_session_id', '=', fixture.chatSessionId)
      .orderBy('sequence_number')
      .execute();
    expect(messages).toEqual([
      {
        id: questionMessageId,
        message_type: 'predefined_question',
        sequence_number: '1',
      },
      { id: answerMessageId, message_type: 'predefined_answer', sequence_number: '2' },
    ]);
    await expect(
      database
        .updateTable('chat.chat_messages')
        .set({ text: 'forged mutation' })
        .where('id', '=', questionMessageId)
        .execute(),
    ).rejects.toThrow(/immutable/u);
  });

  it('rejects unreserved sequence gaps, nonparticipants, and read cursors past committed history', async () => {
    const fixture = await createChatFixture(database);
    const question = await database
      .selectFrom('chat.predefined_questions')
      .select('id')
      .where('is_active', '=', true)
      .orderBy('display_order')
      .executeTakeFirstOrThrow();

    await expect(
      database.transaction().execute(async (transaction) => {
        await transaction
          .updateTable('chat.chat_sessions')
          .set({ next_sequence_number: '2', version: 2 })
          .where('id', '=', fixture.chatSessionId)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('chat.chat_messages')
          .values({
            id: randomUUID(),
            chat_session_id: fixture.chatSessionId,
            sender_user_id: fixture.firstUserId,
            message_type: 'predefined_question',
            text: null,
            predefined_question_id: question.id,
            predefined_answer_id: null,
            system_arguments: null,
            sequence_number: '2',
          })
          .execute();
      }),
    ).rejects.toThrow(/sequence/u);

    const outsiderId = await createUser(database);
    await expect(
      database.transaction().execute(async (transaction) => {
        await transaction
          .updateTable('chat.chat_sessions')
          .set({ next_sequence_number: '2', version: 2 })
          .where('id', '=', fixture.chatSessionId)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('chat.chat_messages')
          .values({
            id: randomUUID(),
            chat_session_id: fixture.chatSessionId,
            sender_user_id: outsiderId,
            message_type: 'predefined_question',
            text: null,
            predefined_question_id: question.id,
            predefined_answer_id: null,
            system_arguments: null,
            sequence_number: '1',
          })
          .execute();
      }),
    ).rejects.toThrow();

    await expect(
      database
        .updateTable('chat.chat_participants')
        .set({
          last_read_at: new Date(),
          last_read_sequence_number: '1',
          version: 2,
        })
        .where('chat_session_id', '=', fixture.chatSessionId)
        .where('user_id', '=', fixture.firstUserId)
        .execute(),
    ).rejects.toThrow(/read sequence/u);
  });

  it('deduplicates predefined sends and records one message plus recipient notification', async () => {
    const fixture = await createChatFixture(database);
    const question = await database
      .selectFrom('chat.predefined_questions')
      .select(['id', 'text_key'])
      .where('is_active', '=', true)
      .orderBy('id')
      .executeTakeFirstOrThrow();
    const command = questionCommand(fixture.firstUserId, question.id);
    const store = new PostgresChatStore(database);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.sendPredefined({
          command,
          chatSessionId: fixture.chatSessionId,
          messageId: randomUUID(),
          eventId: randomUUID(),
        }),
      ),
    );
    expect(new Set(results.map((result) => result.message.messageId)).size).toBe(1);
    expect(new Set(results.map((result) => result.message.sequenceNumber))).toEqual(new Set(['1']));
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results[0]!.message).toMatchObject({
      sender: 'self',
      messageType: 'predefined_question',
      content: { questionId: question.id, textKey: question.text_key },
    });

    const messageId = results[0]!.message.messageId;
    expect(
      await database
        .selectFrom('chat.chat_messages')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('chat_session_id', '=', fixture.chatSessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '1' });
    const notification = await database
      .selectFrom('notification.notifications')
      .select(['id', 'user_id', 'payload'])
      .where('deduplication_key', '=', `chat-message:${messageId}:${fixture.secondUserId}`)
      .executeTakeFirstOrThrow();
    expect(notification).toMatchObject({
      user_id: fixture.secondUserId,
      payload: { chatSessionId: fixture.chatSessionId, messageId },
    });
    expect(
      await database
        .selectFrom('notification.notification_deliveries')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('notification_id', '=', notification.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '1' });
    const event = await database
      .selectFrom('platform.outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_type', '=', 'chat_message')
      .where('aggregate_id', '=', messageId)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({
      event_type: 'chat.message-created.v1',
      payload: {
        chatSessionId: fixture.chatSessionId,
        messageId,
        messageType: 'predefined_question',
      },
    });
  });

  it('keeps muted history, rejects mismatched answer ownership, and denies an outsider', async () => {
    const fixture = await createChatFixture(database);
    const questions = await database
      .selectFrom('chat.predefined_questions')
      .select('id')
      .where('is_active', '=', true)
      .orderBy('id')
      .limit(2)
      .execute();
    const answer = await database
      .selectFrom('chat.predefined_answers')
      .select(['id', 'question_id'])
      .where('question_id', '=', questions[0]!.id)
      .orderBy('display_order')
      .executeTakeFirstOrThrow();
    const store = new PostgresChatStore(database);

    await database
      .updateTable('chat.chat_participants')
      .set({ muted_at: new Date(), version: 2 })
      .where('chat_session_id', '=', fixture.chatSessionId)
      .where('user_id', '=', fixture.secondUserId)
      .executeTakeFirstOrThrow();
    const sent = await store.sendPredefined({
      command: answerCommand(fixture.firstUserId, answer.question_id, answer.id),
      chatSessionId: fixture.chatSessionId,
      messageId: randomUUID(),
      eventId: randomUUID(),
    });
    const mutedNotification = await database
      .selectFrom('notification.notifications')
      .select('id')
      .where(
        'deduplication_key',
        '=',
        `chat-message:${sent.message.messageId}:${fixture.secondUserId}`,
      )
      .executeTakeFirstOrThrow();
    expect(
      await database
        .selectFrom('notification.notification_deliveries')
        .select('id')
        .where('notification_id', '=', mutedNotification.id)
        .execute(),
    ).toEqual([]);

    await expect(
      store.sendPredefined({
        command: answerCommand(fixture.firstUserId, questions[1]!.id, answer.id),
        chatSessionId: fixture.chatSessionId,
        messageId: randomUUID(),
        eventId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'chat_unavailable' });

    const outsiderId = await createUser(database);
    await expect(
      store.sendPredefined({
        command: questionCommand(outsiderId, questions[0]!.id),
        chatSessionId: fixture.chatSessionId,
        messageId: randomUUID(),
        eventId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'chat_unavailable' });
  });

  it('derives chat capability and advances the safety warning exactly once', async () => {
    const fixture = await createChatFixture(database);
    const outsiderId = await createUser(database);
    const store = new PostgresChatStore(database);

    await expect(store.loadForMatch(outsiderId, fixture.matchId)).rejects.toMatchObject({
      code: 'chat_unavailable',
    });
    await expect(store.loadForMatch(fixture.firstUserId, fixture.matchId)).resolves.toMatchObject({
      chatSessionId: fixture.chatSessionId,
      matchId: fixture.matchId,
      canRead: true,
      canSendPredefined: true,
      canSendText: false,
      textUnlocked: false,
      mustShowSafetyWarning: false,
      version: 1,
    });
    await new PostgresCreditLedgerStore(database).append({
      transactionId: randomUUID(),
      userId: fixture.firstUserId,
      transactionType: 'admin_adjustment',
      amount: 10n,
      idempotencyKey: `capability-funding:${randomUUID()}`,
      correlationId: randomUUID(),
    });
    await new PostgresPaidActionStore(database).spendCredits({
      featureUnlockId: randomUUID(),
      creditTransactionId: randomUUID(),
      outboxEventId: randomUUID(),
      userId: fixture.firstUserId,
      target: { type: 'match', targetId: fixture.matchId },
      idempotencyKey: `capability-unlock:${randomUUID()}`,
      correlationId: randomUUID(),
    });
    const pending = await store.loadForSession(fixture.secondUserId, fixture.chatSessionId);
    expect(pending).toMatchObject({
      textUnlocked: true,
      mustShowSafetyWarning: true,
      canSendText: false,
      version: 1,
    });
    const shown = await store.markSafetyWarningShown({
      userId: fixture.secondUserId,
      chatSessionId: fixture.chatSessionId,
      expectedVersion: pending.version,
    });
    const replay = await store.markSafetyWarningShown({
      userId: fixture.secondUserId,
      chatSessionId: fixture.chatSessionId,
      expectedVersion: pending.version,
    });
    expect(shown).toMatchObject({
      textUnlocked: true,
      mustShowSafetyWarning: false,
      canSendText: true,
      version: 2,
    });
    expect(replay).toEqual(shown);
  });

  it('allows normalized text only after Match unlock and the actor safety warning', async () => {
    const fixture = await createChatFixture(database);
    const command = textCommand(fixture.firstUserId);
    const write = {
      command,
      chatSessionId: fixture.chatSessionId,
      normalizedText: 'Café\nhello',
      messageId: randomUUID(),
      eventId: randomUUID(),
    } as const;
    const store = new PostgresChatStore(database);

    await expect(store.sendText(write)).rejects.toMatchObject({ code: 'chat_unavailable' });
    await new PostgresCreditLedgerStore(database).append({
      transactionId: randomUUID(),
      userId: fixture.firstUserId,
      transactionType: 'admin_adjustment',
      amount: 10n,
      idempotencyKey: `chat-funding:${randomUUID()}`,
      correlationId: randomUUID(),
    });
    await new PostgresPaidActionStore(database).spendCredits({
      featureUnlockId: randomUUID(),
      creditTransactionId: randomUUID(),
      outboxEventId: randomUUID(),
      userId: fixture.firstUserId,
      target: { type: 'match', targetId: fixture.matchId },
      idempotencyKey: `chat-unlock:${randomUUID()}`,
      correlationId: randomUUID(),
    });
    await expect(store.sendText(write)).rejects.toMatchObject({ code: 'chat_unavailable' });

    await database
      .updateTable('chat.chat_participants')
      .set({ unlock_safety_warning_shown_at: new Date(), version: 2 })
      .where('chat_session_id', '=', fixture.chatSessionId)
      .where('user_id', '=', fixture.firstUserId)
      .executeTakeFirstOrThrow();
    const sent = await store.sendText(write);
    const replay = await store.sendText({
      ...write,
      messageId: randomUUID(),
      eventId: randomUUID(),
    });
    expect(sent).toMatchObject({
      replayed: false,
      message: {
        messageType: 'text',
        sequenceNumber: '1',
        content: { text: 'Café\nhello' },
      },
    });
    expect(replay).toMatchObject({
      replayed: true,
      message: { messageId: sent.message.messageId },
    });

    const persisted = await database
      .selectFrom('chat.chat_messages')
      .select(['text', 'message_type'])
      .where('id', '=', sent.message.messageId)
      .executeTakeFirstOrThrow();
    expect(persisted).toEqual({ text: 'Café\nhello', message_type: 'text' });
    const notification = await database
      .selectFrom('notification.notifications')
      .select('payload')
      .where(
        'deduplication_key',
        '=',
        `chat-message:${sent.message.messageId}:${fixture.secondUserId}`,
      )
      .executeTakeFirstOrThrow();
    const event = await database
      .selectFrom('platform.outbox_events')
      .select('payload')
      .where('aggregate_type', '=', 'chat_message')
      .where('aggregate_id', '=', sent.message.messageId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(notification.payload)).not.toContain('Café');
    expect(JSON.stringify(event.payload)).not.toContain('Café');
  });

  it('pages only within the newest 50 messages using a sequence keyset', async () => {
    const fixture = await createChatFixture(database);
    const question = await database
      .selectFrom('chat.predefined_questions')
      .select('id')
      .where('is_active', '=', true)
      .orderBy('display_order')
      .executeTakeFirstOrThrow();
    for (let sequence = 1; sequence <= 55; sequence += 1)
      await reserveAndInsert(database, {
        chatSessionId: fixture.chatSessionId,
        senderUserId: sequence % 2 === 0 ? fixture.firstUserId : fixture.secondUserId,
        messageId: randomUUID(),
        messageType: 'predefined_question',
        sequenceNumber: String(sequence),
        questionId: question.id,
      });
    const store = new PostgresChatStateStore(database);
    const first = await store.readPage({
      userId: fixture.firstUserId,
      chatSessionId: fixture.chatSessionId,
      limit: 20,
    });
    const second = await store.readPage({
      userId: fixture.firstUserId,
      chatSessionId: fixture.chatSessionId,
      limit: 20,
      beforeSequenceNumber: first.items.at(-1)!.sequenceNumber,
    });
    const third = await store.readPage({
      userId: fixture.firstUserId,
      chatSessionId: fixture.chatSessionId,
      limit: 20,
      beforeSequenceNumber: second.items.at(-1)!.sequenceNumber,
    });
    expect(
      [...first.items, ...second.items, ...third.items].map((item) => item.sequenceNumber),
    ).toEqual(Array.from({ length: 50 }, (_, index) => String(55 - index)));
    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
    const outsiderId = await createUser(database);
    await expect(
      store.readPage({ userId: outsiderId, chatSessionId: fixture.chatSessionId, limit: 20 }),
    ).rejects.toMatchObject({ code: 'chat_unavailable' });
  });

  it('preserves immutable report evidence while deleting only messages older than newest 50', async () => {
    const fixture = await createChatFixture(database);
    const question = await database
      .selectFrom('chat.predefined_questions')
      .select('id')
      .where('is_active', '=', true)
      .orderBy('display_order')
      .executeTakeFirstOrThrow();
    const messageIds = Array.from({ length: 55 }, () => randomUUID());
    for (let sequence = 1; sequence <= messageIds.length; sequence += 1)
      await reserveAndInsert(database, {
        chatSessionId: fixture.chatSessionId,
        senderUserId: sequence % 2 === 0 ? fixture.firstUserId : fixture.secondUserId,
        messageId: messageIds[sequence - 1]!,
        messageType: 'predefined_question',
        sequenceNumber: String(sequence),
        questionId: question.id,
      });

    const store = new PostgresChatRetentionStore(database);
    const capturedReportId = randomUUID();
    const capture = captureMessagesCommand(capturedReportId, fixture.chatSessionId, [
      messageIds[0]!,
    ]);
    expect(await store.captureReportedMessages(capture)).toMatchObject({ replayed: false });
    expect(await store.captureReportedMessages(capture)).toMatchObject({ replayed: true });

    const pendingReportId = randomUUID();
    await database
      .insertInto('chat.chat_message_snapshot_requests')
      .values({
        report_id: pendingReportId,
        chat_session_id: fixture.chatSessionId,
        original_message_id: messageIds[1]!,
        captured_at: null,
      })
      .execute();

    expect(await store.findCleanupCandidates(10)).toContain(fixture.chatSessionId);
    expect(await store.cleanupChat(cleanupChatCommand(fixture.chatSessionId))).toEqual({
      chatSessionId: fixture.chatSessionId,
      retainedCount: 50,
      snapshotCount: 1,
      deletedCount: 5,
      hasMore: false,
    });
    const live = await database
      .selectFrom('chat.chat_messages')
      .select('sequence_number')
      .where('chat_session_id', '=', fixture.chatSessionId)
      .orderBy('sequence_number')
      .execute();
    expect(live.map(({ sequence_number }) => sequence_number)).toEqual(
      Array.from({ length: 50 }, (_, index) => String(index + 6)),
    );
    const snapshots = await database
      .selectFrom('chat.chat_message_snapshots')
      .select(['id', 'report_id', 'original_message_id', 'content', 'integrity_sha256'])
      .where('chat_session_id', '=', fixture.chatSessionId)
      .orderBy('original_created_at')
      .execute();
    expect(snapshots).toHaveLength(2);
    expect(new Set(snapshots.map(({ report_id }) => report_id))).toEqual(
      new Set([capturedReportId, pendingReportId]),
    );
    expect(new Set(snapshots.map(({ original_message_id }) => original_message_id))).toEqual(
      new Set(messageIds.slice(0, 2)),
    );
    expect(snapshots.every(({ integrity_sha256 }) => integrity_sha256.length === 64)).toBe(true);
    expect(snapshots.every(({ content }) => content.predefinedQuestionId === question.id)).toBe(
      true,
    );
    expect(
      await database
        .selectFrom('chat.chat_cleanup_checkpoints')
        .select(['last_retained_sequence_number', 'deleted_message_count'])
        .where('chat_session_id', '=', fixture.chatSessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ last_retained_sequence_number: '6', deleted_message_count: '5' });
    expect(await store.findCleanupCandidates(10)).not.toContain(fixture.chatSessionId);
    await expect(
      database
        .updateTable('chat.chat_message_snapshots')
        .set({ integrity_sha256: '0'.repeat(64) })
        .where('id', '=', snapshots[0]!.id)
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      database
        .deleteFrom('chat.chat_message_snapshots')
        .where('id', '=', snapshots[0]!.id)
        .execute(),
    ).rejects.toThrow(/immutable/u);
  });

  it('advances read state monotonically and changes mute under participant version', async () => {
    const fixture = await createChatFixture(database);
    const question = await database
      .selectFrom('chat.predefined_questions')
      .select('id')
      .where('is_active', '=', true)
      .orderBy('display_order')
      .executeTakeFirstOrThrow();
    for (const sequenceNumber of ['1', '2'])
      await reserveAndInsert(database, {
        chatSessionId: fixture.chatSessionId,
        senderUserId: fixture.secondUserId,
        messageId: randomUUID(),
        messageType: 'predefined_question',
        sequenceNumber,
        questionId: question.id,
      });
    const store = new PostgresChatStateStore(database);
    const firstWrite = {
      command: markReadCommand(fixture.firstUserId, '2'),
      chatSessionId: fixture.chatSessionId,
      eventId: randomUUID(),
    } as const;
    const first = await store.markRead(firstWrite);
    const replay = await store.markRead({ ...firstWrite, eventId: randomUUID() });
    const lower = await store.markRead({
      command: markReadCommand(fixture.firstUserId, '1'),
      chatSessionId: fixture.chatSessionId,
      eventId: randomUUID(),
    });
    expect(first).toMatchObject({ throughSequenceNumber: '2', replayed: false });
    expect(replay).toMatchObject({ throughSequenceNumber: '2', replayed: true });
    expect(lower).toMatchObject({ throughSequenceNumber: '2', replayed: false });

    const muted = await store.changeMute({
      command: muteCommand(fixture.firstUserId, true, 2),
      chatSessionId: fixture.chatSessionId,
      eventId: randomUUID(),
    });
    expect(muted).toMatchObject({ muted: true, version: 3, replayed: false });
    await expect(
      store.changeMute({
        command: muteCommand(fixture.firstUserId, false, 2),
        chatSessionId: fixture.chatSessionId,
        eventId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('converges concurrent Unmatch into one permanent symmetric closure', async () => {
    const fixture = await createChatFixture(database);
    const store = new PostgresUnmatchStore(database);
    const writes = [fixture.firstUserId, fixture.secondUserId].map((actorUserId) => ({
      command: unmatchCommand(actorUserId),
      matchId: fixture.matchId,
      eventId: randomUUID(),
    }));
    const results = await Promise.all(writes.map((write) => store.unmatch(write)));
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(results.filter(({ replayed }) => replayed)).toHaveLength(1);
    expect(new Set(results.map(({ unmatchedAt }) => unmatchedAt)).size).toBe(1);
    expect(new Set(results.map(({ reportWindowExpiresAt }) => reportWindowExpiresAt)).size).toBe(1);
    expect(
      new Date(results[0]!.reportWindowExpiresAt).getTime() -
        new Date(results[0]!.unmatchedAt).getTime(),
    ).toBe(24 * 60 * 60 * 1000);

    const record = await database
      .selectFrom('matching.unmatch_records')
      .selectAll()
      .where('match_id', '=', fixture.matchId)
      .executeTakeFirstOrThrow();
    expect([fixture.firstUserId, fixture.secondUserId]).toContain(record.actor_user_id);
    expect(
      await database
        .selectFrom('matching.matches')
        .select(['status', 'closed_at'])
        .where('id', '=', fixture.matchId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ status: 'unmatched', closed_at: record.unmatched_at });
    expect(
      await database
        .selectFrom('interaction.user_pair_states')
        .select(['state', 'changed_at'])
        .where('user_low_id', '=', fixture.firstUserId)
        .where('user_high_id', '=', fixture.secondUserId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: 'unmatched', changed_at: record.unmatched_at });
    expect(
      await database
        .selectFrom('chat.chat_sessions')
        .select(['status', 'closed_reason', 'closed_at'])
        .where('id', '=', fixture.chatSessionId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ status: 'closed', closed_reason: 'unmatch', closed_at: record.unmatched_at });
    expect(
      await database
        .selectFrom('interaction.likes')
        .select('status')
        .where('sender_user_id', 'in', [fixture.firstUserId, fixture.secondUserId])
        .where('receiver_user_id', 'in', [fixture.firstUserId, fixture.secondUserId])
        .execute(),
    ).toEqual([{ status: 'closed_by_unmatch' }, { status: 'closed_by_unmatch' }]);
    expect(
      await database
        .selectFrom('interaction.not_interested')
        .select('id')
        .where('sender_user_id', 'in', [fixture.firstUserId, fixture.secondUserId])
        .where('receiver_user_id', 'in', [fixture.firstUserId, fixture.secondUserId])
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom('notification.notifications')
        .select(['user_id', 'notification_type'])
        .where('deduplication_key', 'like', `unmatch:${fixture.matchId}:%`)
        .execute(),
    ).toEqual([
      {
        user_id:
          record.actor_user_id === fixture.firstUserId ? fixture.secondUserId : fixture.firstUserId,
        notification_type: 'chat_closed',
      },
    ]);
    await expect(
      database
        .updateTable('matching.unmatch_records')
        .set({ reason_code: 'changed' })
        .where('match_id', '=', fixture.matchId)
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      new PostgresChatStore(database).sendPredefined({
        command: questionCommand(fixture.firstUserId, randomUUID()),
        chatSessionId: fixture.chatSessionId,
        messageId: randomUUID(),
        eventId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'chat_unavailable' });
  });
});
