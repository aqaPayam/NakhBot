import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import * as formatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  ChangeChatMuteCommandSchema,
  ChatCapabilitySchema,
  ChatMessageResultSchema,
  ChatPageSchema,
  ClaimNotificationDeliveriesCommandSchema,
  GetChatPageQuerySchema,
  M6EventTypeSchema,
  SendPredefinedAnswerCommandSchema,
  SendTextMessageCommandSchema,
  SettleNotificationDeliveryCommandSchema,
  UnmatchCommandSchema,
  UnmatchResultSchema,
} from './index.js';

const addFormats = formatsModule.default as unknown as (
  ajv: InstanceType<typeof Ajv>,
) => InstanceType<typeof Ajv>;
function validator(schema: object): ValidateFunction {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const userId = '10000000-0000-4000-8000-000000000000';
const entityId = '20000000-0000-4000-8000-000000000000';
const otherId = '30000000-0000-4000-8000-000000000000';
const timestamp = '2026-09-24T00:00:00.000Z';
const chatActionToken = `v1.ch.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const matchActionToken = `v1.mt.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const envelope = {
  commandId: '40000000-0000-4000-8000-000000000000',
  schemaVersion: 1,
  actor: { userId, kind: 'user' },
  requestId: '50000000-0000-4000-8000-000000000000',
  idempotencyKey: 'stable-chat-command',
  occurredAt: timestamp,
  locale: 'en',
};

describe('M6 chat and notification contracts', () => {
  it('accepts only server-bound predefined answer references', () => {
    const validate = validator(SendPredefinedAnswerCommandSchema);
    const command = {
      ...envelope,
      commandType: 'chat.send-predefined-answer',
      data: { chatActionToken, questionId: entityId, answerId: otherId },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, data: { ...command.data, senderUserId: userId } })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, recipientUserId: otherId } })).toBe(
      false,
    );
    expect(validate({ ...command, data: { ...command.data, text: 'forged prose' } })).toBe(false);
  });

  it('bounds text by Unicode scalar count and rejects attachment or entitlement claims', () => {
    const validate = validator(SendTextMessageCommandSchema);
    const command = {
      ...envelope,
      commandType: 'chat.send-text',
      data: { chatActionToken, text: '🌳'.repeat(1000) },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, data: { ...command.data, text: '🌳'.repeat(1001) } })).toBe(
      false,
    );
    for (const forged of [
      { attachmentId: entityId },
      { telegramFileId: 'secret' },
      { senderUserId: userId },
      { recipientUserId: otherId },
      { unlocked: true },
      { price: 4 },
    ])
      expect(validate({ ...command, data: { ...command.data, ...forged } })).toBe(false);
  });

  it('keeps mute and Unmatch actor-bound and versioned without raw entity selection', () => {
    const mute = {
      ...envelope,
      commandType: 'chat.change-mute',
      data: { chatActionToken, muted: true, expectedVersion: 2 },
    };
    expect(validator(ChangeChatMuteCommandSchema)(mute)).toBe(true);
    expect(
      validator(ChangeChatMuteCommandSchema)({
        ...mute,
        data: { ...mute.data, chatSessionId: entityId },
      }),
    ).toBe(false);

    const unmatch = {
      ...envelope,
      commandType: 'matching.unmatch',
      data: { matchActionToken, reasonCode: 'not_a_fit' },
    };
    expect(validator(UnmatchCommandSchema)(unmatch)).toBe(true);
    expect(
      validator(UnmatchCommandSchema)({
        ...unmatch,
        data: { ...unmatch.data, targetUserId: otherId },
      }),
    ).toBe(false);
  });

  it('uses a bounded opaque page cursor and never accepts offsets', () => {
    const validate = validator(GetChatPageQuerySchema);
    const query = {
      actor: envelope.actor,
      requestId: envelope.requestId,
      chatActionToken,
      limit: 50,
      cursor: `v1.cm.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    };
    expect(validate(query)).toBe(true);
    expect(validate({ ...query, offset: 1 })).toBe(false);
    expect(validate({ ...query, limit: 51 })).toBe(false);
    expect(validate({ ...query, cursor: entityId })).toBe(false);
  });

  it('returns only relationship-safe messages and bounded pages', () => {
    const message = {
      messageId: entityId,
      sequenceNumber: '42',
      sender: 'match',
      messageType: 'text',
      content: { text: 'Hello 🌳' },
      createdAt: timestamp,
    };
    expect(validator(ChatMessageResultSchema)({ message, replayed: false })).toBe(true);
    expect(
      validator(ChatMessageResultSchema)({
        message: { ...message, senderUserId: otherId },
        replayed: false,
      }),
    ).toBe(false);
    expect(validator(ChatPageSchema)({ items: Array.from({ length: 50 }, () => message) })).toBe(
      true,
    );
    expect(validator(ChatPageSchema)({ items: Array.from({ length: 51 }, () => message) })).toBe(
      false,
    );
  });

  it('returns capability and Unmatch state without payer or Telegram identity', () => {
    const capability = {
      chatActionToken,
      chatSessionId: entityId,
      matchId: otherId,
      status: 'active',
      canRead: true,
      canSendPredefined: true,
      canSendText: false,
      canUnmatch: true,
      textUnlocked: true,
      mustShowSafetyWarning: true,
      muted: false,
      version: 1,
    };
    expect(validator(ChatCapabilitySchema)(capability)).toBe(true);
    expect(validator(ChatCapabilitySchema)({ ...capability, payerUserId: userId })).toBe(false);
    expect(validator(ChatCapabilitySchema)({ ...capability, telegramUserId: '123' })).toBe(false);

    const result = {
      matchId: otherId,
      status: 'unmatched',
      unmatchedAt: timestamp,
      reportWindowExpiresAt: '2026-09-25T00:00:00.000Z',
      replayed: false,
    };
    expect(validator(UnmatchResultSchema)(result)).toBe(true);
    expect(validator(UnmatchResultSchema)({ ...result, targetUserId: userId })).toBe(false);
  });

  it('keeps delivery claims opaque and fences every trusted settlement', () => {
    const claim = {
      ...envelope,
      actor: { userId, kind: 'system' },
      commandType: 'notification.claim-deliveries',
      data: { workerId: 'worker:1', limit: 50 },
    };
    expect(validator(ClaimNotificationDeliveriesCommandSchema)(claim)).toBe(true);
    expect(
      validator(ClaimNotificationDeliveriesCommandSchema)({
        ...claim,
        data: { ...claim.data, payload: 'private chat text' },
      }),
    ).toBe(false);

    const settlement = {
      ...envelope,
      actor: { userId, kind: 'system' },
      commandType: 'notification.settle-delivery',
      data: {
        deliveryId: entityId,
        leaseOwner: 'worker:1',
        fenceToken: '7',
        result: { outcome: 'failed_retryable', failureCode: 'rate_limited', retryAfterMs: 1000 },
      },
    };
    expect(validator(SettleNotificationDeliveryCommandSchema)(settlement)).toBe(true);
    expect(
      validator(SettleNotificationDeliveryCommandSchema)({
        ...settlement,
        data: { ...settlement.data, fenceToken: '0' },
      }),
    ).toBe(false);
    expect(
      validator(SettleNotificationDeliveryCommandSchema)({
        ...settlement,
        data: {
          ...settlement.data,
          result: { outcome: 'ambiguous', failureCode: 'network_error' },
        },
      }),
    ).toBe(false);
  });

  it('locks every M6 event name to an explicit version', () => {
    const validate = validator(M6EventTypeSchema);
    for (const eventType of [
      'chat.message-created.v1',
      'matching.unmatched.v1',
      'notification.delivery-settled.v1',
    ])
      expect(validate(eventType)).toBe(true);
    expect(validate('chat.message-created')).toBe(false);
    expect(validate('chat.telegram-id-exposed.v1')).toBe(false);
  });
});
