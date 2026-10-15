import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdtemp, readdir, copyFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createAccountReturnFixture } from './testing/account-return-fixture.js';
import { PostgresAccountReturnStore } from './account-return-store.js';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  retentionPolicyRequestDigest,
  type RetentionPolicyChange,
  type RetentionPolicyApproval,
  type AdminCommandAttempt,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createFinalDeletionFixture } from './testing/final-deletion-fixture.js';
import { createReportFixtureAdmin } from './testing/report-fixture.js';
import { PostgresAccountDeletionEphemeralStore } from './account-deletion-ephemeral-store.js';
import {
  PostgresRetentionPeriodReviewStore,
  PostgresRetentionPolicyWorkflow,
} from './retention-policy-store.js';
import { createPostgresAdminSessions } from './admin-session-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 native retention policy attestations', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_retention_policy');
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
  async function completed(
    db: NakhDatabase = database,
  ): Promise<{ userId: string; recordId: string; version: number }> {
    const item = await createFinalDeletionFixture(db);
    const store = new PostgresAccountDeletionEphemeralStore(db, 'm8-native-final', 'a'.repeat(64));
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
    const account = await db
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
    change: RetentionPolicyChange = approval(),
  ): AdminCommandAttempt {
    return {
      logId: randomUUID(),
      adminUserId,
      commandId: randomUUID(),
      requestId: randomUUID(),
      requestDigest: retentionPolicyRequestDigest(root.recordId, root.version, change),
      commandCode: `retention.${change.action}-policy`,
      requiredPermission: 'approve_retention_policy',
      targetType: 'account_deletion',
      targetId: root.recordId,
      expectedTargetVersion: root.version,
      reasonDigest: 'c'.repeat(64),
      metadata: {},
      correlationId: randomUUID(),
    };
  }
  function approval(version = 0): RetentionPolicyChange {
    // Synthetic test period and attestation, never a production policy approval.
    return {
      action: 'approve',
      policy: {
        resource: 'support.support_messages',
        retentionSeconds: 1,
        basis: 'deletion_completed_at',
        evidenceHash: 'd'.repeat(64),
        expectedPolicyVersion: version,
      },
    };
  }
  async function policies(
    rootId: string,
  ): Promise<readonly { id: string; metadata: Record<string, unknown>; valid: boolean }[]> {
    return (
      await sql<{
        id: string;
        metadata: Record<string, unknown>;
        valid: boolean;
      }>`SELECT id,metadata,identity.retention_policy_proof_valid(a,false) AS valid
      FROM platform.audit_logs a WHERE subject_id=${rootId}::uuid AND event_type IN('account.retention-policy-approved.v1','account.retention-policy-revoked.v1') ORDER BY occurred_at,id`.execute(
        database,
      )
    ).rows;
  }
  async function reviewInput(root: { recordId: string; version: number }): Promise<{
    deletionRecordId: string;
    retentionRecordId: string;
    expectedRootVersion: number;
  }> {
    const manifest = (
      await sql<{ id: string }>`SELECT id FROM identity.data_retention_records
      WHERE deletion_record_id=${root.recordId}::uuid AND retained_data_type='support.support_messages'`.execute(
        database,
      )
    ).rows[0]!;
    return {
      deletionRecordId: root.recordId,
      retentionRecordId: manifest.id,
      expectedRootVersion: root.version,
    };
  }
  it('reviews only an exact completed Root and manifest with an explicit native-clock period', async () => {
    const root = await completed(),
      other = await completed(),
      id = await admin();
    const store = new PostgresRetentionPeriodReviewStore(database),
      input = await reviewInput(root);
    expect(await store.review(input)).toMatchObject({
      status: 'pending_policy',
      policyVersion: 0,
      approvalId: null,
      eligibleAfter: null,
      releaseEnabled: false,
    });
    await expect(
      store.review({ ...input, expectedRootVersion: root.version + 1 }),
    ).rejects.toThrow();
    await expect(
      store.review({ ...input, retentionRecordId: (await reviewInput(other)).retentionRecordId }),
    ).rejects.toThrow();
    await expect(store.review({ ...input, deletionRecordId: randomUUID() })).rejects.toThrow();
    await expect(store.review({ ...input, retentionRecordId: 'not-a-manifest' })).rejects.toThrow();
    const workflow = new PostgresRetentionPolicyWorkflow(database);
    const future = approval();
    if (future.action !== 'approve') throw new Error('fixture');
    const longPeriod: RetentionPolicyChange = {
      action: 'approve',
      policy: { ...future.policy, retentionSeconds: 3155760000 },
    };
    expect((await workflow.record(attempt(id, root, longPeriod), longPeriod)).result).toBe(
      'succeeded',
    );
    const pending = await store.review(input);
    expect(pending).toMatchObject({
      status: 'waiting_period',
      policyVersion: 1,
      releaseEnabled: false,
    });
    expect(new Date(pending.eligibleAfter!).getTime()).toBeGreaterThan(
      new Date(pending.evaluatedAt).getTime(),
    );
    const revoke: RetentionPolicyChange = { action: 'revoke', approvalId: pending.approvalId! };
    expect((await workflow.record(attempt(id, root, revoke), revoke)).result).toBe('succeeded');
    expect(await store.review(input)).toMatchObject({
      status: 'policy_revoked',
      policyVersion: 1,
      eligibleAfter: null,
      releaseEnabled: false,
    });
    expect((await workflow.record(attempt(id, root, approval(1)), approval(1))).result).toBe(
      'succeeded',
    );
    await sql`SELECT pg_sleep(greatest(0,extract(epoch FROM (completed_at+interval '1 second'-clock_timestamp())))+0.01)
      FROM identity.account_deletion_records WHERE id=${root.recordId}::uuid`.execute(database);
    const views = await Promise.all(Array.from({ length: 20 }, () => store.review(input)));
    expect(
      views.every(
        (x) => x.status === 'period_elapsed' && x.policyVersion === 2 && x.releaseEnabled === false,
      ),
    ).toBe(true);
    expect(new Set(views.map((x) => x.approvalId)).size).toBe(1);
    const completedAt = (
      await sql<{ completed_at: Date }>`SELECT completed_at FROM identity.account_deletion_records
        WHERE id=${root.recordId}::uuid`.execute(database)
    ).rows[0]!.completed_at;
    expect(new Date(views[0]!.eligibleAfter!).getTime()).toBe(
      new Date(completedAt).getTime() + 1000,
    );
    expect(await policies(other.recordId)).toHaveLength(0);
    await expect(
      sql`DELETE FROM identity.data_retention_records WHERE id=${input.retentionRecordId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
  });
  it('reads revocation after waiting for its transaction instead of retaining stale policy authority', async () => {
    const root = await completed(),
      id = await admin(),
      workflow = new PostgresRetentionPolicyWorkflow(database);
    expect((await workflow.record(attempt(id, root), approval())).result).toBe('succeeded');
    const input = await reviewInput(root),
      original = { ...input };
    const revoke: RetentionPolicyChange = {
      action: 'revoke',
      approvalId: (await policies(root.recordId))[0]!.id,
    };
    await sql`CREATE SEQUENCE identity.test_period_revocation_seen;
      CREATE FUNCTION identity.test_period_revocation_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='account.retention-policy-revoked.v1' THEN
          PERFORM nextval('identity.test_period_revocation_seen'); PERFORM pg_sleep(1);
        END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_period_revocation_wait AFTER INSERT ON platform.audit_logs
      FOR EACH ROW EXECUTE FUNCTION identity.test_period_revocation_wait()`.execute(database);
    const revocation = workflow.record(attempt(id, root, revoke), revoke);
    try {
      for (let n = 0; n < 100; n++) {
        const row = (
          await sql<{
            is_called: boolean;
          }>`SELECT is_called FROM identity.test_period_revocation_seen`.execute(database)
        ).rows[0]!;
        if (row.is_called) break;
        if (n === 99) throw new Error('revocation did not reach lock-holding barrier');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const reading = new PostgresRetentionPeriodReviewStore(database).review(input);
      input.deletionRecordId = randomUUID();
      input.retentionRecordId = randomUUID();
      input.expectedRootVersion++;
      expect((await revocation).result).toBe('succeeded');
      expect(await reading).toMatchObject({
        deletionRecordId: original.deletionRecordId,
        retentionRecordId: original.retentionRecordId,
        status: 'policy_revoked',
        policyVersion: 1,
        releaseEnabled: false,
      });
    } finally {
      await revocation;
      await sql`DROP TRIGGER test_period_revocation_wait ON platform.audit_logs;
        DROP FUNCTION identity.test_period_revocation_wait(); DROP SEQUENCE identity.test_period_revocation_seen`.execute(
        database,
      );
    }
  });
  it('commits one immutable original-Root policy under twenty identical retries without releasing anything', async () => {
    const root = await completed(),
      id = await admin(),
      command = attempt(id, root);
    const workflow = new PostgresRetentionPolicyWorkflow(database);
    const snapshot = async (): Promise<unknown> =>
      (
        await sql`SELECT to_jsonb(root) AS root,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM identity.data_retention_records r WHERE deletion_record_id=root.id) AS manifests,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY from_checkpoint_version) FROM identity.account_deletion_phase_receipts r WHERE deletion_record_id=root.id) AS receipts
      FROM identity.account_deletion_records root WHERE id=${root.recordId}::uuid`.execute(database)
      ).rows;
    const before = await snapshot();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => workflow.record(command, approval())),
    );
    expect(outcomes.every((x) => x.result === 'succeeded')).toBe(true);
    expect(outcomes.filter((x) => !x.replayed)).toHaveLength(1);
    expect(await policies(root.recordId)).toMatchObject([
      {
        valid: true,
        metadata: { resource: 'support.support_messages', policyVersion: 1, retentionSeconds: 1 },
      },
    ]);
    expect(await snapshot()).toEqual(before);
    await expect(
      sql`UPDATE identity.data_retention_records SET deleted_at=clock_timestamp() WHERE deletion_record_id=${root.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
    await expect(
      sql`DELETE FROM identity.data_retention_records WHERE deletion_record_id=${root.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
    const changed = approval();
    if (changed.action !== 'approve') throw new Error('fixture');
    expect(() =>
      workflow.record(command, { ...changed, policy: { ...changed.policy, retentionSeconds: 2 } }),
    ).toThrow();
    expect(await policies(root.recordId)).toHaveLength(1);
  });
  it('serializes distinct competing expected versions and preserves revocations before replacement', async () => {
    const root = await completed(),
      id = await admin(),
      workflow = new PostgresRetentionPolicyWorkflow(database);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => workflow.record(attempt(id, root), approval())),
    );
    expect(outcomes.filter((x) => x.result === 'succeeded')).toHaveLength(1);
    expect(outcomes.filter((x) => x.safeCode === 'version_conflict')).toHaveLength(19);
    const first = (await policies(root.recordId))[0]!;
    expect((await workflow.record(attempt(id, root, approval(1)), approval(1))).result).toBe(
      'rejected',
    );
    const revoke: RetentionPolicyChange = { action: 'revoke', approvalId: first.id };
    const command = attempt(id, root, revoke);
    expect((await workflow.record(command, revoke)).result).toBe('succeeded');
    expect((await workflow.record(command, revoke)).replayed).toBe(true);
    expect((await workflow.record(attempt(id, root, revoke), revoke)).result).toBe('rejected');
    expect((await workflow.record(attempt(id, root, approval(1)), approval(1))).result).toBe(
      'succeeded',
    );
    expect(await policies(root.recordId)).toMatchObject([
      { valid: true },
      { valid: true },
      { valid: true, metadata: { policyVersion: 2 } },
    ]);
  });
  it('rejects absent MFA, lesser roles, stale Root versions, reference resources and foreign revocations', async () => {
    const root = await completed(),
      foreign = await completed(),
      workflow = new PostgresRetentionPolicyWorkflow(database);
    for (const id of [await admin('super_admin', false), await admin('moderator')])
      expect((await workflow.record(attempt(id, root), approval())).result).toBe('rejected');
    const id = await admin(),
      stale = { ...root, version: root.version + 1 };
    expect((await workflow.record(attempt(id, stale), approval())).safeCode).toBe(
      'version_conflict',
    );
    const reference: RetentionPolicyChange = {
      action: 'approve',
      policy: {
        ...(approval() as { policy: RetentionPolicyApproval }).policy,
        resource: 'administration.admin_permissions',
      },
    };
    expect((await workflow.record(attempt(id, root, reference), reference)).result).toBe(
      'rejected',
    );
    expect((await workflow.record(attempt(id, root), approval())).result).toBe('succeeded');
    const revoke: RetentionPolicyChange = {
      action: 'revoke',
      approvalId: (await policies(root.recordId))[0]!.id,
    };
    expect((await workflow.record(attempt(id, foreign, revoke), revoke)).result).toBe('rejected');
    expect(await policies(foreign.recordId)).toHaveLength(0);
  });
  it('rejects forged direct audit inserts and missing mandatory audits atomically', async () => {
    const root = await completed(),
      id = await admin(),
      workflow = new PostgresRetentionPolicyWorkflow(database);
    expect((await workflow.record(attempt(id, root), approval())).result).toBe('succeeded');
    const first = (await policies(root.recordId))[0]!;
    await expect(
      sql`INSERT INTO platform.audit_logs SELECT (jsonb_populate_record(NULL::platform.audit_logs,
      to_jsonb(a)||jsonb_build_object('id',${randomUUID()}::text,'metadata',a.metadata||jsonb_build_object('resource','support.support_threads','policyVersion',1)))).*
      FROM platform.audit_logs a WHERE id=${first.id}::uuid`.execute(database),
    ).rejects.toThrow('retention policy proof incomplete');
    await expect(
      sql`UPDATE platform.audit_logs SET metadata='{}'::jsonb WHERE id=${first.id}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
    const revoke: RetentionPolicyChange = { action: 'revoke', approvalId: first.id };
    await sql`CREATE FUNCTION platform.m8_test_suppress_policy() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN
      IF NEW.event_type='account.retention-policy-revoked.v1' THEN RETURN NULL; END IF; RETURN NEW; END $fn$;
      CREATE TRIGGER aaa_m8_test_suppress_policy BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION platform.m8_test_suppress_policy()`.execute(
      database,
    );
    const command = attempt(id, root, revoke);
    try {
      await expect(workflow.record(command, revoke)).rejects.toThrow(
        'retention policy audit missing',
      );
    } finally {
      await sql`DROP TRIGGER aaa_m8_test_suppress_policy ON platform.audit_logs; DROP FUNCTION platform.m8_test_suppress_policy()`.execute(
        database,
      );
    }
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('id', '=', command.logId)
        .execute(),
    ).toHaveLength(0);
    expect(await policies(root.recordId)).toHaveLength(1);
  });
  it('preserves historical approval provenance after session revocation but denies further policy changes', async () => {
    const root = await completed(),
      id = await admin(),
      workflow = new PostgresRetentionPolicyWorkflow(database);
    expect((await workflow.record(attempt(id, root), approval())).result).toBe('succeeded');
    const first = (await policies(root.recordId))[0]!;
    await sql`UPDATE administration.admin_sessions SET revoked_at=clock_timestamp() WHERE admin_user_id=${id}::uuid`.execute(
      database,
    );
    expect(await policies(root.recordId)).toMatchObject([{ valid: true }]);
    const revoke: RetentionPolicyChange = { action: 'revoke', approvalId: first.id };
    expect((await workflow.record(attempt(id, root, revoke), revoke)).result).toBe('rejected');
    expect(await policies(root.recordId)).toHaveLength(1);
  });
  it('keeps original policy review valid across separately approved Return without touching the new life', async () => {
    const root = await createAccountReturnFixture(database, { approve: false }),
      id = await admin(),
      workflow = new PostgresRetentionPolicyWorkflow(database);
    expect((await workflow.record(attempt(id, root), approval())).result).toBe('succeeded');
    const { approveAccountReturnFixture } = await import('./testing/account-return-fixture.js');
    await approveAccountReturnFixture(database, root);
    const commandId = randomUUID();
    expect(
      (
        await new PostgresAccountReturnStore(database, root.control).return({
          commandId,
          commandType: 'account.return',
          schemaVersion: 1,
          actor: { kind: 'user', userId: root.userId },
          requestId: randomUUID(),
          idempotencyKey: `return:${commandId}`,
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: { expectedAccountVersion: root.version },
        })
      ).returned,
    ).toBe(true);
    const before = (
      await sql`SELECT to_jsonb(a) AS account FROM identity.accounts a WHERE user_id=${root.userId}::uuid`.execute(
        database,
      )
    ).rows;
    const review = await new PostgresRetentionPeriodReviewStore(database).review(
      await reviewInput(root),
    );
    expect(review).toMatchObject({
      deletionRecordId: root.recordId,
      policyVersion: 1,
      releaseEnabled: false,
    });
    expect(['waiting_period', 'period_elapsed']).toContain(review.status);
    const revoke: RetentionPolicyChange = {
      action: 'revoke',
      approvalId: (await policies(root.recordId))[0]!.id,
    };
    expect((await workflow.record(attempt(id, root, revoke), revoke)).result).toBe('succeeded');
    expect(await policies(root.recordId)).toMatchObject([{ valid: true }, { valid: true }]);
    expect(
      (
        await sql`SELECT to_jsonb(a) AS account FROM identity.accounts a WHERE user_id=${root.userId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual(before);
  });
  it('upgrades schema 144 without changing completed Roots, manifests, financial proof or the registry hash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nakh-policy-upgrade-')),
      target = await createIsolatedTestDatabase(url!, 'm8_policy_upgrade');
    const copied: string[] = [];
    let legacy: NakhDatabase | undefined;
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 144) {
          await copyFile(join(resolve('migrations'), file), join(directory, file));
          copied.push(file);
        }
      expect((await runMigrations(target.url, directory)).applied).toHaveLength(144);
      legacy = createDatabase({
        url: target.url,
        poolMax: 8,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      const root = await completed(legacy);
      const snapshot = async (): Promise<unknown> =>
        (
          await sql`SELECT to_jsonb(root) AS root,identity.retention_registry_hash() AS hash,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM identity.data_retention_records r WHERE deletion_record_id=root.id) AS manifests,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY from_checkpoint_version) FROM identity.account_deletion_phase_receipts r WHERE deletion_record_id=root.id) AS phases,
        (SELECT jsonb_agg(to_jsonb(r)) FROM billing.credit_epoch_closures r WHERE deletion_record_id=root.id) AS financial
        FROM identity.account_deletion_records root WHERE id=${root.recordId}::uuid`.execute(
            legacy!,
          )
        ).rows;
      const before = await snapshot();
      expect((await runMigrations(target.url, resolve('migrations'))).applied).toEqual([
        '000145_m8_retention_policy.sql',
      ]);
      await verifyMigrations(target.url, resolve('migrations/verify'));
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await sql`SELECT identity.retention_policy_eligible(${root.recordId}::uuid,r.id) AS eligible FROM identity.data_retention_records r
        WHERE deletion_record_id=${root.recordId}::uuid AND retained_data_type='support.support_messages'`.execute(
            legacy,
          )
        ).rows,
      ).toEqual([{ eligible: true }]);
      expect((await runMigrations(target.url, resolve('migrations'))).applied).toHaveLength(0);
    } finally {
      await legacy?.destroy();
      await target.destroy();
      for (const file of copied) await unlink(join(directory, file));
      await rmdir(directory);
    }
  });
  it('rolls back approval and successful command together when MFA expires at deferred commit', async () => {
    const root = await completed(),
      id = await admin('super_admin', true, 10000),
      workflow = new PostgresRetentionPolicyWorkflow(database);
    await sql`CREATE SEQUENCE identity.test_policy_expiry_seen`.execute(database);
    await sql`CREATE FUNCTION identity.test_policy_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE expiry timestamptz; BEGIN
      IF NEW.event_type='account.retention-policy-approved.v1' THEN
        SELECT mfa_expires_at INTO expiry FROM administration.admin_sessions WHERE id=(NEW.metadata->>'sessionId')::uuid;
        PERFORM nextval('identity.test_policy_expiry_seen');
        PERFORM pg_sleep(greatest(0,extract(epoch FROM expiry-clock_timestamp()))+0.05);
      END IF; RETURN NULL; END $$`.execute(database);
    await sql`CREATE CONSTRAINT TRIGGER aa_test_policy_expiry AFTER INSERT ON platform.audit_logs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.test_policy_expiry()`.execute(
      database,
    );
    const a = attempt(id, root);
    try {
      await expect(workflow.record(a, approval())).rejects.toThrow(
        'retention policy proof incomplete',
      );
      expect(
        (await sql`SELECT is_called FROM identity.test_policy_expiry_seen`.execute(database)).rows,
      ).toEqual([{ is_called: true }]);
    } finally {
      await sql`DROP TRIGGER aa_test_policy_expiry ON platform.audit_logs`.execute(database);
      await sql`DROP FUNCTION identity.test_policy_expiry()`.execute(database);
      await sql`DROP SEQUENCE identity.test_policy_expiry_seen`.execute(database);
    }
    expect(await policies(root.recordId)).toHaveLength(0);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('command_id', '=', a.commandId)
        .execute(),
    ).toHaveLength(0);
  });
});
