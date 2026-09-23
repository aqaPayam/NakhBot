import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

type ChatFixture = Readonly<{
  firstUserId: string;
  secondUserId: string;
  chatSessionId: string;
}>;

async function createUser(database: NakhDatabase): Promise<string> {
  const userId = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  return userId;
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
  return { firstUserId, secondUserId, chatSessionId };
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
});
