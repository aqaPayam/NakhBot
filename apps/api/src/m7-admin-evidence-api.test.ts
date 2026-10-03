import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminCommandExecutionResult,
  ConfirmedEvidenceReveals,
  AdminIngressRejectionStore,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { RevealedReportEvidence } from '@nakh/contracts';
import { ApiExceptionFilter } from './app.js';
import {
  M7AdminEvidenceApiModule,
  type M7AdminEvidenceApiOptions,
} from './m7-admin-evidence-api.js';

const actor = { kind: 'admin' as const, userId: randomUUID() },
  headers = { authorization: 'Bearer evidence-admin-credential' };
const token = `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
  confirmationToken = `v1.cf.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const draft = {
  commandId: randomUUID(),
  requestId: randomUUID(),
  commandType: 'moderation.reveal-evidence' as const,
  schemaVersion: 1 as const,
  actor,
  occurredAt: new Date().toISOString(),
  locale: 'en',
  idempotencyKey: randomUUID(),
  data: { adminActionToken: token, evidenceId: randomUUID(), reason: 'Review reported content' },
};
const command = { ...draft, data: { ...draft.data, confirmationToken } };
const evidence: RevealedReportEvidence = {
  evidenceId: draft.data.evidenceId,
  snapshotSchemaVersion: 1,
  content: {
    evidenceType: 'message',
    messageId: randomUUID(),
    messageType: 'text',
    content: 'RESTRICTED MESSAGE',
    createdAt: new Date().toISOString(),
  },
  accessedAt: new Date().toISOString(),
};
const outcome = (
  overrides: Partial<AdminCommandExecutionResult<RevealedReportEvidence>> = {},
): AdminCommandExecutionResult<RevealedReportEvidence> => ({
  logId: randomUUID(),
  result: 'succeeded',
  safeCode: 'evidence_revealed',
  recordedAt: new Date(),
  replayed: false,
  value: evidence,
  ...overrides,
});
describe('authenticated confirmed evidence reveal HTTP', () => {
  let app: NestFastifyApplication | undefined;
  const error = vi.fn();
  afterEach(async () => {
    await app?.close();
    app = undefined;
    error.mockClear();
  });
  async function start(overrides: Partial<M7AdminEvidenceApiOptions> = {}): Promise<{
    app: NestFastifyApplication;
    execute: ReturnType<typeof vi.fn<ConfirmedEvidenceReveals['execute']>>;
    record: ReturnType<typeof vi.fn<AdminIngressRejectionStore['record']>>;
  }> {
    const execute = vi.fn<ConfirmedEvidenceReveals['execute']>(() => Promise.resolve(outcome()));
    const record = vi.fn<AdminIngressRejectionStore['record']>(() =>
      Promise.resolve({
        ...outcome({ result: 'rejected', safeCode: 'invalid_request' }),
        value: undefined,
      }),
    );
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminEvidenceApiModule.register({
        authenticator: { authenticate: () => Promise.resolve(actor) },
        commands: { prepare: () => Promise.resolve(confirmationToken), execute },
        journal: { record, recover: () => Promise.resolve(undefined) },
        ...overrides,
      }),
      new FastifyAdapter({ bodyLimit: 256 * 1024, trustProxy: false }),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { app, execute, record };
  }
  it('prepares the exact command and returns content only on a fresh successful audited reveal', async () => {
    const { app: server, execute, record } = await start();
    const prepared = await server.inject({
      method: 'POST',
      url: '/v1/admin/reports/evidence/reveal/prepare',
      headers,
      payload: draft,
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toEqual({ confirmationToken });
    const revealed = await server.inject({
      method: 'POST',
      url: '/v1/admin/reports/evidence/reveal',
      headers,
      payload: command,
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json<{ evidence: RevealedReportEvidence }>().evidence).toEqual(evidence);
    expect(revealed.headers['cache-control']).toBe('no-store');
    expect(revealed.headers.pragma).toBe('no-cache');
    expect(execute).toHaveBeenCalledWith(command, actor);
    expect(record).not.toHaveBeenCalled();
    for (const privateValue of [actor.userId, token, confirmationToken, draft.data.reason])
      expect(revealed.body).not.toContain(privateValue);
  });
  it('suppresses any internal content value on replay or rejection and uses finite public outcome codes', async () => {
    const execute = vi.fn<ConfirmedEvidenceReveals['execute']>();
    const { app: server } = await start({
      commands: { prepare: () => Promise.resolve(confirmationToken), execute },
    });
    for (const result of [
      outcome({ replayed: true }),
      outcome({ result: 'rejected', safeCode: 'private_dynamic_code' }),
      outcome({ result: 'failed' }),
    ]) {
      execute.mockResolvedValueOnce(result);
      const response = await server.inject({
        method: 'POST',
        url: '/v1/admin/reports/evidence/reveal',
        headers,
        payload: command,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        auditId: result.logId,
        result: result.result,
        safeCode:
          result.result === 'succeeded'
            ? 'completed'
            : result.result === 'failed'
              ? 'internal_error'
              : 'unavailable',
        recordedAt: result.recordedAt.toISOString(),
        replayed: result.replayed,
      });
      expect(response.body).not.toContain('RESTRICTED MESSAGE');
      expect(response.body).not.toContain('private_dynamic_code');
    }
  });
  it('audits malformed authenticated execution without delegating and requires the audit to succeed', async () => {
    const { app: server, execute, record } = await start();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/reports/evidence/reveal',
      headers,
      payload: { ...command, leakedText: 'PRIVATE INPUT' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ result: string }>().result).toBe('rejected');
    expect(execute).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE INPUT');
    record.mockRejectedValueOnce(new Error('PRIVATE DATABASE FAILURE'));
    const failed = await server.inject({
      method: 'POST',
      url: '/v1/admin/reports/evidence/reveal',
      headers,
      payload: {},
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('PRIVATE DATABASE FAILURE');
    expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE DATABASE FAILURE');
  });
  it('rejects unsafe confirmation output and unexpected early handler failures without error text', async () => {
    const { app: server, record } = await start({
      commands: {
        prepare: () => Promise.resolve('PRIVATE INVALID CONFIRMATION'),
        execute: () =>
          Promise.reject(
            new ApplicationError('forbidden', 'PRIVATE ERROR', 403, { text: 'PRIVATE DETAIL' }),
          ),
      },
    });
    const prepared = await server.inject({
      method: 'POST',
      url: '/v1/admin/reports/evidence/reveal/prepare',
      headers,
      payload: draft,
    });
    expect(prepared.statusCode).toBe(500);
    expect(prepared.body).not.toContain('PRIVATE');
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/reports/evidence/reveal',
      headers,
      payload: command,
    });
    expect(response.statusCode).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE');
    expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE');
  });
});
