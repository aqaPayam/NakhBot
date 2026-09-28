import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  AppealReviewWorkflow,
  type AdminCommandAttempt,
  type UserAppealWrite,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresAppealStore } from './appeal-store.js';
import { PostgresAppealReviewStore, PostgresAppealReviewWorkflow } from './appeal-review-store.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
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

async function ban(database: NakhDatabase, userId: string): Promise<string> {
  const id = randomUUID();
  await database.transaction().execute(async (tx) => {
    const account = await tx
      .selectFrom('identity.accounts')
      .selectAll()
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const now = new Date(Math.max(Date.now(), account.state_changed_at.getTime() + 1));
    await tx
      .updateTable('identity.accounts')
      .set({
        state: 'banned',
        state_reason: 'test_ban',
        state_changed_at: now,
        version: account.version + 1,
      })
      .where('user_id', '=', userId)
      .execute();
    await tx
      .insertInto('identity.account_state_history')
      .values({
        id,
        user_id: userId,
        previous_state: account.state,
        next_state: 'banned',
        reason_code: 'test_ban',
        actor_type: 'system',
        actor_user_id: null,
        actor_admin_id: null,
        changed_at: now,
      })
      .execute();
  });
  return id;
}
function write(userId: string, banHistoryId: string): UserAppealWrite {
  const commandId = randomUUID();
  return {
    userId,
    banHistoryId,
    commandId,
    appealId: randomUUID(),
    eventId: randomUUID(),
    requestId: randomUUID(),
    idempotencyKey: commandId,
    requestDigest: createHash('sha256').update(commandId).digest('hex'),
    normalizedText: 'Restricted appeal text',
  };
}

async function createAdmin(
  database: NakhDatabase,
  role: 'moderator' | 'support' = 'moderator',
): Promise<string> {
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
      role_code: role,
      assigned_by_admin_id: adminUserId,
      revoked_by_admin_id: null,
      revoked_at: null,
    })
    .execute();
  return adminUserId;
}

