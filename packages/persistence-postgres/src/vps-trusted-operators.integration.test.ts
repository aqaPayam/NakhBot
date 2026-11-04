import { randomUUID, createHash } from 'node:crypto';
import { resolve, join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminTotpCode, adminTotpStep, ReportSnapshotKeyRing } from '@nakh/application';
import { createDatabase, type DatabaseConfig, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import { launchOperatorCommandDigest } from './launch-operator-host.js';
import { LAUNCH_REVIEW_COMMON_EVIDENCE } from './launch-review.js';
import { PostgresLaunchCohortAdmission, type LaunchCohortCommand } from './launch-cohort-store.js';
import { PostgresAdminTotpEnrollments } from './admin-totp-enrollment-store.js';
import type { AdminTotpApproval } from './admin-totp-operator-store.js';
import { adminTotpDatabaseTime } from './admin-totp-policy.js';
import { createPostgresTotpAdminSessions } from './admin-totp-verifier.js';
import {
  runVpsLaunchOperator,
  runVpsMfaOperator,
  vpsMfaCommandDigest,
  type VpsOperatorBinding,
  type VpsMfaOperatorBinding,
} from './vps-trusted-operators.js';
import type { VpsMachineIdentity } from './vps-launch-readiness.js';

const source = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(source === undefined)('staging VPS operators with native fenced authority', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, database: NakhDatabase;
  let binding: VpsOperatorBinding,
    mfa: VpsMfaOperatorBinding,
    secret: { NAKH_DATABASE_URL: string };
  let owner: string, other: string;
  let telegramSerial = 2100000000;
  const key = Buffer.alloc(32, 47),
    keyId = 'totp-vps-key';
  const keys = [{ keyId, keyVersion: 1, key: key.toString('base64url') }];
  const host = (): Promise<VpsMachineIdentity> =>
    Promise.resolve({ platform: 'linux', uid: 0, machineId: binding.machineId });
  // Host identity, TLS transport and evidence bytes here are explicit fixtures.
  // Native policy/MFA/audit behavior is real; this is not live VPS or launch acceptance.
  const connect = (config: DatabaseConfig): NakhDatabase =>
    createDatabase({ ...config, url: isolated.url });
  const read = (path: string): Promise<unknown> =>
    Promise.resolve(path === binding.databaseSecretPath ? secret : keys);
  const launch = (command: unknown, config = binding): Promise<unknown> =>
    runVpsLaunchOperator(config, command, read, host, connect);
  const approve = (command: unknown, config = mfa): Promise<unknown> =>
    runVpsMfaOperator(config, command, read, host, connect);
  const admission = (): PostgresLaunchCohortAdmission =>
    new PostgresLaunchCohortAdmission(database, {
      sourceSha: binding.sourceSha,
      environment: binding.environment,
      telegramBotId: binding.telegramBotId,
    });
  async function staff(): Promise<{ userId: string; telegramUserId: string }> {
    const userId = await createReportUser(database),
      telegramUserId = String(++telegramSerial),
      at = new Date();
    await database
      .insertInto('identity.telegram_identities')
      .values({
        user_id: userId,
        telegram_user_id: telegramUserId,
        username: null,
        first_seen_at: at,
        last_seen_at: at,
      })
      .execute();
    return { userId, telegramUserId };
  }
  async function intent(): Promise<LaunchCohortCommand> {
    const row = (
      await sql<{ version: number; expiry: string }>`SELECT
      coalesce(max(platform.launch_policy_version(id)),0)::integer AS version,
      to_char((clock_timestamp()+interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expiry
      FROM platform.audit_logs WHERE event_type='platform.launch-policy-applied.v1'`.execute(
        database,
      )
    ).rows[0]!;
    return {
      requestId: randomUUID(),
      expectedVersion: row.version,
      sourceSha: binding.sourceSha,
      environment: 'staging',
      telegramBotId: binding.telegramBotId,
      mode: 'cohort',
      expiresAt: row.expiry,
      reviewDigest: 'b'.repeat(64),
      members: [{ userId: owner, productEpoch: 0 }],
    };
  }
  async function reviewed(input?: LaunchCohortCommand): Promise<{
    operation: 'apply-reviewed';
    input: LaunchCohortCommand;
    review: { reviewDigest: string; dossier: Record<string, unknown> };
  }> {
    const now = new Date(),
      selected = input ?? (await intent());
    const review = (await launch({
      operation: 'prepare-review',
      phase: 'canary',
      intent: selected,
      evidence: [...LAUNCH_REVIEW_COMMON_EVIDENCE, 'canary_plan'].map((role) => ({
        role,
        sha256: 'c'.repeat(64),
        observedAt: new Date(now.getTime() - 1000).toISOString(),
        expiresAt: new Date(now.getTime() + 3600000).toISOString(),
      })),
    })) as {
      reviewDigest: string;
      dossier: Record<string, unknown>;
    };
    expect(review.dossier.blockers).toEqual([]);
    expect(review.dossier.launchAuthorized).toBe(false);
    return {
      operation: 'apply-reviewed',
      input: { ...selected, reviewDigest: review.reviewDigest },
      review,
    };
  }
  function mfaRequest(userId: string): {
    operation: 'approve';
    input: {
      actorUserId: string;
      requestId: string;
      roles: readonly ['support'];
      reasonCode: 'bootstrap';
    };
  } {
    return {
      operation: 'approve' as const,
      input: {
        actorUserId: userId,
        requestId: randomUUID(),
        roles: ['support'] as const,
        reasonCode: 'bootstrap' as const,
      },
    };
  }
  function pending(value: unknown): Extract<AdminTotpApproval, { status: 'pending' }> {
    const result = value as AdminTotpApproval;
    if (result.status !== 'pending') throw new Error('Pending native fixture required.');
    return result;
  }
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(source!, 'nakh_vps_operators');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    const url = new URL(isolated.url);
    binding = {
      version: 1,
      environment: 'staging',
      sourceSha: 'a'.repeat(40),
      telegramBotId: '123456789',
      machineId: 'b'.repeat(32),
      databaseHost: 'reviewed.vps.invalid',
      databaseName: decodeURIComponent(url.pathname.slice(1)),
      databaseUser: decodeURIComponent(url.username),
      databaseSecretPath: '/run/operator/database.json',
      operatorId: randomUUID(),
      approvedCommandDigest: null,
    };
    mfa = { ...binding, totpSecretPath: '/run/operator/totp.json', keyId, keyVersion: 1 };
    secret = {
      NAKH_DATABASE_URL: `postgresql://${binding.databaseUser}:fixture-only@${binding.databaseHost}/${binding.databaseName}?sslmode=verify-full`,
    };
    owner = (await staff()).userId;
    other = (await staff()).userId;
    for (const run_type of ['billing', 'nakh', 'chat', 'moderation'] as const)
      await database
        .insertInto('billing.reconciliation_runs')
        .values({
          id: randomUUID(),
          run_type,
          status: 'succeeded',
          cursor: {},
          failure_code: null,
          started_at: new Date(Date.now() - 2000),
          finished_at: new Date(Date.now() - 1000),
        })
        .execute();
  });
  afterAll(async () => {
    key.fill(0);
    await database?.destroy();
    await isolated?.destroy();
  });
  it('observes and resolves only current native members without granting admission or writing audits', async () => {
    const before = (
      await sql`SELECT count(*)::text AS n FROM platform.audit_logs`.execute(database)
    ).rows;
    expect(await launch({ operation: 'inspect' })).toBeNull();
    const user = await database
      .selectFrom('identity.telegram_identities')
      .select('telegram_user_id')
      .where('user_id', '=', owner)
      .executeTakeFirstOrThrow();
    expect(
      await launch({ operation: 'resolve-member', telegramUserId: user.telegram_user_id }),
    ).toEqual({ userId: owner, productEpoch: 0 });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => launch({ operation: 'health' })),
    );
    expect(
      results.every((r) => (r as { launchAuthorized: boolean }).launchAuthorized === false),
    ).toBe(true);
    expect(
      (await sql`SELECT count(*)::text AS n FROM platform.audit_logs`.execute(database)).rows,
    ).toEqual(before);
    expect(await admission().allows(owner)).toBe(false);
  });
  it('requires exact reviewed approval and converges twenty openings to one audited native policy', async () => {
    const request = await reviewed();
    await expect(launch(request)).rejects.toThrow();
    const config = { ...binding, approvedCommandDigest: launchOperatorCommandDigest(request) };
    const results = await Promise.all(Array.from({ length: 20 }, () => launch(request, config)));
    expect(results.filter((r) => !(r as { replayed: boolean }).replayed)).toHaveLength(1);
    expect(await launch({ operation: 'receipt', input: request.input }, config)).toMatchObject({
      latest: true,
    });
    expect(await admission().allows(owner)).toBe(true);
    expect(await admission().allows(other)).toBe(false);
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('command_id', '=', request.input.requestId)
        .execute(),
    ).toHaveLength(2);
  });
  it('stops independently of an opening approval and recovers the immutable close receipt', async () => {
    const input = { ...(await intent()), mode: 'closed' as const, members: [], expiresAt: null };
    expect(await launch({ operation: 'apply', input })).toMatchObject({
      mode: 'closed',
      replayed: false,
    });
    expect(await launch({ operation: 'receipt', input })).toMatchObject({
      mode: 'closed',
      latest: true,
    });
    expect(await admission().allows(owner)).toBe(false);
  });
  it('captures source, approval and member identity before secret access', async () => {
    const selected = await reviewed();
    const request = {
      ...selected,
      input: { ...selected.input, members: selected.input.members.map((r) => ({ ...r })) },
    };
    const config = { ...binding, approvedCommandDigest: launchOperatorCommandDigest(request) };
    let first = true;
    await runVpsLaunchOperator(
      config,
      request,
      (path) => {
        if (first) {
          first = false;
          request.input.members[0]!.userId = other;
          config.approvedCommandDigest = 'd'.repeat(64);
          config.machineId = 'd'.repeat(32);
        }
        return read(path);
      },
      host,
      connect,
    );
    expect(await admission().allows(owner)).toBe(true);
    expect(await admission().allows(other)).toBe(false);
    const close = { ...(await intent()), mode: 'closed' as const, members: [], expiresAt: null };
    await launch({ operation: 'apply', input: close });
  });
  it('rejects a review whose native lock wait outlives its deadline without a policy write', async () => {
    const request = await reviewed();
    let release!: () => void, held!: (pid: number) => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      held = resolve;
    });
    const holder = database.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('nakh-launch-cohort'))`.execute(tx);
      held((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx)).rows[0]!.pid);
      await released;
    });
    void holder.catch(() => {
      release();
    });
    const pid = await Promise.race([
      acquired,
      holder.then((): never => {
        throw new Error('Policy lock was not acquired.');
      }),
    ]);
    // Review bytes are synthetic fixture evidence; shortening its deadline is
    // explicitly rehashed to exercise the real post-lock native deadline check.
    const now = new Date();
    request.review.dossier.expiresAt = new Date(now.getTime() + 2000).toISOString();
    request.review.reviewDigest = createHash('sha256')
      .update(JSON.stringify(request.review.dossier))
      .digest('hex');
    request.input = { ...request.input, reviewDigest: request.review.reviewDigest };
    const config = { ...binding, approvedCommandDigest: launchOperatorCommandDigest(request) };
    const result = launch(request, config).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    );
    try {
      const until = Date.now() + 1500;
      for (;;) {
        const waiting = (
          await sql<{ n: number }>`SELECT count(*)::integer AS n FROM pg_stat_activity
          WHERE ${pid}::integer=ANY(pg_blocking_pids(pid))`.execute(database)
        ).rows[0]!.n;
        if (waiting > 0) break;
        if (Date.now() > until) throw new Error('Opening did not reach the native policy lock.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await sql`SELECT pg_sleep(2.1)`.execute(database);
    } finally {
      release();
      await holder;
    }
    expect(await result).toMatchObject({ ok: false });
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('command_id', '=', request.input.requestId)
        .execute(),
    ).toHaveLength(0);
  });
  it('checks the original native database owner before opening the MFA key file', async () => {
    const user = await staff(),
      command = mfaRequest(user.userId),
      paths: string[] = [];
    const config = {
      ...mfa,
      databaseUser: 'other_owner',
      approvedCommandDigest: vpsMfaCommandDigest(command),
    };
    const changed = {
      NAKH_DATABASE_URL: secret.NAKH_DATABASE_URL.replace(
        binding.databaseUser + ':',
        'other_owner:',
      ),
    };
    await expect(
      runVpsMfaOperator(
        config,
        command,
        (path) => {
          paths.push(path);
          return Promise.resolve(path === config.databaseSecretPath ? changed : keys);
        },
        host,
        connect,
      ),
    ).rejects.toThrow();
    expect(paths).toEqual([binding.databaseSecretPath]);
    expect(
      await database
        .selectFrom('administration.admin_users')
        .select('id')
        .where('user_id', '=', user.userId)
        .execute(),
    ).toHaveLength(0);
  });
  it('denies machine drift before MFA key access after native owner admission', async () => {
    const user = await staff(),
      command = mfaRequest(user.userId),
      config = { ...mfa, approvedCommandDigest: vpsMfaCommandDigest(command) };
    const paths: string[] = [];
    let calls = 0;
    await expect(
      runVpsMfaOperator(
        config,
        command,
        (path) => {
          paths.push(path);
          return read(path);
        },
        () =>
          Promise.resolve({
            platform: 'linux',
            uid: 0,
            machineId: ++calls < 4 ? binding.machineId : 'd'.repeat(32),
          }),
        connect,
      ),
    ).rejects.toThrow();
    expect(paths).toEqual([binding.databaseSecretPath]);
    expect(
      await database
        .selectFrom('administration.admin_users')
        .select('id')
        .where('user_id', '=', user.userId)
        .execute(),
    ).toHaveLength(0);
  });
  it('converges native MFA approvals to one invitation, role assignment and operator receipt', async () => {
    const user = await staff(),
      command = mfaRequest(user.userId),
      config = { ...mfa, approvedCommandDigest: vpsMfaCommandDigest(command) };
    const results = await Promise.all(Array.from({ length: 8 }, () => approve(command, config)));
    const first = pending(results[0]);
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify(first))).toBe(true);
    expect(
      (
        await sql<{
          n: number;
        }>`SELECT count(*)::integer AS n FROM administration.admin_totp_operator_commands WHERE request_id=${command.input.requestId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
    expect(
      (
        await sql<{ role: string }>`SELECT role_code AS role FROM administration.admin_user_roles
      WHERE admin_user_id=(SELECT id FROM administration.admin_users WHERE user_id=${user.userId}::uuid) AND revoked_at IS NULL`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ role: 'support' }]);
  });
  it('captures the approved MFA subject and role before asynchronous credential access', async () => {
    const user = await staff(),
      foreign = await staff(),
      command = {
        operation: 'approve',
        input: {
          actorUserId: user.userId,
          requestId: randomUUID(),
          roles: ['support'],
          reasonCode: 'bootstrap',
        },
      };
    const config = { ...mfa, approvedCommandDigest: vpsMfaCommandDigest(command) };
    let first = true;
    const result = await runVpsMfaOperator(
      config,
      command,
      (path) => {
        if (first) {
          first = false;
          command.input.actorUserId = foreign.userId;
          command.input.roles = ['super_admin'];
          config.operatorId = randomUUID();
          config.totpSecretPath = '/run/operator/borrowed.json';
        }
        return read(path);
      },
      host,
      connect,
    );
    expect(pending(result).status).toBe('pending');
    expect(
      await database
        .selectFrom('administration.admin_users')
        .select('id')
        .where('user_id', '=', foreign.userId)
        .execute(),
    ).toHaveLength(0);
    expect(
      (
        await sql<{ role: string }>`SELECT role_code AS role FROM administration.admin_user_roles
      WHERE admin_user_id=(SELECT id FROM administration.admin_users WHERE user_id=${user.userId}::uuid) AND revoked_at IS NULL`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ role: 'support' }]);
  });
  it('keeps recovery independent of opening approval and revokes real native credential/session authority idempotently', async () => {
    const user = await staff(),
      command = mfaRequest(user.userId),
      config = { ...mfa, approvedCommandDigest: vpsMfaCommandDigest(command) };
    const approved = pending(await approve(command, config)),
      ring = new ReportSnapshotKeyRing(JSON.stringify(keys));
    const enrollments = new PostgresAdminTotpEnrollments(database, ring),
      actor = { kind: 'user' as const, userId: user.userId };
    const opened = await enrollments.begin({
      actor,
      invitationToken: approved.invitationToken,
      requestId: randomUUID(),
    });
    const at = await adminTotpDatabaseTime(database);
    const encoded = new URL(opened.enrollmentUri).searchParams.get('secret')!;
    const bits = [...encoded]
      .map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0'))
      .join('');
    const seed = Buffer.from(bits.match(/.{8}/gu)!.map((b) => parseInt(b, 2)));
    try {
      await enrollments.confirm({
        actor,
        invitationToken: approved.invitationToken,
        requestId: randomUUID(),
        code: adminTotpCode(seed, at),
      });
      const sessions = createPostgresTotpAdminSessions(database, ring);
      const session = await sessions.issue({
        actor,
        telegramUserId: user.telegramUserId,
        requestId: randomUUID(),
        proof: adminTotpCode(seed, new Date((adminTotpStep(at) + 1) * 30000)),
      });
      const credential = (
        await sql<{ id: string }>`SELECT id FROM administration.admin_totp_credentials
        WHERE admin_user_id=(SELECT id FROM administration.admin_users WHERE user_id=${user.userId}::uuid) AND revoked_at IS NULL`.execute(
          database,
        )
      ).rows[0]!;
      const revoke = {
        operation: 'revoke',
        input: {
          actorUserId: user.userId,
          credentialId: credential.id,
          requestId: randomUUID(),
          reasonCode: 'recovery',
        },
      };
      expect(await approve(revoke)).toEqual({ status: 'revoked', replayed: false });
      expect(await approve(revoke)).toEqual({ status: 'revoked', replayed: true });
      expect(
        await sessions.authenticate({ bearerToken: session.adminSessionToken, audience: 'admin' }),
      ).toBeUndefined();
    } finally {
      seed.fill(0);
    }
  });
  it('requires historical key custody even for revoked credentials before another enrollment', async () => {
    const user = await staff(),
      command = mfaRequest(user.userId);
    for (const changed of [
      { keyId, keyVersion: 1, key: Buffer.alloc(32, 48).toString('base64url') },
      { keyId: 'totp-vps-next', keyVersion: 2, key: Buffer.alloc(32, 49).toString('base64url') },
    ]) {
      const config = {
        ...mfa,
        keyId: changed.keyId,
        keyVersion: changed.keyVersion,
        approvedCommandDigest: vpsMfaCommandDigest(command),
      };
      await expect(
        runVpsMfaOperator(
          config,
          command,
          (path) => Promise.resolve(path === binding.databaseSecretPath ? secret : [changed]),
          host,
          connect,
        ),
      ).rejects.toThrow();
    }
    expect(
      await database
        .selectFrom('administration.admin_users')
        .select('id')
        .where('user_id', '=', user.userId)
        .execute(),
    ).toHaveLength(0);
  });
  it('runs compiled digest CLIs only as qualified root without changing native authority', async () => {
    const workspace = resolve(process.cwd());
    const directory = await mkdtemp(join(workspace, 'nakh-vps-cli-fixture-'));
    if (!resolve(directory).startsWith(workspace + sep))
      throw new Error('Unexpected native CLI fixture path.');
    const before = (
      await sql`SELECT count(*)::text AS n FROM platform.audit_logs`.execute(database)
    ).rows;
    try {
      const cohort = { operation: 'apply', input: await intent() },
        mfaCommand = mfaRequest(owner);
      const commands = [
        { name: 'vps-launch-operator', input: cohort, digest: launchOperatorCommandDigest(cohort) },
        {
          name: 'vps-admin-totp-operator',
          input: mfaCommand,
          digest: vpsMfaCommandDigest(mfaCommand),
        },
      ];
      for (const command of commands) {
        const inputPath = join(directory, `${command.name}.json`),
          outputPath = join(directory, `${command.name}-result.json`);
        await writeFile(inputPath, JSON.stringify(command.input), { mode: 0o600 });
        const run = promisify(execFile)(
          process.execPath,
          [
            resolve(`packages/persistence-postgres/dist/cli/${command.name}.js`),
            '--digest',
            inputPath,
            outputPath,
          ],
          { timeout: 30000, maxBuffer: 65536 },
        );
        if (process.platform === 'linux' && process.getuid?.() === 0) {
          await run;
          expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual({
            commandDigest: command.digest,
          });
        } else {
          await expect(run).rejects.toMatchObject({ code: 1 });
          await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        }
      }
      expect(
        (await sql`SELECT count(*)::text AS n FROM platform.audit_logs`.execute(database)).rows,
      ).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
