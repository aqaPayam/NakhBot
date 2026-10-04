import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, runMigrations, type NakhDatabase } from '@nakh/persistence-postgres';
import type { OpaqueTokenStore } from '@nakh/application';
import type { UserAppealReceipt, PreparedAppealReference } from '@nakh/contracts';
import { createReportUser } from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { M7AppealApiModule } from './m7-appeal-api.js';
import { createM7AppealApiOptions } from './m7-appeal-services.js';
import { ApiExceptionFilter } from './app.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('exact-ban appeal HTTP to PostgreSQL', () => {
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
  it('submits one appeal under retry races, rejects borrowed references, and never exposes ban identity or text', async () => {
    const userId = await createReportUser(database),
      otherId = await createReportUser(database),
      banId = randomUUID(),
      now = new Date();
    await database.transaction().execute(async (tx) => {
      await tx
        .updateTable('identity.accounts')
        .set({ state: 'banned', state_reason: 'test_ban', state_changed_at: now, version: 2 })
        .where('user_id', '=', userId)
        .execute();
      await tx
        .insertInto('identity.account_state_history')
        .values({
          id: banId,
          user_id: userId,
          previous_state: 'active',
          next_state: 'banned',
          reason_code: 'test_ban',
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          changed_at: now,
        })
        .execute();
    });
    const values = new Map<string, string>(),
      tokens: OpaqueTokenStore = {
        get: (id) => Promise.resolve(values.get(id)),
        putIfAbsent: (id, value) => {
          if (values.has(id)) return Promise.resolve(false);
          values.set(id, value);
          return Promise.resolve(true);
        },
      };
    const error = vi.fn();
    app = await NestFactory.create<NestFastifyApplication>(
      M7AppealApiModule.register(
        createM7AppealApiOptions({
          database,
          tokens,
          key: Buffer.alloc(32, 18),
          authenticator: {
            authenticate: ({ bearerToken }) =>
              Promise.resolve(
                bearerToken === 'appeal-user-credential'
                  ? { kind: 'user', userId }
                  : bearerToken === 'appeal-other-credential'
                    ? { kind: 'user', userId: otherId }
                    : undefined,
              ),
          },
        }),
      ),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer appeal-user-credential' },
      actor = { kind: 'user' as const, userId },
      commandId = randomUUID(),
      requestId = randomUUID();
    const prepared = await app.inject({
      method: 'POST',
      url: '/v1/appeals/prepare',
      headers,
      payload: { actor, commandId, requestId },
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.body).not.toContain(banId);
    const payload = {
      actor,
      commandId,
      requestId,
      commandType: 'moderation.submit-appeal',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      idempotencyKey: randomUUID(),
      data: {
        banActionToken: prepared.json<PreparedAppealReference>().banActionToken,
        text: 'Private HTTP appeal',
      },
    };
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({ method: 'POST', url: '/v1/appeals', headers, payload }),
      ),
    );
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(
      responses
        .map((response) => response.json<UserAppealReceipt>())
        .filter((receipt) => !receipt.replayed),
    ).toHaveLength(1);
    for (const response of responses) {
      expect(response.body).not.toContain(banId);
      expect(response.body).not.toContain(payload.data.text);
      expect(response.json()).not.toHaveProperty('appealId');
    }
    const borrowed = await app.inject({
      method: 'POST',
      url: '/v1/appeals',
      headers: { authorization: 'Bearer appeal-other-credential' },
      payload: { ...payload, actor: { kind: 'user', userId: otherId }, commandId: randomUUID() },
    });
    expect(borrowed.statusCode).toBe(400);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/appeals',
      headers,
      payload: { ...payload, commandId: randomUUID(), idempotencyKey: randomUUID() },
    });
    expect(duplicate.statusCode).toBe(409);
    const rows = await database
      .selectFrom('moderation.user_appeals')
      .selectAll()
      .where('ban_state_history_id', '=', banId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(userId);
    expect(JSON.stringify(error.mock.calls)).not.toContain(payload.data.text);
  });
});
