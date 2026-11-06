import { createHash } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { RateLimiterPort } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { TelegramPaymentSupportContact } from './payment-support-contact.js';

type Send = (recipient: string, username: string) => Promise<void>;
function fixture(): {
  consume: Mock<RateLimiterPort['consume']>;
  send: Mock<Send>;
  ports: {
    botId: string;
    username: string;
    limiter: { consume: Mock<RateLimiterPort['consume']> };
    send: Mock<Send>;
  };
  contact: TelegramPaymentSupportContact;
  update: {
    update_id: number;
    message: {
      text: string;
      from: { id: number; is_bot: boolean };
      chat: { id: number; type: string };
    };
  };
} {
  const consume = vi
    .fn<RateLimiterPort['consume']>()
    .mockResolvedValue({ allowed: true, remaining: 9, retryAfterSeconds: 0 });
  const send = vi.fn<Send>().mockResolvedValue(undefined);
  const ports = { botId: '12345', username: 'NakhSupport', limiter: { consume }, send };
  const contact = new TelegramPaymentSupportContact(ports);
  const update = {
    update_id: 1,
    message: {
      text: '/paysupport secret-charge-and-body',
      from: { id: 123, is_bot: false },
      chat: { id: 123, type: 'private' },
    },
  };
  return { consume, send, ports, contact, update };
}

describe('public payment support contact', () => {
  it('returns only the configured contact without account lookup, message body or write acknowledgement', async () => {
    const f = fixture();
    expect(await f.contact.handle(f.update)).toBe('notice');
    expect(f.send).toHaveBeenCalledExactlyOnceWith('123', 'NakhSupport');
    expect(f.consume).toHaveBeenCalledExactlyOnceWith({
      scope: 'telegram_payment_support_contact',
      subject: createHash('sha256')
        .update('12345\0' + '123')
        .digest('hex'),
      limit: 10,
      windowSeconds: 60,
    });
    expect(JSON.stringify(f.consume.mock.calls)).not.toContain('secret-charge');
    expect(JSON.stringify(f.send.mock.calls)).not.toContain('secret-charge');
  });
  it('ignores unrelated, edited and lookalike commands', async () => {
    const f = fixture();
    for (const update of [
      {},
      { edited_message: f.update.message },
      ...['/support', '/paysupporting', '/paysupport@AnotherBot'].map((text) => ({
        ...f.update,
        message: { ...f.update.message, text },
      })),
    ])
      expect(await f.contact.handle(update)).toBe('unhandled');
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects groups, bots, forged private chats and unsafe identifiers before side effects', async () => {
    const f = fixture();
    for (const update of [
      { ...f.update, update_id: -1 },
      { ...f.update, update_id: Number.MAX_SAFE_INTEGER + 1 },
      ...[
        { ...f.update.message, chat: { id: 123, type: 'group' } },
        { ...f.update.message, chat: { id: 456, type: 'private' } },
        { ...f.update.message, from: { id: 123, is_bot: true } },
        { ...f.update.message, from: { id: 0, is_bot: false } },
        { ...f.update.message, from: { id: Number.MAX_SAFE_INTEGER + 1, is_bot: false } },
      ].map((message) => ({ ...f.update, message })),
    ])
      await expect(f.contact.handle(update)).rejects.toMatchObject({ status: 400 });
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('captures recipient, bot and configured contact before asynchronous work', async () => {
    const f = fixture();
    let release!: () => void;
    f.consume.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { allowed: true, remaining: 9, retryAfterSeconds: 0 };
    });
    const pending = f.contact.handle(f.update);
    f.update.message.from.id = 456;
    f.update.message.chat.id = 456;
    f.ports.username = 'Attacker';
    f.ports.botId = '45678';
    f.ports.send = vi.fn<Send>().mockRejectedValue(new Error('replacement'));
    release();
    await pending;
    expect(f.send).toHaveBeenCalledExactlyOnceWith('123', 'NakhSupport');
  });
  it('fails closed on throttling and sanitizes limiter/provider failures', async () => {
    const f = fixture();
    f.consume.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    await expect(f.contact.handle(f.update)).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    expect(f.send).not.toHaveBeenCalled();
    for (const error of [
      new Error('private provider response'),
      new ApplicationError('rate_limited', 'private limiter response', 503),
    ]) {
      f.consume.mockRejectedValueOnce(error);
      const result: unknown = await f.contact.handle(f.update).catch((failure: unknown) => failure);
      expect(result).toMatchObject({
        message: error instanceof ApplicationError ? 'error.m7.rate_limited' : 'error.m7.internal',
      });
      expect(String(result)).not.toContain('private');
    }
    f.send.mockRejectedValueOnce(new Error('private charge ID'));
    await expect(f.contact.handle(f.update)).rejects.toMatchObject({
      status: 500,
      message: 'error.m7.internal',
    });
  });
  it('rejects malformed configured contacts and bot identities', () => {
    const f = fixture();
    for (const username of [
      '@NakhSupport',
      'https://t.me/NakhSupport',
      'abc',
      'Nakh/Support',
      'NakhSupport\n',
    ])
      expect(() => new TelegramPaymentSupportContact({ ...f.ports, username })).toThrow();
    for (const botId of ['0', '-123', '9007199254740992'])
      expect(() => new TelegramPaymentSupportContact({ ...f.ports, botId })).toThrow();
  });
});
