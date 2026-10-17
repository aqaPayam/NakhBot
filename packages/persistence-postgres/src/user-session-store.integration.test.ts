import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AesGcmProfileReportSnapshotProtector,
  AesGcmProfileReportSnapshotReader,
  ReportTokenFactory,
  type OpaqueTokenStore,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import {
  createReportUser,
  createReportLike,
  createReportFixtureAdmin,
} from './testing/report-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { PostgresUserSessionStore, createPostgresUserSessions } from './user-session-store.js';
import { createPostgresReportServices } from './report-services.js';
import { createPostgresAdminSessions } from './admin-session-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('native original-life session grants', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_user_sessions');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  const key = Buffer.alloc(32, 103);
  it('hands off one existing native grant concurrently without new audit facts or extending expiry', async () => {
    const life = { userId: await createReportUser(database), productEpoch: 0 };
    const sessions = createPostgresUserSessions(database, key);
    const issued = await sessions.issue(life, randomUUID());
    const actor = (await sessions.authenticate({
      bearerToken: issued.userSessionToken,
      audience: 'user',
    }))!;
    const factsQuery = database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('actor_user_id', '=', life.userId)
      .orderBy('id');
    const facts = (): ReturnType<typeof factsQuery.execute> => factsQuery.execute();
    const before = await facts();
    const exported = await Promise.all(
      Array.from({ length: 20 }, () => sessions.exportCurrent(actor)),
    );
    expect(await facts()).toEqual(before);
    expect(exported.every((value) => value.expiresAt === issued.expiresAt)).toBe(true);
    for (const value of exported) {
      expect(
        await sessions.authenticate({ bearerToken: value.userSessionToken, audience: 'user' }),
      ).toEqual(actor);
      expect(
        await sessions.authenticate({ bearerToken: value.userSessionToken, audience: 'admin' }),
      ).toBeUndefined();
    }
    for (const borrowed of [
      { ...actor, userId: await createReportUser(database) },
      { ...actor, productEpoch: 1 },
      { ...actor, sessionGrantId: randomUUID() },
    ])
      await expect(sessions.exportCurrent(borrowed)).rejects.toMatchObject({ status: 401 });
    await sessions.revoke(life, issued.userSessionToken, randomUUID());
    await expect(sessions.exportCurrent(actor)).rejects.toMatchObject({ status: 401 });
    expect(
      await sessions.authenticate({ bearerToken: exported[0]!.userSessionToken, audience: 'user' }),
    ).toBeUndefined();
    expect(
      (await facts()).filter((row) => row.event_type === 'identity.user-session-issued.v1'),
    ).toHaveLength(1);
  });
  it('fences durable report replay by live grant and original epoch under twenty concurrent retries', async () => {
    const userId = await createReportUser(database),
      target = await createReportUser(database, true);
    const life = { userId, productEpoch: 0 },
      actor = { kind: 'user' as const, userId };
    const sessions = new PostgresUserSessionStore(database),
      grant = (await sessions.issue(life, randomUUID()))!;
    const values = new Map<string, string>();
    const store: OpaqueTokenStore = {
      get: (id) => Promise.resolve(values.get(id)),
      putIfAbsent: (id, value) => {
        if (values.has(id)) return Promise.resolve(false);
        values.set(id, value);
        return Promise.resolve(true);
      },
    };
    const refs = new ReportTokenFactory({ forLife: () => store }, key);
    const services = createPostgresReportServices(database, refs, store, key, {
      profile: {
        protector: new AesGcmProfileReportSnapshotProtector('m8-session-report', 1, key),
        reader: new AesGcmProfileReportSnapshotReader({ resolve: () => key }),
      },
    });
    const source = await createReportLike(database, userId, target);
    const sourceActionToken = (
      await refs.forLife(life).issueSource(userId, { kind: 'received_like', referenceId: source })
    ).token;
    const query = {
      actor,
      requestId: randomUUID(),
      sourceActionToken,
      requestedEvidenceTypes: ['profile' as const],
    };
    const prepared = await services.prepare.execute(query, actor, 0, grant.id);
    const command = {
      actor,
      commandId: randomUUID(),
      commandType: 'moderation.submit-report' as const,
      schemaVersion: 1 as const,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { reasonCode: 'harassment', evidenceIntentToken: prepared.evidenceIntentToken },
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => services.submit.execute(command, actor, 0, grant.id)),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.reportId)).size).toBe(1);
    await sessions.revoke(life, grant.id, randomUUID());
    await expect(services.submit.execute(command, actor, 0, grant.id)).rejects.toMatchObject({
      code: 'report_unavailable',
    });
    const replacement = (await sessions.issue(life, randomUUID()))!;
    expect((await services.submit.execute(command, actor, 0, replacement.id)).replayed).toBe(true);
    // Privileged fault fixture, not approved Return: retained safety receipts cannot become a new life's receipt.
    await database.transaction().execute(async (tx) => {
      await sql`ALTER TABLE identity.accounts DISABLE TRIGGER USER`.execute(tx);
      try {
        await tx
          .updateTable('identity.accounts')
          .set({ product_epoch: 1 })
          .where('user_id', '=', userId)
          .execute();
      } finally {
        await sql`ALTER TABLE identity.accounts ENABLE TRIGGER USER`.execute(tx);
      }
    });
    const fresh = (await sessions.issue({ userId, productEpoch: 1 }, randomUUID()))!;
    await expect(services.submit.execute(command, actor, 1, fresh.id)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    await expect(services.prepare.execute(query, actor, 1, fresh.id)).rejects.toMatchObject({
      code: 'report_unavailable',
    });
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('reporter_user_id', '=', userId)
        .execute(),
    ).toHaveLength(1);
  });
  it('denies stale first-factor admission without revoking independently issued workforce sessions', async () => {
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
    const life = { userId: admin.user_id, productEpoch: 0 },
      users = createPostgresUserSessions(database, key);
    const userToken = (await users.issue(life, randomUUID())).userSessionToken;
    const userSession = (await users.authenticate({ bearerToken: userToken, audience: 'user' }))!;
    const staff = createPostgresAdminSessions(database, {
      verify: () =>
        Promise.resolve({
          actorUserId: life.userId,
          telegramUserId: admin.telegram_user_id,
          proofId: randomUUID(),
          verifiedAt: new Date(Date.now() - 1000),
          expiresAt: new Date(Date.now() + 240000),
        }),
    });
    const input = {
      actor: { kind: 'user' as const, userId: life.userId },
      telegramUserId: admin.telegram_user_id,
      requestId: randomUUID(),
      proof: 'synthetic-first-factor-MFA',
      userSession,
    };
    const independent = await staff.issue(input);
    await users.revoke(life, userToken, randomUUID());
    await expect(staff.issue({ ...input, requestId: randomUUID() })).rejects.toMatchObject({
      status: 401,
    });
    expect(
      await staff.authenticate({ bearerToken: independent.adminSessionToken, audience: 'admin' }),
    ).toMatchObject({ kind: 'admin', userId: life.userId });
    expect(
      (
        await sql<{
          id: string;
        }>`SELECT id FROM administration.admin_sessions WHERE admin_user_id=${adminId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('serializes twenty issuance retries into one immutable grant and fixed expiry', async () => {
    const life = { userId: await createReportUser(database), productEpoch: 0 },
      requestId = randomUUID();
    const store = new PostgresUserSessionStore(database);
    const grants = await Promise.all(
      Array.from({ length: 20 }, () => store.issue(life, requestId)),
    );
    expect(grants.every((grant) => grant !== undefined)).toBe(true);
    expect(new Set(grants.map((grant) => grant!.id)).size).toBe(1);
    expect(new Set(grants.map((grant) => grant!.expiresAt.toISOString())).size).toBe(1);
    const first = grants[0]!;
    expect(first.expiresAt.getTime() - first.issuedAt.getTime()).toBe(900000);
    const again = await store.issue(life, requestId);
    expect(again).toEqual(first);
    const rows = await database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('actor_user_id', '=', life.userId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual({
      productEpoch: 0,
      expiresAt: first.expiresAt.toISOString(),
    });
    await expect(
      database
        .updateTable('platform.audit_logs')
        .set({ result_code: 'changed' })
        .where('id', '=', first.id)
        .execute(),
    ).rejects.toBeDefined();
  });
  it('serializes twenty revocations into one fact and never revives an idempotent grant', async () => {
    const life = { userId: await createReportUser(database), productEpoch: 0 },
      requestId = randomUUID();
    const sessions = createPostgresUserSessions(database, key),
      store = new PostgresUserSessionStore(database);
    const issued = await sessions.issue(life, requestId);
    expect(
      await sessions.authenticate({ bearerToken: issued.userSessionToken, audience: 'user' }),
    ).toMatchObject(life);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        sessions.revoke(life, issued.userSessionToken, randomUUID()),
      ),
    );
    expect(
      await sessions.authenticate({ bearerToken: issued.userSessionToken, audience: 'user' }),
    ).toBeUndefined();
    expect(await store.issue(life, requestId)).toBeUndefined();
    const rows = await database
      .selectFrom('platform.audit_logs')
      .select('id')
      .where('actor_user_id', '=', life.userId)
      .where('event_type', '=', 'identity.user-session-revoked.v1')
      .execute();
    expect(rows).toHaveLength(1);
    const replacement = await sessions.issue(life, randomUUID());
    expect(
      await sessions.authenticate({ bearerToken: replacement.userSessionToken, audience: 'user' }),
    ).toMatchObject(life);
  });
  it('denies every issued bearer immediately after actual Root admission and cannot issue to tombstones', async () => {
    const sessions = createPostgresUserSessions(database, key);
    let token!: string;
    let original!: NonNullable<Awaited<ReturnType<typeof sessions.authenticate>>>;
    let exported!: string;
    const { userId } = await createDeletionFixture(database, async (subject) => {
      token = (await sessions.issue({ userId: subject, productEpoch: 0 }, randomUUID()))
        .userSessionToken;
      expect(await sessions.authenticate({ bearerToken: token, audience: 'user' })).toMatchObject({
        userId: subject,
      });
      original = (await sessions.authenticate({ bearerToken: token, audience: 'user' }))!;
      exported = (await sessions.exportCurrent(original)).userSessionToken;
    });
    expect(await sessions.authenticate({ bearerToken: token, audience: 'user' })).toBeUndefined();
    expect(
      await sessions.authenticate({ bearerToken: exported, audience: 'user' }),
    ).toBeUndefined();
    await expect(sessions.exportCurrent(original)).rejects.toMatchObject({ status: 401 });
    await expect(sessions.issue({ userId, productEpoch: 0 }, randomUUID())).rejects.toMatchObject({
      status: 401,
    });
    // Revocation remains available after tombstoning, without authorizing product use.
    await sessions.revoke({ userId, productEpoch: 0 }, token, randomUUID());
    expect(await sessions.authenticate({ bearerToken: token, audience: 'user' })).toBeUndefined();
  });
  it('never upgrades a prior-life bearer or lets a new life revoke its grant', async () => {
    const userId = await createReportUser(database),
      sessions = createPostgresUserSessions(database, key);
    const old = await sessions.issue({ userId, productEpoch: 0 }, randomUUID());
    const original = (await sessions.authenticate({
      bearerToken: old.userSessionToken,
      audience: 'user',
    }))!;
    // Privileged fault fixture only: this is not approved native Return evidence.
    await database.transaction().execute(async (tx) => {
      await sql`ALTER TABLE identity.accounts DISABLE TRIGGER USER`.execute(tx);
      try {
        await tx
          .updateTable('identity.accounts')
          .set({ product_epoch: 1 })
          .where('user_id', '=', userId)
          .execute();
      } finally {
        await sql`ALTER TABLE identity.accounts ENABLE TRIGGER USER`.execute(tx);
      }
    });
    expect(
      await sessions.authenticate({ bearerToken: old.userSessionToken, audience: 'user' }),
    ).toBeUndefined();
    await expect(sessions.exportCurrent(original)).rejects.toMatchObject({ status: 401 });
    await expect(sessions.issue({ userId, productEpoch: 0 }, randomUUID())).rejects.toMatchObject({
      status: 401,
    });
    const fresh = await sessions.issue({ userId, productEpoch: 1 }, randomUUID());
    expect(
      await sessions.authenticate({ bearerToken: fresh.userSessionToken, audience: 'user' }),
    ).toMatchObject({ userId, productEpoch: 1 });
    await expect(
      sessions.revoke({ userId, productEpoch: 1 }, old.userSessionToken, randomUUID()),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      await sessions.authenticate({ bearerToken: fresh.userSessionToken, audience: 'user' }),
    ).toBeDefined();
  });
  it('rejects unknown grants, wrong owners, expired facts and malformed metadata', async () => {
    const life = { userId: await createReportUser(database), productEpoch: 0 },
      store = new PostgresUserSessionStore(database);
    const native = (await store.issue(life, randomUUID()))!;
    expect(
      await store.current({ userId: await createReportUser(database), productEpoch: 0 }, native.id),
    ).toBeUndefined();
    expect(await store.current(life, randomUUID())).toBeUndefined();
    for (const metadata of [
      { productEpoch: 0, expiresAt: new Date(900000).toISOString() },
      { productEpoch: 1, expiresAt: new Date(Date.now() + 900000).toISOString() },
      { productEpoch: 0, expiresAt: 'invalid' },
      { productEpoch: 0, expiresAt: new Date(Date.now() + 900000).toISOString(), extra: true },
    ]) {
      const id = randomUUID(),
        request = randomUUID();
      await database
        .insertInto('platform.audit_logs')
        .values({
          id,
          category: 'security',
          event_type: 'identity.user-session-issued.v1',
          actor_type: 'user',
          actor_user_id: life.userId,
          actor_admin_id: null,
          subject_type: 'user_session',
          subject_id: id,
          result_code: 'issued',
          metadata_schema_version: 1,
          metadata,
          command_id: request,
          request_id: request,
          occurred_at: new Date(0),
        })
        .execute();
      expect(await store.current(life, id)).toBeUndefined();
      await expect(
        createPostgresUserSessions(database, key).exportCurrent({
          ...life,
          kind: 'user',
          sessionGrantId: id,
        }),
      ).rejects.toMatchObject({ status: 401 });
    }
  });
  it('fails issuance atomically when its immutable audit cannot be written', async () => {
    const life = { userId: await createReportUser(database), productEpoch: 0 };
    await sql`CREATE FUNCTION platform.m8_session_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type = 'identity.user-session-issued.v1' THEN RAISE EXCEPTION 'synthetic session audit fault'; END IF;
      RETURN NEW; END $$`.execute(database);
    await sql`CREATE TRIGGER m8_session_audit_fault BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION platform.m8_session_audit_fault()`.execute(
      database,
    );
    try {
      await expect(
        createPostgresUserSessions(database, key).issue(life, randomUUID()),
      ).rejects.toBeDefined();
      expect(
        await database
          .selectFrom('platform.audit_logs')
          .select('id')
          .where('actor_user_id', '=', life.userId)
          .execute(),
      ).toHaveLength(0);
    } finally {
      await sql`DROP TRIGGER m8_session_audit_fault ON platform.audit_logs`.execute(database);
      await sql`DROP FUNCTION platform.m8_session_audit_fault()`.execute(database);
    }
  });
});
