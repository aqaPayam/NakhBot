import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sql } from 'kysely';
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from 'vitest';
import { adminTotpCode, adminTotpStep, createAdminTotpEnrollment } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, sourceMigrationDigests } from './migrations.js';
import {
  PostgresWorkforceCarryover,
  type WorkforceCarryoverRequest,
} from './workforce-carryover-store.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { createPostgresTotpAdminSessions } from './admin-totp-verifier.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import { createMediaAuthorityFixture } from './testing/media-authority-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
type Lease = Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
describe.skipIf(url === undefined)('native clean workforce carryover', () => {
  let source: NakhDatabase, target: NakhDatabase, sourceLease: Lease, targetLease: Lease;
  let sourceDirectory: string, targetDirectory: string;
  let sourceMigrations: WorkforceCarryoverRequest['sourceMigrations'],
    targetMigrations: WorkforceCarryoverRequest['targetMigrations'];
  beforeAll(async () => {
    sourceDirectory = await mkdtemp(join(tmpdir(), 'workforce-legacy-'));
    targetDirectory = await mkdtemp(join(tmpdir(), 'workforce-current-'));
    for (const name of await readdir(resolve('migrations'))) {
      if (!/^\d{6}_[a-z0-9_]+\.sql$/u.test(name)) continue;
      const canonical = (await readFile(join(resolve('migrations'), name), 'utf8')).replace(
        /\r\n/gu,
        '\n',
      );
      await writeFile(join(targetDirectory, name), canonical);
      if (Number(name.slice(0, 6)) <= 164)
        await writeFile(join(sourceDirectory, name), canonical.replace(/\n/gu, '\r\n'));
    }
    sourceMigrations = await sourceMigrationDigests(sourceDirectory);
    targetMigrations = await sourceMigrationDigests(targetDirectory);
    expect(sourceMigrations).toHaveLength(164);
    expect(targetMigrations).toHaveLength(171);
    expect(sourceMigrations[0]!.sha256).not.toBe(targetMigrations[0]!.sha256);
  });
  beforeEach(async () => {
    sourceLease = await createIsolatedTestDatabase(url!, 'workforce_source');
    targetLease = await createIsolatedTestDatabase(url!, 'workforce_target');
    await runMigrations(sourceLease.url, sourceDirectory);
    await runMigrations(targetLease.url, targetDirectory);
    source = createDatabase({
      url: sourceLease.url,
      poolMax: 16,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 20000,
    });
    target = createDatabase({
      url: targetLease.url,
      poolMax: 16,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 20000,
    });
  });
  afterEach(async () => {
    await source?.destroy();
    await target?.destroy();
    await sourceLease?.destroy();
    await targetLease?.destroy();
  });
  afterAll(async () => {
    await rm(sourceDirectory, { recursive: true, force: true });
    await rm(targetDirectory, { recursive: true, force: true });
  });
  type Staff = {
    userId: string;
    adminId: string;
    credentialId: string;
    telegram: string;
    seed: Buffer;
    key: Buffer;
    request: WorkforceCarryoverRequest;
  };
  async function staff(largeTelegram = false): Promise<Staff> {
    const userId = await createReportUser(source),
      adminId = randomUUID(),
      credentialId = randomUUID();
    const telegram = largeTelegram
        ? '9007199254740993'
        : String(700000000000 + Math.floor(Math.random() * 100000000000)),
      now = new Date();
    await source
      .insertInto('identity.telegram_identities')
      .values({
        user_id: userId,
        telegram_user_id: telegram,
        username: null,
        first_seen_at: now,
        last_seen_at: now,
      })
      .execute();
    await source
      .insertInto('administration.admin_users')
      .values({
        id: adminId,
        user_id: userId,
        telegram_user_id: telegram,
        is_active: true,
        disabled_at: null,
        identity_verified_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await source
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'super_admin',
        assigned_by_admin_id: adminId,
        revoked_at: null,
        revoked_by_admin_id: null,
      })
      .execute();
    const key = randomBytes(32),
      enrollment = createAdminTotpEnrollment(
        { actorUserId: userId, credentialId },
        { keyId: 'synthetic-workforce-key', keyVersion: 1, key },
      );
    const encoded = new URL(enrollment.enrollmentUri).searchParams.get('secret')!;
    const bits = [...encoded]
      .map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0'))
      .join('');
    const seed = Buffer.from(bits.match(/.{8}/gu)!.map((b) => parseInt(b, 2)));
    const auditId = randomUUID();
    // Native text keeps all six timestamp decimals; no JS Date round trip.
    const at = (
      await sql<{
        at: string;
      }>`SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')-interval '2 minutes','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(
        source,
      )
    ).rows[0]!.at;
    await source.transaction().execute(async (tx) => {
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id: auditId,
          category: 'security',
          event_type: 'administration.totp-activated.v1',
          actor_type: 'user',
          actor_user_id: userId,
          actor_admin_id: null,
          subject_type: 'admin_totp_credential',
          subject_id: credentialId,
          result_code: 'activated',
          metadata_schema_version: 1,
          metadata: {},
          command_id: randomUUID(),
          request_id: randomUUID(),
          occurred_at: sql<Date>`${at}::timestamptz`,
        })
        .execute();
      await sql`INSERT INTO administration.admin_totp_credentials(id,admin_user_id,ciphertext,nonce,key_id,key_version,activated_at,activation_audit_id,last_used_step)
        VALUES(${credentialId}::uuid,${adminId}::uuid,${Buffer.from(enrollment.secret.ciphertext)},${Buffer.from(enrollment.secret.nonce)},${enrollment.secret.keyId},${enrollment.secret.keyVersion},${at}::timestamptz,${auditId}::uuid,GREATEST(0,floor(extract(epoch FROM ${at}::timestamptz)/30)::bigint-1))`.execute(
        tx,
      );
    });
    return {
      userId,
      adminId,
      credentialId,
      telegram,
      seed,
      key,
      request: {
        version: 1,
        commandId: randomUUID(),
        operatorId: randomUUID(),
        sourceSha: '1'.repeat(40),
        targetSha: '2'.repeat(40),
        adminIds: [adminId],
        sourceMigrations,
        targetMigrations,
      },
    };
  }
  async function credential(db: NakhDatabase, id: string): Promise<unknown> {
    return (
      await sql<{
        body: unknown;
      }>`SELECT jsonb_build_object('id',id,'admin',admin_user_id,'ciphertext',encode(ciphertext,'hex'),'nonce',encode(nonce,'hex'),'key',key_id,'version',key_version,'activatedMicros',(extract(epoch FROM activated_at)*1000000)::numeric::text,'audit',activation_audit_id,'step',last_used_step::text,'revoked',revoked_at) AS body FROM administration.admin_totp_credentials WHERE id=${id}::uuid`.execute(
        db,
      )
    ).rows[0]?.body;
  }
  async function count(db: NakhDatabase, table: string): Promise<number> {
    return Number(
      (
        await sql<{
          n: string;
        }>`SELECT count(*)::text AS n FROM ${sql.id(...table.split('.'))}`.execute(db)
      ).rows[0]!.n,
    );
  }
  it('preserves exact encrypted authority across a populated CRLF-164 source and fresh LF-171 target, excluding product data and old sign-ins', async () => {
    const f = await staff();
    try {
      await createMediaAuthorityFixture(source, 'owner_preview', f.userId);
      await createReportUser(source, true);
      await source
        .insertInto('billing.credit_accounts')
        .values({ user_id: f.userId, created_at: new Date(), updated_at: new Date() })
        .execute();
      await new PostgresCreditLedgerStore(source).append({
        transactionId: randomUUID(),
        userId: f.userId,
        transactionType: 'admin_adjustment',
        amount: 777n,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      });
      const oldGrant = await new PostgresUserSessionStore(source).issue(
        { userId: f.userId, productEpoch: 0 },
        randomUUID(),
      );
      const sourceSessions = createPostgresTotpAdminSessions(source, {
        resolve: () => Buffer.from(f.key),
      });
      const step = adminTotpStep(
        (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(source)).rows[0]!.at,
      );
      await sourceSessions.issue({
        actor: { kind: 'user', userId: f.userId },
        telegramUserId: f.telegram,
        requestId: randomUUID(),
        proof: adminTotpCode(f.seed, new Date(step * 30000)),
      });
      const original = await credential(source, f.credentialId);
      const store = new PostgresWorkforceCarryover(source, target),
        result = await store.execute(f.request);
      expect(result).toMatchObject({
        status: 'restored',
        replayed: false,
        staffUsers: 1,
        activeAdministrators: 1,
        credentials: 1,
      });
      expect(await credential(target, f.credentialId)).toEqual(original);
      expect(await credential(source, f.credentialId)).toEqual(original);
      expect(await count(target, 'identity.users')).toBe(1);
      for (const table of [
        'profile.profiles',
        'media.media_assets',
        'media.profile_photos',
        'billing.credit_transactions',
        'administration.admin_sessions',
        'administration.admin_totp_proofs',
        'administration.admin_totp_enrollments',
        'platform.outbox_events',
      ])
        expect(await count(target, table)).toBe(0);
      expect(
        await target
          .selectFrom('identity.accounts')
          .select(['state', 'product_epoch'])
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'guest', product_epoch: 0 });
      expect(
        (
          await target
            .selectFrom('billing.credit_accounts')
            .select('balance')
            .executeTakeFirstOrThrow()
        ).balance,
      ).toBe('0');
      expect(
        await new PostgresUserSessionStore(target).current(
          { userId: f.userId, productEpoch: 0 },
          oldGrant!.id,
        ),
      ).toBeUndefined();
      const next = createPostgresTotpAdminSessions(target, { resolve: () => Buffer.from(f.key) });
      await expect(
        next.issue({
          actor: { kind: 'user', userId: f.userId },
          telegramUserId: f.telegram,
          requestId: randomUUID(),
          proof: adminTotpCode(f.seed, new Date(step * 30000)),
        }),
      ).rejects.toMatchObject({ status: 401 });
      const fresh = await next.issue({
        actor: { kind: 'user', userId: f.userId },
        telegramUserId: f.telegram,
        requestId: randomUUID(),
        proof: adminTotpCode(
          f.seed,
          new Date(Math.max(step + 1, adminTotpStep(new Date())) * 30000),
        ),
      });
      expect(fresh.adminSessionToken).toBeTruthy();
      const advanced = await credential(target, f.credentialId);
      expect((await store.execute(f.request)).replayed).toBe(true);
      expect(await credential(target, f.credentialId)).toEqual(advanced);
    } finally {
      f.seed.fill(0);
      f.key.fill(0);
    }
  });
  it.each(['minimum', 'bigint'] as const)(
    'preserves the %s replay floor and a bigint Telegram binding without rounding',
    async (kind) => {
      const f = await staff(true);
      try {
        if (kind === 'bigint')
          await sql`UPDATE administration.admin_totp_credentials SET last_used_step=9223372036854775800 WHERE id=${f.credentialId}::uuid`.execute(
            source,
          );
        const original = await credential(source, f.credentialId);
        await new PostgresWorkforceCarryover(source, target).execute(f.request);
        expect(await credential(target, f.credentialId)).toEqual(original);
        expect(
          (
            await sql<{
              id: string;
            }>`SELECT telegram_user_id::text AS id FROM identity.telegram_identities WHERE user_id=${f.userId}::uuid`.execute(
              target,
            )
          ).rows[0]!.id,
        ).toBe(f.telegram);
      } finally {
        f.seed.fill(0);
        f.key.fill(0);
      }
    },
  );
  it('serializes eight same-command attempts to one native audit and never repeats imported authority', async () => {
    const f = await staff();
    try {
      const store = new PostgresWorkforceCarryover(source, target);
      const results = await Promise.all(Array.from({ length: 8 }, () => store.execute(f.request)));
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.requestDigest)).size).toBe(1);
      expect(await count(target, 'administration.admin_totp_credentials')).toBe(1);
      expect(
        await target
          .selectFrom('platform.audit_logs')
          .select('id')
          .where('event_type', '=', 'administration.workforce-carried-over.v1')
          .execute(),
      ).toHaveLength(1);
    } finally {
      f.seed.fill(0);
      f.key.fill(0);
    }
  });
  it('rejects stale ledgers, a different administrator scope, same-database copies and nonempty targets before writing', async () => {
    const f = await staff();
    try {
      const store = new PostgresWorkforceCarryover(source, target);
      for (const request of [
        { ...f.request, sourceMigrations: sourceMigrations.slice(0, -1) },
        { ...f.request, targetMigrations: targetMigrations.slice(0, -1) },
        { ...f.request, adminIds: [randomUUID()] },
      ])
        await expect(store.execute(request)).rejects.toThrow('Workforce carryover unavailable.');
      await expect(
        new PostgresWorkforceCarryover(source, source).execute(f.request),
      ).rejects.toThrow();
      expect(await count(target, 'identity.users')).toBe(0);
      const existing = await createReportUser(target, true);
      await expect(store.execute(f.request)).rejects.toThrow();
      expect(
        (await target.selectFrom('identity.users').select('id').execute()).map((r) => r.id),
      ).toEqual([existing]);
      expect(await count(target, 'administration.admin_totp_credentials')).toBe(0);
    } finally {
      f.seed.fill(0);
      f.key.fill(0);
    }
  });
  it('rolls every imported row back when the required audit fails, with native guards enabled', async () => {
    const f = await staff();
    try {
      const original = await credential(source, f.credentialId);
      await sql`CREATE SEQUENCE public.workforce_receipt_attempts`.execute(target);
      await sql`CREATE FUNCTION public.fail_workforce_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='administration.workforce-carried-over.v1' THEN PERFORM nextval('public.workforce_receipt_attempts'); RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`.execute(
        target,
      );
      await sql`CREATE TRIGGER fail_workforce_receipt BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION public.fail_workforce_receipt()`.execute(
        target,
      );
      await expect(
        new PostgresWorkforceCarryover(source, target).execute(f.request),
      ).rejects.toThrow();
      expect(
        (
          await sql<{
            is_called: boolean;
          }>`SELECT is_called FROM public.workforce_receipt_attempts`.execute(target)
        ).rows[0]!.is_called,
      ).toBe(true);
      expect(await count(target, 'identity.users')).toBe(0);
      expect(await count(target, 'administration.admin_totp_credentials')).toBe(0);
      expect(await credential(source, f.credentialId)).toEqual(original);
    } finally {
      f.seed.fill(0);
      f.key.fill(0);
    }
  });
  it('refuses a non-superuser source connection without reading encrypted workforce rows', async () => {
    const f = await staff(),
      name = 'workforce_reader_' + randomUUID().replaceAll('-', '').slice(0, 12),
      password = randomBytes(24).toString('base64url');
    let restricted: NakhDatabase | undefined;
    try {
      await sql`CREATE ROLE ${sql.id(name)} LOGIN PASSWORD ${sql.lit(password)}`.execute(source);
      const endpoint = new URL(sourceLease.url);
      endpoint.username = name;
      endpoint.password = password;
      restricted = createDatabase({
        url: endpoint.toString(),
        poolMax: 1,
        statementTimeoutMs: 10000,
        lockTimeoutMs: 5000,
      });
      await expect(
        new PostgresWorkforceCarryover(restricted, target).execute(f.request),
      ).rejects.toThrow('Workforce carryover unavailable.');
      expect(await count(target, 'identity.users')).toBe(0);
    } finally {
      await restricted?.destroy();
      await sql`DROP ROLE IF EXISTS ${sql.id(name)}`.execute(source);
      f.seed.fill(0);
      f.key.fill(0);
    }
  });
});
