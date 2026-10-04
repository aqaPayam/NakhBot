import { ApplicationError } from '@nakh/domain';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConfirmedAppealCommands,
  OpaqueTokenStore,
  PrepareAppealUnbanAccessHandler,
} from '@nakh/application';
import { TelegramAdminAppealUnbans } from './admin-appeal-unbans.js';
import { TelegramAdminSafetyMutationVault } from './admin-safety-mutation-vault.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';
import type { TelegramAdminSessionVerifier } from './admin-session.js';

class Harness {
  public now = new Date();
  public actor = { kind: 'admin' as const, userId: randomUUID() };
  public revoked = false;
  public rows = new Map<string, string>();
  public sessions = {
    current: vi.fn<TelegramAdminSessionVerifier['current']>().mockImplementation(() =>
      Promise.resolve(
        this.revoked
          ? undefined
          : {
              actor: this.actor,
              telegramUserId: '123',
              locale: 'en',
              expiresAt: new Date(this.now.getTime() + 300000),
              mfaExpiresAt: new Date(this.now.getTime() + 300000),
            },
      ),
    ),
  };
  public tokens: OpaqueTokenStore = {
    get: (key) => Promise.resolve(this.rows.get(key)),
    putIfAbsent: (key, value) => {
      const absent = !this.rows.has(key);
      if (absent) this.rows.set(key, value);
      return Promise.resolve(absent);
    },
  };
  public vault = new TelegramAdminSafetyMutationVault(
    'appeal-unban',
    this.tokens,
    new Uint8Array(32).fill(1),
    new Uint8Array(32).fill(2),
    () => this.now.getTime(),
  );
  public actions = vi.fn<PrepareAppealUnbanAccessHandler['execute']>().mockResolvedValue({
    adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    appealVersion: 1,
    accountVersion: 2,
  });
  public prepare = vi
    .fn<ConfirmedAppealCommands['prepare']>()
    .mockResolvedValue(`v1.cf.${'c'.repeat(16)}.${'d'.repeat(16)}`);
  public execute = vi.fn<ConfirmedAppealCommands['execute']>().mockImplementation(() =>
    Promise.resolve({
      logId: randomUUID(),
      result: 'succeeded',
      safeCode: 'support_replied',
      recordedAt: this.now,
      replayed: false,
      value: undefined,
    }),
  );
  public text = vi.fn<TelegramAdminTextDelivery['text']>().mockResolvedValue(undefined);
  public menu = vi.fn<TelegramAdminTextDelivery['appealUnbanMenu']>().mockResolvedValue(undefined);
  public adapter = new TelegramAdminAppealUnbans(
    this.sessions,
    { execute: this.actions },
    { prepare: this.prepare, execute: this.execute },
    this.vault,
    new Uint8Array(32).fill(2),
    { text: this.text, appealUnbanMenu: this.menu },
    { render: (_locale, intent) => intent.key },
    () => this.now,
  );
  public input = {
    choice: {
      kind: 'appeal' as const,
      targetId: randomUUID(),
      queueActionToken: `v1.ad.${'e'.repeat(16)}.${'f'.repeat(16)}`,
      expectedVersion: 1,
    },
    action: 'unban' as const,
    reason: '  Review selected request  ',
    operationId: 'operation',
    occurredAt: this.now.toISOString(),
  };
}
function callback(reference: string, code = 'h', sender = 123): unknown {
  return {
    update_id: 3,
    callback_query: {
      data: `m7${code}:${reference}`,
      from: { id: sender, is_bot: false },
      message: { chat: { type: 'private', id: sender } },
    },
  };
}
describe('separate native confirmed appeal unban UI', () => {
  it('prepares normalized exact payloads without execution and retries the saved command', async () => {
    const f = new Harness();
    const refs = await Promise.all(
      Array.from({ length: 10 }, () => f.adapter.prepare('123', f.input)),
    );
    expect(new Set(refs).size).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.actions).toHaveBeenCalledWith(
      expect.objectContaining({
        appealId: f.input.choice.targetId,
        expectedAppealVersion: 1,
      }),
      f.actor,
    );
    expect(f.prepare.mock.calls[0]![0].data).toMatchObject({
      reason: 'Review selected request',
      expectedAccountVersion: 2,
    });
    expect(f.prepare.mock.calls[0]![1]).toEqual(f.actor);
    expect(f.text).not.toHaveBeenCalled();
    expect(f.menu.mock.calls[0]![0].text).toContain('admin.appeal.unban_effect');
    expect(f.prepare.mock.calls[0]![0].data).toMatchObject({ expectedAccountVersion: 2 });
    expect(JSON.stringify(f.menu.mock.calls)).not.toContain(f.input.choice.targetId);
    const selected = await f.vault.resolve(f.actor, refs[0]!);
    await Promise.all(Array.from({ length: 10 }, () => f.adapter.handle(callback(refs[0]!))));
    expect(f.execute).toHaveBeenCalledTimes(10);
    for (const call of f.execute.mock.calls) expect(call).toEqual([selected!.command, f.actor]);
    await expect(f.adapter.handle(callback(refs[0]!, 'n'))).rejects.toMatchObject({
      code: 'version_conflict',
    });
  });
  it('cancels only owned drafts and never executes a cancelled action', async () => {
    const f = new Harness();
    const ref = await f.adapter.prepare('123', f.input);
    expect(f.text).not.toHaveBeenCalled();
    expect(f.prepare.mock.calls[0]![0].commandType).toBe('moderation.unban-appeal');
    await expect(f.adapter.handle(callback(ref, 'n', 124))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await f.adapter.handle(callback(ref, 'n'));
    await f.adapter.handle(callback(ref, 'n'));
    await expect(f.adapter.handle(callback(ref))).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('accepts the full reason limit and denies lost drafts or a revoked session before delivery', async () => {
    const f = new Harness();
    const ref = await f.adapter.prepare('123', { ...f.input, reason: '😀'.repeat(1024) });
    expect(f.menu.mock.calls[0]![0].text.length).toBeLessThanOrEqual(3500);
    f.rows.clear();
    await expect(f.adapter.handle(callback(ref))).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.execute).not.toHaveBeenCalled();
    const revoked = new Harness();
    revoked.prepare.mockImplementation(() => {
      revoked.revoked = true;
      return Promise.resolve(`v1.cf.${'c'.repeat(16)}.${'d'.repeat(16)}`);
    });
    await expect(revoked.adapter.prepare('123', revoked.input)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(revoked.menu).not.toHaveBeenCalled();
  });
  it('checks availability through native permission and never prepares a command for a denial', async () => {
    const f = new Harness();
    await expect(f.adapter.available('123', f.input.choice)).resolves.toBe(true);
    f.actions.mockRejectedValueOnce(new ApplicationError('forbidden', 'error.m7.unavailable', 403));
    await expect(f.adapter.available('123', f.input.choice)).resolves.toBe(false);
    f.actions.mockRejectedValueOnce(new Error('restricted provider diagnostics'));
    await expect(f.adapter.available('123', f.input.choice)).rejects.toMatchObject({
      message: 'error.m7.internal',
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('takes the account version only from native selection and rejects a changed retry', async () => {
    const f = new Harness();
    await f.adapter.prepare('123', {
      ...f.input,
      expectedAccountVersion: 999,
    } as unknown as Parameters<TelegramAdminAppealUnbans['prepare']>[1]);
    expect(f.prepare.mock.calls[0]![0].data).toMatchObject({ expectedAccountVersion: 2 });
    f.actions.mockResolvedValue({
      adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
      appealVersion: 1,
      accountVersion: 3,
    });
    await expect(f.adapter.prepare('123', f.input)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });
  it('rechecks the current session before native mutation and sanitizes unexpected failures', async () => {
    const f = new Harness();
    const ref = await f.adapter.prepare('123', f.input);
    f.revoked = true;
    await expect(f.adapter.handle(callback(ref))).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.execute).not.toHaveBeenCalled();
    f.revoked = false;
    f.execute.mockRejectedValue(new Error('restricted provider parameters'));
    await expect(f.adapter.handle(callback(ref))).rejects.toMatchObject({
      message: 'error.m7.internal',
    });
    expect(JSON.stringify(f.menu.mock.calls)).not.toContain('restricted provider');
    await expect(f.adapter.handle(callback('malformed'))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(f.adapter.handle(callback(ref, 's'))).resolves.toBe('unhandled');
  });
});
