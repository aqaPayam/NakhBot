import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminIngressRejection } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresRecordAdminIngressRejectionHandler } from './admin-ingress-rejection-store.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
import { createReportFixtureAdmin } from './testing/report-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
describe.skipIf(url === undefined)(
  'immutable rejection-only authenticated admin ingress audit',
  () => {
    let database: NakhDatabase;
    beforeAll(async () => {
      await runMigrations(url!, resolve(process.cwd(), 'migrations'));
      database = createDatabase({
        url: url!,
        poolMax: 10,
        statementTimeoutMs: 15000,
        lockTimeoutMs: 10000,
      });
    });
    afterAll(async () => {
      await database?.destroy();
    });
    async function input(): Promise<{ admin: string; rejection: AdminIngressRejection }> {
      const admin = await createReportFixtureAdmin(database);
      await database
        .insertInto('administration.admin_user_roles')
        .values({
          admin_user_id: admin,
          role_code: 'super_admin',
          assigned_by_admin_id: admin,
          revoked_by_admin_id: null,
          revoked_at: null,
        })
        .execute();
      const row = await database
        .selectFrom('administration.admin_users')
        .select('user_id')
        .where('id', '=', admin)
        .executeTakeFirstOrThrow();
      return {
        admin,
        rejection: {
          actor: { kind: 'admin', userId: row.user_id },
          commandId: randomUUID(),
          requestId: randomUUID(),
          requestDigest: digest('PRIVATE MALFORMED REQUEST'),
          commandCode: 'moderation.reveal-evidence',
          requiredPermission: 'view_reports',
        },
      };
    }
    it('records once across concurrent retries, targets only the authenticated request context and rejects changed replay', async () => {
      const fixture = await input(),
        handler = new PostgresRecordAdminIngressRejectionHandler(database);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => handler.record(fixture.rejection)),
      );
      expect(
        results.every(
          (result) =>
            result.result === 'rejected' &&
            result.safeCode === 'invalid_request' &&
            result.value === undefined,
        ),
      ).toBe(true);
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      const rows = await database
        .selectFrom('administration.admin_action_logs')
        .selectAll()
        .where('admin_user_id', '=', fixture.admin)
        .where('command_id', '=', fixture.rejection.commandId)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        target_type: 'admin_request',
        target_id: fixture.admin,
        result: 'rejected',
        safe_code: 'invalid_request',
        expected_target_version: null,
        metadata: {},
      });
      expect(JSON.stringify(rows)).not.toContain('PRIVATE MALFORMED REQUEST');
      await expect(
        handler.record({ ...fixture.rejection, requestDigest: digest('changed request') }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      await expect(
        database
          .updateTable('administration.admin_action_logs')
          .set({ safe_code: 'changed' })
          .where('id', '=', rows[0]!.id)
          .execute(),
      ).rejects.toThrow();
    });
    it('records missing permission and disabled-admin attempts without any effect capability', async () => {
      const fixture = await input(),
        handler = new PostgresRecordAdminIngressRejectionHandler(database);
      await database
        .updateTable('administration.admin_user_roles')
        .set({ revoked_at: new Date(), revoked_by_admin_id: fixture.admin })
        .where('admin_user_id', '=', fixture.admin)
        .where('revoked_at', 'is', null)
        .execute();
      expect(await handler.record(fixture.rejection)).toMatchObject({
        result: 'rejected',
        safeCode: 'forbidden',
        value: undefined,
      });
      await database
        .updateTable('administration.admin_users')
        .set({ is_active: false, disabled_at: new Date(), updated_at: new Date(), version: 2 })
        .where('id', '=', fixture.admin)
        .execute();
      expect(await handler.record({ ...fixture.rejection, commandId: randomUUID() })).toMatchObject(
        { result: 'rejected', safeCode: 'forbidden', value: undefined },
      );
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('admin_user_id', '=', fixture.admin)
          .execute(),
      ).toHaveLength(2);
    });
    it('never replaces an existing terminal business attempt or treats malformed replay as fresh authorization', async () => {
      const fixture = await input();
      await new PostgresAdminCommandStore(database).execute(
        {
          logId: randomUUID(),
          adminUserId: fixture.admin,
          commandId: fixture.rejection.commandId,
          requestId: fixture.rejection.requestId,
          requestDigest: digest('original business request'),
          commandCode: 'moderation.reveal-evidence',
          requiredPermission: 'view_reports',
          targetType: 'report_evidence',
          targetId: randomUUID(),
          expectedTargetVersion: 1,
          reasonDigest: digest('fixture reason'),
          metadata: {},
          correlationId: fixture.rejection.requestId,
        },
        () => Promise.resolve({ safeCode: 'fixture_success', value: undefined }),
      );
      await expect(
        new PostgresRecordAdminIngressRejectionHandler(database).record(fixture.rejection),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select(['result', 'safe_code'])
          .where('admin_user_id', '=', fixture.admin)
          .where('command_id', '=', fixture.rejection.commandId)
          .execute(),
      ).toEqual([{ result: 'succeeded', safe_code: 'fixture_success' }]);
    });
    it('fails atomically when the required audit cannot be inserted', async () => {
      const fixture = await input(),
        logId = randomUUID();
      const handler = new PostgresRecordAdminIngressRejectionHandler(database, {
        uuid: () => logId,
      });
      await handler.record(fixture.rejection);
      const changed = { ...fixture.rejection, commandId: randomUUID() };
      await expect(handler.record(changed)).rejects.toThrow();
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('command_id', '=', changed.commandId)
          .execute(),
      ).toHaveLength(0);
    });
    it('recovers failed ingress attempts without effects even after permission removal', async () => {
      const fixture = await input();
      const handler = new PostgresRecordAdminIngressRejectionHandler(database);
      expect(await handler.recover(fixture.rejection)).toBeUndefined();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          handler.record({ ...fixture.rejection, outcome: 'failed' }),
        ),
      );
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(
        results.every(
          (result) => result.result === 'failed' && result.safeCode === 'internal_error',
        ),
      ).toBe(true);
      await database
        .updateTable('administration.admin_user_roles')
        .set({ revoked_at: new Date(), revoked_by_admin_id: fixture.admin })
        .where('admin_user_id', '=', fixture.admin)
        .where('revoked_at', 'is', null)
        .execute();
      expect(
        await handler.recover({ ...fixture.rejection, requestId: randomUUID() }),
      ).toMatchObject({
        logId: results[0]!.logId,
        result: 'failed',
        replayed: true,
        value: undefined,
      });
      await expect(
        handler.recover({ ...fixture.rejection, requestDigest: digest('changed') }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      const other = await input();
      expect(
        await handler.recover({ ...fixture.rejection, actor: other.rejection.actor }),
      ).toBeUndefined();
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('admin_user_id', '=', fixture.admin)
          .execute(),
      ).toHaveLength(1);
    });
  },
);
