import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConfirmedAppealCommands,
  OpaqueTokenStore,
  PrepareAppealReviewAccessHandler,
} from '@nakh/application';
import { TelegramAdminAppealReviews } from './admin-appeal-reviews.js';
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
    'appeal-review',
    this.tokens,
    new Uint8Array(32).fill(1),
    new Uint8Array(32).fill(2),
    () => this.now.getTime(),
  );
  public actions = vi.fn<PrepareAppealReviewAccessHandler['execute']>().mockResolvedValue({
    adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    appealVersion: 1,
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
  public menu = vi.fn<TelegramAdminTextDelivery['appealReviewMenu']>().mockResolvedValue(undefined);
  public adapter = new TelegramAdminAppealReviews(
    this.sessions,
    { execute: this.actions },
    { prepare: this.prepare, execute: this.execute },
    this.vault,
    new Uint8Array(32).fill(2),
    { text: this.text, appealReviewMenu: this.menu },
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
    action: 'accepted' as 'accepted' | 'rejected',
    reason: '  Review selected request  ',
    note: '  We can help.  ',
    operationId: 'operation',
    occurredAt: this.now.toISOString(),
  };
}
function callback(reference: string, code = 'd', sender = 123): unknown {
  return {
    update_id: 3,
    callback_query: {
      data: `m7${code}:${reference}`,
      from: { id: sender, is_bot: false },
      message: { chat: { type: 'private', id: sender } },
    },
  };
}
describe('native confirmed appeal review UI', () => {
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
        action: 'review',
      }),
      f.actor,
    );
    expect(f.prepare.mock.calls[0]![0].data).toMatchObject({
      reason: 'Review selected request',
      note: 'We can help.',
    });
    expect(f.prepare.mock.calls[0]![1]).toEqual(f.actor);
    expect(f.text.mock.calls[0]![0].text).toContain('We can help.');
    expect(f.menu.mock.calls[0]![0].text).toContain('admin.appeal.ban_remains');
    expect(f.prepare.mock.calls[0]![0].data).toMatchObject({ decision: 'accepted' });
    expect(JSON.stringify(f.menu.mock.calls)).not.toContain(f.input.choice.targetId);
    const selected = await f.vault.resolve(f.actor, refs[0]!);
    await Promise.all(Array.from({ length: 10 }, () => f.adapter.handle(callback(refs[0]!))));
    expect(f.execute).toHaveBeenCalledTimes(10);
    for (const call of f.execute.mock.calls) expect(call).toEqual([selected!.command, f.actor]);
    await expect(f.adapter.handle(callback(refs[0]!, 'z'))).rejects.toMatchObject({
      code: 'version_conflict',
    });
  });
  it('cancels only owned drafts and never executes a cancelled action', async () => {
    const f = new Harness();
    const { note, ...close } = f.input;
    void note;
    const ref = await f.adapter.prepare('123', { ...close, action: 'rejected' });
    expect(f.text).not.toHaveBeenCalled();
    expect(f.prepare.mock.calls[0]![0].commandType).toBe('moderation.review-appeal');
    await expect(f.adapter.handle(callback(ref, 'z', 124))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await f.adapter.handle(callback(ref, 'z'));
    await f.adapter.handle(callback(ref, 'z'));
    await expect(f.adapter.handle(callback(ref))).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('chunks the full emoji note and stops presentation when session or pending draft disappears', async () => {
    const f = new Harness();
    await f.adapter.prepare('123', {
      ...f.input,
      reason: '😀'.repeat(1024),
      note: '😀'.repeat(2000),
    });
    expect(f.text).toHaveBeenCalledTimes(2);
    for (const call of f.text.mock.calls) expect(call[0].text.length).toBeLessThanOrEqual(3500);
    const lost = new Harness();
    lost.text.mockImplementation(() => {
      lost.rows.clear();
      return Promise.resolve();
    });
    await expect(lost.adapter.prepare('123', lost.input)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect(lost.menu).not.toHaveBeenCalled();
    const revoked = new Harness();
    revoked.text.mockImplementation(() => {
      revoked.revoked = true;
      return Promise.resolve();
    });
    await expect(revoked.adapter.prepare('123', revoked.input)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(revoked.menu).not.toHaveBeenCalled();
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
    expect(f.text.mock.calls.at(-1)![0].text).not.toContain('restricted provider');
    await expect(f.adapter.handle(callback('malformed'))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(f.adapter.handle(callback(ref, 's'))).resolves.toBe('unhandled');
  });
});
