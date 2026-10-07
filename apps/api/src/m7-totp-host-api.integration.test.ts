import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import {
  adminTotpCode,
  adminTotpStep,
  ReportTokens,
  AesGcmReviewNoteProtector,
  type OpaqueTokenStore,
} from '@nakh/application';
import {
  createDatabase,
  runMigrations,
  PostgresAdminTotpOperator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createReportFixtureAdmin } from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { createM7TotpSessionHostOptions } from './m7-session-host-services.js';
import { M7HostApiModule } from './m7-host-api.js';
import { ApiExceptionFilter } from './app.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)(
  'actual authenticator enrollment and sessions in the shared HTTP host',
  () => {
    let database: NakhDatabase,
      isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined,
      app: NestFastifyApplication | undefined,
      operator: PostgresAdminTotpOperator;
    const key = randomBytes(32),
      encryption = { keyId: 'http-totp-test-key', keyVersion: 1, key };
    const keys = {
      resolve: (id: string, version: number): Buffer | undefined =>
        id === encryption.keyId && version === 1 ? Buffer.from(key) : undefined,
    };
    const users = new Map<string, { kind: 'user'; userId: string }>();
    const authenticate = vi.fn(({ bearerToken }: { bearerToken: string }) =>
      Promise.resolve(users.get(bearerToken)),
    );
    const error = vi.fn();
    let composition: ReturnType<typeof createM7TotpSessionHostOptions>;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'nakh_totp_http');
      await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 20,
        statementTimeoutMs: 15000,
        lockTimeoutMs: 10000,
      });
      operator = new PostgresAdminTotpOperator(
        database,
        { operatorId: randomUUID() },
        encryption,
        keys,
      );
      const values = new Map<string, string>();
      const tokens: OpaqueTokenStore = {
        get: (k) => Promise.resolve(values.get(k)),
        putIfAbsent: (k, v) => {
          if (values.has(k)) return Promise.resolve(false);
          values.set(k, v);
          return Promise.resolve(true);
        },
      };
      composition = createM7TotpSessionHostOptions({
        database,
        userAuthenticator: { authenticate },
        totpKeys: keys,
        reportTokens: new ReportTokens(tokens, randomBytes(32)),
        adminTokens: tokens,
        adminKey: randomBytes(32),
        safetyTokens: tokens,
        safetyKey: randomBytes(32),
        capabilities: {},
        reviewNotes: new AesGcmReviewNoteProtector('http-totp-notes', 1, randomBytes(32)),
      });
      app = await NestFactory.create<NestFastifyApplication>(
        M7HostApiModule.register(composition.host),
        new FastifyAdapter(),
        { logger: false },
      );
      app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });
    afterAll(async () => {
      await app?.close();
      operator?.dispose();
      key.fill(0);
      try {
        await database?.destroy();
      } finally {
        await isolated?.destroy();
      }
    });
    async function staff(): Promise<{
      actor: { kind: 'user'; userId: string };
      headers: { authorization: string };
      invitationToken: string;
      adminId: string;
    }> {
      const adminId = await createReportFixtureAdmin(database);
      const admin = await database
        .selectFrom('administration.admin_users')
        .select('user_id')
        .where('id', '=', adminId)
        .executeTakeFirstOrThrow();
      const actor = { kind: 'user' as const, userId: admin.user_id },
        token = `first-factor-${randomUUID()}`;
      users.set(token, actor);
      const approval = await operator.approve({
        actorUserId: actor.userId,
        requestId: randomUUID(),
        roles: ['super_admin'],
        reasonCode: 'bootstrap',
      });
      if (approval.status !== 'pending') throw new Error('Synthetic approval unavailable.');
      return {
        actor,
        headers: { authorization: `Bearer ${token}` },
        invitationToken: approval.invitationToken,
        adminId,
      };
    }
    async function at(): Promise<Date> {
      return (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(database)).rows[0]!
        .at;
    }
    function code(uri: string, date: Date): string {
      const text = new URL(uri).searchParams.get('secret')!;
      const bits = [...text]
        .map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0'))
        .join('');
      const seed = Buffer.from(bits.match(/.{8}/gu)!.map((b) => parseInt(b, 2)));
      try {
        return adminTotpCode(seed, date);
      } finally {
        seed.fill(0);
      }
    }
    async function post(
      path: string,
      headers: { authorization: string },
      payload: object,
    ): ReturnType<NestFastifyApplication['inject']> {
      return app!.inject({ method: 'POST', url: `/v1/admin/auth/${path}`, headers, payload });
    }
    it('activates through the first-factor channel, signs in with the next real counter, authorizes native health and logs out', async () => {
      const s = await staff(),
        requestId = randomUUID();
      const opening = { actor: s.actor, invitationToken: s.invitationToken, requestId };
      const opened = await post('enrollment', s.headers, opening);
      expect(opened.statusCode).toBe(200);
      expect(opened.headers['cache-control']).toBe('no-store');
      const uri = opened.json<{ enrollmentUri: string }>().enrollmentUri,
        time = await at();
      const confirmation = { ...opening, requestId: randomUUID(), code: code(uri, time) };
      const confirmations = await Promise.all(
        Array.from({ length: 20 }, () => post('enrollment/confirm', s.headers, confirmation)),
      );
      expect(confirmations.every((r) => r.statusCode === 200)).toBe(true);
      expect(confirmations.filter((r) => !r.json<{ replayed: boolean }>().replayed)).toHaveLength(
        1,
      );
      expect(
        (
          await post('sessions', s.headers, {
            actor: s.actor,
            requestId: randomUUID(),
            code: confirmation.code,
          })
        ).statusCode,
      ).toBe(401);
      const signIn = await post('sessions', s.headers, {
        actor: s.actor,
        requestId: randomUUID(),
        code: code(uri, new Date((adminTotpStep(time) + 1) * 30000)),
      });
      expect(signIn.statusCode).toBe(200);
      expect(signIn.headers['cache-control']).toBe('no-store');
      const bearer = signIn.json<{ adminSessionToken: string }>().adminSessionToken,
        admin = { ...s.actor, kind: 'admin' as const };
      const adminHeaders = { authorization: `Bearer ${bearer}` };
      const callsBefore = authenticate.mock.calls.length;
      const health = await app!.inject({
        method: 'POST',
        url: '/v1/admin/moderation/operational-health/prepare',
        headers: adminHeaders,
        payload: { actor: admin, requestId: randomUUID() },
      });
      expect(health.statusCode).toBe(200);
      expect(authenticate.mock.calls).toHaveLength(callsBefore);
      expect((await post('enrollment', s.headers, opening)).statusCode).toBe(401);
      expect(
        (
          await post('sessions', adminHeaders, {
            actor: s.actor,
            requestId: randomUUID(),
            code: confirmation.code,
          })
        ).statusCode,
      ).toBe(401);
      const stored = JSON.stringify({
        sessions: (
          await sql`SELECT * FROM administration.admin_sessions WHERE admin_user_id=${s.adminId}::uuid`.execute(
            database,
          )
        ).rows,
        audits: await database
          .selectFrom('platform.audit_logs')
          .selectAll()
          .where('actor_user_id', '=', s.actor.userId)
          .execute(),
      });
      for (const secret of [
        uri,
        bearer,
        s.invitationToken,
        new URL(uri).searchParams.get('secret')!,
      ])
        expect(stored).not.toContain(secret);
      expect(
        (await post('sessions/logout', adminHeaders, { actor: admin, requestId: randomUUID() }))
          .statusCode,
      ).toBe(200);
      expect(
        await composition.sessions.authenticate({ bearerToken: bearer, audience: 'admin' }),
      ).toBeUndefined();
      expect(
        (
          await app!.inject({
            method: 'POST',
            url: '/v1/admin/moderation/operational-health/prepare',
            headers: adminHeaders,
            payload: { actor: admin, requestId: randomUUID() },
          })
        ).statusCode,
      ).toBe(401);
      expect((await post('recovery', s.headers, { actor: s.actor })).statusCode).toBe(404);
    });
    it('rejects borrowed invitations and identity authority, and invalidates the HTTP session after operator recovery', async () => {
      const s = await staff(),
        other = await staff();
      const opening = {
        actor: s.actor,
        invitationToken: s.invitationToken,
        requestId: randomUUID(),
      };
      expect(
        (await post('enrollment', other.headers, { ...opening, actor: other.actor })).statusCode,
      ).toBe(401);
      expect((await post('enrollment', other.headers, opening)).statusCode).toBe(401);
      const opened = await post('enrollment', s.headers, opening),
        uri = opened.json<{ enrollmentUri: string }>().enrollmentUri,
        time = await at();
      await sql`CREATE FUNCTION platform.reject_http_totp_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.event_type='administration.totp-activated.v1' THEN
          RAISE EXCEPTION 'private-http-totp-provider-error'; END IF; RETURN NEW; END $$`.execute(
        database,
      );
      await sql`CREATE TRIGGER http_totp_audit BEFORE INSERT ON platform.audit_logs
        FOR EACH ROW EXECUTE FUNCTION platform.reject_http_totp_audit()`.execute(database);
      try {
        const failed = await post('enrollment/confirm', s.headers, {
          ...opening,
          requestId: randomUUID(),
          code: code(uri, time),
        });
        expect(failed.statusCode).toBe(500);
        expect(failed.headers['cache-control']).toBe('no-store');
        expect(failed.body).not.toContain('private-http-totp-provider-error');
        expect(JSON.stringify(error.mock.calls)).not.toContain('private-http-totp-provider-error');
        expect(
          (
            await sql`SELECT id FROM administration.admin_totp_credentials WHERE admin_user_id=${s.adminId}::uuid`.execute(
              database,
            )
          ).rows,
        ).toEqual([]);
      } finally {
        await sql`DROP TRIGGER http_totp_audit ON platform.audit_logs`.execute(database);
        await sql`DROP FUNCTION platform.reject_http_totp_audit()`.execute(database);
      }
      expect(
        (
          await post('enrollment/confirm', s.headers, {
            ...opening,
            requestId: randomUUID(),
            code: code(uri, time),
          })
        ).statusCode,
      ).toBe(200);
      const proof = code(uri, new Date((adminTotpStep(time) + 1) * 30000));
      expect(
        (
          await post('sessions', s.headers, {
            actor: s.actor,
            requestId: randomUUID(),
            code: proof,
            telegramUserId: '12345',
          })
        ).statusCode,
      ).toBe(400);
      const signed = await post('sessions', s.headers, {
        actor: s.actor,
        requestId: randomUUID(),
        code: proof,
      });
      expect(signed.statusCode).toBe(200);
      const bearer = signed.json<{ adminSessionToken: string }>().adminSessionToken;
      const credential = (
        await sql<{
          id: string;
        }>`SELECT id FROM administration.admin_totp_credentials WHERE admin_user_id=${s.adminId}::uuid AND revoked_at IS NULL`.execute(
          database,
        )
      ).rows[0]!;
      await operator.revokeCredential({
        actorUserId: s.actor.userId,
        credentialId: credential.id,
        requestId: randomUUID(),
        reasonCode: 'recovery',
      });
      expect(
        await composition.sessions.authenticate({ bearerToken: bearer, audience: 'admin' }),
      ).toBeUndefined();
      expect(
        (
          await post('sessions', s.headers, {
            actor: s.actor,
            requestId: randomUUID(),
            code: proof,
          })
        ).statusCode,
      ).toBe(401);
      expect(JSON.stringify(error.mock.calls)).not.toContain(uri);
      expect(JSON.stringify(error.mock.calls)).not.toContain(bearer);
    });
  },
);
