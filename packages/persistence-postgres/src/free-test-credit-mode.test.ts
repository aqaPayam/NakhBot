import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  captureFreeTestCreditModeCommand,
  freeTestCreditModeDigest,
} from './free-test-credit-mode.js';

describe('free test funding authority', () => {
  const command = {
    requestId: randomUUID(),
    expectedVersion: 0,
    enabled: true,
    cohortPolicyId: randomUUID(),
    expiresAt: '2026-11-06T12:00:00.000Z',
    sourceSha: 'a'.repeat(40),
    environment: 'staging',
    telegramBotId: '12345',
  };
  it('captures an exact immutable command with an order-independent approval digest', () => {
    const input = { ...command },
      captured = captureFreeTestCreditModeCommand(input);
    input.enabled = false;
    expect(captured.enabled).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(freeTestCreditModeDigest(command)).toBe(
      freeTestCreditModeDigest(Object.fromEntries(Object.entries(command).reverse())),
    );
    expect(freeTestCreditModeDigest(command)).not.toBe(
      freeTestCreditModeDigest({ ...command, telegramBotId: '54321' }),
    );
  });
  it('denies production, extra fields and malformed or noncanonical authority', () => {
    for (const patch of [
      { environment: 'production' },
      { extra: true },
      { expectedVersion: -1 },
      { expectedVersion: 0.5 },
      { expiresAt: '2026-11-06T12:00:00Z' },
      { cohortPolicyId: null },
      { enabled: false },
      { telegramBotId: '0' },
      { sourceSha: 'dev' },
    ])
      expect(() => captureFreeTestCreditModeCommand({ ...command, ...patch })).toThrow();
    expect(
      captureFreeTestCreditModeCommand({
        ...command,
        enabled: false,
        cohortPolicyId: null,
        expiresAt: null,
      }).enabled,
    ).toBe(false);
  });
});
