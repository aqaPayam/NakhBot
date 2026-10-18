import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createAccountReturnFixture } from './testing/account-return-fixture.js';
import { PostgresAccountReturnStore } from './account-return-store.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import {
  PostgresLaunchCohortAdmission,
  PostgresLaunchCohortControl,
  launchCohortAdmissionStatement,
  type LaunchCohortCommand,
} from './launch-cohort-store.js';
const source = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(source === undefined)('native source-bound launch cohort authority', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
    database: NakhDatabase,
    control: PostgresLaunchCohortControl,
    admission: PostgresLaunchCohortAdmission;
  const operatorId = randomUUID(),
    sha = 'a'.repeat(40);
  const audience = { sourceSha: sha, environment: 'staging' as const, telegramBotId: '123456789' };
  let version = 0;
  let user: string, other: string;
  const command = async (
    members: LaunchCohortCommand['members'] = [{ userId: user, productEpoch: 0 }],
  ): Promise<LaunchCohortCommand> => {
    const now = (
      await sql<{
        expiry: string;
      }>`SELECT to_char((clock_timestamp()+interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expiry`.execute(
        database,
      )
    ).rows[0]!.expiry;
    return {
      requestId: randomUUID(),
      expectedVersion: version,
      ...audience,
      mode: members.length ? 'cohort' : 'closed',
      expiresAt: members.length ? now : null,
      reviewDigest: 'b'.repeat(64),
      members,
    };
  };
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(source!, 'nakh_m9_cohort');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    control = new PostgresLaunchCohortControl(database, { operatorId });
    admission = new PostgresLaunchCohortAdmission(database, audience);
    user = await createReportUser(database);
    other = await createReportUser(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  it('starts closed and converges twenty identical operator retries to one immutable policy', async () => {
    expect(await admission.allows(user)).toBe(false);
    const input = await command();
    const results = await Promise.all(Array.from({ length: 20 }, () => control.apply(input)));
    expect(results.filter((x) => !x.replayed)).toHaveLength(1);
    version = results[0]!.version;
    expect(await admission.allows(user)).toBe(true);
    expect(await admission.allows(other)).toBe(false);
    expect(
      await new PostgresLaunchCohortAdmission(database, {
        ...audience,
        environment: 'production',
      }).allows(user),
    ).toBe(false);
    expect(
      await new PostgresLaunchCohortAdmission(database, {
        ...audience,
        telegramBotId: '987654321',
      }).allows(user),
    ).toBe(false);

    expect(
      await new PostgresLaunchCohortAdmission(database, {
        ...audience,
        sourceSha: 'c'.repeat(40),
      }).allows(user),
    ).toBe(false);
    expect(
      (
        await sql<{
          count: string;
        }>`SELECT count(*)::text AS count FROM platform.audit_logs WHERE id=${input.requestId}::uuid`.execute(
          database,
        )
      ).rows[0]!.count,
    ).toBe('1');
  });
  it('stops fresh admission immediately and never reopens from an old successful retry', async () => {
    const open = await command();
    version = (await control.apply(open)).version;
    expect(await admission.allows(user)).toBe(true);
    const stop = await command([]);
    version = (await control.apply(stop)).version;
    expect(await admission.allows(user)).toBe(false);
    expect((await control.apply(open)).latest).toBe(false);
    expect(await admission.allows(user)).toBe(false);
    await expect(control.apply({ ...stop, requestId: randomUUID() })).rejects.toThrow();
    expect(await admission.allows(user)).toBe(false);
  });
  it('denies changed replays, wrong operators and stale original lives without partial grants', async () => {
    const input = await command();
    version = (await control.apply(input)).version;
    await expect(control.apply({ ...input, reviewDigest: 'c'.repeat(64) })).rejects.toThrow();
    await expect(
      new PostgresLaunchCohortControl(database, { operatorId: randomUUID() }).apply(input),
    ).rejects.toThrow();
    const stale = await command([{ userId: other, productEpoch: 99 }]);
    await expect(control.apply(stale)).rejects.toThrow();
    expect(
      (
        await sql<{
          exists: boolean;
        }>`SELECT EXISTS(SELECT 1 FROM platform.audit_logs WHERE id=${stale.requestId}::uuid) AS exists`.execute(
          database,
        )
      ).rows[0]!.exists,
    ).toBe(false);
  });
  it('serializes conflicting cohort replacements so one expected version wins', async () => {
    const a = await command([{ userId: user, productEpoch: 0 }]),
      b = await command([{ userId: other, productEpoch: 0 }]);
    const results = await Promise.allSettled([control.apply(a), control.apply(b)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    version++;
    expect(Number(await admission.allows(user)) + Number(await admission.allows(other))).toBe(1);
  });
  it('requires mandatory authority audit and complete cohort manifests at native commit', async () => {
    const input = await command();
    await sql`CREATE FUNCTION public.reject_launch_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.event_type='platform.launch-cohort-granted.v1' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER reject_launch_fixture BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION public.reject_launch_fixture()`.execute(
      database,
    );
    try {
      await expect(control.apply(input)).rejects.toThrow();
      expect(
        (
          await sql<{
            exists: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM platform.audit_logs WHERE id=${input.requestId}::uuid) AS exists`.execute(
            database,
          )
        ).rows[0]!.exists,
      ).toBe(false);
    } finally {
      await sql`DROP TRIGGER reject_launch_fixture ON platform.audit_logs`.execute(database);
      await sql`DROP FUNCTION public.reject_launch_fixture()`.execute(database);
    }
  });
  it('denies expired policy by the database clock without relaxing historical proof', async () => {
    const input = await command([]);
    version = (await control.apply(input)).version;
    const id = randomUUID(),
      at = '2000-01-01T00:00:00.000Z',
      expiry = '2000-01-01T01:00:00.000Z';
    await database.transaction().execute(async (tx) => {
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id,
          category: 'security',
          event_type: 'platform.launch-policy-applied.v1',
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          subject_type: 'launch_policy',
          subject_id: '00000000-0000-4000-8000-000000000009',
          result_code: 'cohort',
          metadata_schema_version: 1,
          metadata: {
            operatorId,
            requestDigest: 'd'.repeat(64),
            reviewDigest: 'b'.repeat(64),
            ...audience,
            version: version + 1,
            cohortSize: 1,
            expiresAt: expiry,
          },
          command_id: id,
          request_id: id,
          occurred_at: new Date(at),
        })
        .execute();
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id: randomUUID(),
          category: 'security',
          event_type: 'platform.launch-cohort-granted.v1',
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          subject_type: 'user',
          subject_id: user,
          result_code: 'admitted',
          metadata_schema_version: 1,
          metadata: { policyId: id, productEpoch: 0 },
          command_id: id,
          request_id: id,
          occurred_at: new Date(at),
        })
        .execute();
    });
    version++;
    expect(await admission.allows(user)).toBe(false);
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
  });
  it('fences a genuine Root and retains only original-life security facts', async () => {
    const root = await createDeletionFixture(database, async (id) => {
      const input = await command([{ userId: id, productEpoch: 0 }]);
      version = (await control.apply(input)).version;
      expect(await admission.allows(id)).toBe(true);
    });
    expect(await admission.allows(root.userId)).toBe(false);
    expect(
      (
        await sql<{
          phase: boolean;
        }>`SELECT platform.deletion_operational_blocker(${root.userId}::uuid) AS phase`.execute(
          database,
        )
      ).rows[0]!.phase,
    ).toBe(false);
    await expect(
      control.apply(await command([{ userId: root.userId, productEpoch: 0 }])),
    ).rejects.toThrow();
  });
  it('uses bounded indexed admission over twenty thousand prior policies', async () => {
    await sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
   SELECT id,'security','platform.launch-policy-applied.v1','system',NULL,NULL,'launch_policy','00000000-0000-4000-8000-000000000009'::uuid,'closed',1,
    jsonb_build_object('operatorId',${operatorId}::text,'requestDigest',${'f'.repeat(64)}::text,'reviewDigest',${'b'.repeat(64)}::text,'sourceSha',${sha}::text,'environment','staging','telegramBotId','123456789','version',${version}::integer+n,'cohortSize',0,'expiresAt',NULL),id,id,clock_timestamp()
   FROM (SELECT n,gen_random_uuid() AS id FROM generate_series(1,20000) n) fixture`.execute(
      database,
    );
    version += 20000;
    version = (await control.apply(await command())).version;
    await sql`ANALYZE platform.audit_logs`.execute(database);
    const result = await sql<
      Record<string, unknown>
    >`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${launchCohortAdmissionStatement(user, audience)}`.execute(
      database,
    );
    const value = result.rows[0]!['QUERY PLAN'];
    const plan = JSON.stringify(value);
    expect(plan).toContain('launch_policy_version_idx');
    expect(plan).toContain('launch_member_policy_user_idx');
    const root = (value as Array<Record<string, unknown>>)[0]!;
    expect(Number(root['Execution Time'])).toBeLessThanOrEqual(1500);
    expect(await admission.allows(user)).toBe(true);
  });
  it('requires a new original-life cohort grant after a genuinely approved fresh Return', async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(
      database,
    );
    const returned = await createAccountReturnFixture(database, {
      beforeDeletion: async (userId) => {
        version = (await control.apply(await command([{ userId, productEpoch: 0 }]))).version;
        expect(await admission.allows(userId)).toBe(true);
      },
    });
    expect(await admission.allows(returned.userId)).toBe(false);
    const id = randomUUID();
    await new PostgresAccountReturnStore(database, returned.control).return({
      commandId: id,
      commandType: 'account.return',
      schemaVersion: 1,
      actor: { kind: 'user', userId: returned.userId },
      requestId: randomUUID(),
      idempotencyKey: 'launch-return:' + id,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { expectedAccountVersion: returned.version },
    });
    expect(await admission.allows(returned.userId)).toBe(false);
    await expect(
      control.apply(await command([{ userId: returned.userId, productEpoch: 0 }])),
    ).rejects.toThrow();
    version = (await control.apply(await command([{ userId: returned.userId, productEpoch: 1 }])))
      .version;
    expect(await admission.allows(returned.userId)).toBe(true);
  });
  it('rejects a policy whose declared roster is incomplete at commit', async () => {
    const input = await command();
    await expect(
      database.transaction().execute(async (tx) => {
        await tx
          .insertInto('platform.audit_logs')
          .values({
            id: input.requestId,
            category: 'security',
            event_type: 'platform.launch-policy-applied.v1',
            actor_type: 'system',
            actor_user_id: null,
            actor_admin_id: null,
            subject_type: 'launch_policy',
            subject_id: '00000000-0000-4000-8000-000000000009',
            result_code: 'cohort',
            metadata_schema_version: 1,
            metadata: {
              operatorId,
              requestDigest: 'd'.repeat(64),
              reviewDigest: input.reviewDigest,
              ...audience,
              version: version + 1,
              cohortSize: 1,
              expiresAt: input.expiresAt,
            },
            command_id: input.requestId,
            request_id: input.requestId,
            occurred_at: new Date(
              (
                await sql<{
                  at: string;
                }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`.execute(
                  tx,
                )
              ).rows[0]!.at,
            ),
          })
          .execute();
        expect(
          (
            await sql<{
              version: string;
            }>`SELECT platform.launch_policy_version(${input.requestId}::uuid)::text AS version`.execute(
              tx,
            )
          ).rows[0]!.version,
        ).toBe(String(version + 1));
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      (
        await sql<{
          present: boolean;
        }>`SELECT EXISTS(SELECT 1 FROM platform.audit_logs WHERE id=${input.requestId}::uuid) AS present`.execute(
          database,
        )
      ).rows[0]!.present,
    ).toBe(false);
  });
  it('rolls back a populated upgrade containing unprotected pre-migration launch facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nakh_launch_upgrade_'));
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('nakh_launch_upgrade_')
    )
      throw new Error('Unsafe fixture cleanup');
    const old = await createIsolatedTestDatabase(source!, 'nakh_launch_legacy');
    let legacy: NakhDatabase | undefined;
    try {
      for (const name of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(name) && Number(name.slice(0, 6)) <= 162)
          await copyFile(resolve('migrations', name), join(directory, name));
      await runMigrations(old.url, directory);
      legacy = createDatabase({
        url: old.url,
        poolMax: 1,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      const id = randomUUID();
      await legacy
        .insertInto('platform.audit_logs')
        .values({
          id,
          category: 'security',
          event_type: 'platform.launch-policy-applied.v1',
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          subject_type: 'launch_policy',
          subject_id: '00000000-0000-4000-8000-000000000009',
          result_code: 'closed',
          metadata_schema_version: 1,
          metadata: {},
          command_id: id,
          request_id: id,
          occurred_at: new Date(),
        })
        .execute();
      await expect(runMigrations(old.url, resolve('migrations'))).rejects.toThrow(
        'Untrusted launch history',
      );
      const result = (
        await sql<{
          migrations: string;
          absent: boolean;
        }>`SELECT (SELECT count(*)::text FROM platform.schema_migrations) AS migrations,to_regprocedure('platform.launch_policy_version(uuid)') IS NULL AS absent`.execute(
          legacy,
        )
      ).rows[0]!;
      expect(result).toEqual({ migrations: '162', absent: true });
    } finally {
      await legacy?.destroy();
      await old.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
