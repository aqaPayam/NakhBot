import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  AppealUnbanWorkflow,
  type AdminCommandAttempt,
  type UserAppealWrite,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresAppealStore } from './appeal-store.js';
import { PostgresAppealReviewWorkflow } from './appeal-review-store.js';
import { PostgresAppealUnbanStore, PostgresAppealUnbanWorkflow } from './appeal-unban-store.js';
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

async function createAdmin(database: NakhDatabase, role: string = 'moderator'): Promise<string> {
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
  review = false,
  version = 2,
): AdminCommandAttempt {
  return {
    logId: randomUUID(),
    adminUserId,
    commandId: randomUUID(),
    requestId: randomUUID(),
    requestDigest: 'b'.repeat(64),
    commandCode: review ? 'moderation.review-appeal' : 'moderation.unban-appeal',
    requiredPermission: review ? 'review_appeals' : 'unban_user',
    targetType: 'user_appeal',
    targetId: appealId,
    expectedTargetVersion: review ? 1 : version,
    reasonDigest: 'c'.repeat(64),
    metadata: {},
    correlationId: randomUUID(),
  };
}
describe.skipIf(databaseUrl === undefined)('M7 separate appeal-authorized unban', () => {
  let database: NakhDatabase, workflow: PostgresAppealUnbanWorkflow;
  let server: pg.Pool;
  const databaseName = `nakh_appeal_unban_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  beforeAll(async () => {
    // The appeal-only test role must never change the shared database's code-owned role catalog.
    server = new pg.Pool({ connectionString: databaseUrl! });
    await server.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.pathname = `/${databaseName}`;
    await runMigrations(isolatedUrl.toString(), resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolatedUrl.toString(),
      poolMax: 20,
      statementTimeoutMs: 10000,
      lockTimeoutMs: 5000,
    });
    workflow = new PostgresAppealUnbanWorkflow(database);
  });
  afterAll(async () => {
    await database?.destroy();
    try {
      if (created) await server.query(`DROP DATABASE "${databaseName}"`);
    } finally {
      await server?.end();
    }
  });
  async function submitted(): Promise<UserAppealWrite> {
    const user = await createUser(database),
      history = await ban(database, user),
      input = write(user, history);
    await new PostgresAppealStore(database).submit(input);
    return input;
  }
  async function accept(input: UserAppealWrite, admin: string): Promise<void> {
    expect(
      await new PostgresAppealReviewWorkflow(database).review(
        attempt(admin, input.appealId, true),
        'accepted',
      ),
    ).toMatchObject({ result: 'succeeded' });
  }
  it('requires separate unban permission even when that admin accepted the appeal', async () => {
    const role = 'appeal_only_' + randomUUID().replaceAll('-', '');
    await database
      .insertInto('administration.admin_roles')
      .values({ code: role, description: 'Test appeal-only reviewer' })
      .execute();
    await database
      .insertInto('administration.admin_role_permissions')
      .values({ role_code: role, permission_code: 'review_appeals' })
      .execute();
    const reviewer = await createAdmin(database, role),
      admin = await createAdmin(database),
      input = await submitted();
    await accept(input, reviewer);
    const denied = attempt(reviewer, input.appealId);
    await expect(workflow.unban(denied, 2)).resolves.toMatchObject({
      result: 'rejected',
      safeCode: 'forbidden',
    });
    expect(
      await database
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', input.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'banned' });
    const command = attempt(admin, input.appealId);
    await expect(workflow.unban(command, 2)).resolves.toMatchObject({
      result: 'succeeded',
      value: { previousState: 'banned', nextState: 'active', accountVersion: 3 },
    });
    await expect(workflow.unban(command, 2)).resolves.toMatchObject({
      result: 'succeeded',
      replayed: true,
    });
    await expect(workflow.unban(command, 3)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    const proof = await database
      .selectFrom('moderation.appeal_unbans')
      .selectAll()
      .where('appeal_id', '=', input.appealId)
      .executeTakeFirstOrThrow();
    expect(proof.admin_action_log_id).toBe(command.logId);
    expect(
      await database
        .selectFrom('identity.account_state_history')
        .select(['previous_state', 'next_state'])
        .where('id', '=', proof.unban_history_id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ previous_state: 'banned', next_state: 'active' });
    expect(
      await database
        .selectFrom('moderation.moderation_actions')
        .select(['action_type', 'target_user_id'])
        .where('id', '=', proof.action_id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ action_type: 'unban_user', target_user_id: input.userId });
    const notices = await database
      .selectFrom('notification.notifications')
      .select('id')
      .where('user_id', '=', input.userId)
      .execute();
    expect(notices).toHaveLength(1);
    expect(
      await database
        .selectFrom('notification.notification_deliveries')
        .select('id')
        .where('notification_id', '=', notices[0]!.id)
        .execute(),
    ).toHaveLength(1);
    const events = await database
      .selectFrom('platform.outbox_events')
      .select(['event_type', 'payload'])
      .where('causation_id', '=', command.commandId)
      .execute();
    expect(events.map((e) => e.event_type).sort()).toEqual([
      'identity.account-state-changed.v1',
      'moderation.action-recorded.v1',
      'notification.delivery-requested.v1',
    ]);
    expect(JSON.stringify(events)).not.toContain(input.normalizedText);
    await expect(
      database
        .deleteFrom('moderation.appeal_unbans')
        .where('appeal_id', '=', input.appealId)
        .execute(),
    ).rejects.toThrow();
  });
  it('rejects pending/rejected appeals and stale versions, and never reuses acceptance for a later ban', async () => {
    const admin = await createAdmin(database),
      pending = await submitted();
    await expect(
      workflow.unban(attempt(admin, pending.appealId, false, 1), 2),
    ).resolves.toMatchObject({ result: 'rejected', safeCode: 'conflict' });
    await new PostgresAppealReviewWorkflow(database).review(
      attempt(admin, pending.appealId, true),
      'rejected',
    );
    await expect(workflow.unban(attempt(admin, pending.appealId), 2)).resolves.toMatchObject({
      result: 'rejected',
      safeCode: 'conflict',
    });
    const input = await submitted();
    await accept(input, admin);
    await expect(
      workflow.unban(attempt(admin, input.appealId, false, 1), 2),
    ).resolves.toMatchObject({ result: 'rejected', safeCode: 'version_conflict' });
    await expect(workflow.unban(attempt(admin, input.appealId), 99)).resolves.toMatchObject({
      result: 'rejected',
      safeCode: 'version_conflict',
    });
    await expect(workflow.unban(attempt(admin, input.appealId), 2)).resolves.toMatchObject({
      result: 'succeeded',
    });
    const laterBan = await ban(database, input.userId);
    await expect(workflow.unban(attempt(admin, input.appealId), 4)).resolves.toMatchObject({
      result: 'rejected',
      safeCode: 'conflict',
    });
    const second = write(input.userId, laterBan);
    await new PostgresAppealStore(database).submit(second);
    await accept(second, admin);
    await expect(workflow.unban(attempt(admin, second.appealId), 4)).resolves.toMatchObject({
      result: 'succeeded',
      value: { accountVersion: 5 },
    });
    expect(
      await database
        .selectFrom('moderation.user_appeals')
        .select('id')
        .where('user_id', '=', input.userId)
        .execute(),
    ).toHaveLength(2);
  });
  it('admits one account effect across independent concurrent unban commands', async () => {
    const input = await submitted(),
      admins = await Promise.all(Array.from({ length: 6 }, () => createAdmin(database)));
    await accept(input, admins[0]!);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commands = admins.map((admin) => attempt(admin, input.appealId));
    const racers = commands.map(async (command) => {
      await barrier;
      return workflow.unban(command, 2);
    });
    release();
    const results = await Promise.all(racers);
    expect(results.filter((r) => r.result === 'succeeded')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'rejected')).toHaveLength(5);
    expect(
      await database
        .selectFrom('moderation.appeal_unbans')
        .select('appeal_id')
        .where('appeal_id', '=', input.appealId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where(
          'command_id',
          'in',
          commands.map((c) => c.commandId),
        )
        .execute(),
    ).toHaveLength(6);
    expect(
      await database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', '=', input.userId)
        .execute(),
    ).toHaveLength(1);
  });
  it('rolls back the entire account effect and proof on failure, then permits a new command', async () => {
    const input = await submitted(),
      admin = await createAdmin(database);
    await accept(input, admin);
    const command = attempt(admin, input.appealId),
      real = new PostgresAppealUnbanStore();
    const faulty = new AppealUnbanWorkflow(
      new PostgresAdminCommandStore(database),
      {
        unban: async (tx: NakhDatabase, input: Parameters<typeof real.unban>[1]) => {
          await real.unban(tx, input);
          throw new Error('injected after account transition');
        },
      },
      { uuid: randomUUID },
    );
    await expect(faulty.unban(command, 2)).resolves.toMatchObject({
      result: 'failed',
      safeCode: 'internal_error',
    });
    await expect(workflow.unban(command, 2)).resolves.toMatchObject({
      result: 'failed',
      replayed: true,
    });
    expect(
      await database
        .selectFrom('identity.accounts')
        .select(['state', 'version'])
        .where('user_id', '=', input.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'banned', version: 2 });
    expect(
      await database
        .selectFrom('moderation.appeal_unbans')
        .select('appeal_id')
        .where('appeal_id', '=', input.appealId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', '=', input.userId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('causation_id', '=', command.commandId)
        .execute(),
    ).toHaveLength(0);
    await expect(workflow.unban(attempt(admin, input.appealId), 2)).resolves.toMatchObject({
      result: 'succeeded',
    });
  });
});
