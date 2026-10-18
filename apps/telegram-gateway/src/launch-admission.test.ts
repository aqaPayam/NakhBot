import { describe, expect, it, vi } from 'vitest';
import { TelegramLaunchAdmission } from './launch-admission.js';

const life = { userId: 'aaaabbbb-cccc-4ddd-8eee-ffffffffffff', productEpoch: 0 };
const message = {
  update_id: 1,
  message: { from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, text: '/start' },
};
describe('gateway launch admission boundary', () => {
  it('observes every new dispatch and denies a stop without a cached successful grant', async () => {
    let admitted = true;
    const gate = new TelegramLaunchAdmission(
      '456',
      () => Promise.resolve(life),
      () => Promise.resolve(admitted),
    );
    expect(await gate.allowsUpdate(message)).toBe(true);
    admitted = false;
    expect(await gate.allowsUpdate(message)).toBe(false);
    expect(await gate.allowsLife('123', life)).toBe(false);
  });
  it('captures the original life before waits and denies a Root/Return during observation', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = { ...life };
    let current = { ...life };
    const gate = new TelegramLaunchAdmission(
      '456',
      () => Promise.resolve(current),
      async () => {
        await held;
        return true;
      },
    );
    const pending = gate.allowsLife('123', input);
    input.productEpoch = 1;
    current = { ...input };
    release();
    expect(await pending).toBe(false);
  });
  it('fails closed for missing identities and private dependency failures', async () => {
    const allows = vi.fn(() => Promise.resolve(true));
    expect(
      await new TelegramLaunchAdmission(
        '456',
        () => Promise.resolve(undefined),
        allows,
      ).allowsUpdate(message),
    ).toBe(false);
    expect(allows).not.toHaveBeenCalled();
    expect(
      await new TelegramLaunchAdmission(
        '456',
        () => Promise.reject(new Error('PRIVATE_URL')),
        allows,
      ).allowsUpdate(message),
    ).toBe(false);
    expect(
      await new TelegramLaunchAdmission(
        '456',
        () => Promise.resolve(life),
        () => Promise.reject(new Error('PRIVATE_SQL')),
      ).allowsUpdate(message),
    ).toBe(false);
  });
  it.each([
    { ...message, update_id: -1 },
    { ...message, edited_message: message.message },
    { ...message, message: { ...message.message, from: { id: 123, is_bot: true } } },
    { ...message, message: { ...message.message, chat: { id: 999, type: 'private' } } },
    { ...message, message: { ...message.message, chat: { id: 123, type: 'group' } } },
    {
      update_id: 1,
      callback_query: {
        from: message.message.from,
        message: { ...message.message, from: { id: 999, is_bot: true } },
      },
    },
  ])('does not consult membership for an unowned Telegram envelope %#', async (update) => {
    const allows = vi.fn(() => Promise.resolve(true));
    expect(
      await new TelegramLaunchAdmission('456', () => Promise.resolve(life), allows).allowsUpdate(
        update,
      ),
    ).toBe(false);
    expect(allows).not.toHaveBeenCalled();
  });
});
