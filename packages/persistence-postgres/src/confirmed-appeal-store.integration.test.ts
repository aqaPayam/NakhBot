import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AdminActionAuthorizationService,
  type OpaqueTokenStore,
  type UserAppealWrite,
} from '@nakh/application';
import type { ReviewAppealCommand, UnbanAppealCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresAppealStore } from './appeal-store.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresConfirmedAppealCommands } from './confirmed-appeal-store.js';
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

class MemoryTokens implements OpaqueTokenStore {
  public readonly rows = new Map<string, string>();
  public putIfAbsent(id: string, value: string): Promise<boolean> {
    if (this.rows.has(id)) return Promise.resolve(false);
    this.rows.set(id, value);
    return Promise.resolve(true);
  }
  public get(id: string): Promise<string | undefined> {
    return Promise.resolve(this.rows.get(id));
  }
}
describe.skipIf(databaseUrl === undefined)('M7 confirmed appeal command boundary', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 10,
      statementTimeoutMs: 10000,
      lockTimeoutMs: 5000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
  });
  async function setup(): Promise<{
    input: UserAppealWrite;
    adminId: string;
    actor: { kind: 'admin'; userId: string };
    authorization: AdminActionAuthorizationService;
    commands: PostgresConfirmedAppealCommands;
    review: ReviewAppealCommand;
    advance: () => void;
  }> {
    const userId = await createUser(database),
      banId = await ban(database, userId),
      input = write(userId, banId);
    await new PostgresAppealStore(database).submit(input);
    const adminId = await createAdmin(database),
      admin = await database
        .selectFrom('administration.admin_users')
        .select(['user_id', 'telegram_user_id'])
        .where('id', '=', adminId)
        .executeTakeFirstOrThrow();
    const actor = { kind: 'admin' as const, userId: admin.user_id },
      tokens = new MemoryTokens(),
      key = Buffer.alloc(32, 7);
    let now = Date.now();
    const authorization = new AdminActionAuthorizationService(
      new PostgresAdminAuthorizationStore(database),
      tokens,
      key,
      () => now,
    );
    const commands = new PostgresConfirmedAppealCommands(database, tokens, key, () => now);
    const token = await authorization.issue({
      actorUserId: actor.userId,
      telegramUserId: admin.telegram_user_id,
      ttlSeconds: 900,
      scope: {
        commandCode: 'moderation.review-appeal',
        requiredPermission: 'review_appeals',
        targetType: 'user_appeal',
        targetId: input.appealId,
        expectedTargetVersion: 1,
      },
    });
    const review: ReviewAppealCommand = {
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'moderation.review-appeal',
      schemaVersion: 1,
      actor,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: token,
        confirmationToken: '',
        expectedTargetVersion: 1,
        reason: 'Private bounded reason',
        decision: 'accepted',
        note: 'Private review note',
      },
    };
    return {
      input,
      adminId,
      actor,
      authorization,
      commands,
      review,
      advance: () => {
        now += 300000;
      },
    };
  }
  it('binds exact review payload, records one replayable result, and requires a new confirmation for unban', async () => {
    const c = await setup();
    c.review.data.confirmationToken = await c.commands.prepare(c.review, c.actor);
    await expect(c.commands.execute(c.review, c.actor)).resolves.toMatchObject({
      result: 'succeeded',
    });
    await expect(c.commands.execute(c.review, c.actor)).resolves.toMatchObject({
      result: 'succeeded',
      replayed: true,
    });
    await expect(
      c.commands.execute(
        { ...c.review, data: { ...c.review.data, decision: 'rejected' } },
        c.actor,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const admin = await database
      .selectFrom('administration.admin_users')
      .select('telegram_user_id')
      .where('id', '=', c.adminId)
      .executeTakeFirstOrThrow();
    const token = await c.authorization.issue({
      actorUserId: c.actor.userId,
      telegramUserId: admin.telegram_user_id,
      scope: {
        commandCode: 'moderation.unban-appeal',
        requiredPermission: 'unban_user',
        targetType: 'user_appeal',
        targetId: c.input.appealId,
        expectedTargetVersion: 2,
      },
    });
    const unban: UnbanAppealCommand = {
      ...c.review,
      commandId: randomUUID(),
      commandType: 'moderation.unban-appeal',
      data: {
        adminActionToken: token,
        confirmationToken: c.review.data.confirmationToken,
        reason: 'Restore access',
        expectedTargetVersion: 2,
        expectedAccountVersion: 2,
      },
    };
    await expect(c.commands.execute(unban, c.actor)).resolves.toMatchObject({
      result: 'rejected',
      safeCode: 'invalid_request',
    });
    unban.commandId = randomUUID();
    unban.data.confirmationToken = await c.commands.prepare(unban, c.actor);
    await expect(c.commands.execute(unban, c.actor)).resolves.toMatchObject({
      result: 'succeeded',
      value: { nextState: 'active' },
    });
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .selectAll()
      .where('target_id', '=', c.input.appealId)
      .execute();
    expect(logs).toHaveLength(3);
    expect(JSON.stringify(logs)).not.toContain('Private');
  });
  it('audits altered reason, missing/expired confirmation, stale version and disabled admin without mutation', async () => {
    const c = await setup();
    const confirmation = await c.commands.prepare(c.review, c.actor);
    const changed = {
      ...c.review,
      data: { ...c.review.data, confirmationToken: confirmation, reason: 'Changed private reason' },
    };
    await expect(c.commands.execute(changed, c.actor)).resolves.toMatchObject({
      result: 'rejected',
      safeCode: 'invalid_request',
    });
    await expect(
      c.commands.execute({ ...c.review, commandId: randomUUID() }, c.actor),
    ).resolves.toMatchObject({ result: 'rejected', safeCode: 'invalid_request' });
    await expect(
      c.commands.execute(
        {
          ...c.review,
          commandId: randomUUID(),
          data: { ...c.review.data, expectedTargetVersion: 2 },
        },
        c.actor,
      ),
    ).resolves.toMatchObject({ result: 'rejected', safeCode: 'version_conflict' });
    const expiring = { ...c.review, commandId: randomUUID(), data: { ...c.review.data } };
    expiring.data.confirmationToken = await c.commands.prepare(expiring, c.actor);
    c.advance();
    await expect(c.commands.execute(expiring, c.actor)).resolves.toMatchObject({
      result: 'rejected',
      safeCode: 'invalid_request',
    });
    const disabled = { ...c.review, commandId: randomUUID(), data: { ...c.review.data } };
    disabled.data.confirmationToken = await c.commands.prepare(disabled, c.actor);
    await database
      .updateTable('administration.admin_users')
      .set({
        is_active: false,
        disabled_at: sql<Date>`updated_at + interval '1 millisecond'`,
        updated_at: sql<Date>`updated_at + interval '1 millisecond'`,
        version: 2,
      })
      .where('id', '=', c.adminId)
      .execute();
    await expect(c.commands.execute(disabled, c.actor)).resolves.toMatchObject({
      result: 'rejected',
      safeCode: 'forbidden',
    });
    expect(
      await database
        .selectFrom('moderation.user_appeals')
        .select(['status', 'version'])
        .where('id', '=', c.input.appealId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'submitted', version: 1 });
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('target_id', '=', c.input.appealId)
        .execute(),
    ).toHaveLength(5);
    await expect(
      c.commands.execute(c.review, { kind: 'admin', userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
