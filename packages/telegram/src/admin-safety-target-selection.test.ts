import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  OpaqueTokenStore,
  PrepareSupportActionHandler,
  PrepareAppealReviewAccessHandler,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { TelegramAdminSafetyReadPreparation } from './admin-safety-read-preparation.js';
import {
  TelegramAdminSafetyTargetSelection,
  type TelegramSafetyTargetSelection,
} from './admin-safety-target-selection.js';

function fixture(): Readonly<{
  selection: TelegramAdminSafetyTargetSelection;
  selected: TelegramSafetyTargetSelection;
  values: Map<string, string>;
  support: ReturnType<typeof vi.fn<PrepareSupportActionHandler['execute']>>;
  appeals: ReturnType<typeof vi.fn<PrepareAppealReviewAccessHandler['execute']>>;
  prepare: ReturnType<typeof vi.fn<TelegramAdminSafetyReadPreparation['prepare']>>;
  actor: { kind: 'admin'; userId: string };
  expire: () => void;
  revoke: () => void;
}> {
  let now = new Date();
  const actor = { kind: 'admin' as const, userId: randomUUID() };
  let active = true;
  const sessions = {
    current: () =>
      Promise.resolve(
        active
          ? {
              actor,
              telegramUserId: '123',
              locale: 'en',
              expiresAt: new Date(now.getTime() + 300000),
              mfaExpiresAt: new Date(now.getTime() + 300000),
            }
          : undefined,
      ),
  };
  const values = new Map<string, string>();
  const tokens: OpaqueTokenStore = {
    get: (id) => Promise.resolve(values.get(id)),
    putIfAbsent: (id, value) => {
      if (values.has(id)) return Promise.resolve(false);
      values.set(id, value);
      return Promise.resolve(true);
    },
  };
  const token = (): string => `v1.ad.${randomBytes(12).toString('base64url')}.${'a'.repeat(16)}`;
  const support = vi
    .fn<PrepareSupportActionHandler['execute']>()
    .mockImplementation((query) =>
      Promise.resolve({ adminActionToken: token(), threadVersion: query.expectedThreadVersion }),
    );
  const appeals = vi
    .fn<PrepareAppealReviewAccessHandler['execute']>()
    .mockImplementation((query) =>
      Promise.resolve({ adminActionToken: token(), appealVersion: query.expectedAppealVersion }),
    );
  const prepare = vi
    .fn<TelegramAdminSafetyReadPreparation['prepare']>()
    .mockResolvedValue('opaque');
  const selection = new TelegramAdminSafetyTargetSelection(
    sessions,
    { execute: support },
    { execute: appeals },
    tokens,
    new Uint8Array(32).fill(3),
    { prepare },
    () => now,
  );
  const selected: TelegramSafetyTargetSelection = {
    kind: 'support',
    queueActionToken: token(),
    targetId: randomUUID(),
    expectedVersion: 1,
    reason: 'review selected request',
    operationId: 'bot:123:update:5',
    occurredAt: now.toISOString(),
  };
  return {
    selection,
    selected,
    values,
    support,
    appeals,
    prepare,
    actor,
    expire: () => {
      now = new Date(now.getTime() + 300000);
    },
    revoke: () => {
      active = false;
    },
  };
}

describe('trusted Telegram admin target selection', () => {
  it.each(['support', 'appeal'] as const)(
    'converges %s native action races to an identical read draft without caching prose',
    async (kind) => {
      const f = fixture(),
        selected = { ...f.selected, kind };
      await Promise.all(Array.from({ length: 20 }, () => f.selection.select('123', selected)));
      expect(f.prepare).toHaveBeenCalledTimes(20);
      const first = f.prepare.mock.calls[0]!;
      for (const call of f.prepare.mock.calls) expect(call).toEqual(first);
      expect(first[1].command.actor).toEqual(f.actor);
      expect(first[1].command.commandId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(first[1].command.data.reason).toBe(selected.reason);
      expect(first[1].command.commandType).toBe(
        kind === 'support' ? 'support.reveal-thread' : 'moderation.reveal-appeal',
      );
      expect(kind === 'support' ? f.appeals : f.support).not.toHaveBeenCalled();
      expect(f.values.size).toBe(1);
      expect([...f.values.values()].join('')).not.toContain(selected.reason);
      expect([...f.values.values()].join('')).not.toContain(selected.targetId);
      const firstStored = [...f.values.entries()];
      await expect(
        f.selection.select('123', { ...selected, reason: 'changed reason' }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      expect([...f.values.entries()]).toEqual(firstStored);
      expect(f.prepare).toHaveBeenCalledTimes(20);
    },
  );
  it('never treats cached selection as current permission or extends its native/UI lifetime', async () => {
    const f = fixture();
    await f.selection.select('123', f.selected);
    f.support.mockRejectedValueOnce(new ApplicationError('forbidden', 'error.m7.unavailable', 403));
    await expect(f.selection.select('123', f.selected)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    f.expire();
    await expect(f.selection.select('123', f.selected)).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    f.revoke();
    await expect(f.selection.select('123', f.selected)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
  it('denies another Telegram identity and malformed selection before presenting any menu', async () => {
    const f = fixture();
    await expect(f.selection.select('456', f.selected)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(
      f.selection.select('123', { ...f.selected, targetId: 'invalid' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.support).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rejects every changed request binding while preserving the first action and deadline', async () => {
    const f = fixture();
    await f.selection.select('123', f.selected);
    const firstStored = [...f.values.entries()];
    for (const change of [
      { targetId: randomUUID() },
      { expectedVersion: 2 },
      { kind: 'appeal' as const },
      { occurredAt: new Date(Date.parse(f.selected.occurredAt) + 1000).toISOString() },
      { queueActionToken: `v1.ad.${'b'.repeat(16)}.${'c'.repeat(16)}` },
    ]) {
      await expect(f.selection.select('123', { ...f.selected, ...change })).rejects.toMatchObject({
        code: 'idempotency_conflict',
      });
      expect([...f.values.entries()]).toEqual(firstStored);
    }
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it('sanitizes native or cache failures and stops on session revocation during native selection', async () => {
    const f = fixture();
    f.support.mockRejectedValueOnce(new Error('private diagnostics'));
    await expect(f.selection.select('123', f.selected)).rejects.toMatchObject({
      code: 'internal_error',
      message: 'error.m7.internal',
    });
    f.support.mockImplementationOnce((query) => {
      f.revoke();
      return Promise.resolve({
        adminActionToken: f.selected.queueActionToken,
        threadVersion: query.expectedThreadVersion,
      });
    });
    await expect(f.selection.select('123', f.selected)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(f.prepare).not.toHaveBeenCalled();
  });
});
