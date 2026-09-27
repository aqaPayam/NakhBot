import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { runMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe.skipIf(databaseUrl === undefined)('M7 administration schema', () => {
  let database: NakhDatabase;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 5,
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 1_000,
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('installs explicit least-privilege role and permission seeds', async () => {
    const roles = await database
      .selectFrom('administration.admin_roles')
      .select(['code', 'is_active'])
      .orderBy('code')
      .execute();
    expect(roles).toEqual([
      { code: 'moderator', is_active: true },
      { code: 'super_admin', is_active: true },
      { code: 'support', is_active: true },
    ]);

    const mappings = await database
      .selectFrom('administration.admin_role_permissions')
      .select(['role_code', 'permission_code'])
      .execute();
    expect(mappings.filter((mapping) => mapping.role_code === 'super_admin')).toHaveLength(14);
    expect(mappings.filter((mapping) => mapping.role_code === 'moderator')).toHaveLength(13);
    expect(
      mappings
        .filter((mapping) => mapping.role_code === 'support')
        .map((mapping) => mapping.permission_code)
        .sort(),
    ).toEqual(['review_support', 'view_user_profile']);
  });

  it('binds admins to authenticated Telegram identities and retains append-only attempts', async () => {
    const userId = randomUUID();
    const adminUserId = randomUUID();
    const telegramUserId = String(2_000_000_000 + Math.floor(Math.random() * 7_000_000_000));
    const now = new Date('2026-09-27T12:00:00.000Z');
    await database
      .insertInto('identity.users')
      .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
      .execute();
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

    await expect(
      database
        .insertInto('administration.admin_users')
        .values({
          id: randomUUID(),
          user_id: userId,
          telegram_user_id: String(Number(telegramUserId) + 1),
          is_active: true,
          disabled_at: null,
          identity_verified_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow('admin identity must match');

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
        role_code: 'super_admin',
        assigned_by_admin_id: adminUserId,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();

    const authorization = new PostgresAdminAuthorizationStore(database);
    const authorized = await authorization.loadByTelegramIdentity({
      actorUserId: userId,
      telegramUserId,
    });
    expect(authorized).toMatchObject({ adminUserId, actorUserId: userId, adminActive: true });
    expect(authorized?.activePermissions).toHaveLength(14);
    expect(authorized?.activePermissions).toContain('ban_user');
    expect(authorized?.activePermissions).toContain('unban_user');
    expect(authorized?.activePermissions).toContain('view_reports');
    await expect(
      authorization.loadByTelegramIdentity({
        actorUserId: userId,
        telegramUserId: String(Number(telegramUserId) + 1),
      }),
    ).resolves.toBeUndefined();

    const actionLogId = randomUUID();
    await database
      .insertInto('administration.admin_action_logs')
      .values({
        id: actionLogId,
        admin_user_id: adminUserId,
        command_id: randomUUID(),
        request_id: randomUUID(),
        request_digest: digest('request'),
        command_code: 'administration.bootstrap_admin',
        target_type: 'admin_user',
        target_id: adminUserId,
        expected_target_version: null,
        result: 'succeeded',
        safe_code: 'admin_bootstrapped',
        reason_digest: digest('approved bootstrap'),
        metadata: {},
        correlation_id: randomUUID(),
      })
      .execute();

    await expect(
      database
        .updateTable('administration.admin_action_logs')
        .set({ safe_code: 'changed' })
        .where('id', '=', actionLogId)
        .execute(),
    ).rejects.toThrow('append-only');
    await expect(
      database.deleteFrom('administration.admin_users').where('id', '=', adminUserId).execute(),
    ).rejects.toThrow('retained workforce identity');

    const changedAt = new Date(Date.now() + 60_000);
    await database
      .updateTable('administration.admin_user_roles')
      .set({
        revoked_by_admin_id: adminUserId,
        revoked_at: changedAt,
      })
      .where('admin_user_id', '=', adminUserId)
      .where('role_code', '=', 'super_admin')
      .executeTakeFirstOrThrow();
    await expect(
      authorization.loadCurrent({ adminUserId, actorUserId: userId }),
    ).resolves.toMatchObject({ adminActive: true, activePermissions: [] });

    await database
      .updateTable('administration.admin_users')
      .set({
        is_active: false,
        disabled_at: changedAt,
        updated_at: changedAt,
        version: 2,
      })
      .where('id', '=', adminUserId)
      .executeTakeFirstOrThrow();
    await expect(
      authorization.loadCurrent({ adminUserId, actorUserId: userId }),
    ).resolves.toMatchObject({ adminActive: false, activePermissions: [] });
  });
});
