import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AesGcmProfileReportSnapshotProtector, ReportTokens } from '@nakh/application';
import type {
  PreparedReportEvidence,
  ReportSubmissionResult,
  SubmitReportCommand,
} from '@nakh/contracts';
import {
  createDatabase,
  runMigrations,
  PostgresPrepareProfileReportEvidenceHandler,
  PostgresSubmitProfileReportHandler,
  PostgresGetReportReasonsHandler,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
// Shared synthetic test fixtures; these imports never enter the production adapter.
import {
  createReportUser,
  createReportLike,
  createReportFixtureAdmin,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { ApiExceptionFilter } from './app.js';
import { M7ReportApiModule } from './m7-report-api.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M7 HTTP to committed PostgreSQL report facts', () => {
  let database: NakhDatabase, app: NestFastifyApplication, reporter: string;
  const values = new Map<string, string>(),
    error = vi.fn();
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
    app = await NestFactory.create<NestFastifyApplication>(
      M7ReportApiModule.register({
        authenticator: {
          authenticate: ({ bearerToken, audience }) =>
            Promise.resolve(
              bearerToken === 'http-fixture-credential' && audience === 'user'
                ? { kind: 'user', userId: reporter }
                : undefined,
            ),
        },
        reasons: new PostgresGetReportReasonsHandler(database),
        prepare: new PostgresPrepareProfileReportEvidenceHandler(database, tokens),
        submit: new PostgresSubmitProfileReportHandler(
          database,
          tokens,
          new AesGcmProfileReportSnapshotProtector('http-key', 1, Buffer.alloc(32, 93)),
        ),
      }),
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
            .where('reporter_user_id', '=', reporter),
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
});
