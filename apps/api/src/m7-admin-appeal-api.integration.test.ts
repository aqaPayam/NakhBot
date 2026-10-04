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
  PostgresConfirmedAppealReveals,
  PostgresRecordAdminIngressRejectionHandler,
  PostgresGetAppealMetadataHandler,
  PostgresGetSafetyQueueActionsHandler,
  PostgresPrepareAppealReviewAccessHandler,
  PostgresPrepareAppealUnbanAccessHandler,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import type {
  AdminCommandReceipt,
  PreparedAdminConfirmation,
  PrepareAppealReviewCommand,
  PrepareAppealUnbanCommand,
  SafetyQueueActions,
  AppealMetadataPage,
  PreparedAppealReviewAccess,
  PreparedAppealUnbanAccess,
  PrepareAppealRevealCommand,
  AdminAppealRevealResult,
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
  it('audits retained appeal reads after separate unban, releases content once, and denies stale or revoked attempts', async () => {
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
      appeal = await createCurrentBanAppeal(database);
    const commands = new PostgresConfirmedAppealCommands(database, fixture.tokens, fixture.key);
    const review: PrepareAppealReviewCommand = {
      actor: fixture.actor,
      commandType: 'moderation.review-appeal',
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: await fixture.issue({
          commandCode: 'moderation.review-appeal',
          requiredPermission: 'review_appeals',
          targetType: 'user_appeal',
          targetId: appeal.appealId,
          expectedTargetVersion: 1,
        }),
        expectedTargetVersion: 1,
        decision: 'accepted',
        reason: 'Review exact ban',
        note: 'Private retained decision note',
      },
    };
    const reviewed = await commands.execute(
      {
        ...review,
        data: { ...review.data, confirmationToken: await commands.prepare(review, fixture.actor) },
      },
      fixture.actor,
    );
    expect(reviewed.result).toBe('succeeded');
    const unban: PrepareAppealUnbanCommand = {
      ...review,
      commandId: randomUUID(),
      commandType: 'moderation.unban-appeal',
      data: {
        adminActionToken: await fixture.issue({
          commandCode: 'moderation.unban-appeal',
          requiredPermission: 'unban_user',
          targetType: 'user_appeal',
          targetId: appeal.appealId,
          expectedTargetVersion: 2,
        }),
        expectedTargetVersion: 2,
        expectedAccountVersion: 2,
        reason: 'Separately unban accepted appeal',
      },
    };
    expect(
      (
        await commands.execute(
          {
            ...unban,
            data: {
              ...unban.data,
              confirmationToken: await commands.prepare(unban, fixture.actor),
            },
          },
          fixture.actor,
        )
      ).result,
    ).toBe('succeeded');
    await app?.close();
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminModerationApiModule.register({
        authenticator: { authenticate: () => Promise.resolve(fixture.actor) },
        journal: new PostgresRecordAdminIngressRejectionHandler(database),
        appealActions: new PostgresPrepareAppealReviewAccessHandler(
          database,
          fixture.tokens,
          fixture.key,
        ),
        appealReveals: new PostgresConfirmedAppealReveals(database, fixture.tokens, fixture.key),
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error: vi.fn() } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer appeal-admin-credential' };
    const actionQuery = {
      actor: fixture.actor,
      requestId: randomUUID(),
      adminActionToken: await fixture.issue({
        commandCode: 'moderation.appeal-metadata',
        requiredPermission: 'review_appeals',
        targetType: 'appeal_queue',
        targetId: null,
        expectedTargetVersion: null,
      }),
      appealId: appeal.appealId,
      expectedAppealVersion: 2,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/appeals/actions',
          headers,
          payload: actionQuery,
        })
      ).statusCode,
    ).toBe(409);
    const access = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/actions',
      headers,
      payload: { ...actionQuery, action: 'reveal' },
    });
    expect(access.statusCode).toBe(200);
    const draft: PrepareAppealRevealCommand = {
      ...review,
      commandType: 'moderation.reveal-appeal',
      commandId: randomUUID(),
      data: {
        adminActionToken: access.json<PreparedAppealReviewAccess>().adminActionToken,
        expectedTargetVersion: 2,
        reason: 'Inspect retained appeal decision',
      },
    };
    const confirmation = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/reveal/prepare',
      headers,
      payload: draft,
    });
    expect(confirmation.statusCode).toBe(200);
    const payload = {
      ...draft,
      data: {
        ...draft.data,
        confirmationToken: confirmation.json<PreparedAdminConfirmation>().confirmationToken,
      },
    };
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({ method: 'POST', url: '/v1/admin/appeals/reveal', headers, payload }),
      ),
    );
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const receipts = responses.map((response) => response.json<AdminAppealRevealResult>());
    expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
    expect(receipts.find((receipt) => !receipt.replayed)).toMatchObject({
      result: 'succeeded',
      appeal: {
        appealVersion: 2,
        status: 'accepted',
        text: 'Private fixture appeal',
        note: review.data.note,
      },
    });
    for (const response of responses) {
      expect(response.headers['cache-control']).toBe('no-store');
      for (const identity of [appeal.userId, appeal.banId, adminId])
        expect(response.body).not.toContain(identity);
      if (response.json<AdminAppealRevealResult>().replayed)
        expect(response.body).not.toContain('Private');
    }
    const audit = await database
      .selectFrom('administration.safety_access_audits')
      .selectAll()
      .where('command_id', '=', draft.commandId)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      outcome: 'revealed',
      item_count: 1,
      admin_action_log_id: receipts[0]!.auditId,
    });
    expect(JSON.stringify(audit)).not.toContain('Private');
    await expect(
      database
        .insertInto('administration.safety_access_audits')
        .values({ ...audit[0]!, id: randomUUID(), admin_action_log_id: reviewed.logId })
        .execute(),
    ).rejects.toThrow(/must match its recorded attempt/u);
    const stale = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/reveal',
      headers,
      payload: {
        ...payload,
        commandId: randomUUID(),
        data: { ...payload.data, expectedTargetVersion: 1 },
      },
    });
    expect(stale.json<AdminAppealRevealResult>()).toMatchObject({
      result: 'rejected',
      safeCode: 'version_conflict',
    });
    expect(stale.body).not.toContain('Private');
    const revokedDraft = { ...draft, commandId: randomUUID() };
    const revokedConfirmation = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/reveal/prepare',
      headers,
      payload: revokedDraft,
    });
    expect(revokedConfirmation.statusCode).toBe(200);
    await database
      .updateTable('administration.admin_user_roles')
      .set({ revoked_at: new Date(), revoked_by_admin_id: adminId })
      .where('admin_user_id', '=', adminId)
      .execute();
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/reveal',
      headers,
      payload: {
        ...revokedDraft,
        data: {
          ...revokedDraft.data,
          confirmationToken:
            revokedConfirmation.json<PreparedAdminConfirmation>().confirmationToken,
        },
      },
    });
    expect(denied.json<AdminAppealRevealResult>()).toMatchObject({
      result: 'rejected',
      safeCode: 'forbidden',
    });
    expect(denied.body).not.toContain('Private');
    expect(
      await database
        .selectFrom('administration.safety_access_audits')
        .select(['outcome', 'item_count'])
        .where('command_id', '=', revokedDraft.commandId)
        .execute(),
    ).toEqual([{ outcome: 'rejected', item_count: 0 }]);
  });
  it('unbans only an accepted current ban, rejects stale account versions, and records one effect under retry races', async () => {
    await app?.close();
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
      appeal = await createCurrentBanAppeal(database);
    const commands = new PostgresConfirmedAppealCommands(database, fixture.tokens, fixture.key);
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminModerationApiModule.register({
        authenticator: { authenticate: () => Promise.resolve(fixture.actor) },
        journal: new PostgresRecordAdminIngressRejectionHandler(database),
        appealReviews: commands,
        appealUnbans: commands,
        safetyQueueActions: new PostgresGetSafetyQueueActionsHandler(
          database,
          fixture.tokens,
          fixture.key,
        ),
        appealUnbanActions: new PostgresPrepareAppealUnbanAccessHandler(
          database,
          fixture.tokens,
          fixture.key,
        ),
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error: vi.fn() } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer appeal-admin-credential' };
    const queueResponse = await app.inject({
      method: 'POST',
      url: '/v1/admin/safety/queue/actions',
      headers,
      payload: { actor: fixture.actor, requestId: randomUUID(), queue: 'appeals' },
    });
    expect(queueResponse.statusCode).toBe(200);
    const unbanQuery = {
      actor: fixture.actor,
      requestId: randomUUID(),
      adminActionToken: queueResponse.json<SafetyQueueActions>().adminActionToken,
      appealId: appeal.appealId,
      expectedAppealVersion: 1,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/appeals/unban/actions',
          headers,
          payload: unbanQuery,
        })
      ).statusCode,
    ).toBe(409);
    async function unbanDraft(
      expectedAppealVersion: number,
      expectedAccountVersion: number,
      actionToken?: string,
    ): Promise<PrepareAppealUnbanCommand> {
      return {
        actor: fixture.actor,
        commandType: 'moderation.unban-appeal',
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          adminActionToken:
            actionToken ??
            (await fixture.issue({
              commandCode: 'moderation.unban-appeal',
              requiredPermission: 'unban_user',
              targetType: 'user_appeal',
              targetId: appeal.appealId,
              expectedTargetVersion: expectedAppealVersion,
            })),
          expectedTargetVersion: expectedAppealVersion,
          expectedAccountVersion,
          reason: 'Accepted current appeal',
        },
      };
    }
    async function confirm(path: string, draft: unknown): Promise<string> {
      const response = await app.inject({
        method: 'POST',
        url: `${path}/prepare`,
        payload: JSON.stringify(draft),
        headers: { ...headers, 'content-type': 'application/json' },
      });
      expect(response.statusCode).toBe(200);
      return response.json<PreparedAdminConfirmation>().confirmationToken;
    }
    const pending = await unbanDraft(1, 2);
    const pendingResult = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/unban',
      headers,
      payload: {
        ...pending,
        data: {
          ...pending.data,
          confirmationToken: await confirm('/v1/admin/appeals/unban', pending),
        },
      },
    });
    expect(pendingResult.json()).toMatchObject({ result: 'rejected', safeCode: 'unavailable' });
    const review: PrepareAppealReviewCommand = {
      actor: fixture.actor,
      commandType: 'moderation.review-appeal',
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: await fixture.issue({
          commandCode: 'moderation.review-appeal',
          requiredPermission: 'review_appeals',
          targetType: 'user_appeal',
          targetId: appeal.appealId,
          expectedTargetVersion: 1,
        }),
        expectedTargetVersion: 1,
        reason: 'Review current ban',
        decision: 'accepted',
      },
    };
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/review/accepted',
      headers,
      payload: {
        ...review,
        data: {
          ...review.data,
          confirmationToken: await confirm('/v1/admin/appeals/review/accepted', review),
        },
      },
    });
    expect(accepted.json()).toMatchObject({ result: 'succeeded' });
    expect(
      await database
        .selectFrom('identity.accounts')
        .select(['state', 'version'])
        .where('user_id', '=', appeal.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'banned', version: 2 });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/appeals/unban/actions',
          headers,
          payload: unbanQuery,
        })
      ).statusCode,
    ).toBe(409);
    const access = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/unban/actions',
      headers,
      payload: { ...unbanQuery, expectedAppealVersion: 2 },
    });
    expect(access.statusCode).toBe(200);
    expect(access.headers['cache-control']).toBe('no-store');
    expect(access.json<PreparedAppealUnbanAccess>()).toMatchObject({
      appealVersion: 2,
      accountVersion: 2,
    });
    expect(access.body).not.toContain(appeal.userId);
    expect(access.body).not.toContain(appeal.banId);
    const preparedUnbanToken = access.json<PreparedAppealUnbanAccess>().adminActionToken;
    const stale = await unbanDraft(2, 1, preparedUnbanToken);
    const staleResult = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/unban',
      headers,
      payload: {
        ...stale,
        data: { ...stale.data, confirmationToken: await confirm('/v1/admin/appeals/unban', stale) },
      },
    });
    expect(staleResult.json()).toMatchObject({ result: 'rejected', safeCode: 'version_conflict' });
    const draft = await unbanDraft(2, 2, preparedUnbanToken);
    const payload = {
      ...draft,
      data: { ...draft.data, confirmationToken: await confirm('/v1/admin/appeals/unban', draft) },
    };
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({ method: 'POST', url: '/v1/admin/appeals/unban', headers, payload }),
      ),
    );
    const results = responses.map((response) => response.json<AdminCommandReceipt>());
    expect(results.every((result) => result.result === 'succeeded')).toBe(true);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/appeals/unban/actions',
          headers,
          payload: { ...unbanQuery, expectedAppealVersion: 2 },
        })
      ).statusCode,
    ).toBe(409);
    expect(new Set(results.map((result) => result.auditId)).size).toBe(1);
    const account = await database
      .selectFrom('identity.accounts')
      .selectAll()
      .where('user_id', '=', appeal.userId)
      .executeTakeFirstOrThrow();
    expect(account.state).toBe('active');
    expect(account.version).toBe(3);
    const bindings = await database
      .selectFrom('moderation.appeal_unbans')
      .selectAll()
      .where('appeal_id', '=', appeal.appealId)
      .execute();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.admin_action_log_id).toBe(results[0]!.auditId);
    const revoked = await unbanDraft(2, 3, preparedUnbanToken),
      confirmationToken = await confirm('/v1/admin/appeals/unban', revoked);
    await database
      .updateTable('administration.admin_user_roles')
      .set({ revoked_at: new Date(), revoked_by_admin_id: adminId })
      .where('admin_user_id', '=', adminId)
      .execute();
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/unban',
      headers,
      payload: { ...revoked, data: { ...revoked.data, confirmationToken } },
    });
    expect(denied.json()).toMatchObject({ result: 'rejected', safeCode: 'forbidden' });
    for (const response of responses) expect(response.body).not.toContain(appeal.userId);
  });
  it('reviews each appeal once under races, keeps acceptance separate from unban, and audits revoked permission', async () => {
    await app?.close();
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
        appealActions: new PostgresPrepareAppealReviewAccessHandler(
          database,
          fixture.tokens,
          fixture.key,
        ),
        safetyQueueActions: new PostgresGetSafetyQueueActionsHandler(
          database,
          fixture.tokens,
          fixture.key,
        ),
        appealMetadata: new PostgresGetAppealMetadataHandler(database, fixture.tokens, fixture.key),
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer appeal-admin-credential' },
      note = 'Private HTTP appeal review note';
    const pending = [
      await createCurrentBanAppeal(database),
      await createCurrentBanAppeal(database),
    ];
    const queueResponse = await app.inject({
      method: 'POST',
      url: '/v1/admin/safety/queue/actions',
      headers,
      payload: { actor: fixture.actor, requestId: randomUUID(), queue: 'appeals' },
    });
    expect(queueResponse.statusCode).toBe(200);
    const metadataQuery = {
      actor: fixture.actor,
      requestId: randomUUID(),
      adminActionToken: queueResponse.json<SafetyQueueActions>().adminActionToken,
      limit: 1,
    };
    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/metadata',
      headers,
      payload: metadataQuery,
    });
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.headers['cache-control']).toBe('no-store');
    const first = firstResponse.json<AppealMetadataPage>();
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const nextResponse = await app.inject({
      method: 'POST',
      url: '/v1/admin/appeals/metadata',
      headers,
      payload: { ...metadataQuery, cursor: first.nextCursor },
    });
    expect(nextResponse.statusCode).toBe(200);
    expect(nextResponse.json<AppealMetadataPage>().items[0]!.appealId).not.toBe(
      first.items[0]!.appealId,
    );
    for (const response of [firstResponse, nextResponse]) {
      expect(response.body).not.toContain('Private fixture appeal');
      for (const appeal of pending) {
        expect(response.body).not.toContain(appeal.userId);
        expect(response.body).not.toContain(appeal.banId);
      }
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/appeals/metadata',
          headers,
          payload: { ...metadataQuery, cursor: first.nextCursor, status: 'accepted' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/appeals/metadata',
          headers,
          payload: { ...metadataQuery, limit: 51 },
        })
      ).statusCode,
    ).toBe(400);
    for (const decision of ['accepted', 'rejected'] as const) {
      const appeal = pending[decision === 'accepted' ? 0 : 1]!;
      const accessQuery = {
        actor: fixture.actor,
        requestId: randomUUID(),
        adminActionToken: metadataQuery.adminActionToken,
        appealId: appeal.appealId,
        expectedAppealVersion: 1,
      };
      const access = await app.inject({
        method: 'POST',
        url: '/v1/admin/appeals/actions',
        headers,
        payload: accessQuery,
      });
      expect(access.statusCode).toBe(200);
      expect(access.headers['cache-control']).toBe('no-store');
      expect(access.json<PreparedAppealReviewAccess>().appealVersion).toBe(1);
      expect(access.body).not.toContain(appeal.appealId);
      expect(access.body).not.toContain(appeal.banId);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/admin/appeals/actions',
            headers,
            payload: { ...accessQuery, expectedAppealVersion: 2 },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/admin/appeals/actions',
            headers,
            payload: { ...accessQuery, userId: appeal.userId },
          })
        ).statusCode,
      ).toBe(400);
      const token = access.json<PreparedAppealReviewAccess>().adminActionToken;
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
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/admin/appeals/actions',
            headers,
            payload: { ...accessQuery, expectedAppealVersion: 2 },
          })
        ).statusCode,
      ).toBe(409);
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
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/appeals/metadata',
          headers,
          payload: metadataQuery,
        })
      ).statusCode,
    ).toBe(403);
    expect(JSON.stringify(error.mock.calls)).not.toContain(note);
  });
});
