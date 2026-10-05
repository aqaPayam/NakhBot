import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AesGcmChatReportSnapshotProtector,
  AesGcmChatReportSnapshotReader,
  ReportTokens,
  canonicalAdminPairTargetId,
  type InternalBlockDraft,
} from '@nakh/application';
import { normalizeUserPair } from '@nakh/domain';
import type {
  PreparedReportInternalBlock,
  PreparedAdminConfirmation,
  AdminCommandReceipt,
} from '@nakh/contracts';
import {
  createDatabase,
  runMigrations,
  createPostgresReportServices,
  PostgresGetAdminReportQueueActionsHandler,
  PostgresPrepareSelectedReportInternalBlockHandler,
  PostgresConfirmedInternalBlocks,
  PostgresRecordAdminIngressRejectionHandler,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  createReportUser,
  createReportChat,
  createReportFixtureAdmin,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { M7AdminModerationApiModule } from './m7-admin-moderation-api.js';
import { ApiExceptionFilter } from './app.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
const route = '/v1/admin/moderation/reports/internal-block-selection';
const headers = { authorization: 'Bearer report-block-admin' };
describe.skipIf(url === undefined)('exact Report pair internal block HTTP and native audit', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  const apps: NestFastifyApplication[] = [];
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_report_block');
    await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 20,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });
  afterAll(async () => {
    try {
      await database?.destroy();
    } finally {
      await isolated?.destroy();
    }
  });
  async function fixture(): Promise<{
    reporter: string;
    target: string;
    reportId: string;
    matchId: string;
    chatSessionId: string;
    adminId: string;
    f: Awaited<ReturnType<typeof confirmationFixture>>;
    query: Parameters<PostgresPrepareSelectedReportInternalBlockHandler['execute']>[0];
    native: PostgresConfirmedInternalBlocks;
    app: NestFastifyApplication;
  }> {
    const reporter = await createReportUser(database),
      target = await createReportUser(database);
    const chat = await createReportChat(database, reporter, target);
    const pair = normalizeUserPair(reporter, target);
    await database
      .insertInto('interaction.user_pair_states')
      .values({
        ...{ user_low_id: pair.userLowId, user_high_id: pair.userHighId },
        state: 'matched',
        reason_code: 'mutual_like_match',
        changed_at: new Date(),
      })
      .execute();
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
    const f = await confirmationFixture(database, adminId);
    const tokens = new ReportTokens(f.tokens, f.key),
      key = Buffer.alloc(32, 71);
    const services = createPostgresReportServices(database, tokens, f.tokens, f.key, {
      chat: {
        protector: new AesGcmChatReportSnapshotProtector('block-fixture', 1, key),
        reader: new AesGcmChatReportSnapshotReader({ resolve: () => key }),
      },
    });
    const actor = { kind: 'user' as const, userId: reporter };
    const prepared = await services.prepare.execute(
      {
        actor,
        requestId: randomUUID(),
        sourceActionToken: (
          await tokens.issueSource(reporter, { kind: 'match', referenceId: chat.matchId })
        ).token,
        requestedEvidenceTypes: ['chat'],
      },
      actor,
    );
    const report = await services.submit.execute(
      {
        actor,
        commandId: randomUUID(),
        commandType: 'moderation.submit-report',
        schemaVersion: 1,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { reasonCode: 'harassment', evidenceIntentToken: prepared.evidenceIntentToken },
      },
      actor,
    );
    const root = await new PostgresGetAdminReportQueueActionsHandler(
      database,
      f.tokens,
      f.key,
    ).execute({ actor: f.actor, requestId: randomUUID() }, f.actor);
    const query = {
      actor: f.actor,
      requestId: randomUUID(),
      adminActionToken: root.metadataActionToken,
      reportId: report.reportId,
      expectedReportVersion: 1,
      action: 'create' as const,
    };
    const native = new PostgresConfirmedInternalBlocks(database, f.tokens, f.key);
    const app = await NestFactory.create<NestFastifyApplication>(
      M7AdminModerationApiModule.register({
        authenticator: {
          authenticate: ({ bearerToken, audience }) =>
            Promise.resolve(
              bearerToken === 'report-block-admin' && audience === 'admin' ? f.actor : undefined,
            ),
        },
        journal: new PostgresRecordAdminIngressRejectionHandler(database),
        selectedReportInternalBlock: new PostgresPrepareSelectedReportInternalBlockHandler(
          database,
          f.tokens,
          f.key,
        ),
        internalBlocks: native,
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    apps.push(app);
    app.useGlobalFilters(new ApiExceptionFilter({ error: vi.fn() } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { reporter, target, reportId: report.reportId, ...chat, adminId, f, query, native, app };
  }
  async function draft(
    f: Awaited<ReturnType<typeof fixture>>,
    action: 'create' | 'remove',
    selected?: PreparedReportInternalBlock,
  ): Promise<InternalBlockDraft> {
    if (selected === undefined) {
      const response = await f.app.inject({
        method: 'POST',
        url: route,
        headers,
        payload: { ...f.query, action },
      });
      expect(response.statusCode).toBe(200);
      selected = response.json<PreparedReportInternalBlock>();
    }
    return {
      actor: f.f.actor,
      commandId: randomUUID(),
      commandType: 'moderation.change-internal-block',
      schemaVersion: 1,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: selected.adminActionToken,
        expectedTargetVersion: selected.pairVersion,
        reason: 'Separate users for safety',
        action,
      },
    };
  }
  async function confirm(
    f: Awaited<ReturnType<typeof fixture>>,
    value: InternalBlockDraft,
  ): Promise<
    InternalBlockDraft & { data: InternalBlockDraft['data'] & { confirmationToken: string } }
  > {
    const response = await f.app.inject({
      method: 'POST',
      url: `/v1/admin/moderation/internal-blocks/${value.data.action}/prepare`,
      headers,
      payload: value,
    });
    expect(response.statusCode).toBe(200);
    return {
      ...value,
      data: {
        ...value.data,
        confirmationToken: response.json<PreparedAdminConfirmation>().confirmationToken,
      },
    };
  }
  it('creates and removes only the selected pair with one immutable action/attempt under retries and no reopened state or identity disclosure', async () => {
    const f = await fixture();
    const notificationsBefore = await database
      .selectFrom('notification.notifications')
      .select('id')
      .where('user_id', 'in', [f.reporter, f.target])
      .execute();
    const selections = await Promise.all(
      Array.from({ length: 12 }, () =>
        f.app.inject({ method: 'POST', url: route, headers, payload: f.query }),
      ),
    );
    for (const response of selections) {
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.json())).toEqual(['adminActionToken', 'pairVersion']);
      for (const id of [f.reporter, f.target, f.reportId, f.matchId, f.chatSessionId, f.adminId])
        expect(response.body).not.toContain(id);
    }
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('admin_user_id', '=', f.adminId)
        .execute(),
    ).toHaveLength(0);
    const create = await confirm(
      f,
      await draft(f, 'create', selections[0]!.json<PreparedReportInternalBlock>()),
    );
    for (const action of ['create', 'remove'] as const) {
      const command = action === 'create' ? create : await confirm(f, await draft(f, 'remove'));
      const outcomes = await Promise.all(
        Array.from({ length: 12 }, () =>
          f.app.inject({
            method: 'POST',
            url: `/v1/admin/moderation/internal-blocks/${command.data.action}`,
            headers,
            payload: command,
          }),
        ),
      );
      expect(
        outcomes.every(
          (outcome) =>
            outcome.statusCode === 200 &&
            outcome.json<AdminCommandReceipt>().result === 'succeeded',
        ),
      ).toBe(true);
      for (const outcome of outcomes)
        for (const id of [f.reporter, f.target, f.reportId, f.matchId, f.chatSessionId])
          expect(outcome.body).not.toContain(id);
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('result')
          .where('command_id', '=', command.commandId)
          .execute(),
      ).toEqual([{ result: 'succeeded' }]);
      expect(
        await database
          .selectFrom('moderation.moderation_actions')
          .select('source_report_id')
          .where('command_id', '=', command.commandId)
          .execute(),
      ).toEqual([{ source_report_id: f.reportId }]);
    }
    await Promise.all(
      Array.from({ length: 12 }, () =>
        f.app.inject({
          method: 'POST',
          url: '/v1/admin/moderation/internal-blocks/create',
          headers,
          payload: create,
        }),
      ),
    );
    const pair = normalizeUserPair(f.reporter, f.target);
    expect(
      await database
        .selectFrom('interaction.user_pair_states')
        .select('state')
        .where('user_low_id', '=', pair.userLowId)
        .where('user_high_id', '=', pair.userHighId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await database
        .selectFrom('matching.matches')
        .select('status')
        .where('id', '=', f.matchId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'closed' });
    expect(
      await database
        .selectFrom('chat.chat_sessions')
        .select(['status', 'closed_reason'])
        .where('id', '=', f.chatSessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'closed', closed_reason: 'internal_block' });
    expect(
      await database
        .selectFrom('interaction.likes')
        .select('status')
        .where('sender_user_id', 'in', [f.reporter, f.target])
        .where('receiver_user_id', 'in', [f.reporter, f.target])
        .execute(),
    ).toEqual([{ status: 'cancelled_by_system' }, { status: 'cancelled_by_system' }]);
    expect(
      await database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', 'in', [f.reporter, f.target])
        .execute(),
    ).toEqual(notificationsBefore);
    expect(
      await database
        .selectFrom('identity.accounts')
        .select(['state', 'version'])
        .where('user_id', 'in', [f.reporter, f.target])
        .execute(),
    ).toEqual([
      { state: 'active', version: 1 },
      { state: 'active', version: 1 },
    ]);
    const fresh = await f.app.inject({ method: 'POST', url: route, headers, payload: f.query });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json<PreparedReportInternalBlock>().pairVersion).toBe(1);
    expect(
      await database
        .selectFrom('moderation.reports')
        .select(['status', 'version'])
        .where('id', '=', f.reportId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'pending_review', version: 1 });
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select(['status', 'assigned_admin_id'])
        .where('report_id', '=', f.reportId)
        .execute(),
    ).toEqual([{ status: 'pending', assigned_admin_id: null }]);
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('id')
        .where('report_id', '=', f.reportId)
        .execute(),
    ).toHaveLength(0);
  });
  it.each(['revoked', 'stale'] as const)(
    'records one rejected saved command after %s without an extra block effect',
    async (scenario) => {
      const f = await fixture(),
        command = await confirm(f, await draft(f, 'create'));
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: route,
            headers,
            payload: { ...f.query, expectedReportVersion: 999 },
          })
        ).statusCode,
      ).toBe(409);
      if (scenario === 'revoked')
        await database
          .updateTable('administration.admin_user_roles')
          .set({ revoked_at: new Date(), revoked_by_admin_id: f.adminId })
          .where('admin_user_id', '=', f.adminId)
          .execute();
      else {
        const winner = await confirm(f, await draft(f, 'create'));
        expect((await f.native.execute(winner, f.f.actor)).result).toBe('succeeded');
      }
      const results = await Promise.all(
        Array.from({ length: 12 }, () => f.native.execute(command, f.f.actor)),
      );
      expect(results.every((result) => result.result === 'rejected')).toBe(true);
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select(['result', 'safe_code'])
          .where('command_id', '=', command.commandId)
          .execute(),
      ).toEqual([
        {
          result: 'rejected',
          safe_code: scenario === 'revoked' ? 'forbidden' : 'version_conflict',
        },
      ]);
      expect(
        await database
          .selectFrom('moderation.moderation_actions')
          .select('id')
          .where('command_id', '=', command.commandId)
          .execute(),
      ).toHaveLength(0);
      if (scenario === 'revoked') {
        const role = `block_view_${f.adminId.replaceAll('-', '')}`;
        await database
          .insertInto('administration.admin_roles')
          .values({ code: role, description: 'Synthetic view-only role' })
          .execute();
        await database
          .insertInto('administration.admin_role_permissions')
          .values({ role_code: role, permission_code: 'view_reports' })
          .execute();
        await database
          .insertInto('administration.admin_user_roles')
          .values({
            admin_user_id: f.adminId,
            role_code: role,
            assigned_by_admin_id: f.adminId,
            revoked_at: null,
            revoked_by_admin_id: null,
          })
          .execute();
        expect(
          (await f.app.inject({ method: 'POST', url: route, headers, payload: f.query }))
            .statusCode,
        ).toBe(403);
        expect(
          (
            await f.app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: { ...f.query, action: 'remove' },
            })
          ).statusCode,
        ).toBe(403);
      }
    },
  );
  it('rejects a substituted Report pair and enforces exact SQL target and successful attempt guards', async () => {
    const f = await fixture();
    const other = await createReportUser(database),
      wrong = normalizeUserPair(f.reporter, other);
    const token = await f.f.issue({
      commandCode: 'moderation.change-internal-block',
      requiredPermission: 'manage_internal_blocks',
      targetType: 'user_pair',
      targetId: canonicalAdminPairTargetId(wrong),
      targetPair: wrong,
      expectedTargetVersion: 1,
      sourceReportId: f.reportId,
    });
    const value = await draft(f, 'create', { adminActionToken: token, pairVersion: 1 });
    const rejected = await f.native.execute(
      {
        ...value,
        data: { ...value.data, confirmationToken: await f.native.prepare(value, f.f.actor) },
      },
      f.f.actor,
    );
    expect(rejected.result).toBe('rejected');
    expect(
      await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('command_id', '=', value.commandId)
        .execute(),
    ).toHaveLength(0);
    const command = await confirm(f, await draft(f, 'create'));
    await f.native.execute(command, f.f.actor);
    const action = await database
      .selectFrom('moderation.moderation_actions')
      .selectAll()
      .where('command_id', '=', command.commandId)
      .executeTakeFirstOrThrow();
    await expect(
      database.transaction().execute((tx) =>
        tx
          .insertInto('moderation.moderation_actions')
          .values({
            ...action,
            id: randomUUID(),
            command_id: randomUUID(),
            target_pair_low_user_id: wrong.userLowId,
            target_pair_high_user_id: wrong.userHighId,
          })
          .execute(),
      ),
    ).rejects.toThrow('internal block does not match its report pair');
    const platformAudit = await database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('id', '=', action.audit_log_id)
      .executeTakeFirstOrThrow();
    const forgedAuditId = randomUUID(),
      forgedCommandId = randomUUID(),
      forgedRequestId = randomUUID();
    await expect(
      database.transaction().execute(async (tx) => {
        // Satisfy the independent platform-audit FK and uniqueness rules so the
        // deferred guard can reject the missing exact successful admin attempt.
        await tx
          .insertInto('platform.audit_logs')
          .values({
            ...platformAudit,
            id: forgedAuditId,
            command_id: forgedCommandId,
            request_id: forgedRequestId,
          })
          .execute();
        await tx
          .insertInto('moderation.moderation_actions')
          .values({
            ...action,
            id: randomUUID(),
            audit_log_id: forgedAuditId,
            command_id: forgedCommandId,
            request_id: forgedRequestId,
          })
          .execute();
      }),
    ).rejects.toThrow('report action lacks its successful admin attempt');
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('id', '=', forgedAuditId)
        .execute(),
    ).toHaveLength(0);
    for (let i = 0; i < 12; i++) {
      const pair = normalizeUserPair(randomUUID(), randomUUID());
      const row = await database
        .selectNoFrom((eb) =>
          eb
            .fn<string>('moderation.admin_pair_target_id', [
              eb.val(pair.userLowId),
              eb.val(pair.userHighId),
            ])
            .as('target'),
        )
        .executeTakeFirstOrThrow();
      expect(row.target).toBe(canonicalAdminPairTargetId(pair));
    }
  });
});
