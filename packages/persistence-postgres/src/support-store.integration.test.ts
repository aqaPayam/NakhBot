import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminCommandAttempt, UserSupportWrite } from '@nakh/application';

import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresSupportAdminWorkflow, PostgresSupportStore } from './support-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createUser(
  database: NakhDatabase,
  state: 'active' | 'banned' = 'active',
): Promise<string> {
  const userId = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('identity.accounts')
    .values({
      user_id: userId,
      state,
      state_reason: state === 'banned' ? 'test_ban' : null,
      state_changed_at: now,
    })
    .execute();
  return userId;
}

async function createSupportAdmin(database: NakhDatabase): Promise<string> {
  const userId = await createUser(database);
  const adminUserId = randomUUID();
  const telegramUserId = String(2_000_000_000 + Math.floor(Math.random() * 7_000_000_000));
  const now = new Date();
  await database
    .insertInto('identity.telegram_identities')
    .values({
      user_id: userId,
      telegram_user_id: telegramUserId,
      username: null,
      first_seen_at: now,
      last_seen_at: now,
    })
    .execute();
  await database
    .insertInto('administration.admin_users')
    .values({
      id: adminUserId,
      user_id: userId,
      telegram_user_id: telegramUserId,
      is_active: true,
      disabled_at: null,
      identity_verified_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await database
    .insertInto('administration.admin_user_roles')
    .values({
      admin_user_id: adminUserId,
      role_code: 'support',
      assigned_by_admin_id: adminUserId,
      revoked_by_admin_id: null,
      revoked_at: null,
    })
    .execute();
  return adminUserId;
}

function userWrite(
  userId: string,
  threadId: string,
  label: string,
  expectedVersion?: number,
): UserSupportWrite {
  return {
    userId,
    supportThreadId: threadId,
    messageId: randomUUID(),
    eventId: randomUUID(),
    commandId: randomUUID(),
    requestId: randomUUID(),
    idempotencyKey: `support-${label}-${randomUUID()}`,
    requestDigest: digest(`${userId}:${threadId}:${label}:${expectedVersion ?? 'open'}`),
    normalizedText: `Support message ${label}`,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

function adminAttempt(
  adminUserId: string,
  threadId: string,
  commandCode: 'support.reply-thread' | 'support.close-thread',
  expectedVersion: number,
): AdminCommandAttempt {
  const commandId = randomUUID();
  return {
    logId: randomUUID(),
    adminUserId,
    commandId,
    requestId: randomUUID(),
    requestDigest: digest(`${commandCode}:${threadId}:${expectedVersion}:${commandId}`),
    commandCode,
    requiredPermission: 'review_support',
    targetType: 'support_thread',
    targetId: threadId,
    expectedTargetVersion: expectedVersion,
    reasonDigest: digest('support response'),
    metadata: {},
    correlationId: randomUUID(),
  };
}

describe.skipIf(databaseUrl === undefined)('M7 durable support messaging', () => {
  let database: NakhDatabase;
  let store: PostgresSupportStore;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 20,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
    store = new PostgresSupportStore(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('admits at most two unanswered messages across concurrent attempts and resets after reply', async () => {
    const userId = await createUser(database);
    const threadId = randomUUID();
    const opened = await store.open(userWrite(userId, threadId, 'first'));
    expect(opened).toMatchObject({ version: 1, unansweredUserMessages: 1, replayed: false });

    const racers = Array.from({ length: 12 }, (_, index) =>
      store.send(userWrite(userId, threadId, `race-${index}`, 1)),
    );
    const settled = await Promise.allSettled(racers);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(11);
    await expect(store.send(userWrite(userId, threadId, 'third', 2))).rejects.toMatchObject({
      code: 'support_unanswered_limit',
    });

    const messagesBeforeReply = await database
      .selectFrom('support.support_messages')
      .selectAll()
      .where('support_thread_id', '=', threadId)
      .execute();
    expect(messagesBeforeReply).toHaveLength(2);
    expect(
      messagesBeforeReply.every((message) => message.message_text.startsWith('Support message')),
    ).toBe(true);

    const adminUserId = await createSupportAdmin(database);
    const workflow = new PostgresSupportAdminWorkflow(database);
    const replied = await workflow.reply(
      adminAttempt(adminUserId, threadId, 'support.reply-thread', 2),
      '  We can help.  ',
    );
    expect(replied).toMatchObject({
      result: 'succeeded',
      safeCode: 'support_replied',
      value: { version: 3, unansweredUserMessages: 0 },
    });
    await expect(store.send(userWrite(userId, threadId, 'after-reply', 3))).resolves.toMatchObject({
      version: 4,
      unansweredUserMessages: 1,
    });

    const storedAdminMessage = await database
      .selectFrom('support.support_messages')
      .select(['message_text', 'unanswered_user_messages_after'])
      .where('support_thread_id', '=', threadId)
      .where('sender_type', '=', 'admin')
      .executeTakeFirstOrThrow();
    expect(storedAdminMessage).toEqual({
      message_text: 'We can help.',
      unanswered_user_messages_after: 0,
    });
  });

  it('replays one open command, rejects a changed replay, and routes banned users away', async () => {
    const userId = await createUser(database);
    const write = userWrite(userId, randomUUID(), 'replay');
    const first = await store.open(write);
    await expect(
      store.open({
        ...write,
        supportThreadId: randomUUID(),
        messageId: randomUUID(),
        eventId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      supportThreadId: first.supportThreadId,
      replayed: true,
    });
    await expect(store.open({ ...write, requestDigest: digest('changed') })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });

    const bannedUserId = await createUser(database, 'banned');
    await expect(store.open(userWrite(bannedUserId, randomUUID(), 'banned'))).rejects.toMatchObject(
      {
        code: 'conflict',
      },
    );
    expect(
      await database
        .selectFrom('support.support_threads')
        .select('id')
        .where('user_id', '=', bannedUserId)
        .execute(),
    ).toHaveLength(0);
  });
});
