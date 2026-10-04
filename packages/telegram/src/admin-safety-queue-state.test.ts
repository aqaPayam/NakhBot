import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OpaqueTokenStore } from '@nakh/application';
import {
  TelegramAdminSafetyQueueState,
  type TelegramSafetyQueueChoice,
} from './admin-safety-queue-state.js';

describe('encrypted admin queue selections and prompt correlation', () => {
  it('retains concurrent opaque choices without identities in ciphertext and binds actor/purpose/expiry', async () => {
    let now = Date.now();
    const values = new Map<string, string>();
    const store: OpaqueTokenStore = {
      get: (id) => Promise.resolve(values.get(id)),
      putIfAbsent: (id, value) => {
        if (values.has(id)) return Promise.resolve(false);
        values.set(id, value);
        return Promise.resolve(true);
      },
    };
    const encryptionKey = new Uint8Array(32).fill(1),
      referenceKey = new Uint8Array(32).fill(2);
    const state = new TelegramAdminSafetyQueueState(store, encryptionKey, referenceKey, () => now);
    encryptionKey.fill(9);
    referenceKey.fill(9);
    const actor = { kind: 'admin' as const, userId: randomUUID() };
    const choice: TelegramSafetyQueueChoice = {
      kind: 'support',
      queueActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
      targetId: randomUUID(),
      expectedVersion: 1,
    };
    const refs = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        state.putChoice(actor, 'operation', {
          ...choice,
          queueActionToken: `v1.ad.${String(index).padStart(16, '0')}.${'c'.repeat(16)}`,
        }),
      ),
    );
    expect(new Set(refs).size).toBe(1);
    expect(values.size).toBe(1);
    const reference = refs[0]!;
    const first = await state.choice(actor, reference);
    expect(first?.targetId).toBe(choice.targetId);
    expect([...values.values()].join('')).not.toContain(choice.targetId);
    expect([...values.values()].join('')).not.toContain(actor.userId);
    await expect(
      state.choice({ kind: 'admin', userId: randomUUID() }, reference),
    ).resolves.toBeUndefined();
    await expect(state.page(actor, reference)).resolves.toBeUndefined();
    const preserved = [...values.entries()];
    await expect(
      state.putChoice(actor, 'operation', { ...choice, targetId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect([...values.entries()]).toEqual(preserved);
    await state.bindPrompt(actor, 7, reference);
    await expect(state.prompt(actor, 7)).resolves.toBe(reference);
    await expect(state.promptSelection(actor, 7)).resolves.toEqual({ reference, action: 'read' });
    await expect(state.bindPrompt(actor, 7, reference, 'reply')).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    await expect(state.prompt(actor, 8)).resolves.toBeUndefined();
    await expect(state.prompt({ kind: 'admin', userId: randomUUID() }, 7)).resolves.toBeUndefined();
    const second = await state.putChoice(actor, 'second', choice);
    await expect(state.bindPrompt(actor, 7, second)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    now += 300000;
    await expect(state.choice(actor, reference)).resolves.toBeUndefined();
    await expect(state.prompt(actor, 7)).resolves.toBeUndefined();
    await expect(state.putChoice(actor, 'operation', choice)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
  it('denies corrupted state and sanitizes cache failures without extending authority', async () => {
    const actor = { kind: 'admin' as const, userId: randomUUID() },
      values = new Map<string, string>();
    let failed = false;
    const store: OpaqueTokenStore = {
      get: (id) =>
        failed ? Promise.reject(new Error('private diagnostics')) : Promise.resolve(values.get(id)),
      putIfAbsent: (id, value) => {
        values.set(id, value);
        return Promise.resolve(true);
      },
    };
    const state = new TelegramAdminSafetyQueueState(
      store,
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
    );
    const ref = await state.putPage(actor, 'page', {
      kind: 'appeal',
      status: 'accepted',
      cursor: `v1.sq.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    });
    const key = [...values.keys()][0]!;
    values.set(key, '{"version":1,"nonce":"invalid"}');
    await expect(state.page(actor, ref)).resolves.toBeUndefined();
    failed = true;
    await expect(state.page(actor, ref)).rejects.toMatchObject({ message: 'error.m7.internal' });
  });
});
