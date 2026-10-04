import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  runMigrations,
  PostgresConfirmedAppealCommands,
  PostgresRecordAdminIngressRejectionHandler,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import type {
  AdminCommandReceipt,
  PreparedAdminConfirmation,
  PrepareAppealReviewCommand,
} from '@nakh/contracts';
import { createReportFixtureAdmin } from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { createCurrentBanAppeal } from '../../../packages/persistence-postgres/src/testing/appeal-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { M7AdminModerationApiModule } from './m7-admin-moderation-api.js';
import { ApiExceptionFilter } from './app.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('confirmed appeal review HTTP to PostgreSQL', () => {
  let database: NakhDatabase, app: NestFastifyApplication;
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
    await app?.close();
    await database?.destroy();
  });
  it('reviews each appeal once under races, keeps acceptance separate from unban, and audits revoked permission', async () => {
    const adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'moderator',
        assigned_by_admin_id: adminId,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    const fixture = await confirmationFixture(database, adminId),
      error = vi.fn();
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminModerationApiModule.register({
        authenticator: { authenticate: () => Promise.resolve(fixture.actor) },
        journal: new PostgresRecordAdminIngressRejectionHandler(database),
        appealReviews: new PostgresConfirmedAppealCommands(database, fixture.tokens, fixture.key),
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer appeal-admin-credential' },
      note = 'Private HTTP appeal review note';
    for (const decision of ['accepted', 'rejected'] as const) {
      const appeal = await createCurrentBanAppeal(database);
      const token = await fixture.issue({
        commandCode: 'moderation.review-appeal',
        requiredPermission: 'review_appeals',
        targetType: 'user_appeal',
        targetId: appeal.appealId,
        expectedTargetVersion: 1,
      });
      const draft: PrepareAppealReviewCommand = {
        actor: fixture.actor,
        commandType: 'moderation.review-appeal',
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          adminActionToken: token,
          expectedTargetVersion: 1,
          reason: 'Review current ban',
          decision,
          note,
        },
      };
      const prepared = await app.inject({
        method: 'POST',
        url: `/v1/admin/appeals/review/${decision}/prepare`,
        headers,
        payload: draft,
      });
      expect(prepared.statusCode).toBe(200);
      const payload = {
        ...draft,
        data: {
          ...draft.data,
          confirmationToken: prepared.json<PreparedAdminConfirmation>().confirmationToken,
        },
      };
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          app.inject({
            method: 'POST',
            url: `/v1/admin/appeals/review/${decision}`,
            headers,
            payload,
          }),
        ),
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      const results = responses.map((response) => response.json<AdminCommandReceipt>());
      expect(results.every((result) => result.result === 'succeeded')).toBe(true);
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(new Set(results.map((result) => result.auditId)).size).toBe(1);
      const row = await database
        .selectFrom('moderation.user_appeals')
        .selectAll()
        .where('id', '=', appeal.appealId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe(decision);
      expect(row.version).toBe(2);
      const account = await database
        .selectFrom('identity.accounts')
        .selectAll()
        .where('user_id', '=', appeal.userId)
        .executeTakeFirstOrThrow();
      expect(account.state).toBe('banned');
      expect(account.version).toBe(2);
      const logs = await database
        .selectFrom('administration.admin_action_logs')
        .selectAll()
        .where('command_id', '=', draft.commandId)
        .execute();
      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain(note);
      for (const response of responses) {
        expect(response.body).not.toContain(note);
        expect(response.body).not.toContain(appeal.userId);
      }
    }
    const appeal = await createCurrentBanAppeal(database);
    const token = await fixture.issue({
      commandCode: 'moderation.review-appeal',
      requiredPermission: 'review_appeals',
      targetType: 'user_appeal',
      targetId: appeal.appealId,
      expectedTargetVersion: 1,
    });
    const draft: PrepareAppealReviewCommand = {
      actor: fixture.actor,
      commandType: 'moderation.review-appeal',
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: token,
        expectedTargetVersion: 1,
        reason: 'Review current ban',
        decision: 'accepted',
      },
    };
    const prepared = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/review/accepted/prepare',
      headers,
      payload: draft,
    });
    expect(prepared.statusCode).toBe(200);
    await database
      .updateTable('administration.admin_user_roles')
      .set({ revoked_at: new Date(), revoked_by_admin_id: adminId })
      .where('admin_user_id', '=', adminId)
      .execute();
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/review/accepted',
      headers,
      payload: {
        ...draft,
        data: {
          ...draft.data,
          confirmationToken: prepared.json<PreparedAdminConfirmation>().confirmationToken,
        },
      },
    });
    expect(denied.json()).toMatchObject({ result: 'rejected', safeCode: 'forbidden' });
    const unchanged = await database
      .selectFrom('moderation.user_appeals')
      .select('status')
      .where('id', '=', appeal.appealId)
      .executeTakeFirstOrThrow();
    expect(unchanged.status).toBe('submitted');
    expect(JSON.stringify(error.mock.calls)).not.toContain(note);
  });
});
