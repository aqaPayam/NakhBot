import type { TelegramLockedLikedByScreen } from '@nakh/telegram';
import { describe, expect, it, vi, type Mock } from 'vitest';

import type { TelegramLikedBySendInput } from './liked-by-delivery-processor.js';
import { TelegramLikedByLeaseLost } from './liked-by-delivery-processor.js';
import { ResumableTelegramLikedBySender } from './liked-by-resumable-sender.js';

const firstAction = 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba';
const secondAction = 'v1.lb.ponmlkjihgfedcba.abcdefghijklmnop';
const grant = {
  deliveryUrl:
    'https://media.example.test/media/40000000-0000-4000-8000-000000000000/blurred-preview-v1.webp?token=payload.signature',
  expiresAt: '2026-10-01T00:00:00.000Z',
  variantType: 'blurred_preview' as const,
  cachePolicy: 'no-store' as const,
};
const screen: TelegramLockedLikedByScreen = {
  title: { key: 'liked_by.title', variables: { count: 2 } },
  cards: [
    {
      label: { key: 'liked_by.card.locked', variables: { position: 1 } },
      blurredPhoto: grant,
      unlock: {
        label: { key: 'liked_by.button.unlock', variables: {} },
        callbackData: firstAction,
      },
    },
    {
      label: { key: 'liked_by.card.locked', variables: { position: 2 } },
      blurredPhoto: grant,
      unlock: {
        label: { key: 'liked_by.button.unlock', variables: {} },
        callbackData: secondAction,
      },
    },
  ],
};
const input: TelegramLikedBySendInput = {
  deliveryId: '10000000-0000-4000-8000-000000000000',
  owner: 'sender-one',
  attemptCount: 1,
  botId: '123',
  viewerUserId: '20000000-0000-4000-8000-000000000000',
  telegramUserId: '456',
  screen,
};

type Fixture = Readonly<{
  sender: ResumableTelegramLikedBySender;
  receipts: Readonly<{ loadRecordedMessageKeys: Mock; recordMessageReceipt: Mock }>;
  renderers: Readonly<{ rendererFor: Mock }>;
  screens: Readonly<{ sendScreen: Mock }>;
  cards: Readonly<{ sendCard: Mock }>;
}>;

type ReceiptCall = Readonly<{ messageKey: string; providerMessageId: number }>;

function recordedReceipts(mock: Mock): ReceiptCall[] {
  return mock.mock.calls.map((call) => call[0] as ReceiptCall);
}

function fixture(): Fixture {
  const receipts = {
    loadRecordedMessageKeys: vi.fn().mockResolvedValue([]),
    recordMessageReceipt: vi
      .fn()
      .mockImplementation((value: { providerMessageId: number }) =>
        Promise.resolve({ outcome: 'recorded', providerMessageId: value.providerMessageId }),
      ),
  };
  const renderers = {
    rendererFor: vi.fn().mockResolvedValue((intent: { key: string }) => intent.key),
  };
  const screens = { sendScreen: vi.fn().mockResolvedValue(10) };
  const cards = { sendCard: vi.fn().mockResolvedValueOnce(11).mockResolvedValueOnce(12) };
  return {
    sender: new ResumableTelegramLikedBySender(receipts, renderers, screens, cards),
    receipts,
    renderers,
    screens,
    cards,
  };
}

describe('resumable Telegram Liked By sender', () => {
  it('records each accepted logical message and skips all known successes on replay', async () => {
    const parts = fixture();
    await parts.sender.send(input);
    const receiptCalls = recordedReceipts(parts.receipts.recordMessageReceipt);
    const keys = receiptCalls.map((value) => value.messageKey);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(/^screen:[A-Za-z0-9_-]{43}$/u);
    expect(keys.slice(1)).toEqual([`card:${firstAction}`, `card:${secondAction}`]);
    expect(receiptCalls.map((value) => value.providerMessageId)).toEqual([10, 11, 12]);
    expect(JSON.stringify(keys)).not.toContain(input.viewerUserId);
    expect(JSON.stringify(keys)).not.toContain(input.telegramUserId);

    parts.receipts.loadRecordedMessageKeys.mockResolvedValue(keys);
    parts.receipts.recordMessageReceipt.mockClear();
    parts.renderers.rendererFor.mockClear();
    parts.screens.sendScreen.mockClear();
    parts.cards.sendCard.mockClear();
    await parts.sender.send(input);
    expect(parts.renderers.rendererFor).not.toHaveBeenCalled();
    expect(parts.screens.sendScreen).not.toHaveBeenCalled();
    expect(parts.cards.sendCard).not.toHaveBeenCalled();
    expect(parts.receipts.recordMessageReceipt).not.toHaveBeenCalled();
  });

  it('resends changed screen metadata but not already accepted cards', async () => {
    const parts = fixture();
    await parts.sender.send(input);
    const priorKeys = recordedReceipts(parts.receipts.recordMessageReceipt).map(
      (value) => value.messageKey,
    );
    parts.receipts.loadRecordedMessageKeys.mockResolvedValue(priorKeys);
    parts.receipts.recordMessageReceipt.mockClear();
    parts.screens.sendScreen.mockClear();
    parts.cards.sendCard.mockClear();
    await parts.sender.send({
      ...input,
      screen: { ...screen, title: { key: 'liked_by.title', variables: { count: 3 } } },
    });
    expect(parts.screens.sendScreen).toHaveBeenCalledOnce();
    expect(parts.cards.sendCard).not.toHaveBeenCalled();
    const nextScreenKey = recordedReceipts(parts.receipts.recordMessageReceipt)[0]!.messageKey;
    expect(nextScreenKey).not.toBe(priorKeys[0]);
  });

  it('does not contact Telegram after discovering that its lease is gone', async () => {
    const parts = fixture();
    parts.receipts.loadRecordedMessageKeys.mockResolvedValue(undefined);
    await expect(parts.sender.send(input)).rejects.toBeInstanceOf(TelegramLikedByLeaseLost);
    expect(parts.renderers.rendererFor).not.toHaveBeenCalled();
    expect(parts.screens.sendScreen).not.toHaveBeenCalled();
    expect(parts.cards.sendCard).not.toHaveBeenCalled();
  });

  it('stops after a successful provider call when the receipt lease was lost', async () => {
    const parts = fixture();
    parts.receipts.recordMessageReceipt.mockResolvedValue({ outcome: 'lease_lost' });
    await expect(parts.sender.send(input)).rejects.toBeInstanceOf(TelegramLikedByLeaseLost);
    expect(parts.screens.sendScreen).toHaveBeenCalledOnce();
    expect(parts.cards.sendCard).not.toHaveBeenCalled();
  });
});
