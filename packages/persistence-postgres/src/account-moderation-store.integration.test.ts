import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminCommandAttempt, AccountModerationAction } from '@nakh/application';
import type { M7Permission } from '@nakh/domain';

import { PostgresAccountModerationWorkflow } from './account-moderation-store.js';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import type { ApplyAccountModerationActionCommand } from '@nakh/contracts';
import { PostgresConfirmedAccountActions } from './confirmed-account-store.js';
import { confirmationFixture } from './testing/admin-confirmation.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createUser(database: NakhDatabase, withAccount = false): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  if (withAccount)
    await database
      .insertInto('identity.accounts')
      .values({ user_id: id, state: 'active', state_reason: null, state_changed_at: now })
      .execute();
  return id;
}

async function createAdmin(database: NakhDatabase, role: 'moderator' | 'support'): Promise<string> {
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
  targetUserId: string,
  action: AccountModerationAction,
  expectedTargetVersion: number,
  permission: M7Permission = action,
): AdminCommandAttempt {
  const commandId = randomUUID();
  return {
    logId: randomUUID(),
    adminUserId,
    commandId,
    requestId: randomUUID(),
    requestDigest: digest(`${commandId}:${action}:${targetUserId}:${expectedTargetVersion}`),
    commandCode: 'moderation.apply-account-action',
    requiredPermission: permission,
    targetType: 'user',
    targetId: targetUserId,
    expectedTargetVersion,
    reasonDigest: digest('reviewed safety action'),
    metadata: {},
    correlationId: randomUUID(),
  };
}

