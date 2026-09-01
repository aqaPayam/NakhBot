import { describe, expect, it } from 'vitest';

import { TelegramWebhookAuthenticator } from './index.js';

describe('Telegram webhook authentication', () => {
  it('accepts only the exact secret', () => {
    const authenticator = new TelegramWebhookAuthenticator('a'.repeat(32));

    expect(authenticator.verify('a'.repeat(32))).toBe(true);
    expect(authenticator.verify('a'.repeat(31))).toBe(false);
    expect(authenticator.verify(undefined)).toBe(false);
  });
});
