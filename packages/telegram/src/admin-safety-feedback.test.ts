import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { OpaqueTokenStore } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { TelegramAdminEvidenceDelivery } from './admin-evidence-adapter.js';
import type { TelegramAdminSessionVerifier } from './admin-session.js';
import {
  TelegramAdminSafetyFeedback,
  type TelegramAdminSafetyHandler,
} from './admin-safety-feedback.js';

const update = {
  update_id: 5,
  callback_query: {
    data: `m7q:${'a'.repeat(22)}`,
    from: { id: 123, is_bot: false },
    message: { chat: { id: 123, type: 'private' } },
  },
};
class Harness {
  public now = new Date();
  public actor = { kind: 'admin' as const, userId: randomUUID() };
  public revoked = false;
  public cacheFailed = false;
  public rotateOnClaim = false;
  public rows = new Map<string, { value: string; expiresAt: number }>();
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
  public native = vi
    .fn<TelegramAdminSafetyHandler['handle']>()
    .mockRejectedValue(
      new ApplicationError('admin_reason_invalid', 'private exception prose', 400),
    );
  public text = vi.fn<TelegramAdminEvidenceDelivery['text']>().mockResolvedValue(undefined);
  public feedback: TelegramAdminSafetyFeedback;
  public constructor() {
    const tokens: OpaqueTokenStore = {
      get: (id) => {
        if (this.cacheFailed) return Promise.reject(new Error('private cache diagnostics'));
        const row = this.rows.get(id);
        return Promise.resolve(
          row !== undefined && row.expiresAt > this.now.getTime() ? row.value : undefined,
        );
      },
      putIfAbsent: (id, value, ttl) => {
        if (this.cacheFailed) return Promise.reject(new Error('private cache diagnostics'));
        const row = this.rows.get(id);
        if (row !== undefined && row.expiresAt > this.now.getTime()) return Promise.resolve(false);
        this.rows.set(id, { value, expiresAt: this.now.getTime() + ttl * 1000 });
        if (this.rotateOnClaim && value === 'pending')
          this.actor = { kind: 'admin', userId: randomUUID() };
        return Promise.resolve(true);
      },
    };
    this.feedback = new TelegramAdminSafetyFeedback(
      '99',
      this.sessions,
      [{ handle: this.native }],
      tokens,
      new Uint8Array(32).fill(5),
      { text: this.text },
      { render: (_locale, intent) => intent.key },
      () => this.now,
    );
  }
}

describe('current-session admin rejection feedback and acknowledgement', () => {
  it('acknowledges expected errors with fixed protected localized prose and keeps native execution before deduplication', async () => {
    const f = new Harness();
    await expect(f.feedback.handle(update)).resolves.toBe('notice');
    await expect(f.feedback.handle(update)).resolves.toBe('notice');
    expect(f.native).toHaveBeenCalledTimes(2);
    expect(f.text).toHaveBeenCalledTimes(1);
    expect(f.text).toHaveBeenCalledWith({
      recipient: '123',
      text: 'error.admin.reason_invalid',
      disableLinkPreviews: true,
    });
    expect([...f.rows.values()].map((row) => row.value)).toEqual(['pending', 'delivered']);
    const cache = JSON.stringify([...f.rows]);
    expect(cache).not.toContain('private exception prose');
    expect(cache).not.toContain(f.actor.userId);
    expect(cache).not.toContain(update.callback_query.data);
    f.native.mockResolvedValueOnce('notice');
    await expect(f.feedback.handle(update)).resolves.toBe('notice');
    expect(f.native).toHaveBeenCalledTimes(3);
  });
  it('converges concurrent rejected retries to one notice and acknowledges duplicates after successful delivery', async () => {
    const f = new Harness();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => f.feedback.handle(update)),
    );
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'internal_error' });
    expect(f.text).toHaveBeenCalledTimes(1);
    await Promise.all(Array.from({ length: 20 }, () => f.feedback.handle(update)));
    expect(f.native).toHaveBeenCalledTimes(40);
    expect(f.text).toHaveBeenCalledTimes(1);
  });
  it('does not falsely acknowledge pending or ambiguous failed delivery and permits a bounded retry after its claim expires', async () => {
    const f = new Harness();
    f.text.mockRejectedValueOnce(new Error('private provider diagnostics'));
    await expect(f.feedback.handle(update)).rejects.toMatchObject({
      code: 'internal_error',
      message: 'error.m7.internal',
    });
    await expect(f.feedback.handle(update)).rejects.toMatchObject({ code: 'internal_error' });
    expect(f.text).toHaveBeenCalledTimes(1);
    expect([...f.rows.values()].some((row) => row.value === 'delivered')).toBe(false);
    f.now = new Date(f.now.getTime() + 31000);
    await expect(f.feedback.handle(update)).resolves.toBe('notice');
    expect(f.text).toHaveBeenCalledTimes(2);
  });
  it('acknowledges malformed private/group callbacks or expired sessions without a recipient or native execution', async () => {
    const f = new Harness();
    await expect(
      f.feedback.handle({
        ...update,
        callback_query: { ...update.callback_query, message: { chat: { id: -1, type: 'group' } } },
      }),
    ).resolves.toBe('notice');
    f.revoked = true;
    await expect(f.feedback.handle(update)).resolves.toBe('notice');
    expect(f.native).not.toHaveBeenCalled();
    expect(f.text).not.toHaveBeenCalled();
  });
  it('stops feedback after session revocation or actor rotation during execution and before delivery', async () => {
    const f = new Harness();
    f.native.mockImplementationOnce(() => {
      f.revoked = true;
      return Promise.reject(new ApplicationError('forbidden', 'private exception', 403));
    });
    await expect(f.feedback.handle(update)).resolves.toBe('notice');
    expect(f.text).not.toHaveBeenCalled();
    f.revoked = false;
    f.rotateOnClaim = true;
    await expect(f.feedback.handle(update)).resolves.toBe('notice');
    expect(f.text).not.toHaveBeenCalled();
  });
  it('preserves unexpected execution, cache and session failures as sanitized failures', async () => {
    const f = new Harness();
    f.native.mockRejectedValueOnce(new Error('private native diagnostics'));
    await expect(f.feedback.handle(update)).rejects.toMatchObject({ message: 'error.m7.internal' });
    f.cacheFailed = true;
    await expect(f.feedback.handle(update)).rejects.toMatchObject({ message: 'error.m7.internal' });
    f.sessions.current.mockRejectedValueOnce(new Error('private verifier diagnostics'));
    await expect(f.feedback.handle(update)).rejects.toMatchObject({ message: 'error.m7.internal' });
    expect(f.text).not.toHaveBeenCalled();
  });
  it('leaves ordinary user updates and unrelated bot replies available to other flows', async () => {
    const f = new Harness();
    await expect(
      f.feedback.handle({ update_id: 5, message: { text: '/support ordinary request' } }),
    ).resolves.toBe('unhandled');
    f.revoked = true;
    await expect(
      f.feedback.handle({
        update_id: 5,
        message: {
          date: 1000,
          from: { id: 123, is_bot: false },
          chat: { id: 123, type: 'private' },
          reply_to_message: { from: { id: 99, is_bot: true } },
        },
      }),
    ).resolves.toBe('unhandled');
    expect(f.native).not.toHaveBeenCalled();
    expect(f.text).not.toHaveBeenCalled();
  });
});
