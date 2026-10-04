import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalAdminPairTargetId,
  type UserSupportWrite,
  type AdminCommandAttempt,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createReportUser, createReportFixtureAdmin } from './testing/report-fixture.js';
import { reconciliationCursorBefore } from './testing/reconciliation-cursor.js';
import { PostgresSupportStore, PostgresSupportAdminWorkflow } from './support-store.js';
import { scanSupportThreads, scanInternalBlocks } from './moderation-safety-reconciliation.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M7 safety reconciliation metadata', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 10,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
  });
  it('uses the shared cross-thread support limit and honors an audited reply reset', async () => {
    const userId = await createReportUser(database),
      adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'support',
        assigned_by_admin_id: adminId,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    const store = new PostgresSupportStore(database),
      threadId = randomUUID();
    const write = (id: string): UserSupportWrite => ({
      userId,
      supportThreadId: id,
      messageId: randomUUID(),
      eventId: randomUUID(),
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestDigest: 'a'.repeat(64),
      normalizedText: 'Private shared support text',
    });
    await store.open(write(threadId));
    await store.open(write(randomUUID()));
    const cursor = {
      phase: 'support_threads' as const,
      lastId: reconciliationCursorBefore(threadId),
    };
    expect((await scanSupportThreads(database, cursor, 1)).findings).toEqual([]);
    const message = await database
      .selectFrom('support.support_messages')
      .selectAll()
      .where('support_thread_id', '=', threadId)
      .executeTakeFirstOrThrow();
    const corruptId = randomUUID();
    await database
      .insertInto('support.support_messages')
      .values({
        ...message,
        id: corruptId,
        command_id: randomUUID(),
        idempotency_key: randomUUID(),
        unanswered_user_messages_after: 2,
      })
      .execute();
    try {
      const drift = await scanSupportThreads(database, cursor, 1);
      expect(drift.findings).toEqual([
        {
          anomalyType: 'support_unanswered_limit_mismatch',
          entityType: 'support_thread',
          entityId: threadId,
          keyId: threadId,
          safeDetail: {},
        },
      ]);
      expect(JSON.stringify(drift)).not.toContain('Private');
      expect(JSON.stringify(drift)).not.toContain(userId);
      const attempt: AdminCommandAttempt = {
        logId: randomUUID(),
        adminUserId: adminId,
        commandId: randomUUID(),
        requestId: randomUUID(),
        requestDigest: 'b'.repeat(64),
        commandCode: 'support.reply-thread',
        requiredPermission: 'review_support',
        targetType: 'support_thread',
        targetId: threadId,
        expectedTargetVersion: 1,
        reasonDigest: 'c'.repeat(64),
        metadata: {},
        correlationId: randomUUID(),
      };
      expect(
        (await new PostgresSupportAdminWorkflow(database).reply(attempt, 'Private reset reply'))
          .result,
      ).toBe('succeeded');
      expect((await scanSupportThreads(database, cursor, 1)).findings).toEqual([]);
    } finally {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role = replica`.execute(connection);
        try {
          await connection
            .deleteFrom('support.support_messages')
            .where('id', '=', corruptId)
            .execute();
        } finally {
          await sql`SET session_replication_role = origin`.execute(connection);
        }
      });
    }
  });
  it('paginates blocked pairs sharing one lower user and records only an opaque pair finding', async () => {
    const users = (
      await Promise.all(Array.from({ length: 3 }, () => createReportUser(database)))
    ).sort();
    const [low, highA, highB] = users as [string, string, string];
    const now = new Date(),
      likeId = randomUUID();
    await database
      .insertInto('interaction.user_pair_states')
      .values(
        [highA, highB].map((high) => ({
          user_low_id: low,
          user_high_id: high,
          state: 'blocked' as const,
          reason_code: 'admin_internal_block',
          changed_at: now,
        })),
      )
      .execute();
    await database.connection().execute(async (connection) => {
      await sql`SET session_replication_role = replica`.execute(connection);
      try {
        await connection
          .insertInto('interaction.likes')
          .values({
            id: likeId,
            sender_user_id: low,
            receiver_user_id: highA,
            status: 'active',
            created_at: now,
            closed_at: null,
          })
          .execute();
      } finally {
        await sql`SET session_replication_role = origin`.execute(connection);
      }
    });
    try {
      const first = await scanInternalBlocks(
        database,
        {
          phase: 'internal_blocks',
          lastId: low,
          lastPairHighId: reconciliationCursorBefore(highA),
        },
        1,
      );
      const pairId = canonicalAdminPairTargetId({ userLowId: low, userHighId: highA });
      expect(first.findings).toEqual([
        {
          anomalyType: 'internal_block_active_relationship',
          entityType: 'internal_block',
          entityId: pairId,
          keyId: pairId,
          safeDetail: {},
        },
      ]);
      for (const id of users) expect(JSON.stringify(first.findings)).not.toContain(id);
      expect(first.nextCursor).toEqual({
        phase: 'internal_blocks',
        lastId: low,
        lastPairHighId: highA,
      });
      const next = await scanInternalBlocks(database, first.nextCursor!, 1);
      expect(next.scannedCount).toBe(1);
      expect(next.findings).toEqual([]);
      expect(next.nextCursor?.lastPairHighId).toBe(highB);
    } finally {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role = replica`.execute(connection);
        try {
          await connection.deleteFrom('interaction.likes').where('id', '=', likeId).execute();
        } finally {
          await sql`SET session_replication_role = origin`.execute(connection);
        }
      });
    }
  });
});
