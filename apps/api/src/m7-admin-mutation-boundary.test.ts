import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@nakh/domain';
import {
  RecordAdminIngressRejectionHandler,
  type AdminCommandExecutionResult,
  type AdminIngressRejection,
  type AdminIngressRejectionStore,
} from '@nakh/application';
import {
  ApplyAccountModerationActionCommandSchema,
  type ApplyAccountModerationActionCommand,
} from '@nakh/contracts';
import { M7ApiBoundary } from './m7-api-boundary.js';
import { AuditedAdminMutationIngress } from './m7-admin-mutation-boundary.js';

const actor = { kind: 'admin' as const, userId: randomUUID() };
const scope = {
  commandCode: 'moderation.apply-account-action',
  requiredPermission: 'restrict_user' as const,
};
const body: ApplyAccountModerationActionCommand = {
  commandType: 'moderation.apply-account-action',
  schemaVersion: 1,
  actor,
  commandId: randomUUID(),
  requestId: randomUUID(),
  idempotencyKey: randomUUID(),
  occurredAt: new Date().toISOString(),
  locale: 'en',
  data: {
    adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    confirmationToken: `v1.cf.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    expectedTargetVersion: 1,
    reason: 'Fixture review reason',
    action: 'restrict_user',
  },
};
const request = (): { headers: { authorization: string; 'x-request-id'?: string } } => ({
  headers: { authorization: 'Bearer admin-fixture-credential' },
});
function rejected(): AdminCommandExecutionResult<never> {
  return {
    logId: randomUUID(),
    result: 'rejected',
    safeCode: 'invalid_request',
    recordedAt: new Date(),
    replayed: false,
    value: undefined,
  };
}
function fixture(store?: Partial<AdminIngressRejectionStore>): {
  ingress: AuditedAdminMutationIngress;
  record: ReturnType<typeof vi.fn<AdminIngressRejectionStore['record']>>;
} {
  const record = vi.fn<AdminIngressRejectionStore['record']>(
    store?.record ?? (() => Promise.resolve(rejected())),
  );
  const journal = new RecordAdminIngressRejectionHandler({
    record,
    ...(store?.recover === undefined ? {} : { recover: store.recover }),
  });
  return {
    ingress: new AuditedAdminMutationIngress(
      new M7ApiBoundary({ authenticate: () => Promise.resolve(actor) }),
      journal,
    ),
    record,
  };
}
describe('audited authenticated admin mutation ingress', () => {
  it('delegates validated commands without replacing their owned business audit or command identity', async () => {
    const { ingress, record } = fixture(),
      execute = vi.fn(() => Promise.resolve(rejected()));
    const result = await ingress.execute<ApplyAccountModerationActionCommand, never>(
      ApplyAccountModerationActionCommandSchema,
      request(),
      body,
      scope,
      execute,
    );
    expect(result.result).toBe('rejected');
    expect(execute).toHaveBeenCalledWith(body, actor);
    expect(record).not.toHaveBeenCalled();
  });
  it('records malformed and forged-actor requests against only the authenticated context', async () => {
    const { ingress, record } = fixture(),
      execute = vi.fn(() => Promise.resolve(rejected()));
    const privateValue = 'PRIVATE INPUT AND TARGET';
    await ingress.execute(
      ApplyAccountModerationActionCommandSchema,
      request(),
      { ...body, privateText: privateValue },
      scope,
      execute,
    );
    await ingress.execute(
      ApplyAccountModerationActionCommandSchema,
      request(),
      { ...body, actor: { ...actor, userId: randomUUID() } },
      scope,
      execute,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(2);
    for (const [context] of record.mock.calls) {
      expect(context.actor).toEqual(actor);
      expect(context.commandId).toBe(body.commandId);
      expect(context.commandCode).toBe(scope.commandCode);
      expect(context.requiredPermission).toBe(scope.requiredPermission);
      expect(context.outcome).toBe('rejected');
      expect(context.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(context)).not.toContain(privateValue);
    }
  });
  it('uses a stable digest across JSON key order and transport metadata changes and recovers terminal ingress outcomes', async () => {
    let saved: AdminIngressRejection | undefined;
    const recovered = { ...rejected(), replayed: true };
    const { ingress, record } = fixture({
      record: (input) => {
        saved = input;
        return Promise.resolve(rejected());
      },
      recover: (input) =>
        Promise.resolve(saved?.requestDigest === input.requestDigest ? recovered : undefined),
    });
    const execute = vi.fn(() => Promise.resolve(rejected()));
    const invalid = { ...body, privateExtra: 'fixture' };
    await ingress.execute(
      ApplyAccountModerationActionCommandSchema,
      request(),
      invalid,
      scope,
      execute,
    );
    const reordered = Object.fromEntries(
      Object.entries({ ...invalid, requestId: randomUUID(), locale: 'fa' }).reverse(),
    );
    expect(
      await ingress.execute(
        ApplyAccountModerationActionCommandSchema,
        request(),
        reordered,
        scope,
        execute,
      ),
    ).toEqual(recovered);
    expect(record).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
  it('records unexpected early failure as failed without passing error text or details into the journal', async () => {
    const { ingress, record } = fixture(),
      privateValue = 'PRIVATE FAILURE DATA';
    await ingress.execute(ApplyAccountModerationActionCommandSchema, request(), body, scope, () =>
      Promise.reject(new Error(privateValue)),
    );
    expect(record.mock.calls[0]?.[0].outcome).toBe('failed');
    expect(JSON.stringify(record.mock.calls)).not.toContain(privateValue);
  });
  it('fails closed with a sanitized error when the required journal is unavailable', async () => {
    const { ingress } = fixture({
      record: () => Promise.reject(new Error('PRIVATE DATABASE FAILURE')),
    });
    await expect(
      ingress.execute(
        ApplyAccountModerationActionCommandSchema,
        request(),
        { ...body, extra: 'invalid' },
        scope,
        () => Promise.resolve(rejected()),
      ),
    ).rejects.toMatchObject({ code: 'internal_error', message: 'error.m7.internal' });
  });
  it('never delegates or writes an admin attempt when identity cannot be authenticated', async () => {
    const record = vi.fn<AdminIngressRejectionStore['record']>(() => Promise.resolve(rejected())),
      execute = vi.fn(() => Promise.resolve(rejected()));
    const ingress = new AuditedAdminMutationIngress(
      new M7ApiBoundary({ authenticate: () => Promise.resolve(undefined) }),
      new RecordAdminIngressRejectionHandler({ record }),
    );
    await expect(
      ingress.execute(ApplyAccountModerationActionCommandSchema, request(), body, scope, execute),
    ).rejects.toBeInstanceOf(ApplicationError);
    expect(record).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
