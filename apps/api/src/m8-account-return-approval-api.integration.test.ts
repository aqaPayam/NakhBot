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
  ReportTokenFactory,
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
import { PostgresAccountReturnStore } from '@nakh/persistence-postgres';
import { createAccountReturnFixture } from '../../../packages/persistence-postgres/src/testing/account-return-fixture.js';
import { createDeletionFixture } from '../../../packages/persistence-postgres/src/testing/deletion-fixture.js';
import type { ApproveAccountReturnCommand, SelectedAccountReturnApproval } from '@nakh/contracts';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)(
  'native confirmed Return approval in the authenticator-protected host',
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
    const error = vi.fn();
    let composition: ReturnType<typeof createM7TotpSessionHostOptions>;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'nakh_return_approval_http');
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
        totpKeys: keys,
        accountReturnApprovalEnabled: true,
        reportTokens: new ReportTokenFactory({ forLife: () => tokens }, randomBytes(32)),
        adminTokens: tokens,
        adminKey: randomBytes(32),
        safetyTokens: { forLife: () => tokens },
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
      const actor = { kind: 'user' as const, userId: admin.user_id };
      const { userSessionToken: token } = await composition.userSessions.issue(
        { userId: actor.userId, productEpoch: 0 },
        randomUUID(),
      );
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
    async function login(): Promise<{
      actor: { kind: 'admin'; userId: string };
      headers: { authorization: string };
      firstHeaders: { authorization: string };
      adminId: string;
    }> {
      const s = await staff(),
        opening = { actor: s.actor, invitationToken: s.invitationToken, requestId: randomUUID() };
      const enrolled = await post('enrollment', s.headers, opening);
      expect(enrolled.statusCode).toBe(200);
      const uri = enrolled.json<{ enrollmentUri: string }>().enrollmentUri,
        time = await at();
      expect(
        (
          await post('enrollment/confirm', s.headers, {
            ...opening,
            requestId: randomUUID(),
            code: code(uri, time),
          })
        ).statusCode,
      ).toBe(200);
      const session = await post('sessions', s.headers, {
        actor: s.actor,
        requestId: randomUUID(),
        code: code(uri, new Date((adminTotpStep(time) + 1) * 30000)),
      });
      expect(session.statusCode).toBe(200);
      return {
        actor: { kind: 'admin', userId: s.actor.userId },
        headers: {
          authorization: `Bearer ${session.json<{ adminSessionToken: string }>().adminSessionToken}`,
        },
        firstHeaders: s.headers,
        adminId: s.adminId,
      };
    }
    type Staff = Awaited<ReturnType<typeof login>>;
    type Root = Awaited<ReturnType<typeof createAccountReturnFixture>>;
    async function select(
      s: Staff,
      root: { recordId: string; version: number },
    ): ReturnType<NestFastifyApplication['inject']> {
      return app!.inject({
        method: 'POST',
        url: '/v1/admin/account-returns/actions',
        headers: s.headers,
        payload: {
          actor: s.actor,
          requestId: randomUUID(),
          deletionRecordId: root.recordId,
          expectedTargetVersion: root.version,
        },
      });
    }
    async function prepare(s: Staff, root: Root): Promise<ApproveAccountReturnCommand> {
      const selected = await select(s, root);
      expect(selected.statusCode).toBe(200);
      expect(Object.keys(selected.json()).sort()).toEqual([
        'adminActionToken',
        'expectedTargetVersion',
      ]);
      const command = {
        actor: s.actor,
        commandType: 'account.approve-return' as const,
        schemaVersion: 1 as const,
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          ...selected.json<SelectedAccountReturnApproval>(),
          reason: 'synthetic-private-return-review',
        },
      };
      const result = await app!.inject({
        method: 'POST',
        url: '/v1/admin/account-returns/approve/prepare',
        headers: s.headers,
        payload: command,
      });
      expect(result.statusCode).toBe(200);
      return {
        ...command,
        data: {
          ...command.data,
          confirmationToken: result.json<{ confirmationToken: string }>().confirmationToken,
        },
      };
    }
    async function approve(
      s: Staff,
      command: object,
    ): ReturnType<NestFastifyApplication['inject']> {
      return app!.inject({
        method: 'POST',
        url: '/v1/admin/account-returns/approve',
        headers: s.headers,
        payload: command,
      });
    }
    it('uses real TOTP and twenty confirmed HTTP retries for one immutable approval, then requires a separate owner Return', async () => {
      const root = await createAccountReturnFixture(database, { approve: false }),
        s = await login();
      const snapshot = async (): Promise<unknown> =>
        (
          await sql`SELECT to_jsonb(root) AS root,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM identity.data_retention_records r WHERE deletion_record_id=root.id) AS manifests,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY from_checkpoint_version) FROM identity.account_deletion_phase_receipts r WHERE deletion_record_id=root.id) AS phases,
        (SELECT jsonb_agg(to_jsonb(r)) FROM billing.credit_epoch_closures r WHERE deletion_record_id=root.id) AS financial
        FROM identity.account_deletion_records root WHERE id=${root.recordId}::uuid`.execute(
            database,
          )
        ).rows;
      const before = await snapshot(),
        command = await prepare(s, root);
      expect(
        (
          await app!.inject({
            method: 'POST',
            url: '/v1/admin/account-returns/approve',
            headers: s.firstHeaders,
            payload: command,
          })
        ).statusCode,
      ).toBe(401);
      const outcomes = await Promise.all(Array.from({ length: 20 }, () => approve(s, command)));
      expect(
        outcomes.every(
          (r) => r.statusCode === 200 && r.json<{ result: string }>().result === 'succeeded',
        ),
      ).toBe(true);
      expect(outcomes.filter((r) => !r.json<{ replayed: boolean }>().replayed)).toHaveLength(1);
      expect(outcomes[0]!.headers['cache-control']).toBe('no-store');
      for (const r of outcomes)
        for (const privateValue of [
          root.recordId,
          root.userId,
          command.data.reason,
          command.data.adminActionToken,
          command.data.confirmationToken,
        ])
          expect(r.body).not.toContain(privateValue);
      expect(
        (
          await sql`SELECT identity.account_return_approval_valid(a,false) AS valid FROM platform.audit_logs a WHERE subject_id=${root.recordId}::uuid AND event_type='account.return-approved.v1'`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ valid: true }]);
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await sql`SELECT state,product_epoch FROM identity.accounts WHERE user_id=${root.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ state: 'deleted', product_epoch: 0 }]);
      const id = randomUUID();
      expect(
        (
          await new PostgresAccountReturnStore(database, root.control).return({
            commandId: id,
            commandType: 'account.return',
            schemaVersion: 1,
            actor: { kind: 'user', userId: root.userId },
            requestId: randomUUID(),
            idempotencyKey: `return:${id}`,
            occurredAt: new Date().toISOString(),
            locale: 'en',
            data: { expectedAccountVersion: root.version },
          })
        ).returned,
      ).toBe(true);
      expect(
        (
          await sql`SELECT state,product_epoch FROM identity.accounts WHERE user_id=${root.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ state: 'guest', product_epoch: 1 }]);
      expect((await select(s, root)).statusCode).toBe(409);
      expect(error).not.toHaveBeenCalled();
    });
    it('rejects borrowed capabilities and direct target injection, journals malformed execution, and denies revoked MFA', async () => {
      const root = await createAccountReturnFixture(database, { approve: false }),
        s = await login(),
        foreign = await login(),
        command = await prepare(s, root);
      expect(
        (
          await app!.inject({
            method: 'POST',
            url: '/v1/admin/account-returns/approve/prepare',
            headers: foreign.headers,
            payload: {
              ...command,
              actor: foreign.actor,
              data: {
                adminActionToken: command.data.adminActionToken,
                expectedTargetVersion: root.version,
                reason: command.data.reason,
              },
            },
          })
        ).statusCode,
      ).toBe(403);
      const bad = {
        ...command,
        commandId: randomUUID(),
        requestId: randomUUID(),
        data: { ...command.data, deletionRecordId: root.recordId },
      };
      const rejected = await approve(s, bad);
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json()).toMatchObject({ result: 'rejected', safeCode: 'invalid_request' });
      expect(
        (
          await sql`SELECT count(*)::integer AS count FROM administration.admin_action_logs WHERE command_id=${bad.commandId}::uuid AND result='rejected'`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      await sql`UPDATE administration.admin_sessions SET revoked_at=clock_timestamp() WHERE admin_user_id=${s.adminId}::uuid`.execute(
        database,
      );
      expect((await approve(s, command)).statusCode).toBe(401);
      expect(
        (
          await sql`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE subject_id=${root.recordId}::uuid AND event_type='account.return-approved.v1'`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    });
    it('requires exact Root version, completed verified deletion, no safety bar and current approval permission', async () => {
      const s = await login(),
        pending = await createDeletionFixture(database);
      expect((await select(s, { ...pending, version: 2 })).statusCode).toBe(409);
      await sql`UPDATE identity.account_deletion_work SET available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(
        database,
      );
      const banned = await createAccountReturnFixture(database, { approve: false, banned: true });
      expect((await select(s, banned)).statusCode).toBe(409);
      const root = await createAccountReturnFixture(database, { approve: false });
      expect((await select(s, { ...root, version: root.version + 1 })).statusCode).toBe(409);
      await sql`UPDATE administration.admin_user_roles SET revoked_at=clock_timestamp(),revoked_by_admin_id=${s.adminId}::uuid WHERE admin_user_id=${s.adminId}::uuid AND revoked_at IS NULL`.execute(
        database,
      );
      expect([401, 403]).toContain((await select(s, root)).statusCode);
      expect(
        (
          await sql`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE subject_id=${root.recordId}::uuid AND event_type='account.return-approved.v1'`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    });
  },
);
