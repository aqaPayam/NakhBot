import { sql } from 'kysely';

import {
  SupportAdminWorkflow,
  type AdminSupportWrite,
  type StoredSupportResult,
  type SupportStore,
  type UserSupportWrite,
} from '@nakh/application';
import { ApplicationError, canUseSupport, evaluateSupportMessageAdmission } from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
import { SystemIdGenerator } from './foundation-store.js';

function unavailable(): ApplicationError {
  return new ApplicationError('conflict', 'error.support.unavailable', 409);
}

function versionConflict(): ApplicationError {
  return new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
}

function idempotencyConflict(): ApplicationError {
  return new ApplicationError('idempotency_conflict', 'error.command.idempotency_conflict', 409);
}

async function databaseTime(database: NakhDatabase): Promise<Date> {
  const result = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(database);
  return result.rows[0]!.now;
}

async function lockSupportUser(database: NakhDatabase, userId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(
    hashtextextended(${'support-user:'} || ${userId}::text, 0)
  )`.execute(database);
}

async function countUnanswered(database: NakhDatabase, userId: string): Promise<number> {
  const result = await sql<{ count: number }>`
    WITH user_messages AS (
      SELECT message.created_at, message.id
      FROM support.support_messages AS message
      JOIN support.support_threads AS thread ON thread.id = message.support_thread_id
      WHERE thread.user_id = ${userId}::uuid
        AND thread.status = 'open' AND message.sender_type = 'user'
    ), latest_admin AS (
      SELECT message.created_at, message.id
      FROM support.support_messages AS message
      JOIN support.support_threads AS thread ON thread.id = message.support_thread_id
      WHERE thread.user_id = ${userId}::uuid AND message.sender_type = 'admin'
      ORDER BY message.created_at DESC, message.id DESC LIMIT 1
    )
    SELECT count(*)::integer AS count
    FROM user_messages AS message
    WHERE (
        NOT EXISTS (SELECT 1 FROM latest_admin)
        OR (message.created_at, message.id) >
          (SELECT created_at, id FROM latest_admin)
      )
  `.execute(database);
  return result.rows[0]?.count ?? 0;
}

async function assertSupportAccount(database: NakhDatabase, userId: string): Promise<void> {
  const account = await database
    .selectFrom('identity.accounts')
    .select('state')
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (account === undefined || !canUseSupport(account.state)) throw unavailable();
}

async function replayUserMessage(
  database: NakhDatabase,
  write: UserSupportWrite,
): Promise<StoredSupportResult | undefined> {
  const existing = await database
    .selectFrom('support.support_messages as message')
    .innerJoin('support.support_threads as thread', 'thread.id', 'message.support_thread_id')
    .select([
      'message.command_id as commandId',
      'message.request_digest as requestDigest',
      'message.thread_version_after as version',
      'message.unanswered_user_messages_after as unansweredUserMessages',
      'message.created_at as changedAt',
      'thread.id as supportThreadId',
    ])
    .where('message.sender_type', '=', 'user')
    .where('message.sender_user_id', '=', write.userId)
    .where((expression) =>
      expression.or([
        expression('message.command_id', '=', write.commandId),
        expression('message.idempotency_key', '=', write.idempotencyKey),
      ]),
    )
    .executeTakeFirst();
  if (existing === undefined) return undefined;
  if (existing.requestDigest !== write.requestDigest) throw idempotencyConflict();
  return {
    supportThreadId: existing.supportThreadId,
    status: 'open',
    unansweredUserMessages: existing.unansweredUserMessages,
    version: existing.version,
    changedAt: existing.changedAt,
    replayed: true,
  };
}

function assertAdmission(unanswered: number): number {
  const admission = evaluateSupportMessageAdmission(unanswered);
  if (!admission.allowed)
    throw new ApplicationError('support_unanswered_limit', 'error.support.unanswered_limit', 429);
  return unanswered + 1;
}

async function insertEvent(
  database: NakhDatabase,
  write: Readonly<{
    eventId: string;
    threadId: string;
    userId: string;
    status: 'open' | 'closed';
    version: number;
    unanswered: number;
    occurredAt: Date;
    requestId: string;
    commandId: string;
  }>,
): Promise<void> {
  await database
    .insertInto('platform.outbox_events')
    .values({
      id: write.eventId,
      aggregate_type: 'support_thread',
      aggregate_id: write.threadId,
      event_type: 'support.thread-changed.v1',
      schema_version: 1,
      payload: {
        supportThreadId: write.threadId,
        userId: write.userId,
        status: write.status,
        version: write.version,
        unansweredUserMessages: write.unanswered,
      },
      occurred_at: write.occurredAt,
      available_at: write.occurredAt,
      published_at: null,
      last_error_code: null,
      lease_owner: null,
      lease_expires_at: null,
      correlation_id: write.requestId,
      causation_id: write.commandId,
    })
    .execute();
}

export class PostgresSupportStore implements SupportStore<NakhDatabase> {
  public constructor(private readonly database: NakhDatabase) {}

  public open(write: UserSupportWrite): Promise<StoredSupportResult> {
    return this.database.transaction().execute(async (transaction) => {
      await lockSupportUser(transaction, write.userId);
      const replay = await replayUserMessage(transaction, write);
      if (replay !== undefined) return replay;
      await assertSupportAccount(transaction, write.userId);
      const unanswered = assertAdmission(await countUnanswered(transaction, write.userId));
      const occurredAt = await databaseTime(transaction);
      await transaction
        .insertInto('support.support_threads')
        .values({
          id: write.supportThreadId,
          user_id: write.userId,
          status: 'open',
          open_command_id: write.commandId,
          open_idempotency_key: write.idempotencyKey,
          open_request_digest: write.requestDigest,
          last_message_at: occurredAt,
          created_at: occurredAt,
          closed_at: null,
          version: 1,
        })
        .execute();
      await transaction
        .insertInto('support.support_messages')
        .values({
          id: write.messageId,
          support_thread_id: write.supportThreadId,
          sender_type: 'user',
          sender_user_id: write.userId,
          sender_admin_id: null,
          message_text: write.normalizedText,
          command_id: write.commandId,
          request_id: write.requestId,
          request_digest: write.requestDigest,
          idempotency_key: write.idempotencyKey,
          thread_version_after: 1,
          unanswered_user_messages_after: unanswered,
          created_at: occurredAt,
        })
        .execute();
      await insertEvent(transaction, {
        eventId: write.eventId,
        threadId: write.supportThreadId,
        userId: write.userId,
        status: 'open',
        version: 1,
        unanswered,
        occurredAt,
        requestId: write.requestId,
        commandId: write.commandId,
      });
      return {
        supportThreadId: write.supportThreadId,
        status: 'open',
        unansweredUserMessages: unanswered,
        version: 1,
        changedAt: occurredAt,
        replayed: false,
      };
    });
  }

  public send(write: UserSupportWrite): Promise<StoredSupportResult> {
    return this.database.transaction().execute(async (transaction) => {
      await lockSupportUser(transaction, write.userId);
      const replay = await replayUserMessage(transaction, write);
      if (replay !== undefined) return replay;
      await assertSupportAccount(transaction, write.userId);
      const thread = await transaction
        .selectFrom('support.support_threads')
        .select(['user_id', 'status', 'version'])
        .where('id', '=', write.supportThreadId)
        .forUpdate()
        .executeTakeFirst();
      if (thread === undefined || thread.user_id !== write.userId || thread.status !== 'open')
        throw unavailable();
      if (thread.version !== write.expectedVersion) throw versionConflict();
      const unanswered = assertAdmission(await countUnanswered(transaction, write.userId));
      const occurredAt = await databaseTime(transaction);
      const version = thread.version + 1;
      await transaction
        .updateTable('support.support_threads')
        .set({ last_message_at: occurredAt, version })
        .where('id', '=', write.supportThreadId)
        .where('version', '=', thread.version)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('support.support_messages')
        .values({
          id: write.messageId,
          support_thread_id: write.supportThreadId,
          sender_type: 'user',
          sender_user_id: write.userId,
          sender_admin_id: null,
          message_text: write.normalizedText,
          command_id: write.commandId,
          request_id: write.requestId,
          request_digest: write.requestDigest,
          idempotency_key: write.idempotencyKey,
          thread_version_after: version,
          unanswered_user_messages_after: unanswered,
          created_at: occurredAt,
        })
        .execute();
      await insertEvent(transaction, {
        eventId: write.eventId,
        threadId: write.supportThreadId,
        userId: write.userId,
        status: 'open',
        version,
        unanswered,
        occurredAt,
        requestId: write.requestId,
        commandId: write.commandId,
      });
      return {
        supportThreadId: write.supportThreadId,
        status: 'open',
        unansweredUserMessages: unanswered,
        version,
        changedAt: occurredAt,
        replayed: false,
      };
    });
  }

  public async reply(
    database: NakhDatabase,
    write: AdminSupportWrite,
  ): Promise<StoredSupportResult> {
    return this.adminChange(database, write, 'reply');
  }

  public async close(
    database: NakhDatabase,
    write: AdminSupportWrite,
  ): Promise<StoredSupportResult> {
    return this.adminChange(database, write, 'close');
  }

  private async adminChange(
    database: NakhDatabase,
    write: AdminSupportWrite,
    action: 'reply' | 'close',
  ): Promise<StoredSupportResult> {
    const initial = await database
      .selectFrom('support.support_threads')
      .select('user_id')
      .where('id', '=', write.supportThreadId)
      .executeTakeFirst();
    if (initial === undefined) throw unavailable();
    await lockSupportUser(database, initial.user_id);
    const thread = await database
      .selectFrom('support.support_threads')
      .select(['user_id', 'status', 'version'])
      .where('id', '=', write.supportThreadId)
      .forUpdate()
      .executeTakeFirst();
    if (thread === undefined || thread.status !== 'open') throw unavailable();
    if (thread.version !== write.expectedVersion) throw versionConflict();
    if (action === 'reply' && (write.messageId === undefined || write.normalizedText === undefined))
      throw new ApplicationError('invalid_request', 'error.support.admin_request_invalid', 400);

    const occurredAt = await databaseTime(database);
    const version = thread.version + 1;
    const status = action === 'close' ? ('closed' as const) : ('open' as const);
    await database
      .updateTable('support.support_threads')
      .set({
        status,
        last_message_at: action === 'reply' ? occurredAt : undefined,
        closed_at: action === 'close' ? occurredAt : null,
        version,
      })
      .where('id', '=', write.supportThreadId)
      .where('version', '=', thread.version)
      .executeTakeFirstOrThrow();
    if (action === 'reply') {
      await database
        .insertInto('support.support_messages')
        .values({
          id: write.messageId!,
          support_thread_id: write.supportThreadId,
          sender_type: 'admin',
          sender_user_id: null,
          sender_admin_id: write.adminUserId,
          message_text: write.normalizedText!,
          command_id: write.commandId,
          request_id: write.requestId,
          request_digest: write.requestDigest,
          idempotency_key: write.commandId,
          thread_version_after: version,
          unanswered_user_messages_after: 0,
          created_at: occurredAt,
        })
        .execute();
    }
    const unanswered = await countUnanswered(database, thread.user_id);
    await database
      .insertInto('platform.audit_logs')
      .values({
        id: write.auditId,
        category: 'admin',
        event_type: `support.thread-${action === 'reply' ? 'replied' : 'closed'}.v1`,
        actor_type: 'admin',
        actor_user_id: null,
        actor_admin_id: write.adminUserId,
        subject_type: 'support_thread',
        subject_id: write.supportThreadId,
        result_code: `support_${action === 'reply' ? 'replied' : 'closed'}`,
        metadata_schema_version: 1,
        metadata: { status, version, unansweredUserMessages: unanswered },
        request_id: write.requestId,
        command_id: write.commandId,
        occurred_at: occurredAt,
      })
      .execute();
    await insertEvent(database, {
      eventId: write.eventId,
      threadId: write.supportThreadId,
      userId: thread.user_id,
      status,
      version,
      unanswered,
      occurredAt,
      requestId: write.requestId,
      commandId: write.commandId,
    });
    return {
      supportThreadId: write.supportThreadId,
      status,
      unansweredUserMessages: unanswered,
      version,
      changedAt: occurredAt,
      replayed: false,
    };
  }
}

/** Production composition: support mutation and immutable admin attempt share one commit. */
export class PostgresSupportAdminWorkflow extends SupportAdminWorkflow<NakhDatabase> {
  public constructor(database: NakhDatabase) {
    super(
      new PostgresAdminCommandStore(database),
      new PostgresSupportStore(database),
      new SystemIdGenerator(),
    );
  }
}