function attempt(
  adminUserId: string,
  appealId: string,
  expectedTargetVersion = 1,
): AdminCommandAttempt {
  return {
    logId: randomUUID(),
    adminUserId,
    commandId: randomUUID(),
    requestId: randomUUID(),
    requestDigest: 'b'.repeat(64),
    commandCode: 'moderation.review-appeal',
    requiredPermission: 'review_appeals',
    targetType: 'user_appeal',
    targetId: appealId,
    expectedTargetVersion,
    reasonDigest: 'c'.repeat(64),
    metadata: {},
    correlationId: randomUUID(),
  };
}
describe.skipIf(databaseUrl === undefined)('M7 audited appeal review', () => {
  let database: NakhDatabase, workflow: PostgresAppealReviewWorkflow;
  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 20,
      statementTimeoutMs: 10000,
      lockTimeoutMs: 5000,
    });
    workflow = new PostgresAppealReviewWorkflow(database);
  });
  afterAll(async () => {
    await database?.destroy();
  });
  async function submitted(): Promise<UserAppealWrite> {
    const userId = await createUser(database),
      banId = await ban(database, userId);
    const input = write(userId, banId);
    await new PostgresAppealStore(database).submit(input);
    return input;
  }
  it('accepts without unbanning, replays once, binds decision/note and keeps text out of audit/outbox', async () => {
    const input = await submitted(),
      admin = await createAdmin(database),
      command = attempt(admin, input.appealId);
    await expect(
      workflow.review(command, 'accepted', '  Private review note  '),
    ).resolves.toMatchObject({ result: 'succeeded', value: { status: 'accepted', version: 2 } });
    await expect(
      workflow.review(command, 'accepted', '  Private review note  '),
    ).resolves.toMatchObject({ result: 'succeeded', replayed: true });
    await expect(
      workflow.review(command, 'rejected', '  Private review note  '),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(workflow.review(command, 'accepted', 'changed')).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    const account = await database
      .selectFrom('identity.accounts')
      .select(['state', 'version'])
      .where('user_id', '=', input.userId)
      .executeTakeFirstOrThrow();
    expect(account).toEqual({ state: 'banned', version: 2 });
    const appeal = await database
      .selectFrom('moderation.user_appeals')
      .selectAll()
      .where('id', '=', input.appealId)
      .executeTakeFirstOrThrow();
    expect(appeal).toMatchObject({
      status: 'accepted',
      admin_note: 'Private review note',
      reviewed_by_admin_id: admin,
      version: 2,
    });
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .selectAll()
      .where('command_id', '=', command.commandId)
      .execute();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.result).toBe('succeeded');
    const audits = await database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('command_id', '=', command.commandId)
      .execute();
    const events = await database
      .selectFrom('platform.outbox_events')
      .selectAll()
      .where('causation_id', '=', command.commandId)
      .execute();
    expect(audits).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(JSON.stringify([logs, audits, events])).not.toContain('Private review note');
    expect(JSON.stringify([logs, audits, events])).not.toContain(input.normalizedText);
    expect(
      await database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', '=', input.userId)
        .execute(),
    ).toHaveLength(0);
    await expect(
      workflow.review(attempt(admin, input.appealId, 2), 'rejected'),
    ).resolves.toMatchObject({ result: 'rejected', safeCode: 'conflict' });
    await expect(new PostgresAppealStore(database).submit(input)).resolves.toMatchObject({
      status: 'submitted',
      version: 1,
      replayed: true,
    });
  });
  it('records missing permission, disabled admin, invalid note, stale target and terminal rejection', async () => {
    const input = await submitted(),
      admin = await createAdmin(database),
      support = await createAdmin(database, 'support');
    const denied = attempt(support, input.appealId),
      invalid = attempt(admin, input.appealId),
      stale = attempt(admin, input.appealId, 9);
    await expect(workflow.review(denied, 'accepted')).resolves.toMatchObject({
      result: 'rejected',
      safeCode: 'forbidden',
    });
    await expect(workflow.review(invalid, 'accepted', 'x'.repeat(2001))).resolves.toMatchObject({
      result: 'rejected',
    });
    await expect(workflow.review(stale, 'accepted')).resolves.toMatchObject({
      result: 'rejected',
      safeCode: 'version_conflict',
    });
    await expect(
      workflow.review(attempt(admin, input.appealId), 'rejected'),
    ).resolves.toMatchObject({ result: 'succeeded' });
    await expect(
      workflow.review(attempt(admin, input.appealId, 2), 'accepted'),
    ).resolves.toMatchObject({ result: 'rejected' });
    await expect(
      new PostgresAppealStore(database).submit(write(input.userId, input.banHistoryId)),
    ).rejects.toMatchObject({ code: 'conflict' });
    const disabled = await createAdmin(database);
    await database
      .updateTable('administration.admin_users')
      .set({
        is_active: false,
        disabled_at: sql<Date>`updated_at + interval '1 millisecond'`,
        updated_at: sql<Date>`updated_at + interval '1 millisecond'`,
        version: 2,
      })
      .where('id', '=', disabled)
      .execute();
    await expect(
      workflow.review(attempt(disabled, input.appealId), 'accepted'),
    ).resolves.toMatchObject({ result: 'rejected', safeCode: 'forbidden' });
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .select('result')
      .where('target_id', '=', input.appealId)
      .execute();
    expect(logs).toHaveLength(6);
    expect(logs.filter((l) => l.result === 'rejected')).toHaveLength(5);
  });
  it('rolls back an injected post-effect failure and commits only the failed attempt', async () => {
    const input = await submitted(),
      admin = await createAdmin(database),
      command = attempt(admin, input.appealId);
    const real = new PostgresAppealReviewStore();
    const faulty = new AppealReviewWorkflow(
      new PostgresAdminCommandStore(database),
      {
        review: async (tx: NakhDatabase, reviewWrite: Parameters<typeof real.review>[1]) => {
          await real.review(tx, reviewWrite);
          throw new Error('private injected failure');
        },
      },
      { uuid: randomUUID },
    );
    await expect(faulty.review(command, 'accepted')).resolves.toMatchObject({
      result: 'failed',
      safeCode: 'internal_error',
    });
    await expect(faulty.review(command, 'accepted')).resolves.toMatchObject({
      result: 'failed',
      replayed: true,
    });
    const row = await database
      .selectFrom('moderation.user_appeals')
      .select(['status', 'version'])
      .where('id', '=', input.appealId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'submitted', version: 1 });
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('command_id', '=', command.commandId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('causation_id', '=', command.commandId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('command_id', '=', command.commandId)
        .execute(),
    ).toHaveLength(1);
  });
  it('serializes independent reviewers into one decision with one result per attempt', async () => {
    const input = await submitted();
    const admins = await Promise.all(Array.from({ length: 6 }, () => createAdmin(database)));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racers = admins.map(async (admin, index) => {
      await barrier;
      return workflow.review(
        attempt(admin, input.appealId),
        index % 2 === 0 ? 'accepted' : 'rejected',
      );
    });
    release();
    const results = await Promise.all(racers);
    expect(results.filter((r) => r.result === 'succeeded')).toHaveLength(1);
    expect(
      results.filter((r) => r.result === 'rejected' && r.safeCode === 'version_conflict'),
    ).toHaveLength(5);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('target_id', '=', input.appealId)
        .execute(),
    ).toHaveLength(6);
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', input.appealId)
        .execute(),
    ).toHaveLength(1);
  });
});