describe.skipIf(databaseUrl === undefined)('M7 account moderation lifecycle', () => {
  let database: NakhDatabase;
  let workflow: PostgresAccountModerationWorkflow;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 10,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
    workflow = new PostgresAccountModerationWorkflow(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });
  it('confirms each account action separately, serializes replay and audits revoked admin access', async () => {
    const adminId = await createAdmin(database, 'moderator'),
      targetId = await createUser(database, true);
    const f = await confirmationFixture(database, adminId);
    const commands = new PostgresConfirmedAccountActions(database, f.tokens, f.key);
    let version = 1;
    for (const action of ['restrict_user', 'unrestrict_user', 'ban_user', 'unban_user'] as const) {
      const adminActionToken = await f.issue({
        commandCode: 'moderation.apply-account-action',
        requiredPermission: action,
        targetType: 'user',
        targetId,
        expectedTargetVersion: version,
      });
      const command: ApplyAccountModerationActionCommand = {
        actor: f.actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        commandType: 'moderation.apply-account-action',
        schemaVersion: 1,
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          adminActionToken,
          confirmationToken: '',
          expectedTargetVersion: version,
          reason: 'Restricted account reason',
          action,
        },
      };
      expect(await commands.execute(command, f.actor)).toMatchObject({
        result: 'rejected',
        safeCode: 'invalid_request',
      });
      command.commandId = randomUUID();
      command.data.confirmationToken = await commands.prepare(command, f.actor);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => commands.execute(command, f.actor)),
      );
      expect(results.every((r) => r.result === 'succeeded')).toBe(true);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      version++;
      const account = await database
        .selectFrom('identity.accounts')
        .select('version')
        .where('user_id', '=', targetId)
        .executeTakeFirstOrThrow();
      expect(account.version).toBe(version);
    }
    const token = await f.issue({
      commandCode: 'moderation.apply-account-action',
      requiredPermission: 'ban_user',
      targetType: 'user',
      targetId,
      expectedTargetVersion: version,
    });
    const disabled: ApplyAccountModerationActionCommand = {
      actor: f.actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'moderation.apply-account-action',
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: token,
        confirmationToken: '',
        expectedTargetVersion: version,
        reason: 'Restricted account reason',
        action: 'ban_user',
      },
    };
    disabled.data.confirmationToken = await commands.prepare(disabled, f.actor);
    await database
      .updateTable('administration.admin_users')
      .set({
        is_active: false,
        disabled_at: sql<Date>`updated_at + interval '1 millisecond'`,
        updated_at: sql<Date>`updated_at + interval '1 millisecond'`,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', adminId)
      .execute();
    expect(await commands.execute(disabled, f.actor)).toMatchObject({
      result: 'rejected',
      safeCode: 'forbidden',
    });
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .selectAll()
      .where('admin_user_id', '=', adminId)
      .execute();
    expect(logs).toHaveLength(9);
    expect(JSON.stringify(logs)).not.toContain('Restricted account reason');
  });

  it('reverses restrict and ban paths with complete critical safety facts and replay protection', async () => {
    const adminUserId = await createAdmin(database, 'moderator');
    const targetUserId = await createUser(database, true);
    const commands = [
      attempt(adminUserId, targetUserId, 'restrict_user', 1),
      attempt(adminUserId, targetUserId, 'ban_user', 2),
      attempt(adminUserId, targetUserId, 'unban_user', 3),
      attempt(adminUserId, targetUserId, 'unrestrict_user', 4),
    ] as const;

    const restricted = await workflow.apply(commands[0], 'restrict_user');
    expect(restricted).toMatchObject({
      result: 'succeeded',
      safeCode: 'account_restrict_user',
      value: { previousState: 'active', nextState: 'restricted', accountVersion: 2 },
    });
    await expect(workflow.apply(commands[0], 'restrict_user')).resolves.toMatchObject({
      result: 'succeeded',
      replayed: true,
      value: undefined,
    });
    await expect(workflow.apply(commands[1], 'ban_user')).resolves.toMatchObject({
      result: 'succeeded',
      value: { previousState: 'restricted', nextState: 'banned', accountVersion: 3 },
    });
    await expect(workflow.apply(commands[2], 'unban_user')).resolves.toMatchObject({
      result: 'succeeded',
      value: { previousState: 'banned', nextState: 'restricted', accountVersion: 4 },
    });
    await expect(workflow.apply(commands[3], 'unrestrict_user')).resolves.toMatchObject({
      result: 'succeeded',
      value: { previousState: 'restricted', nextState: 'active', accountVersion: 5 },
    });

    const account = await database
      .selectFrom('identity.accounts')
      .select(['state', 'state_reason', 'version'])
      .where('user_id', '=', targetUserId)
      .executeTakeFirstOrThrow();
    const histories = await database
      .selectFrom('identity.account_state_history')
      .select(['previous_state', 'next_state', 'actor_type', 'actor_admin_id'])
      .where('user_id', '=', targetUserId)
      .orderBy('changed_at')
      .execute();
    const actions = await database
      .selectFrom('moderation.moderation_actions')
      .select(['action_type', 'actor_type', 'actor_admin_id', 'request_digest'])
      .where('target_user_id', '=', targetUserId)
      .orderBy('occurred_at')
      .execute();
    const notifications = await database
      .selectFrom('notification.notifications')
      .select(['id', 'notification_type', 'category', 'payload'])
      .where('user_id', '=', targetUserId)
      .execute();
    const deliveries = await database
      .selectFrom('notification.notification_deliveries')
      .select('id')
      .where(
        'notification_id',
        'in',
        notifications.map(({ id }) => id),
      )
      .execute();
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('event_type')
      .where(
        'causation_id',
        'in',
        commands.map(({ commandId }) => commandId),
      )
      .execute();
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .select(['result', 'safe_code'])
      .where(
        'command_id',
        'in',
        commands.map(({ commandId }) => commandId),
      )
      .execute();

    expect(account).toEqual({ state: 'active', state_reason: 'admin_unrestrict_user', version: 5 });
    expect(histories.map(({ previous_state, next_state }) => [previous_state, next_state])).toEqual(
      [
        ['active', 'restricted'],
        ['restricted', 'banned'],
        ['banned', 'restricted'],
        ['restricted', 'active'],
      ],
    );
    expect(
      histories.every(
        ({ actor_type, actor_admin_id }) =>
          actor_type === 'admin' && actor_admin_id === adminUserId,
      ),
    ).toBe(true);
    expect(actions.map(({ action_type }) => action_type)).toEqual([
      'restrict_user',
      'ban_user',
      'unban_user',
      'unrestrict_user',
    ]);
    expect(
      actions.every(
        ({ actor_type, actor_admin_id, request_digest }) =>
          actor_type === 'admin' && actor_admin_id === adminUserId && request_digest.length === 64,
      ),
    ).toBe(true);
    expect(notifications).toHaveLength(4);
    expect(notifications.every(({ payload }) => Object.keys(payload).length === 0)).toBe(true);
    expect(deliveries).toHaveLength(4);
    expect(events).toHaveLength(12);
    expect(logs).toHaveLength(4);
    expect(logs.every(({ result }) => result === 'succeeded')).toBe(true);
  });

  it('serializes competing target versions and records the losing attempt without partial effects', async () => {
    const adminUserId = await createAdmin(database, 'moderator');
    const targetUserId = await createUser(database, true);
    const restrict = attempt(adminUserId, targetUserId, 'restrict_user', 1);
    const ban = attempt(adminUserId, targetUserId, 'ban_user', 1);
    const results = await Promise.all([
      workflow.apply(restrict, 'restrict_user'),
      workflow.apply(ban, 'ban_user'),
    ]);

    expect(results.filter(({ result }) => result === 'succeeded')).toHaveLength(1);
    expect(results.filter(({ safeCode }) => safeCode === 'version_conflict')).toHaveLength(1);
    expect(
      await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('target_user_id', '=', targetUserId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select(['result', 'safe_code'])
        .where('command_id', 'in', [restrict.commandId, ban.commandId])
        .orderBy('result')
        .execute(),
    ).toEqual([
      { result: 'rejected', safe_code: 'version_conflict' },
      expect.objectContaining({ result: 'succeeded' }),
    ]);
  });

  it('denies a missing exact permission before touching the target account', async () => {
    const adminUserId = await createAdmin(database, 'support');
    const targetUserId = await createUser(database, true);
    const command = attempt(adminUserId, targetUserId, 'ban_user', 1);
    await expect(workflow.apply(command, 'ban_user')).resolves.toMatchObject({
      result: 'rejected',
      safeCode: 'forbidden',
      value: undefined,
    });
    await expect(
      database
        .selectFrom('identity.accounts')
        .select(['state', 'version'])
        .where('user_id', '=', targetUserId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: 'active', version: 1 });
    expect(
      await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('target_user_id', '=', targetUserId)
        .execute(),
    ).toHaveLength(0);
  });
});
