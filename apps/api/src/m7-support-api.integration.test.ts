import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, runMigrations, type NakhDatabase } from '@nakh/persistence-postgres';
import type { OpaqueTokenStore } from '@nakh/application';
import type { UserSupportReceipt } from '@nakh/contracts';
import { createReportUser } from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { M7SupportApiModule } from './m7-support-api.js';
import { createM7SupportApiOptions } from './m7-support-services.js';
import { ApiExceptionFilter } from './app.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('support HTTP to PostgreSQL', () => {
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
  it('replays concurrent opens and sends once, bounds unanswered messages, and rejects borrowed references', async () => {
    const userId = await createReportUser(database),
      otherId = await createReportUser(database);
    const values = new Map<string, string>();
    const tokens: OpaqueTokenStore = {
      get: (id) => Promise.resolve(values.get(id)),
      putIfAbsent: (id, value) => {
        if (values.has(id)) return Promise.resolve(false);
        values.set(id, value);
        return Promise.resolve(true);
      },
    };
    const error = vi.fn();
    app = await NestFactory.create<NestFastifyApplication>(
      M7SupportApiModule.register(
        createM7SupportApiOptions({
          database,
          tokens,
          key: Buffer.alloc(32, 17),
          authenticator: {
            authenticate: ({ bearerToken }) =>
              Promise.resolve(
                bearerToken === 'support-user-credential'
                  ? { kind: 'user', userId }
                  : bearerToken === 'support-other-credential'
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
    const headers = { authorization: 'Bearer support-user-credential' };
    const identity = (): Readonly<{
      actor: { kind: 'user'; userId: string };
      commandId: string;
      requestId: string;
      schemaVersion: 1;
      idempotencyKey: string;
      occurredAt: string;
      locale: string;
    }> => ({
      actor: { kind: 'user', userId },
      commandId: randomUUID(),
      requestId: randomUUID(),
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
    });
    const privateText = 'Private HTTP support request';
    const opening = {
      ...identity(),
      commandType: 'support.open-thread',
      data: { text: privateText },
    };
    const opens = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({ method: 'POST', url: '/v1/support/threads', headers, payload: opening }),
      ),
    );
    expect(opens.every((response) => response.statusCode === 200)).toBe(true);
    const receipts = opens.map((response) => response.json<UserSupportReceipt>());
    expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
    expect(new Set(receipts.map((receipt) => receipt.supportActionToken)).size).toBe(1);
    for (const response of opens) {
      expect(response.body).not.toContain(privateText);
      expect(response.json()).not.toHaveProperty('supportThreadId');
    }
    const receipt = receipts[0]!;
    const sending = {
      ...identity(),
      commandType: 'support.send-message',
      data: {
        text: 'Second private message',
        supportActionToken: receipt.supportActionToken,
        expectedVersion: receipt.version,
      },
    };
    const sends = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({ method: 'POST', url: '/v1/support/messages', headers, payload: sending }),
      ),
    );
    expect(sends.every((response) => response.statusCode === 200)).toBe(true);
    const sent = sends.map((response) => response.json<UserSupportReceipt>());
    expect(sent.filter((receipt) => !receipt.replayed)).toHaveLength(1);
    expect(sent[0]!.unansweredUserMessages).toBe(2);
    const third = await app.inject({
      method: 'POST',
      url: '/v1/support/messages',
      headers,
      payload: {
        ...identity(),
        commandType: 'support.send-message',
        data: {
          ...sending.data,
          supportActionToken: sent[0]!.supportActionToken,
          expectedVersion: sent[0]!.version,
        },
      },
    });
    expect(third.statusCode).toBe(429);
    const borrowed = await app.inject({
      method: 'POST',
      url: '/v1/support/messages',
      headers: { authorization: 'Bearer support-other-credential' },
      payload: { ...sending, commandId: randomUUID(), actor: { kind: 'user', userId: otherId } },
    });
    expect(borrowed.statusCode).toBe(400);
    const messages = await database
      .selectFrom('support.support_messages')
      .innerJoin(
        'support.support_threads',
        'support.support_threads.id',
        'support.support_messages.support_thread_id',
      )
      .select('support.support_messages.id')
      .where('support.support_threads.user_id', '=', userId)
      .execute();
    expect(messages).toHaveLength(2);
    const changed = await app.inject({
      method: 'POST',
      url: '/v1/support/threads',
      headers,
      payload: { ...opening, data: { text: 'Changed support request' } },
    });
    expect(changed.statusCode).toBe(409);
    expect(JSON.stringify(error.mock.calls)).not.toContain(privateText);
  });
});
