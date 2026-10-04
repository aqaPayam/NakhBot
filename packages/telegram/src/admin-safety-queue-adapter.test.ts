import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  OpaqueTokenStore,
  GetSafetyQueueActionsHandler,
  GetSupportMetadataHandler,
  GetAppealMetadataHandler,
  PrepareSupportActionHandler,
  PrepareAppealReviewAccessHandler,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { TelegramAdminAppealReviews } from './admin-appeal-reviews.js';
import type { TelegramAdminSupportMutations } from './admin-support-mutations.js';
import { TelegramAdminSafetyQueueAdapter } from './admin-safety-queue-adapter.js';
import { TelegramAdminSafetyQueueState } from './admin-safety-queue-state.js';
import type { TelegramAdminSafetyTargetSelection } from './admin-safety-target-selection.js';
import type { TelegramAdminQueueDelivery } from './admin-safety-queue-menu.js';
import type { TelegramAdminSessionVerifier } from './admin-session.js';

function message(text: string, updateId = 1): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      text,
      date: 1000,
      from: { id: 123, is_bot: false },
      chat: { id: 123, type: 'private' },
    },
  };
}
function callback(data: string, updateId = 2): Record<string, unknown> {
  return {
    update_id: updateId,
    callback_query: {
      data,
      from: { id: 123, is_bot: false },
      message: { chat: { id: 123, type: 'private' } },
    },
  };
}
function reply(text: string, promptId = 77, botId = 99): Record<string, unknown> {
  return {
    update_id: 3,
    message: {
      text,
      date: 1001,
      from: { id: 123, is_bot: false },
      chat: { id: 123, type: 'private' },
      reply_to_message: { message_id: promptId, from: { id: botId, is_bot: true } },
    },
  };
}
class Harness {
  public now = new Date();
  public revoked = false;
  public actor = { kind: 'admin' as const, userId: randomUUID() };
  public targetId = randomUUID();
  public values = new Map<string, string>();
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
  public queues = vi
    .fn<GetSafetyQueueActionsHandler['execute']>()
    .mockResolvedValue({ adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}` });
  public support = vi.fn<GetSupportMetadataHandler['execute']>().mockResolvedValue({
    items: [
      {
        threadId: this.targetId,
        status: 'open',
        version: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastMessageAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    nextCursor: `v1.sq.${'a'.repeat(16)}.${'b'.repeat(16)}`,
  });
  public appeals = vi.fn<GetAppealMetadataHandler['execute']>().mockResolvedValue({
    items: [
      {
        appealId: this.targetId,
        status: 'submitted',
        version: 2,
        submittedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  public supportActions = vi.fn<PrepareSupportActionHandler['execute']>().mockResolvedValue({
    adminActionToken: `v1.ad.${'c'.repeat(16)}.${'d'.repeat(16)}`,
    threadVersion: 2,
  });
  public appealActions = vi.fn<PrepareAppealReviewAccessHandler['execute']>().mockResolvedValue({
    adminActionToken: `v1.ad.${'c'.repeat(16)}.${'d'.repeat(16)}`,
    appealVersion: 2,
  });
  public select = vi
    .fn<TelegramAdminSafetyTargetSelection['select']>()
    .mockResolvedValue('confirmed');
  public queueMenu = vi.fn<TelegramAdminQueueDelivery['queueMenu']>().mockResolvedValue(undefined);
  public reasonPrompt = vi.fn<TelegramAdminQueueDelivery['reasonPrompt']>().mockResolvedValue(77);
  public text = vi
    .fn<
      (
        input: Readonly<{ recipient: string; text: string; disableLinkPreviews: true }>,
      ) => Promise<void>
    >()
    .mockResolvedValue(undefined);
  public state: TelegramAdminSafetyQueueState;
  public adapter: TelegramAdminSafetyQueueAdapter;
  public mutation = vi
    .fn<TelegramAdminSupportMutations['prepare']>()
    .mockResolvedValue('a'.repeat(22));
  public review = vi.fn<TelegramAdminAppealReviews['prepare']>().mockResolvedValue('b'.repeat(22));
  public constructor(mutations = false, reviews = false) {
    const tokens: OpaqueTokenStore = {
      get: (id) => Promise.resolve(this.values.get(id)),
      putIfAbsent: (id, value) => {
        if (this.values.has(id)) return Promise.resolve(false);
        this.values.set(id, value);
        return Promise.resolve(true);
      },
    };
    this.state = new TelegramAdminSafetyQueueState(
      tokens,
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      () => this.now.getTime(),
    );
    this.adapter = new TelegramAdminSafetyQueueAdapter(
      '99',
      this.sessions,
      { execute: this.queues },
      { execute: this.support },
      { execute: this.appeals },
      { execute: this.supportActions },
      { execute: this.appealActions },
      this.state,
      { select: this.select },
      { queueMenu: this.queueMenu, reasonPrompt: this.reasonPrompt, text: this.text },
      {
        render: (_locale, intent) =>
          intent.key === 'admin.queue.status.open' ? 'Open' : intent.key,
      },
      () => this.now,
      mutations ? { prepare: this.mutation } : undefined,
      reviews ? { prepare: this.review } : undefined,
    );
  }
}
describe('private Telegram admin metadata picker and exact-prompt reason entry', () => {
  it.each(['support', 'appeals'] as const)(
    'prepares %s only after choosing an opaque target and replying to its exact prompt',
    async (queue) => {
      const f = new Harness();
      await expect(f.adapter.handle(message(`/admin_${queue}`))).resolves.toBe('notice');
      const menu = f.queueMenu.mock.calls[0]![0];
      expect(JSON.stringify(menu)).not.toContain(f.targetId);
      expect(JSON.stringify(menu)).not.toContain(f.actor.userId);
      expect(JSON.stringify(menu)).not.toContain('v1.ad.');
      expect(f.select).not.toHaveBeenCalled();
      expect(f.reasonPrompt).not.toHaveBeenCalled();
      await f.adapter.handle(callback(menu.replyMarkup.inline_keyboard[0]![0].callback_data));
      expect(queue === 'support' ? f.supportActions : f.appealActions).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'reveal' }),
        f.actor,
      );
      expect(f.reasonPrompt).toHaveBeenCalledTimes(1);
      expect(f.select).not.toHaveBeenCalled();
      await expect(f.adapter.handle(reply('wrong prompt', 78))).resolves.toBe('unhandled');
      await expect(f.adapter.handle(reply('wrong bot', 77, 100))).rejects.toMatchObject({
        code: 'invalid_request',
      });
      await Promise.all(
        Array.from({ length: 10 }, () => f.adapter.handle(reply('review selected request'))),
      );
      expect(f.select).toHaveBeenCalledTimes(10);
      const first = f.select.mock.calls[0]!;
      for (const call of f.select.mock.calls) expect(call).toEqual(first);
      expect(first).toEqual([
        '123',
        expect.objectContaining({
          targetId: f.targetId,
          expectedVersion: 2,
          kind: queue === 'support' ? 'support' : 'appeal',
          reason: 'review selected request',
          operationId: 'bot:99:update:3',
          occurredAt: '1970-01-01T00:16:41.000Z',
        }),
      ]);
      expect([...f.values.values()].join('')).not.toContain('review selected request');
    },
  );
  it('recovers one opaque picker under concurrent retries and paginates through native metadata without prose', async () => {
    const f = new Harness();
    await Promise.all(
      Array.from({ length: 20 }, () => f.adapter.handle(message('/admin_support'))),
    );
    const first = f.queueMenu.mock.calls[0]![0];
    for (const [menu] of f.queueMenu.mock.calls) expect(menu).toEqual(first);
    f.support.mockResolvedValueOnce({ items: [] });
    await f.adapter.handle(callback(first.replyMarkup.inline_keyboard[1]![0].callback_data));
    expect(f.support.mock.calls.at(-1)![0]).toMatchObject({
      limit: 10,
      cursor: `v1.sq.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    });
    expect(f.text).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'admin.queue.support_title\nadmin.queue.empty' }),
    );
    expect(f.select).not.toHaveBeenCalled();
  });
  it('checks revoked native permission before prompting and expires reason correlations on cache TTL failure', async () => {
    const f = new Harness();
    await f.adapter.handle(message('/admin_support'));
    const button = f.queueMenu.mock.calls[0]![0].replyMarkup.inline_keyboard[0]![0];
    f.supportActions.mockRejectedValueOnce(
      new ApplicationError('forbidden', 'error.m7.unavailable', 403),
    );
    await expect(f.adapter.handle(callback(button.callback_data))).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(f.reasonPrompt).not.toHaveBeenCalled();
    await f.adapter.handle(callback(button.callback_data));
    f.now = new Date(f.now.getTime() + 300000);
    await expect(f.adapter.handle(reply('expired selection'))).resolves.toBe('unhandled');
    expect(f.select).not.toHaveBeenCalled();
  });
  it('stops on session revocation between native metadata and delivery and leaves unrelated replies alone', async () => {
    const f = new Harness();
    f.support.mockImplementationOnce(() => {
      f.revoked = true;
      return Promise.resolve({ items: [] });
    });
    await expect(f.adapter.handle(message('/admin_support'))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(f.queueMenu).not.toHaveBeenCalled();
    expect(f.text).not.toHaveBeenCalled();
    await expect(f.adapter.handle(reply('ordinary reply'))).resolves.toBe('unhandled');
    await expect(
      f.adapter.handle({
        update_id: 3,
        message: { reply_to_message: {}, chat: { type: 'group' } },
      }),
    ).resolves.toBe('unhandled');
  });
  it('offers support actions, binds exact prompt action, and routes reply text separately from its reason', async () => {
    const f = new Harness(true);
    await f.adapter.handle(message('/admin_support'));
    const choice = f.queueMenu.mock.calls[0]![0].replyMarkup.inline_keyboard[0]![0].callback_data;
    await f.adapter.handle(callback(choice));
    expect(f.reasonPrompt).not.toHaveBeenCalled();
    expect(
      f.queueMenu.mock.calls[1]![0].replyMarkup.inline_keyboard.map((row) => row[0].callback_data),
    ).toEqual(['v', 'j', 'k'].map((code) => choice.replace('m7q:', `m7${code}:`)));
    await f.adapter.handle(callback(choice.replace('m7q:', 'm7j:')));
    expect(f.supportActions.mock.calls.at(-1)![0].action).toBe('reply');
    await f.adapter.handle(reply('Review reason\nPrivate reply\nsecond line'));
    expect(f.mutation).toHaveBeenCalledWith(
      '123',
      expect.objectContaining({
        action: 'reply',
        reason: 'Review reason',
        text: 'Private reply\nsecond line',
      }),
    );
    expect(f.mutation.mock.calls[0]![1].choice.targetId).toBe(f.targetId);
    expect(f.select).not.toHaveBeenCalled();
    await expect(f.adapter.handle(callback(choice.replace('m7q:', 'm7k:')))).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect([...f.values.values()].join('')).not.toContain('Private reply');
  });
  it('offers closed support threads only a read action while native selection still owns status checks', async () => {
    const f = new Harness(true);
    f.support.mockResolvedValueOnce({
      items: [
        {
          threadId: f.targetId,
          status: 'closed',
          version: 2,
          createdAt: '2026-01-01T00:00:00Z',
          lastMessageAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    await f.adapter.handle(message('/admin_support closed'));
    const choice = f.queueMenu.mock.calls[0]![0].replyMarkup.inline_keyboard[0]![0].callback_data;
    await f.adapter.handle(callback(choice));
    expect(f.queueMenu.mock.calls[1]![0].replyMarkup.inline_keyboard).toHaveLength(1);
    expect(f.queueMenu.mock.calls[1]![0].replyMarkup.inline_keyboard[0]![0].callback_data).toBe(
      choice.replace('m7q:', 'm7v:'),
    );
  });
  it('binds an appeal decision to the exact prompt and isolates it from support actions', async () => {
    const f = new Harness(false, true);
    await f.adapter.handle(message('/admin_appeals'));
    const choice = f.queueMenu.mock.calls[0]![0].replyMarkup.inline_keyboard[0]![0].callback_data;
    await f.adapter.handle(callback(choice));
    expect(
      f.queueMenu.mock.calls[1]![0].replyMarkup.inline_keyboard.map((row) =>
        row[0].callback_data.slice(0, 4),
      ),
    ).toEqual(['m7v:', 'm7a:', 'm7b:']);
    await f.adapter.handle(callback(choice.replace('m7q:', 'm7a:')));
    expect(f.appealActions.mock.calls.at(-1)![0].action).toBe('review');
    await f.adapter.handle(reply('Review reason\nPrivate note'));
    expect(f.review.mock.calls[0]![1]).toMatchObject({
      action: 'accepted',
      reason: 'Review reason',
      note: 'Private note',
    });
    expect(f.mutation).not.toHaveBeenCalled();
    expect(f.select).not.toHaveBeenCalled();
    await expect(f.adapter.handle(callback(choice.replace('m7q:', 'm7b:')))).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    await expect(f.adapter.handle(callback(choice.replace('m7q:', 'm7j:')))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
