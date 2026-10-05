import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AesGcmReviewNoteProtector, ReportTokens, type OpaqueTokenStore } from '@nakh/application';
import { createDatabase, runMigrations, type NakhDatabase } from '@nakh/persistence-postgres';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createReportFixtureAdmin } from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { createM7SessionHostOptions } from './m7-session-host-services.js';
import { M7HostApiModule } from './m7-host-api.js';
import { ApiExceptionFilter } from './app.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('native sessions in the shared M7 HTTP host', () => {
  let database: NakhDatabase,
    isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined,
    app: NestFastifyApplication | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_session_host');
    await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 10,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    await app?.close();
    try {
      await database?.destroy();
    } finally {
      await isolated?.destroy();
    }
  });
  it('uses native current sessions for health preparation/read and never delegates admin credentials', async () => {
    const id = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: id,
        role_code: 'super_admin',
        assigned_by_admin_id: id,
        revoked_at: null,
        revoked_by_admin_id: null,
      })
      .execute();
    const admin = await database
      .selectFrom('administration.admin_users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const actor = { kind: 'admin' as const, userId: admin.user_id };
    const values = new Map<string, string>();
    const tokens: OpaqueTokenStore = {
      get: (key) => Promise.resolve(values.get(key)),
      putIfAbsent: (key, value) => {
        if (values.has(key)) return Promise.resolve(false);
        values.set(key, value);
        return Promise.resolve(true);
      },
    };
    const authenticate = vi.fn(() => Promise.resolve(actor));
    const composition = createM7SessionHostOptions({
      database,
      userAuthenticator: { authenticate },
      mfa: {
        verify: () =>
          Promise.resolve({
            actorUserId: actor.userId,
            telegramUserId: admin.telegram_user_id,
            proofId: randomUUID(),
            verifiedAt: new Date(Date.now() - 1000),
            expiresAt: new Date(Date.now() + 240000),
          }),
      },
      reportTokens: new ReportTokens(tokens, Buffer.alloc(32, 1)),
      adminTokens: tokens,
      adminKey: Buffer.alloc(32, 2),
      safetyTokens: tokens,
      safetyKey: Buffer.alloc(32, 3),
      capabilities: {},
      reviewNotes: new AesGcmReviewNoteProtector('session-host', 1, Buffer.alloc(32, 4)),
    });
    const credential = await composition.sessions.issue({
      actor: { ...actor, kind: 'user' },
      telegramUserId: admin.telegram_user_id,
      requestId: randomUUID(),
      proof: 'synthetic-server-MFA-proof',
    });
    app = await NestFactory.create<NestFastifyApplication>(
      M7HostApiModule.register(composition.host),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error: vi.fn() } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const root = '/v1/admin/moderation/operational-health',
      headers = { authorization: `Bearer ${credential.adminSessionToken}` },
      query = { actor, requestId: randomUUID() };
    const prepared = await app.inject({
      method: 'POST',
      url: `${root}/prepare`,
      headers,
      payload: query,
    });
    expect(prepared.statusCode).toBe(200);
    const payload = { ...query, ...prepared.json<Record<string, unknown>>() };
    expect((await app.inject({ method: 'POST', url: root, headers, payload })).statusCode).toBe(
      200,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: root,
          headers: { authorization: 'Bearer legacy-admin-credential' },
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(authenticate).not.toHaveBeenCalled();
    await composition.sessions.revoke({
      actor,
      adminSessionToken: credential.adminSessionToken,
      requestId: randomUUID(),
    });
    expect((await app.inject({ method: 'POST', url: root, headers, payload })).statusCode).toBe(
      401,
    );
    expect(await composition.sessions.current(admin.telegram_user_id)).toBeUndefined();
  });
});
