import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminCommandAttempt, AdminSessionService } from '@nakh/application';
import type { ApplyAccountModerationActionCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportFixtureAdmin, createReportUser } from './testing/report-fixture.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import { createPostgresAdminSessions } from './admin-session-store.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresConfirmedAccountActions } from './confirmed-account-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
describe.skipIf(url === undefined)('native session command handoff', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_session_commands');
    await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 20,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    try {
      await database?.destroy();
    } finally {
      await isolated?.destroy();
    }
  });
  async function fixture(): Promise<
    Readonly<{
      adminId: string;
      actor: { kind: 'user'; userId: string };
      telegramUserId: string;
      service: AdminSessionService;
      issue: (ttl?: number) => ReturnType<AdminSessionService['issue']>;
      attempt: AdminCommandAttempt;
    }>
  > {
    const adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'super_admin',
        assigned_by_admin_id: adminId,
        revoked_at: null,
        revoked_by_admin_id: null,
      })
      .execute();
    const admin = await database
      .selectFrom('administration.admin_users')
      .selectAll()
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow();
    const actor = { kind: 'user' as const, userId: admin.user_id },
      telegramUserId = admin.telegram_user_id;
    let ttl = 240000;
    const service = createPostgresAdminSessions(database, {
      verify: () =>
        Promise.resolve({
          actorUserId: actor.userId,
          telegramUserId,
          proofId: randomUUID(),
          verifiedAt: new Date(Date.now() - 1000),
          expiresAt: new Date(Date.now() + ttl),
        }),
    });
    return {
      adminId,
      actor,
      telegramUserId,
      service,
      issue: (value = 240000) => {
        ttl = value;
        return service.issue({
          actor,
          telegramUserId,
          requestId: randomUUID(),
          proof: 'synthetic-protected-factor',
        });
      },
      attempt: {
        logId: randomUUID(),
        adminUserId: adminId,
        commandId: randomUUID(),
        requestId: randomUUID(),
        requestDigest: digest('session command'),
        commandCode: 'administration.test_transition',
        requiredPermission: 'view_reports',
        targetType: 'user',
        targetId: admin.user_id,
        expectedTargetVersion: 1,
        reasonDigest: digest('reviewed reason'),
        metadata: {},
        correlationId: randomUUID(),
      },
    };
  }
  async function marker(tx: NakhDatabase, id: string): Promise<void> {
    const now = new Date();
    await tx
      .insertInto('identity.users')
      .values({ id, created_at: now, updated_at: now, last_activity_at: now })
      .execute();
  }
  async function hasMarker(id: string): Promise<boolean> {
    return (
      (await database
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst()) !== undefined
    );
  }
  it('requires a native grant for preparation and effects, with one denied attempt under retries', async () => {
    const f = await fixture(),
      store = new PostgresAdminCommandStore(database);
    const authorization = new PostgresAdminAuthorizationStore(database);
    expect(
      await authorization.loadCurrent({ adminUserId: f.adminId, actorUserId: f.actor.userId }),
    ).toBeUndefined();
    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store
          .execute(f.attempt, () => {
            calls++;
            return Promise.resolve({ safeCode: 'account_restricted', value: undefined });
          })
          .catch(() => undefined),
      ),
    );
    // The first rejection is audited; unauthenticated retries cannot release the recorded receipt.
    expect(results.filter((r) => r?.result === 'rejected')).toHaveLength(1);
    expect(calls).toBe(0);
    await f.issue();
    expect(
      await authorization.loadCurrent({ adminUserId: f.adminId, actorUserId: f.actor.userId }),
    ).toBeDefined();
    expect(
      await store.execute(f.attempt, () => {
        calls++;
        return Promise.resolve({ safeCode: 'account_restricted', value: undefined });
      }),
    ).toMatchObject({ result: 'rejected', replayed: true });
    expect(calls).toBe(0);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('command_id', '=', f.attempt.commandId)
        .execute(),
    ).toHaveLength(1);
  });
  it('executes once under concurrent replay and denies a revoked grant without altering the receipt', async () => {
    const f = await fixture(),
      grant = await f.issue(),
      id = randomUUID(),
      store = new PostgresAdminCommandStore(database);
    let calls = 0;
    const effect = async (tx: NakhDatabase): Promise<{ safeCode: string; value: string }> => {
      calls++;
      await marker(tx, id);
      return { safeCode: 'account_restricted', value: 'private value' };
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.execute(f.attempt, effect)),
    );
    expect(calls).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.value !== undefined)).toHaveLength(1);
    await f.service.revoke({
      actor: { ...f.actor, kind: 'admin' },
      adminSessionToken: grant.adminSessionToken,
      requestId: randomUUID(),
    });
    await expect(store.execute(f.attempt, effect)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      store.execute({ ...f.attempt, requestDigest: digest('substitution') }, effect),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await hasMarker(id)).toBe(true);
    expect(calls).toBe(1);
    await f.issue();
    expect(await store.execute(f.attempt, effect)).toMatchObject({
      result: 'succeeded',
      replayed: true,
      value: undefined,
    });
  });
  it('uses the fresh database clock after a waiting effect and returns no private value', async () => {
    const f = await fixture(),
      id = randomUUID();
    await f.issue(3000);
    const result = await new PostgresAdminCommandStore(database).execute(f.attempt, async (tx) => {
      await marker(tx, id);
      await sql`SELECT pg_sleep(3.2)`.execute(tx);
      return { safeCode: 'evidence_revealed', value: 'retained private content' };
    });
    expect(result).toMatchObject({ result: 'rejected', safeCode: 'forbidden', value: undefined });
    expect(await hasMarker(id)).toBe(false);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select(['result', 'safe_code'])
        .where('command_id', '=', f.attempt.commandId)
        .execute(),
    ).toEqual([{ result: 'rejected', safe_code: 'forbidden' }]);
  });
  it('rolls back provisional success and audit on expiry during required audit work', async () => {
    const f = await fixture(),
      effectId = randomUUID(),
      provisionalAudit = randomUUID(),
      rejectedAudit = randomUUID();
    await f.issue(3000);
    const callbacks: string[] = [];
    const result = await new PostgresAdminCommandStore(database).execute(
      f.attempt,
      async (tx) => {
        await marker(tx, effectId);
        return { safeCode: 'evidence_revealed', value: 'retained private content' };
      },
      async (tx, outcome) => {
        callbacks.push(outcome.result);
        await marker(tx, outcome.result === 'succeeded' ? provisionalAudit : rejectedAudit);
        if (outcome.result === 'succeeded') await sql`SELECT pg_sleep(3.2)`.execute(tx);
      },
    );
    expect(result).toMatchObject({ result: 'rejected', safeCode: 'forbidden', value: undefined });
    expect(callbacks).toEqual(['succeeded', 'rejected']);
    expect(await hasMarker(effectId)).toBe(false);
    expect(await hasMarker(provisionalAudit)).toBe(false);
    expect(await hasMarker(rejectedAudit)).toBe(true);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('result')
        .where('command_id', '=', f.attempt.commandId)
        .execute(),
    ).toEqual([{ result: 'rejected' }]);
  });
  it('aborts the whole transaction when the required audit fails', async () => {
    const f = await fixture(),
      id = randomUUID();
    await f.issue();
    await expect(
      new PostgresAdminCommandStore(database).execute(
        f.attempt,
        async (tx) => {
          await marker(tx, id);
          return { safeCode: 'account_restricted', value: undefined };
        },
        () => Promise.reject(new Error('Required audit unavailable')),
      ),
    ).rejects.toThrow('Required audit unavailable');
    expect(await hasMarker(id)).toBe(false);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('command_id', '=', f.attempt.commandId)
        .execute(),
    ).toHaveLength(0);
    expect(await f.service.current(f.telegramUserId)).toBeDefined();
  });
  it('rejects a separately confirmed native Account action after logout and allows a fresh command', async () => {
    const f = await fixture(),
      grant = await f.issue(),
      target = await createReportUser(database, true);
    const confirmation = await confirmationFixture(database, f.adminId);
    const actions = new PostgresConfirmedAccountActions(
      database,
      confirmation.tokens,
      confirmation.key,
    );
    const adminActionToken = await confirmation.issue({
      commandCode: 'moderation.apply-account-action',
      requiredPermission: 'restrict_user',
      targetType: 'user',
      targetId: target,
      expectedTargetVersion: 1,
    });
    const command: ApplyAccountModerationActionCommand = {
      actor: confirmation.actor,
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
        expectedTargetVersion: 1,
        reason: 'Reviewed restriction reason',
        action: 'restrict_user',
      },
    };
    command.data.confirmationToken = await actions.prepare(command, confirmation.actor);
    await f.service.revoke({
      actor: confirmation.actor,
      adminSessionToken: grant.adminSessionToken,
      requestId: randomUUID(),
    });
    expect(await actions.execute(command, confirmation.actor)).toMatchObject({
      result: 'rejected',
      safeCode: 'forbidden',
    });
    expect(
      await database
        .selectFrom('identity.accounts')
        .select(['state', 'version'])
        .where('user_id', '=', target)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'active', version: 1 });
    await f.issue();
    expect(await actions.execute(command, confirmation.actor)).toMatchObject({
      result: 'rejected',
      replayed: true,
    });
    command.commandId = randomUUID();
    command.requestId = randomUUID();
    command.idempotencyKey = randomUUID();
    command.data.confirmationToken = await actions.prepare(command, confirmation.actor);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => actions.execute(command, confirmation.actor)),
    );
    expect(results.every((r) => r.result === 'succeeded')).toBe(true);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(
      await database
        .selectFrom('identity.accounts')
        .select(['state', 'version'])
        .where('user_id', '=', target)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'restricted', version: 2 });
    expect(
      await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('target_user_id', '=', target)
        .execute(),
    ).toHaveLength(1);
  });
});
