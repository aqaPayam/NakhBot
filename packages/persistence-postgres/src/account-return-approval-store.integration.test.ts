import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdtemp, readdir, copyFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdminCommandAttempt } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createFinalDeletionFixture } from './testing/final-deletion-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createReportFixtureAdmin } from './testing/report-fixture.js';
import { PostgresAccountDeletionEphemeralStore } from './account-deletion-ephemeral-store.js';
import { PostgresAccountReturnApprovalWorkflow } from './account-return-approval-store.js';
import { createPostgresAdminSessions } from './admin-session-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 separate native account return approval', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_return_approval');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(
      database,
    );
  });
  async function completed(): Promise<{ userId: string; recordId: string; version: number }> {
    const item = await createFinalDeletionFixture(database);
    const store = new PostgresAccountDeletionEphemeralStore(
      database,
      'm8-native-final',
      'a'.repeat(64),
    );
    expect(await store.finish(item.lease)).toEqual({ completed: false });
    for (let n = 0; n < 6; n++) {
      const op = (await store.claimNext(item.lease)).operation!;
      await store.complete(item.lease, op.id, {
        cursor: op.stage.startsWith('queue_') ? { redisCursor: '0', pendingKeys: [] } : '0',
        more: false,
        found: 0,
      });
    }
    expect(await store.finish(item.lease)).toEqual({ completed: true });
    const account = await database
      .selectFrom('identity.accounts')
      .select('version')
      .where('user_id', '=', item.userId)
      .executeTakeFirstOrThrow();
    return { ...item, version: account.version };
  }
  async function admin(role = 'super_admin', issue = true, ttl = 240000): Promise<string> {
    const id = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: id,
        role_code: role,
        assigned_by_admin_id: id,
        revoked_at: null,
        revoked_by_admin_id: null,
      })
      .execute();
    const row = await database
      .selectFrom('administration.admin_users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const service = createPostgresAdminSessions(database, {
      verify: () =>
        Promise.resolve({
          actorUserId: row.user_id,
          telegramUserId: row.telegram_user_id,
          proofId: randomUUID(),
          verifiedAt: new Date(Date.now() - 1000),
          expiresAt: new Date(Date.now() + ttl),
        }),
    });
    if (issue)
      await service.issue({
        actor: { kind: 'user', userId: row.user_id },
        telegramUserId: row.telegram_user_id,
        requestId: randomUUID(),
        proof: 'synthetic-protected-factor',
      });
    return id;
  }
  function attempt(
    adminUserId: string,
    root: { recordId: string; version: number },
  ): AdminCommandAttempt {
    return {
      logId: randomUUID(),
      adminUserId,
      commandId: randomUUID(),
      requestId: randomUUID(),
      requestDigest: 'b'.repeat(64),
      commandCode: 'account.approve-return',
      requiredPermission: 'approve_account_return',
      targetType: 'account_deletion',
      targetId: root.recordId,
      expectedTargetVersion: root.version,
      reasonDigest: 'c'.repeat(64),
      metadata: {},
      correlationId: randomUUID(),
    };
  }
  async function approvals(rootId: string): Promise<readonly Record<string, unknown>[]> {
    return (
      await sql<
        Record<string, unknown>
      >`SELECT *,identity.account_return_approval_valid(a,false) AS valid FROM platform.audit_logs a WHERE event_type='account.return-approved.v1' AND subject_id=${rootId}::uuid`.execute(
        database,
      )
    ).rows;
  }
  it('records one approval under twenty retries, preserves every original Root/proof byte, and keeps Return disabled', async () => {
    const root = await completed(),
      a = attempt(await admin(), root),
      workflow = new PostgresAccountReturnApprovalWorkflow(database);
    const before = (
      await sql`SELECT to_jsonb(r) AS value FROM identity.account_deletion_records r WHERE id=${root.recordId}::uuid`.execute(
        database,
      )
    ).rows;
    const proof = (
      await sql`SELECT * FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${root.recordId}::uuid ORDER BY from_checkpoint_version`.execute(
        database,
      )
    ).rows;
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => workflow.approve(a)));
    expect(outcomes.every((x) => x.result === 'succeeded')).toBe(true);
    expect(outcomes.filter((x) => !x.replayed)).toHaveLength(1);
    expect(await approvals(root.recordId)).toMatchObject([{ valid: true }]);
    expect(
      (
        await sql`SELECT to_jsonb(r) AS value FROM identity.account_deletion_records r WHERE id=${root.recordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await sql`SELECT * FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${root.recordId}::uuid ORDER BY from_checkpoint_version`.execute(
          database,
        )
      ).rows,
    ).toEqual(proof);
    await expect(
      sql`UPDATE identity.accounts SET state='guest',product_epoch=product_epoch+1,version=version+1 WHERE user_id=${root.userId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow('account return lacks verified lifecycle authority');
    await expect(
      sql`UPDATE identity.account_deletion_records SET reactivation_allowed=true WHERE id=${root.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
    const audit = (await approvals(root.recordId))[0]!;
    await expect(
      sql`DELETE FROM platform.audit_logs WHERE id=${audit.id}::uuid`.execute(database),
    ).rejects.toThrow();
    await expect(
      sql`UPDATE platform.audit_logs SET metadata='{}'::jsonb WHERE id=${audit.id}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
  });
  it('audits distinct concurrent reviews with exact retry after lock conflicts and one deletion approval', async () => {
    const root = await completed(),
      id = await admin(),
      workflow = new PostgresAccountReturnApprovalWorkflow(database);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const command = attempt(id, root);
        for (let retry = 0; ; retry++) {
          try {
            return await workflow.approve(command);
          } catch (error) {
            // Native lock/serialization conflicts abort without a receipt. The
            // caller retries the identical command, never a replacement identity.
            if (
              retry >= 2 ||
              !['55P03', '40001', '40P01'].includes(String((error as { code?: unknown }).code))
            )
              throw error;
          }
        }
      }),
    );
    expect(outcomes.every((x) => x.result === 'succeeded' && !x.replayed)).toBe(true);
    expect(new Set(outcomes.map((x) => x.value?.approvalId)).size).toBe(1);
    expect(await approvals(root.recordId)).toHaveLength(1);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM administration.admin_action_logs WHERE target_id=${root.recordId}::uuid AND command_code='account.approve-return'`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 20 }]);
  });
  it('durably rejects pending deletion, stale account version and borrowed command identity', async () => {
    const root = await completed(),
      pending = await createDeletionFixture(database),
      id = await admin(),
      workflow = new PostgresAccountReturnApprovalWorkflow(database);
    const account = await database
      .selectFrom('identity.accounts')
      .select('version')
      .where('user_id', '=', pending.userId)
      .executeTakeFirstOrThrow();
    expect(
      await workflow.approve(attempt(id, { recordId: pending.recordId, version: account.version })),
    ).toMatchObject({ result: 'rejected', safeCode: 'conflict' });
    const a = attempt(id, root);
    expect(await workflow.approve({ ...a, expectedTargetVersion: root.version + 1 })).toMatchObject(
      { result: 'rejected', safeCode: 'version_conflict' },
    );
    await expect(workflow.approve(a)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await approvals(root.recordId)).toHaveLength(0);
  });
  it('requires a current native MFA session and the dedicated permission, without granting it to moderators or support', async () => {
    const root = await completed(),
      workflow = new PostgresAccountReturnApprovalWorkflow(database);
    for (const id of [
      await admin('super_admin', false),
      await admin('moderator'),
      await admin('support'),
    ]) {
      expect(await workflow.approve(attempt(id, root))).toMatchObject({
        result: 'rejected',
        safeCode: 'forbidden',
      });
    }
    expect(await approvals(root.recordId)).toHaveLength(0);
  });
  it('rejects forged native proof and suppressing the required approval write rolls back success', async () => {
    const root = await completed(),
      id = await admin(),
      workflow = new PostgresAccountReturnApprovalWorkflow(database);
    await expect(
      sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at) VALUES(gen_random_uuid(),'account','account.return-approved.v1','admin',NULL,${id}::uuid,'account_deletion',${root.recordId}::uuid,'return_approved',1,'{}'::jsonb,gen_random_uuid(),gen_random_uuid(),clock_timestamp())`.execute(
        database,
      ),
    ).rejects.toThrow('account return approval proof incomplete');
    await sql`CREATE FUNCTION identity.test_suppress_return_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='account.return-approved.v1' THEN RETURN NULL; END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER zz_test_suppress_return_approval BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION identity.test_suppress_return_approval()`.execute(
      database,
    );
    try {
      expect(await workflow.approve(attempt(id, root))).toMatchObject({
        result: 'failed',
        safeCode: 'internal_error',
      });
    } finally {
      await sql`DROP TRIGGER zz_test_suppress_return_approval ON platform.audit_logs`.execute(
        database,
      );
      await sql`DROP FUNCTION identity.test_suppress_return_approval()`.execute(database);
    }
    expect(await approvals(root.recordId)).toHaveLength(0);
    expect(await workflow.approve(attempt(id, root))).toMatchObject({ result: 'succeeded' });
  });
  it('rechecks MFA after the real Account lock wait and records one denied attempt', async () => {
    const root = await completed(),
      id = await admin('super_admin', true, 1500),
      workflow = new PostgresAccountReturnApprovalWorkflow(database);
    let unlock!: () => void, locked!: () => void;
    const gate = new Promise<void>((resolve) => {
        unlock = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
    const held = database.transaction().execute(async (tx) => {
      await sql`SELECT user_id FROM identity.accounts WHERE user_id=${root.userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      locked();
      await gate;
    });
    await ready;
    const result = workflow.approve(attempt(id, root));
    try {
      await sql`SELECT pg_sleep(2)`.execute(database);
    } finally {
      unlock();
      await held;
    }
    expect(await result).toMatchObject({ result: 'rejected', safeCode: 'forbidden' });
    expect(await approvals(root.recordId)).toHaveLength(0);
  });
  it('rolls back approval and successful command together when MFA expires at deferred commit', async () => {
    const root = await completed(),
      id = await admin('super_admin', true, 10000),
      workflow = new PostgresAccountReturnApprovalWorkflow(database);
    await sql`CREATE SEQUENCE identity.test_return_expiry_seen`.execute(database);
    await sql`CREATE FUNCTION identity.test_return_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE expiry timestamptz; BEGIN
      IF NEW.event_type='account.return-approved.v1' THEN
        SELECT mfa_expires_at INTO expiry FROM administration.admin_sessions WHERE id=(NEW.metadata->>'sessionId')::uuid;
        PERFORM nextval('identity.test_return_expiry_seen');
        PERFORM pg_sleep(greatest(0,extract(epoch FROM expiry-clock_timestamp()))+0.05);
      END IF; RETURN NULL; END $$`.execute(database);
    await sql`CREATE CONSTRAINT TRIGGER aa_test_return_expiry AFTER INSERT ON platform.audit_logs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.test_return_expiry()`.execute(
      database,
    );
    const a = attempt(id, root);
    try {
      await expect(workflow.approve(a)).rejects.toThrow('account return approval proof incomplete');
      expect(
        (await sql`SELECT is_called FROM identity.test_return_expiry_seen`.execute(database)).rows,
      ).toEqual([{ is_called: true }]);
    } finally {
      await sql`DROP TRIGGER aa_test_return_expiry ON platform.audit_logs`.execute(database);
      await sql`DROP FUNCTION identity.test_return_expiry()`.execute(database);
      await sql`DROP SEQUENCE identity.test_return_expiry_seen`.execute(database);
    }
    expect(await approvals(root.recordId)).toHaveLength(0);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('command_id', '=', a.commandId)
        .execute(),
    ).toHaveLength(0);
  });
  it.each([false, true])(
    'preserves completed schema-140 proof and refuses unexplained legacy approval: %s',
    async (ambiguous) => {
      const previous = await mkdtemp(join(tmpdir(), 'nakh-return-approval-upgrade-'));
      const copied: string[] = [];
      const target = await createIsolatedTestDatabase(url!, 'm8_approval_upgrade');
      let legacy: NakhDatabase | undefined;
      try {
        for (const file of await readdir(resolve('migrations'))) {
          if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 140) {
            await copyFile(join(resolve('migrations'), file), join(previous, file));
            copied.push(file);
          }
        }
        await runMigrations(target.url, previous);
        legacy = createDatabase({
          url: target.url,
          poolMax: 4,
          statementTimeoutMs: 30000,
          lockTimeoutMs: 15000,
        });
        const root = await createFinalDeletionFixture(legacy);
        const store = new PostgresAccountDeletionEphemeralStore(
          legacy,
          'm8-native-final',
          'a'.repeat(64),
        );
        expect(await store.finish(root.lease)).toEqual({ completed: false });
        for (let n = 0; n < 6; n++) {
          const op = (await store.claimNext(root.lease)).operation!;
          await store.complete(root.lease, op.id, {
            cursor: op.stage.startsWith('queue_') ? { redisCursor: '0', pendingKeys: [] } : '0',
            more: false,
            found: 0,
          });
        }
        expect(await store.finish(root.lease)).toEqual({ completed: true });
        const snapshot = async (): Promise<unknown> =>
          (
            await sql`SELECT
        (SELECT to_jsonb(r) FROM identity.account_deletion_records r WHERE id=${root.recordId}::uuid) AS root,
        (SELECT jsonb_agg(to_jsonb(p) ORDER BY from_checkpoint_version) FROM identity.account_deletion_phase_receipts p WHERE deletion_record_id=${root.recordId}::uuid) AS phases,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY retained_data_type) FROM identity.data_retention_records r WHERE deletion_record_id=${root.recordId}::uuid) AS retention`.execute(
              legacy!,
            )
          ).rows;
        const before = await snapshot();
        if (ambiguous) {
          const id = await createReportFixtureAdmin(legacy);
          await sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_admin_id,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
          VALUES(gen_random_uuid(),'account','account.return-approved.v1','admin',${id}::uuid,'account_deletion',${root.recordId}::uuid,'return_approved',1,'{}'::jsonb,gen_random_uuid(),gen_random_uuid(),clock_timestamp())`.execute(
            legacy,
          );
          await expect(runMigrations(target.url, resolve('migrations'))).rejects.toThrow(
            'legacy return approval requires explicit provenance',
          );
          expect(
            await legacy
              .selectFrom('administration.admin_permissions')
              .select('code')
              .where('code', '=', 'approve_account_return')
              .execute(),
          ).toHaveLength(0);
        } else {
          expect((await runMigrations(target.url, resolve('migrations'))).applied).toEqual([
            '000141_m8_return_approval.sql',
            '000142_m8_fresh_account_return.sql',
            '000143_m8_return_localization.sql',
            '000144_m8_fresh_entry_localization.sql',
            '000145_m8_retention_policy.sql',
          ]);
          await verifyMigrations(target.url, resolve('migrations/verify'));
          expect(
            (
              await sql`SELECT identity.account_return_reviewable(${root.recordId}::uuid) AS available`.execute(
                legacy,
              )
            ).rows,
          ).toEqual([{ available: true }]);
        }
        expect(await snapshot()).toEqual(before);
      } finally {
        await legacy?.destroy();
        await target.destroy();
        for (const file of copied) await rm(join(previous, file));
        await rmdir(previous);
      }
    },
  );
});
