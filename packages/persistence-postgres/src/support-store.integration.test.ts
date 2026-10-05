import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AdminActionAuthorizationService,
  type OpaqueTokenStore,
  type AdminCommandAttempt,
  type UserSupportWrite,
} from '@nakh/application';
import type { ReplySupportThreadCommand, CloseSupportThreadCommand } from '@nakh/contracts';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresConfirmedSupportCommands } from './confirmed-support-store.js';
import { PostgresSupportThreadRevealStore } from './support-reveal-store.js';

import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import {
  PostgresSupportAdminWorkflow,
  PostgresSupportStore,
  supportUnansweredStatement,
} from './support-store.js';
import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';

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
  it('batches support integrity without losing cross-thread reply boundaries or exact attempt bindings', async () => {
    const userId = await createUser(database),
      adminId = await createSupportAdmin(database),
      first = randomUUID(),
      second = randomUUID();
    await store.open(userWrite(userId, first, 'integrity-first'));
    await store.open(userWrite(userId, second, 'integrity-second'));
    const workflow = new PostgresSupportAdminWorkflow(database);
    const reply = adminAttempt(adminId, first, 'support.reply-thread', 1);
    expect((await workflow.reply(reply, 'Synthetic integrity reply')).result).toBe('succeeded');
    expect(
      (await workflow.close(adminAttempt(adminId, first, 'support.close-thread', 2))).result,
    ).toBe('succeeded');
    await store.send(userWrite(userId, second, 'integrity-after-closed-reply', 1));
    await store.send(userWrite(userId, second, 'integrity-two-after-reply', 2));
    const originalAttempt = await database
      .selectFrom('administration.admin_action_logs')
      .selectAll()
      .where('id', '=', reply.logId)
      .executeTakeFirstOrThrow();
    const originalMessage = await database
      .selectFrom('support.support_messages')
      .selectAll()
      .where('command_id', '=', reply.commandId)
      .executeTakeFirstOrThrow();
    async function compare(brokenReply = false): Promise<void> {
      const unanswered = (await supportUnansweredStatement(userId).execute(database)).rows[0]!
        .count;
      const reference = await sql<{ id: string; withinLimit: boolean; hasAttempts: boolean }>`
        SELECT thread.id, thread.status <> 'open' OR ${unanswered} <= 2 AS "withinLimit",
          NOT EXISTS (SELECT 1 FROM support.support_messages message
            WHERE message.support_thread_id = thread.id AND message.sender_type = 'admin'
              AND NOT EXISTS (SELECT 1 FROM administration.admin_action_logs attempt
                WHERE attempt.admin_user_id = message.sender_admin_id AND attempt.command_id = message.command_id
                  AND attempt.request_id = message.request_id AND attempt.request_digest = message.request_digest
                  AND attempt.command_code = 'support.reply-thread' AND attempt.target_type = 'support_thread'
                  AND attempt.target_id = thread.id AND attempt.result = 'succeeded'
                  AND attempt.expected_target_version = message.thread_version_after - 1))
          AND (thread.status <> 'closed' OR EXISTS (SELECT 1 FROM administration.admin_action_logs attempt
            WHERE attempt.command_code = 'support.close-thread' AND attempt.target_type = 'support_thread'
              AND attempt.target_id = thread.id AND attempt.result = 'succeeded'
              AND attempt.expected_target_version = thread.version - 1)) AS "hasAttempts"
        FROM support.support_threads thread WHERE thread.user_id = ${userId}::uuid ORDER BY thread.id
      `.execute(database);
      expect(reference.rows.find((row) => row.id === first)!.hasAttempts).toBe(!brokenReply);
      const samples = await Promise.all(
        Array.from({ length: 5 }, () =>
          sql`SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.support_threads}) observed
          WHERE observed.id IN (${first}::uuid,${second}::uuid) ORDER BY observed.id`.execute(
            database,
          ),
        ),
      );
      for (const sample of samples) expect(sample.rows).toEqual(reference.rows);
    }
    async function mutate(operation: (connection: NakhDatabase) => Promise<void>): Promise<void> {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role = replica`.execute(connection);
        try {
          await operation(connection);
        } finally {
          await sql`SET session_replication_role = origin`.execute(connection);
        }
      });
    }
    await compare();
    try {
      for (const damage of [
        { request_id: randomUUID() },
        { request_digest: digest('borrowed support request') },
        { target_id: second },
        { expected_target_version: 999 },
        { command_id: randomUUID() },
        { command_code: 'support.close-thread' },
      ]) {
        await mutate(async (connection) => {
          await connection
            .updateTable('administration.admin_action_logs')
            .set(damage)
            .where('id', '=', reply.logId)
            .execute();
        });
        await compare(true);
        await mutate(async (connection) => {
          await connection
            .updateTable('administration.admin_action_logs')
            .set(originalAttempt)
            .where('id', '=', reply.logId)
            .execute();
        });
      }
      // Equal timestamps require UUID ordering; moving the closed-thread reply
      // before all messages must expose the third unanswered open-thread message.
      await mutate(async (connection) => {
        await sql`UPDATE support.support_messages SET created_at = (
          SELECT min(created_at) FROM support.support_messages
          WHERE support_thread_id = ${second}::uuid AND sender_type = 'user'
        ) WHERE id = ${originalMessage.id}::uuid`.execute(connection);
      });
      await compare();
      const earliest = await database
        .selectFrom('support.support_messages')
        .select('created_at')
        .where('support_thread_id', 'in', [first, second])
        .orderBy('created_at')
        .executeTakeFirstOrThrow();
      for (const createdAt of [
        earliest.created_at,
        new Date(earliest.created_at.getTime() - 1000),
      ]) {
        await mutate(async (connection) => {
          await connection
            .updateTable('support.support_messages')
            .set({ created_at: createdAt })
            .where('id', '=', originalMessage.id)
            .execute();
        });
        await compare();
      }
      expect((await supportUnansweredStatement(userId).execute(database)).rows[0]!.count).toBe(3);
    } finally {
      await mutate(async (connection) => {
        await connection
          .updateTable('administration.admin_action_logs')
          .set(originalAttempt)
          .where('id', '=', reply.logId)
          .execute();
        await connection
          .updateTable('support.support_messages')
          .set(originalMessage)
          .where('id', '=', originalMessage.id)
          .execute();
      });
    }
    await compare();
  });
  it('bounds retained content and rolls back the command when its required access audit fails', async () => {
    const userId = await createUser(database),
      threadId = randomUUID(),
      adminId = await createSupportAdmin(database);
    await store.open(userWrite(userId, threadId, 'bounded-reveal'));
    const workflow = new PostgresSupportAdminWorkflow(database);
    for (let version = 1; version <= 51; version++) {
      const result = await workflow.reply(
        adminAttempt(adminId, threadId, 'support.reply-thread', version),
        `Private reply ${version}`,
      );
      expect(result.result).toBe('succeeded');
    }
    const attempt = {
      ...adminAttempt(adminId, threadId, 'support.close-thread', 52),
      commandCode: 'support.reveal-thread',
    };
    const reveals = new PostgresSupportThreadRevealStore(database);
    // A disposable, command-specific database fault proves no content or receipt escapes COMMIT.
    const suffix = randomUUID().replaceAll('-', ''),
      functionName = `fail_safety_access_${suffix}`;
    await sql
      .raw(
        `CREATE FUNCTION administration.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.command_id = '${attempt.commandId}'::uuid THEN
        RAISE EXCEPTION 'injected access audit failure'; END IF; RETURN NEW; END $$`,
      )
      .execute(database);
    await sql
      .raw(
        `CREATE TRIGGER ${functionName} BEFORE INSERT ON administration.safety_access_audits
      FOR EACH ROW EXECUTE FUNCTION administration.${functionName}()`,
      )
      .execute(database);
    try {
      await expect(reveals.reveal(attempt)).rejects.toThrow();
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('command_id', '=', attempt.commandId)
          .execute(),
      ).toHaveLength(0);
      expect(
        await database
          .selectFrom('administration.safety_access_audits')
          .select('id')
          .where('command_id', '=', attempt.commandId)
          .execute(),
      ).toHaveLength(0);
    } finally {
      await sql
        .raw(`DROP TRIGGER ${functionName} ON administration.safety_access_audits`)
        .execute(database);
      await sql.raw(`DROP FUNCTION administration.${functionName}()`).execute(database);
    }
    const fresh = await reveals.reveal(attempt);
    expect(fresh.result).toBe('succeeded');
    expect(fresh.value?.messages).toHaveLength(50);
    expect(fresh.value?.hasEarlierMessages).toBe(true);
    expect(fresh.value?.messages[0]?.text).toBe('Private reply 2');
    expect(fresh.value?.messages[49]?.text).toBe('Private reply 51');
    expect((await reveals.reveal(attempt)).value).toBeUndefined();
    expect(
      await database
        .selectFrom('administration.safety_access_audits')
        .select(['outcome', 'item_count'])
        .where('command_id', '=', attempt.commandId)
        .execute(),
    ).toEqual([{ outcome: 'revealed', item_count: 50 }]);
  });
  it('requires exact reply/close confirmation and audits changed, stale and invalid-text attempts', async () => {
    const userId = await createUser(database),
      threadId = randomUUID(),
      adminId = await createSupportAdmin(database);
    await store.open(userWrite(userId, threadId, 'confirmed'));
    const admin = await database
      .selectFrom('administration.admin_users')
      .selectAll()
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow();
    const actor = { kind: 'admin' as const, userId: admin.user_id };
    const values = new Map<string, string>();
    const tokens: OpaqueTokenStore = {
      get: (id) => Promise.resolve(values.get(id)),
      putIfAbsent: (id, value) => {
        if (values.has(id)) return Promise.resolve(false);
        values.set(id, value);
        return Promise.resolve(true);
      },
    };
    const key = Buffer.alloc(32, 6);
    const authorization = new AdminActionAuthorizationService(
      new PostgresAdminAuthorizationStore(database),
      tokens,
      key,
    );
    const commands = new PostgresConfirmedSupportCommands(database, tokens, key);
    const token = await authorization.issue({
      actorUserId: actor.userId,
      telegramUserId: admin.telegram_user_id,
      scope: {
        commandCode: 'support.reply-thread',
        requiredPermission: 'review_support',
        targetType: 'support_thread',
        targetId: threadId,
        expectedTargetVersion: 1,
      },
    });
    const reply: ReplySupportThreadCommand = {
      actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'support.reply-thread',
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: token,
        confirmationToken: '',
        expectedTargetVersion: 1,
        reason: 'Restricted reason',
        text: 'Restricted reply',
      },
    };
    const confirmationToken = await commands.prepare(reply, actor);
    const changed = { ...reply, data: { ...reply.data, confirmationToken, text: 'Changed reply' } };
    expect(await commands.execute(changed, actor)).toMatchObject({
      result: 'rejected',
      safeCode: 'invalid_request',
    });
    const valid = { ...reply, commandId: randomUUID() };
    valid.data = { ...valid.data, confirmationToken: await commands.prepare(valid, actor) };
    expect(await commands.execute(valid, actor)).toMatchObject({ result: 'succeeded' });
    expect(await commands.execute(valid, actor)).toMatchObject({
      result: 'succeeded',
      replayed: true,
    });
    const invalid = { ...reply, commandId: randomUUID(), data: { ...reply.data, text: '   ' } };
    invalid.data.confirmationToken = await commands.prepare(invalid, actor);
    expect(await commands.execute(invalid, actor)).toMatchObject({
      result: 'rejected',
      safeCode: 'support_text_invalid',
    });
    const close: CloseSupportThreadCommand = {
      ...reply,
      commandId: randomUUID(),
      commandType: 'support.close-thread',
      data: {
        adminActionToken: await authorization.issue({
          actorUserId: actor.userId,
          telegramUserId: admin.telegram_user_id,
          scope: {
            commandCode: 'support.close-thread',
            requiredPermission: 'review_support',
            targetType: 'support_thread',
            targetId: threadId,
            expectedTargetVersion: 2,
          },
        }),
        confirmationToken: '',
        expectedTargetVersion: 2,
        reason: 'Close resolved support',
      },
    };
    close.data.confirmationToken = await commands.prepare(close, actor);
    expect(await commands.execute(close, actor)).toMatchObject({
      result: 'succeeded',
      value: { status: 'closed' },
    });
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .selectAll()
      .where('admin_user_id', '=', adminId)
      .execute();
    expect(logs).toHaveLength(4);
    expect(JSON.stringify(logs)).not.toContain('Restricted');
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
