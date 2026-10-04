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
  PostgresRecordAdminIngressRejectionHandler,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import type {
  PreparedAdminConfirmation,
  AdminCommandReceipt,
  PrepareAccountModerationActionCommand,
  PreparePhotoModerationActionCommand,
  PrepareInternalBlockCommand,
} from '@nakh/contracts';
import {
  createReportUser,
  createReportFixtureAdmin,
  createRetainedReportPhoto,
  createReportPhoto,
  createReportChat,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { canonicalAdminPairTargetId } from '@nakh/application';
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
  it('binds each action and permission, commits one effect under retry races and audits revocation without leaking account identities', async () => {
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
});
