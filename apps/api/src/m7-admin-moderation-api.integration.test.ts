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
  PostgresConfirmedAccountActions,
  PostgresConfirmedPhotoActions,
  PostgresConfirmedInternalBlocks,
  PostgresConfirmedReviewAssignments,
  PostgresConfirmedReviewDecisions,
  PostgresClaimModerationReviewsHandler,
  PostgresRecordAdminIngressRejectionHandler,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import type {
  PreparedAdminConfirmation,
  AdminCommandReceipt,
  PrepareAccountModerationActionCommand,
  PreparePhotoModerationActionCommand,
  PrepareInternalBlockCommand,
  PrepareReviewAssignmentCommand,
  PrepareReviewDecisionCommand,
  ClaimModerationReviewsCommand,
  AdminReviewClaimResult,
} from '@nakh/contracts';
import {
  createReportUser,
  createReportFixtureAdmin,
  createRetainedReportPhoto,
  createReportPhoto,
  createReportChat,
  createRetainedPhotoReview,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { canonicalAdminPairTargetId, AesGcmReviewNoteProtector } from '@nakh/application';
import { normalizeUserPair } from '@nakh/domain';
import { ApiExceptionFilter } from './app.js';
import { M7AdminModerationApiModule } from './m7-admin-moderation-api.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('confirmed account moderation HTTP to PostgreSQL', () => {
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
  it('claims a bounded queue once under concurrent retries and preserves ownership after a conflicting retry', async () => {
    const adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'super_admin',
        assigned_by_admin_id: adminId,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    const fixture = await confirmationFixture(database, adminId);
    const report = await createRetainedPhotoReview(database);
    const adminActionToken = await fixture.issue({
      commandCode: 'moderation.claim-reviews',
      requiredPermission: 'view_reports',
      targetType: 'admin_user',
      targetId: adminId,
      expectedTargetVersion: null,
    });
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminModerationApiModule.register({
        authenticator: { authenticate: () => Promise.resolve(fixture.actor) },
        journal: new PostgresRecordAdminIngressRejectionHandler(database),
        reviewClaims: new PostgresClaimModerationReviewsHandler(
          database,
          fixture.tokens,
          fixture.key,
        ),
      }),
      new FastifyAdapter({ trustProxy: false }),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error: vi.fn() } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const payload: ClaimModerationReviewsCommand = {
      actor: fixture.actor,
      commandType: 'moderation.claim-reviews',
      commandId: randomUUID(),
      requestId: randomUUID(),
      schemaVersion: 1,
      locale: 'en',
      occurredAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
      data: { adminActionToken, limit: 1 },
    };
    const headers = { authorization: 'Bearer queue-admin-credential' };
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({ method: 'POST', url: '/v1/admin/moderation/reviews/claim', headers, payload }),
      ),
    );
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const results = responses.map((response) => response.json<AdminReviewClaimResult>());
    expect(new Set(results.map((result) => result.auditId)).size).toBe(1);
    const fresh = results.find((result) => result.result === 'succeeded' && !result.replayed);
    if (fresh?.result !== 'succeeded' || fresh.replayed) throw new Error('Missing fresh claim');
    expect(fresh.claims).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(5);
    for (const result of results.filter((result) => result.replayed))
      expect(result).not.toHaveProperty('claims');
    const owned = await database
      .selectFrom('moderation.moderation_reviews')
      .selectAll()
      .where('id', '=', fresh.claims[0]!.reviewId)
      .executeTakeFirstOrThrow();
    expect(owned.assigned_admin_id).toBe(adminId);
    expect(owned.version).toBe(fresh.claims[0]!.reviewVersion);
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/admin/moderation/reviews/claim',
      headers,
      payload: { ...payload, data: { ...payload.data, limit: 2 } },
    });
    expect(conflict.statusCode).toBe(409);
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .select('id')
      .where('command_id', '=', payload.commandId)
      .execute();
    expect(logs).toHaveLength(1);
    await database
      .updateTable('moderation.moderation_reviews')
      .set({
        status: 'in_review',
        assigned_admin_id: adminId,
        assigned_at: new Date(),
        updated_at: new Date(),
        version: 2,
      })
      .where('id', '=', report.reviewId)
      .where('status', '=', 'pending')
      .execute();
  });
  it('binds each action and permission, commits one effect under retry races and audits revocation without leaking account identities', async () => {
    await app?.close();
    const targetId = await createReportUser(database, true),
      adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'super_admin',
        assigned_by_admin_id: adminId,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    const fixture = await confirmationFixture(database, adminId);
    const error = vi.fn();
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminModerationApiModule.register({
        authenticator: {
          authenticate: ({ audience, bearerToken }) =>
            Promise.resolve(
              audience === 'admin' && bearerToken === 'account-admin-credential'
                ? fixture.actor
                : undefined,
            ),
        },
        journal: new PostgresRecordAdminIngressRejectionHandler(database),
        accounts: new PostgresConfirmedAccountActions(database, fixture.tokens, fixture.key),
      }),
      new FastifyAdapter({ bodyLimit: 256 * 1024, trustProxy: false }),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer account-admin-credential' };
    let version = 1;
    for (const action of ['restrict_user', 'unrestrict_user', 'ban_user', 'unban_user'] as const) {
      const draft: PrepareAccountModerationActionCommand = {
        actor: fixture.actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        commandType: 'moderation.apply-account-action',
        schemaVersion: 1,
        idempotencyKey: randomUUID(),
        locale: 'en',
        occurredAt: new Date().toISOString(),
        data: {
          action,
          expectedTargetVersion: version,
          reason: 'Synthetic account review',
          adminActionToken: await fixture.issue({
            commandCode: 'moderation.apply-account-action',
            requiredPermission: action,
            targetType: 'user',
            targetId,
            expectedTargetVersion: version,
          }),
        },
      };
      const prepared = await app.inject({
        method: 'POST',
        url: `/v1/admin/moderation/accounts/${action}/prepare`,
        headers,
        payload: draft,
      });
      expect(prepared.statusCode).toBe(200);
      const command = {
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
            url: `/v1/admin/moderation/accounts/${action}`,
            headers,
            payload: command,
          }),
        ),
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      const receipts = responses.map((response) => response.json<AdminCommandReceipt>());
      expect(receipts.every((receipt) => receipt.result === 'succeeded')).toBe(true);
      expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
      expect(new Set(receipts.map((receipt) => receipt.auditId)).size).toBe(1);
      for (const response of responses)
        for (const privateValue of [
          targetId,
          fixture.actor.userId,
          draft.data.reason,
          draft.data.adminActionToken,
        ])
          expect(response.body).not.toContain(privateValue);
      version++;
      expect(
        await database
          .selectFrom('identity.accounts')
          .select('version')
          .where('user_id', '=', targetId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ version });
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('admin_user_id', '=', adminId)
          .where('command_id', '=', command.commandId)
          .execute(),
      ).toHaveLength(1);
    }
    const draft: PrepareAccountModerationActionCommand = {
      actor: fixture.actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'moderation.apply-account-action',
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      locale: 'en',
      occurredAt: new Date().toISOString(),
      data: {
        action: 'ban_user',
        expectedTargetVersion: version,
        reason: 'Synthetic revoked review',
        adminActionToken: await fixture.issue({
          commandCode: 'moderation.apply-account-action',
          requiredPermission: 'ban_user',
          targetType: 'user',
          targetId,
          expectedTargetVersion: version,
        }),
      },
    };
    const prepared = await app.inject({
      method: 'POST',
      url: '/v1/admin/moderation/accounts/ban_user/prepare',
      headers,
      payload: draft,
    });
    expect(prepared.statusCode).toBe(200);
    await database
      .updateTable('administration.admin_user_roles')
      .set({ revoked_at: new Date(), revoked_by_admin_id: adminId })
      .where('admin_user_id', '=', adminId)
      .where('revoked_at', 'is', null)
      .execute();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/moderation/accounts/ban_user',
      headers,
      payload: {
        ...draft,
        data: {
          ...draft.data,
          confirmationToken: prepared.json<PreparedAdminConfirmation>().confirmationToken,
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: 'rejected',
      safeCode: 'forbidden',
      replayed: false,
    });
    expect(
      await database
        .selectFrom('identity.accounts')
        .select('version')
        .where('user_id', '=', targetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ version });
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select(['result', 'safe_code'])
        .where('admin_user_id', '=', adminId)
        .where('command_id', '=', draft.commandId)
        .execute(),
    ).toEqual([{ result: 'rejected', safe_code: 'forbidden' }]);
    expect(JSON.stringify(error.mock.calls)).not.toContain(draft.data.reason);
  });
  it('confirms hide, restore and delete independently while retaining reported media and snapshots', async () => {
    await app.close();
    const retained = await createRetainedReportPhoto(database);
    await createReportPhoto(database, retained.target, false);
    const adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'super_admin',
        assigned_by_admin_id: adminId,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    const fixture = await confirmationFixture(database, adminId),
      revoked: string[] = [],
      error = vi.fn();
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminModerationApiModule.register({
        authenticator: { authenticate: () => Promise.resolve(fixture.actor) },
        journal: new PostgresRecordAdminIngressRejectionHandler(database),
        photos: new PostgresConfirmedPhotoActions(database, fixture.tokens, fixture.key, {
          execute: (photoId) => {
            revoked.push(photoId);
            return Promise.resolve();
          },
        }),
      }),
      new FastifyAdapter({ bodyLimit: 256 * 1024, trustProxy: false }),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer photo-admin-credential' };
    let version = 1;
    for (const action of ['hide_photo', 'restore_photo', 'delete_photo'] as const) {
      const draft: PreparePhotoModerationActionCommand = {
        actor: fixture.actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        commandType: 'moderation.apply-photo-action',
        schemaVersion: 1,
        idempotencyKey: randomUUID(),
        locale: 'en',
        occurredAt: new Date().toISOString(),
        data: {
          action,
          expectedTargetVersion: version,
          reason: 'Synthetic retained photo review',
          adminActionToken: await fixture.issue({
            commandCode: 'moderation.apply-photo-action',
            requiredPermission: action,
            targetType: 'photo',
            targetId: retained.photoId,
            expectedTargetVersion: version,
          }),
        },
      };
      const prepared = await app.inject({
        method: 'POST',
        url: `/v1/admin/moderation/photos/${action}/prepare`,
        headers,
        payload: draft,
      });
      expect(prepared.statusCode).toBe(200);
      const before = revoked.length;
      const command = {
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
            url: `/v1/admin/moderation/photos/${action}`,
            headers,
            payload: command,
          }),
        ),
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      const receipts = responses.map((response) => response.json<AdminCommandReceipt>());
      expect(receipts.every((receipt) => receipt.result === 'succeeded')).toBe(true);
      expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
      if (action === 'restore_photo') expect(revoked).toHaveLength(before);
      else expect(revoked.slice(before).every((id) => id === retained.photoId)).toBe(true);
      version++;
      expect(
        await database
          .selectFrom('media.profile_photos')
          .select('version')
          .where('id', '=', retained.photoId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ version });
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('admin_user_id', '=', adminId)
          .where('command_id', '=', command.commandId)
          .execute(),
      ).toHaveLength(1);
      for (const response of responses)
        for (const privateValue of [
          retained.target,
          retained.photoId,
          fixture.actor.userId,
          draft.data.reason,
        ])
          expect(response.body).not.toContain(privateValue);
    }
    expect(
      await database
        .selectFrom('media.profile_photos')
        .select('status')
        .where('id', '=', retained.photoId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'deleted' });
    expect(
      await database
        .selectFrom('media.report_photo_evidence_holds')
        .select('report_evidence_id')
        .where('report_evidence_id', '=', retained.evidenceId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('moderation.report_snapshots')
        .select('id')
        .where('report_evidence_id', '=', retained.evidenceId)
        .execute(),
    ).toHaveLength(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain('Synthetic retained photo review');
  });
  it('confirms opaque pair blocking and removal without disclosing the pair or reviving closed chats', async () => {
    await app.close();
    const first = await createReportUser(database),
      second = await createReportUser(database);
    const pair = normalizeUserPair(first, second),
      chat = await createReportChat(database, first, second);
    await database
      .insertInto('interaction.user_pair_states')
      .values({
        user_low_id: pair.userLowId,
        user_high_id: pair.userHighId,
        state: 'matched',
        reason_code: 'match',
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
        internalBlocks: new PostgresConfirmedInternalBlocks(database, fixture.tokens, fixture.key),
      }),
      new FastifyAdapter({ bodyLimit: 256 * 1024, trustProxy: false }),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer block-admin-credential' };
    let version = 1;
    for (const action of ['create', 'remove'] as const) {
      const draft: PrepareInternalBlockCommand = {
        actor: fixture.actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        commandType: 'moderation.change-internal-block',
        schemaVersion: 1,
        idempotencyKey: randomUUID(),
        locale: 'en',
        occurredAt: new Date().toISOString(),
        data: {
          action,
          expectedTargetVersion: version,
          reason: 'Synthetic pair review',
          adminActionToken: await fixture.issue({
            commandCode: 'moderation.change-internal-block',
            requiredPermission: 'manage_internal_blocks',
            targetType: 'user_pair',
            targetId: canonicalAdminPairTargetId(pair),
            targetPair: pair,
            expectedTargetVersion: version,
          }),
        },
      };
      const prepared = await app.inject({
        method: 'POST',
        url: `/v1/admin/moderation/internal-blocks/${action}/prepare`,
        headers,
        payload: draft,
      });
      expect(prepared.statusCode).toBe(200);
      const command = {
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
            url: `/v1/admin/moderation/internal-blocks/${action}`,
            headers,
            payload: command,
          }),
        ),
      );
      const receipts = responses.map((response) => response.json<AdminCommandReceipt>());
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(receipts.every((receipt) => receipt.result === 'succeeded')).toBe(true);
      expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
      for (const response of responses)
        for (const privateValue of [
          first,
          second,
          chat.matchId,
          chat.chatSessionId,
          draft.data.reason,
        ])
          expect(response.body).not.toContain(privateValue);
      if (action === 'create')
        expect(
          await database
            .selectFrom('interaction.user_pair_states')
            .select(['state', 'version'])
            .where('user_low_id', '=', pair.userLowId)
            .where('user_high_id', '=', pair.userHighId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ state: 'blocked', version: 2 });
      else
        expect(
          await database
            .selectFrom('interaction.user_pair_states')
            .select('state')
            .where('user_low_id', '=', pair.userLowId)
            .where('user_high_id', '=', pair.userHighId)
            .execute(),
        ).toHaveLength(0);
      expect(
        await database
          .selectFrom('matching.matches')
          .select('status')
          .where('id', '=', chat.matchId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'closed' });
      expect(
        await database
          .selectFrom('chat.chat_sessions')
          .select('status')
          .where('id', '=', chat.chatSessionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'closed' });
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('admin_user_id', '=', adminId)
          .where('command_id', '=', command.commandId)
          .execute(),
      ).toHaveLength(1);
      version++;
    }
    expect(JSON.stringify(error.mock.calls)).not.toContain('Synthetic pair review');
  });
  it('assigns a review once under retry races and rejects a prospective reviewer whose grant was revoked', async () => {
    await app.close();
    const report = await createRetainedPhotoReview(database),
      adminId = await createReportFixtureAdmin(database),
      assigneeId = await createReportFixtureAdmin(database);
    for (const id of [adminId, assigneeId])
      await database
        .insertInto('administration.admin_user_roles')
        .values({
          admin_user_id: id,
          role_code: 'super_admin',
          assigned_by_admin_id: id,
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
        reviewAssignments: new PostgresConfirmedReviewAssignments(
          database,
          fixture.tokens,
          fixture.key,
        ),
      }),
      new FastifyAdapter({ bodyLimit: 256 * 1024, trustProxy: false }),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer review-admin-credential' };
    const draft = async (
      version: number,
      assigneeAdminId: string,
    ): Promise<PrepareReviewAssignmentCommand> => ({
      actor: fixture.actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'moderation.assign-review',
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      locale: 'en',
      occurredAt: new Date().toISOString(),
      data: {
        expectedTargetVersion: version,
        assigneeAdminId,
        reason: 'Synthetic assignment review',
        adminActionToken: await fixture.issue({
          commandCode: 'moderation.assign-review',
          requiredPermission: 'view_reports',
          targetType: 'moderation_review',
          targetId: report.reviewId,
          expectedTargetVersion: version,
        }),
      },
    });
    const confirm = async (value: PrepareReviewAssignmentCommand): Promise<string> => {
      const prepared = await app.inject({
        method: 'POST',
        url: '/v1/admin/moderation/reviews/assignment/prepare',
        headers,
        payload: value,
      });
      expect(prepared.statusCode).toBe(200);
      return prepared.json<PreparedAdminConfirmation>().confirmationToken;
    };
    const first = await draft(1, adminId),
      command = { ...first, data: { ...first.data, confirmationToken: await confirm(first) } };
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({
          method: 'POST',
          url: '/v1/admin/moderation/reviews/assignment',
          headers,
          payload: command,
        }),
      ),
    );
    const receipts = responses.map((response) => response.json<AdminCommandReceipt>());
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(receipts.every((receipt) => receipt.result === 'succeeded')).toBe(true);
    expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select(['assigned_admin_id', 'version', 'status'])
        .where('id', '=', report.reviewId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ assigned_admin_id: adminId, version: 2, status: 'in_review' });
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('admin_user_id', '=', adminId)
        .where('command_id', '=', first.commandId)
        .execute(),
    ).toHaveLength(1);
    for (const response of responses)
      for (const privateValue of [
        adminId,
        assigneeId,
        report.reporter,
        report.target,
        report.reviewId,
      ])
        expect(response.body).not.toContain(privateValue);
    const next = await draft(2, assigneeId),
      confirmationToken = await confirm(next);
    await database
      .updateTable('administration.admin_user_roles')
      .set({ revoked_at: new Date(), revoked_by_admin_id: assigneeId })
      .where('admin_user_id', '=', assigneeId)
      .where('revoked_at', 'is', null)
      .execute();
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/admin/moderation/reviews/assignment',
      headers,
      payload: { ...next, data: { ...next.data, confirmationToken } },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ result: 'rejected', safeCode: 'unavailable' });
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select(['assigned_admin_id', 'version'])
        .where('id', '=', report.reviewId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ assigned_admin_id: adminId, version: 2 });
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select(['result', 'safe_code'])
        .where('admin_user_id', '=', adminId)
        .where('command_id', '=', next.commandId)
        .execute(),
    ).toEqual([{ result: 'rejected', safe_code: 'reviewer_unauthorized' }]);
    expect(JSON.stringify(error.mock.calls)).not.toContain('Synthetic assignment review');
  });
  it('confirms dismissal and evidence-backed action decisions, encrypts notes and commits once under retry races', async () => {
    await app.close();
    const adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'super_admin',
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
        reviewAssignments: new PostgresConfirmedReviewAssignments(
          database,
          fixture.tokens,
          fixture.key,
        ),
        reviewDecisions: new PostgresConfirmedReviewDecisions(
          database,
          fixture.tokens,
          fixture.key,
          new AesGcmReviewNoteProtector('http-review-notes', 1, Buffer.alloc(32, 71)),
        ),
        accounts: new PostgresConfirmedAccountActions(database, fixture.tokens, fixture.key),
      }),
      new FastifyAdapter({ bodyLimit: 256 * 1024, trustProxy: false }),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer review-admin-credential' },
      privateNote = 'PRIVATE ENCRYPTED REVIEW NOTE';
    const identity = (): Omit<PrepareReviewDecisionCommand, 'commandType' | 'data'> => ({
      actor: fixture.actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      schemaVersion: 1 as const,
      idempotencyKey: randomUUID(),
      locale: 'en',
      occurredAt: new Date().toISOString(),
    });
    const confirm = async (path: string, draft: unknown): Promise<string> => {
      const prepared = await app.inject({
        method: 'POST',
        url: `${path}/prepare`,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: JSON.stringify(draft),
      });
      expect(prepared.statusCode).toBe(200);
      return prepared.json<PreparedAdminConfirmation>().confirmationToken;
    };
    for (const decision of ['dismissed', 'actioned'] as const) {
      const report = await createRetainedPhotoReview(database);
      const assignment: PrepareReviewAssignmentCommand = {
        ...identity(),
        commandType: 'moderation.assign-review',
        data: {
          expectedTargetVersion: 1,
          reason: 'Synthetic review owner',
          assigneeAdminId: adminId,
          adminActionToken: await fixture.issue({
            commandCode: 'moderation.assign-review',
            requiredPermission: 'view_reports',
            targetType: 'moderation_review',
            targetId: report.reviewId,
            expectedTargetVersion: 1,
          }),
        },
      };
      const assigned = await app.inject({
        method: 'POST',
        url: '/v1/admin/moderation/reviews/assignment',
        headers,
        payload: {
          ...assignment,
          data: {
            ...assignment.data,
            confirmationToken: await confirm('/v1/admin/moderation/reviews/assignment', assignment),
          },
        },
      });
      expect(assigned.json()).toMatchObject({ result: 'succeeded' });
      const draft: PrepareReviewDecisionCommand = {
        ...identity(),
        commandType: 'moderation.decide-review',
        data: {
          expectedTargetVersion: 2,
          reason: 'Synthetic report decision',
          decision,
          note: privateNote,
          adminActionToken: await fixture.issue({
            commandCode: 'moderation.decide-review',
            requiredPermission: decision === 'dismissed' ? 'dismiss_report' : 'view_reports',
            targetType: 'moderation_review',
            targetId: report.reviewId,
            expectedTargetVersion: 2,
          }),
        },
      };
      const path = `/v1/admin/moderation/reviews/decision/${decision}`;
      if (decision === 'actioned') {
        const denied = await app.inject({
          method: 'POST',
          url: path,
          headers,
          payload: {
            ...draft,
            data: { ...draft.data, confirmationToken: await confirm(path, draft) },
          },
        });
        expect(denied.json()).toMatchObject({ result: 'rejected', safeCode: 'unavailable' });
        expect(
          await database
            .selectFrom('moderation.moderation_reviews')
            .select(['status', 'version'])
            .where('id', '=', report.reviewId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: 'in_review', version: 2 });
        const action: PrepareAccountModerationActionCommand = {
          ...identity(),
          commandType: 'moderation.apply-account-action',
          data: {
            expectedTargetVersion: 1,
            reason: 'Synthetic report account action',
            action: 'restrict_user',
            adminActionToken: await fixture.issue({
              commandCode: 'moderation.apply-account-action',
              requiredPermission: 'restrict_user',
              targetType: 'user',
              targetId: report.target,
              expectedTargetVersion: 1,
              sourceReportId: report.reportId,
            }),
          },
        };
        const actionPath = '/v1/admin/moderation/accounts/restrict_user';
        const acted = await app.inject({
          method: 'POST',
          url: actionPath,
          headers,
          payload: {
            ...action,
            data: { ...action.data, confirmationToken: await confirm(actionPath, action) },
          },
        });
        expect(acted.json()).toMatchObject({ result: 'succeeded' });
        draft.commandId = randomUUID();
        draft.requestId = randomUUID();
      }
      const command = {
        ...draft,
        data: { ...draft.data, confirmationToken: await confirm(path, draft) },
      };
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          app.inject({ method: 'POST', url: path, headers, payload: command }),
        ),
      );
      const receipts = responses.map((response) => response.json<AdminCommandReceipt>());
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(receipts.every((receipt) => receipt.result === 'succeeded')).toBe(true);
      expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
      const row = await database
        .selectFrom('moderation.moderation_reviews')
        .select(['status', 'version', 'decision_note_ciphertext', 'decision_note_key_id'])
        .where('id', '=', report.reviewId)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        status: decision,
        version: 3,
        decision_note_key_id: 'http-review-notes',
      });
      expect(row.decision_note_ciphertext).not.toBeNull();
      expect(row.decision_note_ciphertext!.toString('utf8')).not.toContain(privateNote);
      expect(
        await database
          .selectFrom('moderation.reports')
          .select('status')
          .where('id', '=', report.reportId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: decision });
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('admin_user_id', '=', adminId)
          .where('command_id', '=', draft.commandId)
          .execute(),
      ).toHaveLength(1);
      for (const response of responses)
        for (const privateValue of [privateNote, report.target, report.reporter, report.reviewId])
          expect(response.body).not.toContain(privateValue);
      const events = await database
        .selectFrom('platform.outbox_events')
        .select('payload')
        .where('aggregate_id', '=', report.reviewId)
        .execute();
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(privateNote);
    }
    expect(JSON.stringify(error.mock.calls)).not.toContain(privateNote);
  });
});
