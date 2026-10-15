import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pino from 'pino';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  M8AccountReturnApprovalApiModule,
  type M8AccountReturnApprovalApiOptions,
} from './m8-account-return-approval-api.js';
import type { ApproveAccountReturnCommand } from '@nakh/contracts';
import type { AdminCommandExecutionResult, AccountReturnApproval } from '@nakh/application';
import { ApiExceptionFilter } from './app.js';

describe('administrator Return approval HTTP boundary', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => {
    await app?.close();
  });
  async function fixture(): Promise<{
    actor: { kind: 'admin'; userId: string };
    root: string;
    action: string;
    confirmation: string;
    outcome: AdminCommandExecutionResult<AccountReturnApproval>;
    options: {
      authenticator: {
        authenticate: Mock<M8AccountReturnApprovalApiOptions['authenticator']['authenticate']>;
      };
      selection: { execute: Mock<M8AccountReturnApprovalApiOptions['selection']['execute']> };
      commands: {
        prepare: Mock<M8AccountReturnApprovalApiOptions['commands']['prepare']>;
        execute: Mock<M8AccountReturnApprovalApiOptions['commands']['execute']>;
      };
      rejections: {
        recover: Mock<M8AccountReturnApprovalApiOptions['rejections']['recover']>;
        record: Mock<M8AccountReturnApprovalApiOptions['rejections']['record']>;
      };
    };
    headers: { authorization: string };
    command: ApproveAccountReturnCommand;
    app: NestFastifyApplication;
  }> {
    const actor = { kind: 'admin' as const, userId: randomUUID() },
      root = randomUUID(),
      action = `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
      confirmation = `v1.cf.${'c'.repeat(16)}.${'d'.repeat(16)}`;
    const outcome = {
      logId: randomUUID(),
      result: 'succeeded' as const,
      safeCode: 'return_approved',
      recordedAt: new Date(),
      replayed: false,
      value: { approvalId: root, productEpoch: 0 },
    };
    const options = {
      authenticator: {
        authenticate: vi.fn<M8AccountReturnApprovalApiOptions['authenticator']['authenticate']>(
          () => Promise.resolve(actor),
        ),
      },
      selection: {
        execute: vi.fn<M8AccountReturnApprovalApiOptions['selection']['execute']>(() =>
          Promise.resolve({ adminActionToken: action, expectedTargetVersion: 2 }),
        ),
      },
      commands: {
        prepare: vi.fn<M8AccountReturnApprovalApiOptions['commands']['prepare']>(() =>
          Promise.resolve(confirmation),
        ),
        execute: vi.fn<M8AccountReturnApprovalApiOptions['commands']['execute']>(() =>
          Promise.resolve(outcome),
        ),
      },
      rejections: {
        recover: vi.fn<M8AccountReturnApprovalApiOptions['rejections']['recover']>(() =>
          Promise.resolve(undefined),
        ),
        record: vi.fn<M8AccountReturnApprovalApiOptions['rejections']['record']>(() =>
          Promise.resolve({
            ...outcome,
            result: 'rejected',
            safeCode: 'invalid_request',
            value: undefined,
          }),
        ),
      },
    };
    app = await NestFactory.create<NestFastifyApplication>(
      M8AccountReturnApprovalApiModule.register(options),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter(pino({ enabled: false })));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer native-admin-credential' };
    const command: ApproveAccountReturnCommand = {
      commandType: 'account.approve-return',
      schemaVersion: 1,
      actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: action,
        expectedTargetVersion: 2,
        reason: 'private-review',
        confirmationToken: confirmation,
      },
    };
    return { actor, root, action, confirmation, outcome, options, headers, command, app };
  }
  it('authenticates every route before preparation or mutation', async () => {
    const f = await fixture();
    f.options.authenticator.authenticate.mockResolvedValue(undefined);
    for (const path of ['actions', 'approve/prepare', 'approve'])
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `/v1/admin/account-returns/${path}`,
            headers: f.headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
    expect(f.options.selection.execute).not.toHaveBeenCalled();
    expect(f.options.commands.prepare).not.toHaveBeenCalled();
    expect(f.options.commands.execute).not.toHaveBeenCalled();
    expect(f.options.rejections.record).not.toHaveBeenCalled();
  });
  it('returns only uncached selection metadata and withholds data on unsafe output or authority loss', async () => {
    const f = await fixture(),
      payload = {
        actor: f.actor,
        requestId: randomUUID(),
        deletionRecordId: f.root,
        expectedTargetVersion: 2,
      };
    const request = {
      method: 'POST' as const,
      url: '/v1/admin/account-returns/actions',
      headers: f.headers,
      payload,
    };
    const response = await f.app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ adminActionToken: f.action, expectedTargetVersion: 2 });
    const unsafeSelection = {
      adminActionToken: f.action,
      expectedTargetVersion: 2,
      privateBody: 'private-output',
    };
    f.options.selection.execute.mockResolvedValue(unsafeSelection);
    const unsafe = await f.app.inject(request);
    expect(unsafe.statusCode).toBe(500);
    expect(unsafe.body).not.toContain('private-output');
    f.options.selection.execute.mockResolvedValue({
      adminActionToken: f.action,
      expectedTargetVersion: 2,
    });
    f.options.authenticator.authenticate
      .mockResolvedValueOnce(f.actor)
      .mockResolvedValueOnce(undefined);
    expect((await f.app.inject(request)).statusCode).toBe(401);
  });
  it('prepares exact confirmation and discards all internal approval values on fresh success and replay', async () => {
    const f = await fixture();
    const data = {
      adminActionToken: f.command.data.adminActionToken,
      expectedTargetVersion: f.command.data.expectedTargetVersion,
      reason: f.command.data.reason,
    };
    const prepared = await f.app.inject({
      method: 'POST',
      url: '/v1/admin/account-returns/approve/prepare',
      headers: f.headers,
      payload: { ...f.command, data },
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toEqual({ confirmationToken: f.confirmation });
    for (const replayed of [false, true]) {
      f.options.commands.execute.mockResolvedValue({ ...f.outcome, replayed });
      const response = await f.app.inject({
        method: 'POST',
        url: '/v1/admin/account-returns/approve',
        headers: f.headers,
        payload: f.command,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        auditId: f.outcome.logId,
        result: 'succeeded',
        safeCode: 'completed',
        replayed,
      });
      for (const value of [f.root, f.actor.userId, f.command.data.reason, f.action, f.confirmation])
        expect(response.body).not.toContain(value);
    }
  });
  it('journals authenticated malformed execution and fails closed when the mandatory journal fails', async () => {
    const f = await fixture(),
      request = {
        method: 'POST' as const,
        url: '/v1/admin/account-returns/approve',
        headers: f.headers,
        payload: { ...f.command, data: { ...f.command.data, deletionRecordId: f.root } },
      };
    const response = await f.app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: 'rejected', safeCode: 'invalid_request' });
    expect(f.options.commands.execute).not.toHaveBeenCalled();
    expect(f.options.rejections.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: f.actor,
        commandCode: 'account.approve-return',
        requiredPermission: 'approve_account_return',
      }),
    );
    f.options.rejections.record.mockRejectedValue(new Error('private-db-secret'));
    const failed = await f.app.inject(request);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('private-db-secret');
  });
});
