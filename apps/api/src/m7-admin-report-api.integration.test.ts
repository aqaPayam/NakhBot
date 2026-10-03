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
  PostgresGetReportMetadataPageHandler,
  PostgresGetReportEvidenceActionsHandler,
  PostgresConfirmedReportEvidenceReveals,
  PostgresRecordAdminIngressRejectionHandler,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import type {
  ReportMetadataPage,
  ReportEvidenceActions,
  PreparedAdminConfirmation,
  AdminEvidenceRevealResult,
} from '@nakh/contracts';
import { AesGcmPhotoReportSnapshotReader } from '@nakh/application';
import {
  createRetainedReportPhoto,
  createReportFixtureAdmin,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { ApiExceptionFilter } from './app.js';
import { M7AdminReportApiModule } from './m7-admin-report-api.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M7 admin HTTP current PostgreSQL permission checks', () => {
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
  it('returns only signed authorized metadata and denies cross-admin reuse or revoked permissions on an existing token', async () => {
    const source = await createRetainedReportPhoto(database),
      first = await createReportFixtureAdmin(database),
      second = await createReportFixtureAdmin(database);
    for (const admin of [first, second])
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
    const one = await confirmationFixture(database, first),
      two = await confirmationFixture(database, second);
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminReportApiModule.register({
        authenticator: {
          authenticate: ({ bearerToken, audience }) =>
            Promise.resolve(
              audience !== 'admin'
                ? undefined
                : bearerToken === 'metadata-admin-one'
                  ? one.actor
                  : bearerToken === 'metadata-admin-two'
                    ? two.actor
                    : undefined,
            ),
        },
        metadata: new PostgresGetReportMetadataPageHandler(database, one.tokens, one.key),
        evidenceActions: new PostgresGetReportEvidenceActionsHandler(
          database,
          one.tokens,
          one.key,
          Date.now,
          ['photo'],
        ),
        evidenceReveals: {
          commands: new PostgresConfirmedReportEvidenceReveals(database, one.tokens, one.key, {
            photo: new AesGcmPhotoReportSnapshotReader({
              resolve: (keyId, version) =>
                keyId === 'photo-fixture' && version === 1 ? source.key : undefined,
            }),
          }),
          journal: new PostgresRecordAdminIngressRejectionHandler(database),
        },
      }),
      new FastifyAdapter({ bodyLimit: 256 * 1024, trustProxy: false }),
      { logger: false },
    );
    const error = vi.fn();
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const query = {
      actor: one.actor,
      requestId: randomUUID(),
      status: 'submitted',
      limit: 1,
      adminActionToken: await one.issue({
        commandCode: 'moderation.report-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report_queue',
        targetId: null,
        expectedTargetVersion: null,
      }),
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/reports/metadata',
      headers: { authorization: 'Bearer metadata-admin-one' },
      payload: query,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ReportMetadataPage>().items).toHaveLength(1);
    for (const restricted of [
      source.reporter,
      source.target,
      source.photoId,
      one.actor.userId,
      query.adminActionToken,
    ])
      expect(response.body).not.toContain(restricted);
    const cross = await app.inject({
      method: 'POST',
      url: '/v1/admin/reports/metadata',
      headers: { authorization: 'Bearer metadata-admin-two' },
      payload: { ...query, actor: two.actor },
    });
    expect(cross.statusCode).toBe(403);
    const selection = {
      actor: one.actor,
      requestId: randomUUID(),
      adminActionToken: await one.issue({
        commandCode: 'moderation.evidence-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report',
        targetId: source.reportId,
        expectedTargetVersion: 1,
      }),
    };
    const actions = await app.inject({
      method: 'POST',
      url: '/v1/admin/reports/evidence/actions',
      headers: { authorization: 'Bearer metadata-admin-one' },
      payload: selection,
    });
    expect(actions.statusCode).toBe(200);
    const selectedItems = actions.json<ReportEvidenceActions>().items;
    expect(selectedItems).toHaveLength(1);
    expect(selectedItems[0]).toMatchObject({
      evidenceId: source.evidenceId,
      evidenceType: 'photo',
      snapshotSchemaVersion: 1,
    });
    expect(selectedItems[0]?.revealActionToken).toMatch(/^v1\.ad\./u);
    const draft = {
      actor: one.actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'moderation.reveal-evidence',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      idempotencyKey: randomUUID(),
      data: {
        adminActionToken: selectedItems[0]!.revealActionToken,
        evidenceId: source.evidenceId,
        reason: 'Review synthetic retained photo',
      },
    };
    const prepare = async (value: typeof draft): Promise<string> => {
      const prepared = await app.inject({
        method: 'POST',
        url: '/v1/admin/reports/evidence/reveal/prepare',
        headers: { authorization: 'Bearer metadata-admin-one' },
        payload: value,
      });
      expect(prepared.statusCode).toBe(200);
      return prepared.json<PreparedAdminConfirmation>().confirmationToken;
    };
    const confirmed = {
      ...draft,
      data: { ...draft.data, confirmationToken: await prepare(draft) },
    };
    const revealed = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({
          method: 'POST',
          url: '/v1/admin/reports/evidence/reveal',
          headers: { authorization: 'Bearer metadata-admin-one' },
          payload: confirmed,
        }),
      ),
    );
    expect(revealed.every((response) => response.statusCode === 200)).toBe(true);
    const outcomes = revealed.map((response) => response.json<AdminEvidenceRevealResult>());
    expect(
      outcomes.filter((result) => result.result === 'succeeded' && !result.replayed),
    ).toHaveLength(1);
    expect(outcomes.filter((result) => 'evidence' in result)).toHaveLength(1);
    expect(new Set(outcomes.map((result) => result.auditId)).size).toBe(1);
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('id')
        .where('admin_user_id', '=', first)
        .where('command_id', '=', draft.commandId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('admin_user_id', '=', first)
        .where('command_id', '=', draft.commandId)
        .execute(),
    ).toHaveLength(1);
    const revokeDraft = { ...draft, commandId: randomUUID(), requestId: randomUUID() };
    const revokeCommand = {
      ...revokeDraft,
      data: { ...revokeDraft.data, confirmationToken: await prepare(revokeDraft) },
    };
    expect(actions.headers['cache-control']).toBe('no-store');
    for (const privateValue of [
      source.reporter,
      source.target,
      source.photoId,
      selection.adminActionToken,
    ])
      expect(actions.body).not.toContain(privateValue);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/reports/evidence/actions',
          headers: { authorization: 'Bearer metadata-admin-two' },
          payload: { ...selection, actor: two.actor },
        })
      ).statusCode,
    ).toBe(403);
    await database
      .updateTable('administration.admin_user_roles')
      .set({ revoked_at: new Date(), revoked_by_admin_id: first })
      .where('admin_user_id', '=', first)
      .where('role_code', '=', 'super_admin')
      .where('revoked_at', 'is', null)
      .execute();
    const revoked = await app.inject({
      method: 'POST',
      url: '/v1/admin/reports/metadata',
      headers: { authorization: 'Bearer metadata-admin-one' },
      payload: query,
    });
    expect(revoked.statusCode).toBe(403);
    const revokedReveal = await app.inject({
      method: 'POST',
      url: '/v1/admin/reports/evidence/reveal',
      headers: { authorization: 'Bearer metadata-admin-one' },
      payload: revokeCommand,
    });
    expect(revokedReveal.statusCode).toBe(200);
    expect(revokedReveal.json()).toMatchObject({ result: 'rejected', safeCode: 'forbidden' });
    expect(revokedReveal.body).not.toContain('evidence');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/reports/evidence/actions',
          headers: { authorization: 'Bearer metadata-admin-one' },
          payload: selection,
        })
      ).statusCode,
    ).toBe(403);
    expect(JSON.stringify(error.mock.calls)).not.toContain(query.adminActionToken);
  });
});
