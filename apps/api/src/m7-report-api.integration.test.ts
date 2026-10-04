import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AesGcmProfileReportSnapshotProtector,
  AesGcmProfileReportSnapshotReader,
  AesGcmPhotoReportSnapshotProtector,
  AesGcmPhotoReportSnapshotReader,
  AesGcmChatReportSnapshotProtector,
  AesGcmChatReportSnapshotReader,
  AesGcmUnmatchedReportSnapshotProtector,
  AesGcmUnmatchedReportSnapshotReader,
  IntegrityMessageReportSnapshotReader,
  ReportTokens,
  AesGcmReviewNoteProtector,
  type ReportSource,
} from '@nakh/application';
import type {
  PreparedReportEvidence,
  ReportSubmissionResult,
  SubmitReportCommand,
  ReportEvidenceType,
  ReportEvidenceActions,
  PreparedAdminConfirmation,
  AdminEvidenceRevealResult,
} from '@nakh/contracts';
import { createDatabase, runMigrations, type NakhDatabase } from '@nakh/persistence-postgres';
// Shared synthetic test fixtures; these imports never enter the production adapter.
import {
  createReportUser,
  createReportLike,
  createReportFixtureAdmin,
  createReportChat,
  createReportMessage,
  createReportUnmatch,
  createReportPhoto,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { ApiExceptionFilter } from './app.js';
import { M7HostApiModule } from './m7-host-api.js';
import { createM7HostOptions } from './m7-host-services.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M7 HTTP to committed PostgreSQL report facts', () => {
  let database: NakhDatabase, app: NestFastifyApplication, reporter: string;
  let admin: Awaited<ReturnType<typeof confirmationFixture>>;
  const values = new Map<string, string>(),
    error = vi.fn();
  const reporters: string[] = [],
    key = Buffer.alloc(32, 93);
  const tokens = new ReportTokens(
    {
      get: (id) => Promise.resolve(values.get(id)),
      putIfAbsent: (id, value) => {
        if (values.has(id)) return Promise.resolve(false);
        values.set(id, value);
        return Promise.resolve(true);
      },
    },
    Buffer.alloc(32, 92),
  );
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 20,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 25000,
    });
    reporter = await createReportUser(database);
    reporters.push(reporter);
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
    admin = await confirmationFixture(database, adminId);
    const options = createM7HostOptions({
      database,
      reportTokens: tokens,
      adminTokens: admin.tokens,
      adminKey: admin.key,
      safetyTokens: admin.tokens,
      safetyKey: Buffer.alloc(32, 94),
      reviewNotes: new AesGcmReviewNoteProtector('http-review-notes', 1, key),
      capabilities: {
        profile: {
          protector: new AesGcmProfileReportSnapshotProtector('http-key', 1, key),
          reader: new AesGcmProfileReportSnapshotReader({ resolve: () => key }),
        },
        photo: {
          protector: new AesGcmPhotoReportSnapshotProtector('http-key', 1, key),
          reader: new AesGcmPhotoReportSnapshotReader({ resolve: () => key }),
        },
        chat: {
          protector: new AesGcmChatReportSnapshotProtector('http-key', 1, key),
          reader: new AesGcmChatReportSnapshotReader({ resolve: () => key }),
        },
        unmatched_user: {
          protector: new AesGcmUnmatchedReportSnapshotProtector('http-key', 1, key),
          reader: new AesGcmUnmatchedReportSnapshotReader({ resolve: () => key }),
        },
        message: { reader: new IntegrityMessageReportSnapshotReader() },
      },
      authenticator: {
        authenticate: ({ bearerToken, audience }) =>
          Promise.resolve(
            bearerToken === 'http-fixture-credential' && audience === 'user'
              ? { kind: 'user', userId: reporter }
              : bearerToken === 'http-admin-credential' && audience === 'admin'
                ? admin.actor
                : undefined,
          ),
      },
    });
    app = await NestFactory.create<NestFastifyApplication>(
      M7HostApiModule.register(options),
      new FastifyAdapter({ bodyLimit: 256 * 1024, trustProxy: false }),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
    if (database === undefined) return;
    if (reporter !== undefined) {
      const admin = await createReportFixtureAdmin(database);
      await database
        .updateTable('moderation.moderation_reviews')
        .set({
          status: 'in_review',
          assigned_admin_id: admin,
          assigned_at: sql<Date>`transaction_timestamp()`,
          updated_at: sql<Date>`transaction_timestamp()`,
          version: sql<number>`version + 1`,
        })
        .where('status', '=', 'pending')
        .where(
          'report_id',
          'in',
          database
            .selectFrom('moderation.reports')
            .select('id')
            .where('reporter_user_id', 'in', reporters),
        )
        .execute();
    }
    await database.destroy();
  });
  it('commits once under concurrent HTTP retries, replays after token loss, rejects changed replay and enforces durable concurrent admission', async () => {
    const target = await createReportUser(database, true),
      actor = { kind: 'user' as const, userId: reporter };
    const source = await createReportLike(database, reporter, target);
    const headers = { authorization: 'Bearer http-fixture-credential' };
    async function prepare(): Promise<PreparedReportEvidence> {
      const sourceActionToken = (
        await tokens.issueSource(reporter, { kind: 'received_like', referenceId: source })
      ).token;
      const response = await app.inject({
        method: 'POST',
        url: '/v1/reports/prepare',
        headers,
        payload: {
          actor,
          requestId: randomUUID(),
          sourceActionToken,
          requestedEvidenceTypes: ['profile'],
        },
      });
      expect(response.statusCode).toBe(200);
      return response.json<PreparedReportEvidence>();
    }
    const evidence = await prepare();
    const command: SubmitReportCommand = {
      commandType: 'moderation.submit-report',
      schemaVersion: 1,
      actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        evidenceIntentToken: evidence.evidenceIntentToken,
        reasonCode: 'harassment',
        text: 'PRIVATE HTTP REPORT FIXTURE',
      },
    };
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({
          method: 'POST',
          url: '/v1/reports',
          headers,
          payload: command,
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual(Array(6).fill(201));
    const receipts = responses.map((response) => response.json<ReportSubmissionResult>());
    expect(new Set(receipts.map((receipt) => receipt.reportId)).size).toBe(1);
    expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
    for (const response of responses) expect(response.body).not.toContain(command.data.text!);
    values.clear();
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers,
      payload: command,
    });
    expect(replay.json<ReportSubmissionResult>().replayed).toBe(true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/reports',
          headers,
          payload: { ...command, data: { ...command.data, text: 'Changed private fixture' } },
        })
      ).statusCode,
    ).toBe(409);
    const next = await prepare();
    const admissions = await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject({
          method: 'POST',
          url: '/v1/reports',
          headers,
          payload: {
            ...command,
            commandId: randomUUID(),
            idempotencyKey: randomUUID(),
            data: { ...command.data, evidenceIntentToken: next.evidenceIntentToken },
          },
        }),
      ),
    );
    expect(admissions.filter((response) => response.statusCode === 201)).toHaveLength(9);
    expect(admissions.filter((response) => response.statusCode === 429)).toHaveLength(3);
    const reports = await database
      .selectFrom('moderation.reports')
      .select('id')
      .where('reporter_user_id', '=', reporter)
      .execute();
    expect(reports).toHaveLength(10);
    const ids = reports.map((report) => report.id);
    for (const table of [
      'moderation.report_evidence',
      'moderation.report_snapshots',
      'moderation.moderation_reviews',
    ] as const)
      expect(
        await database.selectFrom(table).select('id').where('report_id', 'in', ids).execute(),
      ).toHaveLength(10);
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('payload')
      .where('aggregate_id', 'in', ids)
      .execute();
    expect(events).toHaveLength(10);
    expect(JSON.stringify(events)).not.toContain(command.data.text!);
    expect(JSON.stringify(error.mock.calls)).not.toContain(command.data.text!);
  });
  it('prepares, captures, confirms, reveals and replays all five evidence types through one HTTP host configuration', async () => {
    reporter = await createReportUser(database);
    reporters.push(reporter);
    const actor = { kind: 'user' as const, userId: reporter },
      headers = { authorization: 'Bearer http-fixture-credential' };
    const profileTarget = await createReportUser(database, true),
      like = await createReportLike(database, reporter, profileTarget);
    const chatTarget = await createReportUser(database),
      chat = await createReportChat(database, reporter, chatTarget);
    const contexts: { type: ReportEvidenceType; source: ReportSource }[] = [
      { type: 'profile', source: { kind: 'received_like', referenceId: like } },
      {
        type: 'photo',
        source: {
          kind: 'received_like',
          referenceId: like,
          photoId: await createReportPhoto(database, profileTarget),
        },
      },
      { type: 'chat', source: { kind: 'match', referenceId: chat.matchId } },
      {
        type: 'message',
        source: {
          kind: 'message',
          referenceId: await createReportMessage(database, chat.chatSessionId, chatTarget),
        },
      },
      {
        type: 'unmatched_user',
        source: {
          kind: 'unmatched',
          referenceId: (
            await createReportUnmatch(database, reporter, await createReportUser(database))
          ).matchId,
        },
      },
    ];
    const commands: SubmitReportCommand[] = [],
      ids: string[] = [];
    for (const context of contexts) {
      const sourceActionToken = (await tokens.issueSource(reporter, context.source)).token;
      const prepared = await app.inject({
        method: 'POST',
        url: '/v1/reports/prepare',
        headers,
        payload: {
          actor,
          requestId: randomUUID(),
          sourceActionToken,
          requestedEvidenceTypes: [context.type],
        },
      });
      expect(prepared.statusCode).toBe(200);
      const command: SubmitReportCommand = {
        commandType: 'moderation.submit-report',
        schemaVersion: 1,
        actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          reasonCode: 'harassment',
          evidenceIntentToken: prepared.json<PreparedReportEvidence>().evidenceIntentToken,
        },
      };
      const response = await app.inject({
        method: 'POST',
        url: '/v1/reports',
        headers,
        payload: command,
      });
      expect(response.statusCode).toBe(201);
      ids.push(response.json<ReportSubmissionResult>().reportId);
      commands.push(command);
    }
    expect(
      await database
        .selectFrom('moderation.report_snapshots')
        .select('id')
        .where('report_id', 'in', ids)
        .execute(),
    ).toHaveLength(4);
    expect(
      await database
        .selectFrom('chat.chat_message_snapshots')
        .select('id')
        .where('report_id', 'in', ids)
        .execute(),
    ).toHaveLength(1);
    const evidence = await database
      .selectFrom('moderation.report_evidence')
      .select(['id', 'evidence_type'])
      .where('report_id', 'in', ids)
      .execute();
    expect(new Set(evidence.map((row) => row.evidence_type))).toEqual(
      new Set(contexts.map((context) => context.type)),
    );
    expect(
      await database
        .selectFrom('media.report_photo_evidence_holds')
        .select('report_evidence_id')
        .where(
          'report_evidence_id',
          'in',
          evidence.map((row) => row.id),
        )
        .execute(),
    ).toHaveLength(1);
    for (const reportId of ids) {
      const adminHeaders = { authorization: 'Bearer http-admin-credential' };
      const actionToken = await admin.issue({
        commandCode: 'moderation.evidence-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report',
        targetId: reportId,
        expectedTargetVersion: 1,
      });
      const selected = await app.inject({
        method: 'POST',
        url: '/v1/admin/reports/evidence/actions',
        headers: adminHeaders,
        payload: { actor: admin.actor, requestId: randomUUID(), adminActionToken: actionToken },
      });
      expect(selected.statusCode).toBe(200);
      const selectedEvidence = selected.json<ReportEvidenceActions>().items[0]!;
      expect(selectedEvidence.revealActionToken).toMatch(/^v1\.ad\./u);
      const draft = {
        actor: admin.actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        commandType: 'moderation.reveal-evidence',
        schemaVersion: 1,
        locale: 'en',
        occurredAt: new Date().toISOString(),
        idempotencyKey: randomUUID(),
        data: {
          evidenceId: selectedEvidence.evidenceId,
          adminActionToken: selectedEvidence.revealActionToken,
          reason: 'Review synthetic report evidence',
        },
      };
      const prepared = await app.inject({
        method: 'POST',
        url: '/v1/admin/reports/evidence/reveal/prepare',
        headers: adminHeaders,
        payload: draft,
      });
      expect(prepared.statusCode).toBe(200);
      const confirmed = {
        ...draft,
        data: {
          ...draft.data,
          confirmationToken: prepared.json<PreparedAdminConfirmation>().confirmationToken,
        },
      };
      const revealed = await app.inject({
        method: 'POST',
        url: '/v1/admin/reports/evidence/reveal',
        headers: adminHeaders,
        payload: confirmed,
      });
      expect(revealed.statusCode).toBe(200);
      const result = revealed.json<AdminEvidenceRevealResult>();
      expect(result.result).toBe('succeeded');
      expect('evidence' in result && result.evidence.content.evidenceType).toBe(
        selectedEvidence.evidenceType,
      );
      const replay = await app.inject({
        method: 'POST',
        url: '/v1/admin/reports/evidence/reveal',
        headers: adminHeaders,
        payload: confirmed,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({
        auditId: result.auditId,
        result: 'succeeded',
        replayed: true,
      });
      expect(replay.body).not.toContain('evidence');
      expect(selected.body).not.toContain(reporter);
      expect(revealed.body).not.toContain(reporter);
    }
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('id')
        .where('report_id', 'in', ids)
        .execute(),
    ).toHaveLength(5);
    values.clear();
    for (const command of commands) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/reports',
        headers,
        payload: command,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json<ReportSubmissionResult>().replayed).toBe(true);
    }
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('reporter_user_id', '=', reporter)
        .execute(),
    ).toHaveLength(5);
  });
});
