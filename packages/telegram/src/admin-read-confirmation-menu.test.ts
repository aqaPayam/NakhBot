import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TelegramAdminReadConfirmationMenus } from './admin-read-confirmation-menu.js';
import { TelegramAdminTextDelivery } from './admin-text-delivery.js';
import type {
  TelegramConfirmedSafetyRead,
  TelegramConfirmedSafetyReads,
} from './admin-safety-content-adapter.js';
import type { TelegramAdminSessionVerifier } from './admin-session.js';

const now = new Date('2026-10-04T00:00:00Z'),
  reference = 'x'.repeat(22);
describe('Telegram native read confirmation menus', () => {
  it.each(['support', 'appeal'] as const)(
    'sends a protected localized %s confirmation without identities, native tokens or user content',
    async (kind) => {
      const actor = { kind: 'admin' as const, userId: randomUUID() };
      const base = {
        commandId: randomUUID(),
        schemaVersion: 1 as const,
        actor,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: now.toISOString(),
        locale: 'en',
        data: {
          adminActionToken: 'private-action-token',
          confirmationToken: 'private-confirmation-token',
          expectedTargetVersion: 1,
          reason: '  operator reason <b>literal</b>  ',
        },
      };
      const selected: TelegramConfirmedSafetyRead =
        kind === 'support'
          ? { kind, command: { ...base, commandType: 'support.reveal-thread' } }
          : { kind, command: { ...base, commandType: 'moderation.reveal-appeal' } };
      const session = {
        actor,
        telegramUserId: '123',
        locale: 'fa',
        expiresAt: new Date(now.getTime() + 300000),
        mfaExpiresAt: new Date(now.getTime() + 300000),
      };
      const current = vi.fn<TelegramAdminSessionVerifier['current']>().mockResolvedValue(session);
      const resolve = vi.fn<TelegramConfirmedSafetyReads['resolve']>().mockResolvedValue(selected);
      const fetcher = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockImplementation(() =>
          Promise.resolve(new Response('{"ok":true,"result":{"message_id":1}}')),
        );
      const renderer = { render: vi.fn((_locale: string, intent: { key: string }) => intent.key) };
      const presenter = new TelegramAdminReadConfirmationMenus(
        { current },
        { resolve, withdraw: () => Promise.resolve(true) },
        renderer,
        new TelegramAdminTextDelivery('123:private-token', fetcher),
        () => now,
      );
      await presenter.present('123', reference);
      const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string) as {
        text: string;
        reply_markup: { inline_keyboard: { callback_data: string }[][] };
        protect_content: boolean;
        link_preview_options: { is_disabled: boolean };
      };
      expect(body.text).toBe(
        'admin.confirm.title\nadmin.confirm.prompt\noperator reason <b>literal</b>',
      );
      expect(body.reply_markup.inline_keyboard[0]!.map((button) => button.callback_data)).toEqual([
        `m7s:${reference}`,
        `m7c:${reference}`,
      ]);
      expect(body).toMatchObject({
        protect_content: true,
        link_preview_options: { is_disabled: true },
      });
      expect(body).not.toHaveProperty('parse_mode');
      for (const value of [
        actor.userId,
        base.commandId,
        base.data.adminActionToken,
        base.data.confirmationToken,
      ])
        expect(JSON.stringify(body)).not.toContain(value);
      expect(renderer.render.mock.calls.every(([locale]) => locale === 'fa')).toBe(true);
      current.mockResolvedValueOnce(session).mockResolvedValueOnce(undefined);
      await expect(presenter.present('123', reference)).rejects.toMatchObject({
        code: 'unauthorized',
      });
      resolve.mockResolvedValueOnce(selected).mockResolvedValueOnce(undefined);
      await expect(presenter.present('123', reference)).rejects.toMatchObject({
        code: 'version_conflict',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects invalid references and mismatched button references before delivery', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    const delivery = new TelegramAdminTextDelivery('123:private-token', fetcher);
    await expect(
      delivery.menu({
        recipient: '123',
        text: 'confirmation',
        disableLinkPreviews: true,
        replyMarkup: {
          inline_keyboard: [
            [
              { text: 'Confirm', callback_data: `m7s:${reference}` },
              { text: 'Cancel', callback_data: `m7c:${'y'.repeat(22)}` },
            ],
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const current = vi.fn<TelegramAdminSessionVerifier['current']>();
    const presenter = new TelegramAdminReadConfirmationMenus(
      { current },
      { resolve: () => Promise.resolve(undefined), withdraw: () => Promise.resolve(false) },
      { render: () => 'text' },
      delivery,
    );
    await expect(presenter.present('123', 'raw-id')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(current).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
