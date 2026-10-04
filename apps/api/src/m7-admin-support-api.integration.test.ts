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
  PostgresConfirmedSupportReveals,
  PostgresRecordAdminIngressRejectionHandler,
  PostgresSupportStore,
  PostgresGetSafetyQueueActionsHandler,
  PostgresGetSupportMetadataHandler,
  PostgresPrepareSupportActionHandler,
  PostgresGetOwnAdminCommandReceiptHandler,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { OpenSupportThreadHandler, SupportOpaqueReferences } from '@nakh/application';
import type {
  AdminCommandReceipt,
  PreparedAdminConfirmation,
  SafetyQueueActions,
  SupportMetadataPage,
  PreparedSupportAction,
  AdminSupportRevealResult,
  RevealSupportThreadCommand,
  PrepareSupportRevealCommand,
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
    const opener = new OpenSupportThreadHandler(
      new PostgresSupportStore(database),
      new SupportOpaqueReferences(fixture.tokens, fixture.key),
      { uuid: randomUUID },
    );
    const opening = {
      actor: { kind: 'user' as const, userId },
      commandType: 'support.open-thread' as const,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      schemaVersion: 1 as const,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { text: 'Private user support text' },
    };
    const thread = await opener.execute(opening);
    await opener.execute({ ...opening, commandId: randomUUID(), idempotencyKey: randomUUID() });
    const error = vi.fn();
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminModerationApiModule.register({
        authenticator: { authenticate: () => Promise.resolve(fixture.actor) },
        journal: new PostgresRecordAdminIngressRejectionHandler(database),
        ownCommandReceipts: new PostgresGetOwnAdminCommandReceiptHandler(database),
        supportReveals: new PostgresConfirmedSupportReveals(database, fixture.tokens, fixture.key),
        supportActions: new PostgresPrepareSupportActionHandler(
          database,
          fixture.tokens,
          fixture.key,
        ),
        supportMetadata: new PostgresGetSupportMetadataHandler(
          database,
          fixture.tokens,
          fixture.key,
        ),
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
    const metadataQuery = {
      actor: fixture.actor,
      requestId: randomUUID(),
      adminActionToken: queueResponse.json<SafetyQueueActions>().adminActionToken,
      limit: 1,
    };
    const firstPageResponse = await app.inject({
      method: 'POST',
      url: '/v1/admin/support/metadata',
      headers,
      payload: metadataQuery,
    });
    expect(firstPageResponse.statusCode).toBe(200);
    expect(firstPageResponse.headers['cache-control']).toBe('no-store');
    const firstPage = firstPageResponse.json<SupportMetadataPage>();
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeDefined();
    const secondPageResponse = await app.inject({
      method: 'POST',
      url: '/v1/admin/support/metadata',
      headers,
      payload: { ...metadataQuery, cursor: firstPage.nextCursor },
    });
    expect(secondPageResponse.statusCode).toBe(200);
    expect(secondPageResponse.json<SupportMetadataPage>().items[0]!.threadId).not.toBe(
      firstPage.items[0]!.threadId,
    );
    for (const response of [firstPageResponse, secondPageResponse]) {
      expect(response.body).not.toContain('Private user support text');
      expect(response.body).not.toContain(userId);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/support/metadata',
          headers,
          payload: { ...metadataQuery, cursor: firstPage.nextCursor, status: 'closed' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/support/metadata',
          headers,
          payload: { ...metadataQuery, limit: 51 },
        })
      ).statusCode,
    ).toBe(400);
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
      const actionQuery = {
        actor: fixture.actor,
        requestId: randomUUID(),
        adminActionToken: queueResponse.json<SafetyQueueActions>().adminActionToken,
        threadId: thread.supportThreadId,
        expectedThreadVersion: version,
        action,
      };
      const access = await app.inject({
        method: 'POST',
        url: '/v1/admin/support/actions',
        headers,
        payload: actionQuery,
      });
      expect(access.statusCode).toBe(200);
      expect(access.headers['cache-control']).toBe('no-store');
      expect(access.json<PreparedSupportAction>().threadVersion).toBe(version);
      expect(access.body).not.toContain(thread.supportThreadId);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/admin/support/actions',
            headers,
            payload: { ...actionQuery, expectedThreadVersion: version + 1 },
          })
        ).statusCode,
      ).toBe(409);
      const adminActionToken = access.json<PreparedSupportAction>().adminActionToken;
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
    const revealAccess = await app.inject({
      method: 'POST',
      url: '/v1/admin/support/actions',
      headers,
      payload: {
        actor: fixture.actor,
        requestId: randomUUID(),
        adminActionToken: queueResponse.json<SafetyQueueActions>().adminActionToken,
        threadId: thread.supportThreadId,
        expectedThreadVersion: version,
        action: 'reveal',
      },
    });
    expect(revealAccess.statusCode).toBe(200);
    const revealDraft: PrepareSupportRevealCommand = {
      actor: fixture.actor,
      commandType: 'support.reveal-thread',
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: revealAccess.json<PreparedSupportAction>().adminActionToken,
        expectedTargetVersion: version,
        reason: 'Review retained support conversation',
      },
    };
    const prepareReveal = async (
      draft: typeof revealDraft,
    ): Promise<RevealSupportThreadCommand> => {
      const confirmation = await app.inject({
        method: 'POST',
        url: '/v1/admin/support/reveal/prepare',
        headers,
        payload: draft,
      });
      expect(confirmation.statusCode).toBe(200);
      return {
        ...draft,
        data: {
          ...draft.data,
          confirmationToken: confirmation.json<PreparedAdminConfirmation>().confirmationToken,
        },
      };
    };
    const revealPayload = await prepareReveal(revealDraft);
    const reveals = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({
          method: 'POST',
          url: '/v1/admin/support/reveal',
          headers,
          payload: revealPayload,
        }),
      ),
    );
    expect(reveals.every((response) => response.statusCode === 200)).toBe(true);
    const revealed = reveals.map((response) => response.json<AdminSupportRevealResult>());
    const fresh = revealed.filter((receipt) => receipt.result === 'succeeded' && !receipt.replayed);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({
      thread: {
        status: 'closed',
        threadVersion: version,
        hasEarlierMessages: false,
        messages: [
          { senderType: 'user', text: opening.data.text },
          { senderType: 'admin', text: privateReply },
        ],
      },
    });
    for (const response of reveals) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(userId);
      expect(response.body).not.toContain(adminId);
      if (response.json<AdminSupportRevealResult>().replayed)
        expect(response.body).not.toContain(privateReply);
    }
    const accessAudits = await database
      .selectFrom('administration.safety_access_audits')
      .selectAll()
      .where('command_id', '=', revealDraft.commandId)
      .execute();
    expect(accessAudits).toHaveLength(1);
    expect(accessAudits[0]).toMatchObject({
      outcome: 'revealed',
      item_count: 2,
      admin_action_log_id: fresh[0]!.auditId,
    });
    expect(JSON.stringify(accessAudits)).not.toContain(privateReply);
    await expect(
      database
        .updateTable('administration.safety_access_audits')
        .set({ item_count: 0 })
        .where('id', '=', accessAudits[0]!.id)
        .execute(),
    ).rejects.toThrow();
    const revokedReveal = await prepareReveal({ ...revealDraft, commandId: randomUUID() });
    const token = await fixture.issue({
      commandCode: 'support.reply-thread',
      requiredPermission: 'review_support',
      targetType: 'support_thread',
      targetId: thread.supportThreadId,
      expectedTargetVersion: version,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/support/actions',
          headers,
          payload: {
            actor: fixture.actor,
            requestId: randomUUID(),
            adminActionToken: queueResponse.json<SafetyQueueActions>().adminActionToken,
            threadId: thread.supportThreadId,
            expectedThreadVersion: version,
            action: 'reply',
          },
        })
      ).statusCode,
    ).toBe(409);
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
    const deniedReveal = await app.inject({
      method: 'POST',
      url: '/v1/admin/support/reveal',
      headers,
      payload: revokedReveal,
    });
    expect(deniedReveal.statusCode).toBe(200);
    expect(deniedReveal.json<AdminSupportRevealResult>()).toMatchObject({
      result: 'rejected',
      safeCode: 'forbidden',
    });
    expect(deniedReveal.body).not.toContain(privateReply);
    expect(
      await database
        .selectFrom('administration.safety_access_audits')
        .select(['outcome', 'item_count'])
        .where('command_id', '=', revokedReveal.commandId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ outcome: 'rejected', item_count: 0 });
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
          url: '/v1/admin/support/metadata',
          headers,
          payload: metadataQuery,
        })
      ).statusCode,
    ).toBe(403);
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
    const closed = await database
      .selectFrom('administration.admin_action_logs')
      .select(['id', 'command_id'])
      .where('admin_user_id', '=', adminId)
      .where('command_code', '=', 'support.close-thread')
      .where('result', '=', 'succeeded')
      .executeTakeFirstOrThrow();
    // Simulate lost token storage: receipt recovery must not consult it or reload private content.
    fixture.tokens.get = () => Promise.resolve(undefined);
    const receiptQuery = {
      actor: fixture.actor,
      requestId: randomUUID(),
      commandId: closed.command_id,
    };
    const recovered = await app.inject({
      method: 'POST',
      url: '/v1/admin/commands/receipt',
      headers,
      payload: receiptQuery,
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.headers['cache-control']).toBe('no-store');
    expect(recovered.json<AdminCommandReceipt>()).toMatchObject({
      auditId: closed.id,
      result: 'succeeded',
      safeCode: 'completed',
      replayed: true,
    });
    for (const privateValue of [privateReply, thread.supportThreadId, userId])
      expect(recovered.body).not.toContain(privateValue);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/commands/receipt',
          headers,
          payload: { ...receiptQuery, commandId: randomUUID() },
        })
      ).statusCode,
    ).toBe(404);
    const otherId = await createReportFixtureAdmin(database),
      other = await confirmationFixture(database, otherId);
    await expect(
      new PostgresGetOwnAdminCommandReceiptHandler(database).execute(
        { ...receiptQuery, actor: other.actor },
        other.actor,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('admin_user_id', '=', adminId)
        .where('command_id', '=', closed.command_id)
        .execute(),
    ).toHaveLength(1);
    await database
      .updateTable('administration.admin_users')
      .set({ is_active: false, disabled_at: new Date(), updated_at: new Date(), version: 2 })
      .where('id', '=', adminId)
      .execute();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/commands/receipt',
          headers,
          payload: receiptQuery,
        })
      ).statusCode,
    ).toBe(403);
  });
});
