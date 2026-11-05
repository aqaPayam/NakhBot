import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createAccountReturnFixture } from './testing/account-return-fixture.js';
import {
  PostgresLaunchCohortAdmission,
  PostgresLaunchCohortControl,
} from './launch-cohort-store.js';
import { PostgresTrialInvitationStore, trialCreditCandidates } from './trial-invitation-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { RUNTIME_DATABASE_SCHEMAS } from './runtime-database-policy.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('native bounded private trial invitations', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let database: NakhDatabase, runtime: NakhDatabase;
  let store: PostgresTrialInvitationStore, control: PostgresLaunchCohortControl;
  let admission: PostgresLaunchCohortAdmission, owner: string;
  let version = 0,
    createdRole = false;
  const role = 'trial_probe_' + randomUUID().replaceAll('-', '');
  const audience = {
    sourceSha: 'a'.repeat(40),
    environment: 'staging' as const,
    telegramBotId: '12345',
  };
  const token = (): string => randomBytes(24).toString('base64url');
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_trial_invitations');
    const previous = await mkdtemp(join(tmpdir(), 'nakh-trial-upgrade-'));
    try {
      for (const name of await readdir(resolve('migrations')))
        if (/^\d+.*\.sql$/u.test(name) && name !== '000164_m9_private_trial_invitations.sql')
          await copyFile(resolve('migrations', name), join(previous, name));
      await runMigrations(isolated.url, previous);
    } finally {
      await rm(previous, { recursive: true, force: true });
    }
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 20000,
    });
    const before = await database
      .selectFrom('platform.schema_migrations')
      .selectAll()
      .orderBy('name')
      .execute();
    expect(before).toHaveLength(163);
    await runMigrations(isolated.url, resolve('migrations'));
    expect(
      await database
        .selectFrom('platform.schema_migrations')
        .selectAll()
        .where('name', '!=', '000164_m9_private_trial_invitations.sql')
        .orderBy('name')
        .execute(),
    ).toEqual(before);
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    owner = await createReportUser(database);
    control = new PostgresLaunchCohortControl(database, { operatorId: randomUUID() });
    admission = new PostgresLaunchCohortAdmission(database, audience);
    store = new PostgresTrialInvitationStore(database, audience);
    const password = randomBytes(24).toString('base64url');
    await sql
      .raw('CREATE ROLE "' + role + '" LOGIN PASSWORD \'' + password + "'")
      .execute(database);
    createdRole = true;
    await sql`GRANT USAGE ON SCHEMA platform,identity TO ${sql.id(role)}`.execute(database);
    // Trigger row-type declarations need schema visibility even for unrelated events.
    for (const schema of RUNTIME_DATABASE_SCHEMAS)
      await sql`GRANT USAGE ON SCHEMA ${sql.id(schema)} TO ${sql.id(role)}`.execute(database);
    await sql`GRANT SELECT,INSERT ON platform.audit_logs TO ${sql.id(role)}`.execute(database);
    await sql`GRANT SELECT ON identity.users,identity.accounts TO ${sql.id(role)}`.execute(
      database,
    );
    await sql`GRANT EXECUTE ON FUNCTION platform.redeem_trial_invitation(text,uuid,integer,text,text) TO ${sql.id(role)}`.execute(
      database,
    );
    const runtimeUrl = new URL(isolated.url);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtime = createDatabase({
      url: runtimeUrl.toString(),
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 20000,
    });
  });
  afterAll(async () => {
    await runtime?.destroy();
    await database?.destroy();
    await isolated?.destroy();
    if (createdRole) {
      const root = createDatabase({
        url: url!,
        poolMax: 1,
        statementTimeoutMs: 10000,
        lockTimeoutMs: 10000,
      });
      try {
        await sql`DROP ROLE ${sql.id(role)}`.execute(root);
      } finally {
        await root.destroy();
      }
    }
  });
  async function invitation(
    capacity = 2,
    expiryMs = 3600000,
  ): Promise<{ token: string; id: string; policyId: string; expiresAt: string }> {
    const expiresAt = new Date(Date.now() + expiryMs).toISOString(),
      policyId = randomUUID();
    version = (
      await control.apply({
        ...audience,
        requestId: policyId,
        expectedVersion: version,
        mode: 'cohort',
        reviewDigest: 'b'.repeat(64),
        expiresAt,
        members: [{ userId: owner, productEpoch: 0 }],
      })
    ).version;
    const value = { token: token(), id: randomUUID(), policyId, expiresAt };
    await store.create({ requestId: value.id, policyId, token: value.token, capacity, expiresAt });
    return value;
  }
  const claims = async (id: string): Promise<number> =>
    Number(
      (
        await sql<{
          count: string;
        }>`SELECT count(*)::text AS count FROM platform.audit_logs WHERE event_type='platform.trial-invitation-redeemed.v1' AND metadata->>'invitationId'=${id}`.execute(
          database,
        )
      ).rows[0]!.count,
    );
  it('migrates the existing ledger without rewriting bytes, stores only a hash and replays creation exactly', async () => {
    const value = await invitation();
    await store.create({
      requestId: value.id,
      policyId: value.policyId,
      token: value.token,
      capacity: 2,
      expiresAt: value.expiresAt,
    });
    const row = await database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('id', '=', value.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(value.token);
    expect(row.metadata['tokenHash']).toMatch(/^[a-f0-9]{64}$/u);
    await expect(
      store.create({
        requestId: value.id,
        policyId: value.policyId,
        token: token(),
        capacity: 2,
        expiresAt: value.expiresAt,
      }),
    ).rejects.toThrow();
  });
  it('rolls back an upgrade containing invitation facts written before their guards existed', async () => {
    const legacy = await createIsolatedTestDatabase(url!, 'nakh_trial_untrusted');
    const previous = await mkdtemp(join(tmpdir(), 'nakh-trial-untrusted-'));
    let old: NakhDatabase | undefined;
    try {
      for (const name of await readdir(resolve('migrations')))
        if (/^\d+.*\.sql$/u.test(name) && name !== '000164_m9_private_trial_invitations.sql')
          await copyFile(resolve('migrations', name), join(previous, name));
      await runMigrations(legacy.url, previous);
      old = createDatabase({
        url: legacy.url,
        poolMax: 1,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 10000,
      });
      const id = randomUUID();
      await old
        .insertInto('platform.audit_logs')
        .values({
          id,
          category: 'security',
          event_type: 'platform.trial-invitation-created.v1',
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          subject_type: 'launch_policy',
          subject_id: randomUUID(),
          result_code: 'ready',
          metadata_schema_version: 1,
          metadata: {},
          command_id: id,
          request_id: id,
          occurred_at: new Date(),
        })
        .execute();
      await expect(runMigrations(legacy.url, resolve('migrations'))).rejects.toMatchObject({
        code: '55000',
      });
      expect(
        await old.selectFrom('platform.schema_migrations').select('name').execute(),
      ).toHaveLength(163);
      expect(
        (
          await sql<{
            absent: boolean;
          }>`SELECT to_regprocedure('platform.trial_invitation_policy(uuid)') IS NULL AS absent`.execute(
            old,
          )
        ).rows[0]!.absent,
      ).toBe(true);
      expect(
        await old.selectFrom('platform.audit_logs').select('id').where('id', '=', id).execute(),
      ).toHaveLength(1);
    } finally {
      await old?.destroy();
      await legacy.destroy();
      await rm(previous, { recursive: true, force: true });
    }
  });
  it('converges twenty duplicate joins to one seat and does not charge an existing member a seat', async () => {
    const value = await invitation(),
      userId = await createReportUser(database);
    const userStore = new PostgresTrialInvitationStore(runtime, audience);
    expect(
      await Promise.all(
        Array.from({ length: 20 }, () =>
          userStore.redeem(value.token, { userId, productEpoch: 0 }),
        ),
      ),
    ).toEqual(Array(20).fill(true));
    expect(await claims(value.id)).toBe(1);
    expect(await admission.allows(userId)).toBe(true);
    expect(await userStore.redeem(value.token, { userId: owner, productEpoch: 0 })).toBe(true);
    expect(await claims(value.id)).toBe(1);
  });
  it('admits only the bounded number of concurrent distinct claimants', async () => {
    const value = await invitation(2),
      users = await Promise.all(Array.from({ length: 20 }, () => createReportUser(database)));
    const results = await Promise.all(
      users.map((userId) => store.redeem(value.token, { userId, productEpoch: 0 })),
    );
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await claims(value.id)).toBe(2);
    expect(
      (await Promise.all(users.map((id) => admission.allows(id)))).filter(Boolean),
    ).toHaveLength(2);
  });
  it('denies guessed secrets, stale lives, wrong source, wrong bot and production', async () => {
    const value = await invitation(),
      userId = await createReportUser(database);
    expect(await store.redeem(token(), { userId, productEpoch: 0 })).toBe(false);
    expect(await store.redeem(value.token, { userId, productEpoch: 1 })).toBe(false);
    for (const other of [
      { ...audience, sourceSha: 'c'.repeat(40) },
      { ...audience, telegramBotId: '67890' },
      { ...audience, environment: 'production' as const },
    ])
      expect(
        await new PostgresTrialInvitationStore(database, other).redeem(value.token, {
          userId,
          productEpoch: 0,
        }),
      ).toBe(false);
    expect(await claims(value.id)).toBe(0);
    expect(await admission.allows(userId)).toBe(false);
  });
  it('issues one bounded noncash grant under concurrent retries and denies stale, altered or stopped authority', async () => {
    const value = await invitation(),
      userId = await createReportUser(database, true);
    await database
      .insertInto('billing.credit_accounts')
      .values({ user_id: userId, created_at: new Date(), updated_at: new Date() })
      .execute();
    expect(await store.redeem(value.token, { userId, productEpoch: 0 })).toBe(true);
    const claim = (await trialCreditCandidates(audience).execute(database)).rows.find(
      (row) => row.userId === userId,
    )!;
    expect(claim).toBeDefined();
    const ledger = new PostgresCreditLedgerStore(database);
    const input = {
      transactionId: randomUUID(),
      userId,
      transactionType: 'admin_adjustment' as const,
      amount: 100n,
      idempotencyKey: `private-trial-initial:${userId}:0`,
      correlationId: claim.claimId,
      expectedProductEpoch: 0,
      trialClaim: { id: claim.claimId, audience },
    };
    await expect(ledger.append({ ...input, expectedProductEpoch: 1 })).rejects.toMatchObject({
      code: 'capability_denied',
    });
    await expect(ledger.append({ ...input, amount: 101n })).rejects.toMatchObject({
      code: 'capability_denied',
    });
    await expect(
      ledger.append({ ...input, trialClaim: { ...input.trialClaim, id: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'capability_denied' });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => ledger.append({ ...input, transactionId: randomUUID() })),
    );
    expect(results.filter((row) => !row.replayed)).toHaveLength(1);
    expect(await ledger.getBalance(userId)).toEqual({ balance: 100n, version: 2 });
    expect(
      await database
        .selectFrom('billing.credit_transactions')
        .select('id')
        .where('user_id', '=', userId)
        .execute(),
    ).toHaveLength(1);
    version = (
      await control.apply({
        ...audience,
        requestId: randomUUID(),
        expectedVersion: version,
        mode: 'closed',
        reviewDigest: 'b'.repeat(64),
        expiresAt: null,
        members: [],
      })
    ).version;
    await expect(ledger.append(input)).rejects.toMatchObject({ code: 'capability_denied' });
    expect(await ledger.getBalance(userId)).toEqual({ balance: 100n, version: 2 });
  });
  it('denies runtime creation and forged claims even when the invitation hash is readable', async () => {
    const value = await invitation(),
      userId = await createReportUser(database);
    const row = await database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('id', '=', value.id)
      .executeTakeFirstOrThrow();
    const id = randomUUID();
    await expect(
      runtime
        .insertInto('platform.audit_logs')
        .values({ ...row, id, command_id: id, request_id: id })
        .execute(),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime
        .insertInto('platform.audit_logs')
        .values({
          id,
          category: 'security',
          event_type: 'platform.trial-invitation-redeemed.v1',
          actor_type: 'user',
          actor_user_id: userId,
          actor_admin_id: null,
          subject_type: 'user',
          subject_id: userId,
          result_code: 'admitted',
          metadata_schema_version: 1,
          metadata: { invitationId: value.id, productEpoch: 0 },
          command_id: id,
          request_id: id,
          occurred_at: new Date(),
        })
        .execute(),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      await new PostgresTrialInvitationStore(runtime, audience).redeem(
        String(row.metadata['tokenHash']),
        { userId, productEpoch: 0 },
      ),
    ).toBe(false);
    await sql`REVOKE EXECUTE ON FUNCTION platform.redeem_trial_invitation(text,uuid,integer,text,text) FROM ${sql.id(role)}`.execute(
      database,
    );
    try {
      await expect(
        new PostgresTrialInvitationStore(runtime, audience).redeem(value.token, {
          userId,
          productEpoch: 0,
        }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await sql`GRANT EXECUTE ON FUNCTION platform.redeem_trial_invitation(text,uuid,integer,text,text) TO ${sql.id(role)}`.execute(
        database,
      );
    }
  });
  it('keeps the total cohort at ten and rejects expiry beyond its parent policy', async () => {
    const value = await invitation();
    const input = {
      requestId: randomUUID(),
      policyId: value.policyId,
      token: token(),
      capacity: 10,
      expiresAt: value.expiresAt,
    };
    await expect(store.create(input)).rejects.toThrow();
    await expect(
      store.create({
        ...input,
        capacity: 2,
        expiresAt: new Date(Date.parse(value.expiresAt) + 1).toISOString(),
      }),
    ).rejects.toThrow();
  });
  it('revokes claims on policy replacement and fails closed during a concurrent stop', async () => {
    const value = await invitation(),
      userId = await createReportUser(database);
    const [result] = await Promise.all([
      store.redeem(value.token, { userId, productEpoch: 0 }),
      control
        .apply({
          ...audience,
          requestId: randomUUID(),
          expectedVersion: version,
          mode: 'closed',
          reviewDigest: 'b'.repeat(64),
          expiresAt: null,
          members: [],
        })
        .then((receipt) => {
          version = receipt.version;
        }),
    ]);
    expect(typeof result).toBe('boolean');
    expect(await admission.allows(userId)).toBe(false);
    expect(await store.redeem(value.token, { userId, productEpoch: 0 })).toBe(false);
    await invitation();
    expect(await admission.allows(userId)).toBe(false);
  });
  it('fences a genuine Root while preserving validated content-free security facts', async () => {
    let claimId: string | undefined;
    const root = await createDeletionFixture(database, async (userId) => {
      const value = await invitation();
      expect(await store.redeem(value.token, { userId, productEpoch: 0 })).toBe(true);
      claimId = (
        await database
          .selectFrom('platform.audit_logs')
          .select('id')
          .where('event_type', '=', 'platform.trial-invitation-redeemed.v1')
          .where('subject_id', '=', userId)
          .executeTakeFirstOrThrow()
      ).id;
    });
    expect(await admission.allows(root.userId)).toBe(false);
    const facts = (
      await sql<{
        epoch: number;
        blocker: boolean;
      }>`SELECT platform.trial_claim_epoch(${claimId}::uuid) AS epoch,platform.deletion_operational_blocker(${root.userId}::uuid) AS blocker`.execute(
        database,
      )
    ).rows[0]!;
    expect(facts).toEqual({ epoch: 0, blocker: false });
  });
  it('expires by the database clock without invalidating historical proof', async () => {
    const value = await invitation(1, 5000),
      userId = await createReportUser(database);
    expect(await store.redeem(value.token, { userId, productEpoch: 0 })).toBe(true);
    await sql`SELECT pg_sleep(5.1)`.execute(database);
    expect(await admission.allows(userId)).toBe(false);
    expect(await store.redeem(value.token, { userId, productEpoch: 0 })).toBe(false);
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
  });
  it('never carries an invitation or its credits into a genuinely deleted and approved returned life', async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(
      database,
    );
    let secret = '';
    const returned = await createAccountReturnFixture(database, {
      beforeDeletion: async (userId) => {
        const value = await invitation();
        secret = value.token;
        expect(await store.redeem(secret, { userId, productEpoch: 0 })).toBe(true);
      },
    });
    expect(await admission.allows(returned.userId)).toBe(false);
    expect(await store.redeem(secret, { userId: returned.userId, productEpoch: 1 })).toBe(false);
    expect(
      (await trialCreditCandidates(audience).execute(database)).rows.some(
        (row) => row.userId === returned.userId,
      ),
    ).toBe(false);
  });
});
