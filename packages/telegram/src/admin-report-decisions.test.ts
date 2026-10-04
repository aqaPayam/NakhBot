import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConfirmedReviewDecisions,
  OpaqueTokenStore,
  PrepareSelectedReportReviewHandler,
} from '@nakh/application';
import { TelegramAdminReportDecisions } from './admin-report-decisions.js';
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
    'report-decision',
    this.tokens,
    new Uint8Array(32).fill(1),
    new Uint8Array(32).fill(2),
    () => this.now.getTime(),
  );
  public actions = vi.fn<PrepareSelectedReportReviewHandler['execute']>().mockResolvedValue({
    adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    reviewId: randomUUID(),
    reviewVersion: 2,
    assigneeAdminId: randomUUID(),
  });
  public prepare = vi
    .fn<ConfirmedReviewDecisions['prepare']>()
    .mockResolvedValue(`v1.cf.${'c'.repeat(16)}.${'d'.repeat(16)}`);
  public execute = vi.fn<ConfirmedReviewDecisions['execute']>().mockImplementation(() =>
    Promise.resolve({
      logId: randomUUID(),
      result: 'succeeded',
      safeCode: 'review_decided',
      recordedAt: this.now,
      replayed: false,
      value: undefined,
    }),
  );
  public text = vi.fn<TelegramAdminTextDelivery['text']>().mockResolvedValue(undefined);
  public menu = vi
    .fn<TelegramAdminTextDelivery['reportDecisionMenu']>()
    .mockResolvedValue(undefined);
  public adapter = new TelegramAdminReportDecisions(
    this.sessions,
    { execute: this.actions },
    { prepare: this.prepare, execute: this.execute },
    this.vault,
    new Uint8Array(32).fill(2),
    { text: this.text, reportDecisionMenu: this.menu },
    { render: (_locale, intent) => intent.key },
    () => this.now,
  );
  public input = {
    choice: {
      kind: 'report' as const,
      targetId: randomUUID(),
      queueActionToken: `v1.ad.${'e'.repeat(16)}.${'f'.repeat(16)}`,
      expectedVersion: 1,
    },
    action: 'dismissed' as const,
    note: '  Private decision note  ',
    reason: '  Review selected request  ',
    operationId: 'operation',
    occurredAt: this.now.toISOString(),
  };
}
function callback(reference: string, code = 'G', sender = 123): unknown {
  return {
    update_id: 3,
    callback_query: {
      data: `m7${code}:${reference}`,
      from: { id: sender, is_bot: false },
      message: { chat: { type: 'private', id: sender } },
    },
  };
}
describe('separately confirmed assigned-review decisions', () => {
  it('converges concurrent native preparation, derives review version and preserves decision/note and retries the saved confirmed command', async () => {
    const f = new Harness();
    const refs = await Promise.all(
      Array.from({ length: 20 }, () => f.adapter.prepare('123', f.input)),
    );
    expect(new Set(refs).size).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.actions.mock.calls[0]![0]).toMatchObject({
      reportId: f.input.choice.targetId,
      expectedReportVersion: 1,
      action: 'dismissed',
    });
    const target = await f.actions(f.actions.mock.calls[0]![0], f.actor);
    expect(f.prepare.mock.calls[0]![0].data).toMatchObject({
      reason: 'Review selected request',
      expectedTargetVersion: 2,
      decision: 'dismissed',
      note: 'Private decision note',
    });
    expect(f.menu.mock.calls[0]![0].text).toContain('admin.report.decision_effect');
    const raw = JSON.stringify([...f.rows.values()]);
    for (const secret of [
      f.input.choice.targetId,
      f.actor.userId,
      target.assigneeAdminId,
      'Review selected request',
      'Private decision note',
    ])
      expect(raw).not.toContain(secret);
    const selected = await f.vault.resolve(f.actor, refs[0]!);
    await Promise.all(Array.from({ length: 20 }, () => f.adapter.handle(callback(refs[0]!))));
    expect(f.execute).toHaveBeenCalledTimes(20);
    for (const call of f.execute.mock.calls) expect(call).toEqual([selected!.command, f.actor]);
    await expect(f.adapter.handle(callback(refs[0]!, 'Z'))).rejects.toMatchObject({
      code: 'version_conflict',
    });
  });
  it('denies changed review/note/reason retries, cross-purpose state and mixed confirm/cancel winners', async () => {
    const f = new Harness(),
      ref = await f.adapter.prepare('123', f.input),
      selected = (await f.vault.resolve(f.actor, ref))!;
    await expect(
      f.adapter.prepare('123', { ...f.input, reason: 'Changed reason' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      f.adapter.prepare('123', { ...f.input, note: 'Changed note' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const target = await f.actions(f.actions.mock.calls[0]![0], f.actor);
    f.actions.mockResolvedValueOnce({ ...target, reviewVersion: 3 });
    await expect(f.adapter.prepare('123', f.input)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    f.actions.mockResolvedValueOnce({ ...target, reviewId: randomUUID() });
    await expect(f.adapter.prepare('123', f.input)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    for (const purpose of [
      'support',
      'appeal-review',
      'appeal-unban',
      'report-assignment',
    ] as const) {
      const vault = new TelegramAdminSafetyMutationVault(
        purpose,
        f.tokens,
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
      f.rows.set(
        `telegram-admin-${purpose}-mutation:${ref}`,
        f.rows.get(`telegram-admin-report-decision-mutation:${ref}`)!,
      );
      await expect(vault.resolve(f.actor, ref)).resolves.toBeUndefined();
    }
    await expect(
      f.vault.retainPrepared(
        f.actor,
        {
          ...selected,
          command: {
            ...selected.command,
            data: { ...selected.command.data, ...{ text: 'Forbidden content' } },
          },
        },
        'extra',
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        f.vault.decide(f.actor, ref, index % 2 ? 'confirm' : 'cancel'),
      ),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(10);
  });
  it('binds private sessions, cancels without executing and fails closed on expiry/cache loss', async () => {
    const f = new Harness(),
      ref = await f.adapter.prepare('123', { ...f.input, reason: '😀'.repeat(1024) });
    expect(f.menu.mock.calls[0]![0].text.length).toBeLessThanOrEqual(3500);
    await expect(f.adapter.handle(callback(ref, 'G', 124))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await f.adapter.handle(callback(ref, 'Z'));
    await expect(f.adapter.handle(callback(ref))).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect(f.execute).not.toHaveBeenCalled();
    const other = new Harness(),
      second = await other.adapter.prepare('123', other.input);
    other.now = new Date(other.now.getTime() + 300000);
    await expect(other.adapter.handle(callback(second))).rejects.toMatchObject({
      code: 'forbidden',
    });
    const lost = new Harness(),
      third = await lost.adapter.prepare('123', lost.input);
    lost.rows.clear();
    await expect(lost.adapter.handle(callback(third))).rejects.toMatchObject({ code: 'forbidden' });
    expect(lost.execute).not.toHaveBeenCalled();
  });
  it('rechecks session before preview and confirmation and sanitizes native/provider failures', async () => {
    const f = new Harness();
    f.prepare.mockImplementation(() => {
      f.revoked = true;
      return Promise.resolve(`v1.cf.${'c'.repeat(16)}.${'d'.repeat(16)}`);
    });
    await expect(f.adapter.prepare('123', f.input)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.menu).not.toHaveBeenCalled();
    const other = new Harness(),
      ref = await other.adapter.prepare('123', other.input);
    other.revoked = true;
    await expect(other.adapter.handle(callback(ref))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(other.execute).not.toHaveBeenCalled();
    other.revoked = false;
    other.execute.mockRejectedValue(new Error('private credentials/prose'));
    await expect(other.adapter.handle(callback(ref))).rejects.toMatchObject({
      message: 'error.m7.internal',
    });
    await expect(other.adapter.handle(callback(ref, 'h'))).resolves.toBe('unhandled');
    await expect(other.adapter.handle(callback('malformed'))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
