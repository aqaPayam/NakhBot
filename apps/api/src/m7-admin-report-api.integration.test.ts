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
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import type { ReportMetadataPage } from '@nakh/contracts';
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
    expect(JSON.stringify(error.mock.calls)).not.toContain(query.adminActionToken);
  });
});
