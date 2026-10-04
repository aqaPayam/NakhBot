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
  PostgresConfirmedSupportCommands,
  PostgresRecordAdminIngressRejectionHandler,
  PostgresSupportStore,
  PostgresGetSafetyQueueActionsHandler,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { OpenSupportThreadHandler, SupportOpaqueReferences } from '@nakh/application';
import type {
  AdminCommandReceipt,
  PreparedAdminConfirmation,
  SafetyQueueActions,
} from '@nakh/contracts';
import {
  createReportUser,
  createReportFixtureAdmin,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { M7AdminModerationApiModule } from './m7-admin-moderation-api.js';
import { ApiExceptionFilter } from './app.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('confirmed support admin HTTP to PostgreSQL', () => {
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
  it('replies and closes once under retries, requires current permission, and never publishes restricted reply text', async () => {
    const userId = await createReportUser(database),
      adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'support',
        assigned_by_admin_id: adminId,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    const fixture = await confirmationFixture(database, adminId);
    const thread = await new OpenSupportThreadHandler(
      new PostgresSupportStore(database),
      new SupportOpaqueReferences(fixture.tokens, fixture.key),
      { uuid: randomUUID },
    ).execute({
      actor: { kind: 'user', userId },
      commandType: 'support.open-thread',
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { text: 'Private user support text' },
    });
    const error = vi.fn();
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminModerationApiModule.register({
        authenticator: { authenticate: () => Promise.resolve(fixture.actor) },
        journal: new PostgresRecordAdminIngressRejectionHandler(database),
        safetyQueueActions: new PostgresGetSafetyQueueActionsHandler(
          database,
          fixture.tokens,
          fixture.key,
        ),
        supportCommands: new PostgresConfirmedSupportCommands(
          database,
          fixture.tokens,
          fixture.key,
        ),
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer support-admin-credential' },
      privateReply = 'Private admin HTTP response';
    let version = 1;
    const queueQuery = { actor: fixture.actor, requestId: randomUUID(), queue: 'support' };
    const queueResponse = await app.inject({
      method: 'POST',
      url: '/v1/admin/safety/queue/actions',
      headers,
      payload: queueQuery,
    });
    expect(queueResponse.statusCode).toBe(200);
    expect(queueResponse.headers['cache-control']).toBe('no-store');
    expect(queueResponse.json<SafetyQueueActions>().adminActionToken).toMatch(/^v1\.ad\./u);
    expect(queueResponse.body).not.toContain(adminId);
    expect(queueResponse.body).not.toContain(fixture.actor.userId);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/safety/queue/actions',
          headers,
          payload: { ...queueQuery, queue: 'appeals' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/safety/queue/actions',
          headers,
          payload: { ...queueQuery, targetId: adminId },
        })
      ).statusCode,
    ).toBe(400);
    for (const action of ['reply', 'close'] as const) {
      const commandType = action === 'reply' ? 'support.reply-thread' : 'support.close-thread';
      const adminActionToken = await fixture.issue({
        commandCode: commandType,
        requiredPermission: 'review_support',
        targetType: 'support_thread',
        targetId: thread.supportThreadId,
        expectedTargetVersion: version,
      });
      const draft = {
        actor: fixture.actor,
        commandType,
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          adminActionToken,
          expectedTargetVersion: version,
          reason: 'Support handling',
          ...(action === 'reply' ? { text: privateReply } : {}),
        },
      };
      const prepared = await app.inject({
        method: 'POST',
        url: `/v1/admin/support/${action}/prepare`,
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
          app.inject({ method: 'POST', url: `/v1/admin/support/${action}`, headers, payload }),
        ),
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      const receipts = responses.map((response) => response.json<AdminCommandReceipt>());
      expect(receipts.every((receipt) => receipt.result === 'succeeded')).toBe(true);
      expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
      expect(new Set(receipts.map((receipt) => receipt.auditId)).size).toBe(1);
      for (const response of responses) expect(response.body).not.toContain(privateReply);
      version++;
      const row = await database
        .selectFrom('support.support_threads')
        .selectAll()
        .where('id', '=', thread.supportThreadId)
        .executeTakeFirstOrThrow();
      expect(row.version).toBe(version);
      expect(row.status).toBe(action === 'reply' ? 'open' : 'closed');
      const logs = await database
        .selectFrom('administration.admin_action_logs')
        .selectAll()
        .where('command_id', '=', draft.commandId)
        .execute();
      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain(privateReply);
    }
    const messages = await database
      .selectFrom('support.support_messages')
      .selectAll()
      .where('support_thread_id', '=', thread.supportThreadId)
      .execute();
    expect(messages.filter((message) => message.sender_type === 'admin')).toHaveLength(1);
    const token = await fixture.issue({
      commandCode: 'support.reply-thread',
      requiredPermission: 'review_support',
      targetType: 'support_thread',
      targetId: thread.supportThreadId,
      expectedTargetVersion: version,
    });
    const revokedDraft = {
      actor: fixture.actor,
      commandType: 'support.reply-thread',
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: token,
        expectedTargetVersion: version,
        reason: 'Support follow-up',
        text: privateReply,
      },
    };
    const confirmation = await app.inject({
      method: 'POST',
      url: '/v1/admin/support/reply/prepare',
      headers,
      payload: revokedDraft,
    });
    expect(confirmation.statusCode).toBe(200);
    await database
      .updateTable('administration.admin_user_roles')
      .set({ revoked_at: new Date(), revoked_by_admin_id: adminId })
      .where('admin_user_id', '=', adminId)
      .execute();
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/admin/support/reply',
      headers,
      payload: {
        ...revokedDraft,
        data: {
          ...revokedDraft.data,
          confirmationToken: confirmation.json<PreparedAdminConfirmation>().confirmationToken,
        },
      },
    });
    expect(denied.json()).toMatchObject({ result: 'rejected', safeCode: 'forbidden' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/safety/queue/actions',
          headers,
          payload: queueQuery,
        })
      ).statusCode,
    ).toBe(403);
    expect(denied.body).not.toContain(privateReply);
    expect(JSON.stringify(error.mock.calls)).not.toContain(privateReply);
  });
});
