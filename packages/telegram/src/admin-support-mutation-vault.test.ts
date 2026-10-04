import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { OpaqueTokenStore } from '@nakh/application';
import { TelegramAdminSupportMutationVault } from './admin-support-mutation-vault.js';
import type { TelegramConfirmedSupportMutation } from './admin-support-mutation-vault.js';

const actor = { kind: 'admin' as const, userId: randomUUID() };
const command: TelegramConfirmedSupportMutation & {
  command: Extract<
    TelegramConfirmedSupportMutation['command'],
    { commandType: 'support.reply-thread' }
  >;
} = {
  binding: 'a'.repeat(43),
  command: {
    commandId: randomUUID(),
    commandType: 'support.reply-thread',
    schemaVersion: 1,
    actor,
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    occurredAt: '2026-10-04T00:00:00Z',
    locale: 'en',
    data: {
      adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
      confirmationToken: `v1.cf.${'c'.repeat(16)}.${'d'.repeat(16)}`,
      expectedTargetVersion: 1,
      reason: 'confidential review reason',
      text: 'confidential support response',
    },
  },
};
const fixture = (): Readonly<{
  rows: Map<string, string>;
  store: OpaqueTokenStore;
  vault: TelegramAdminSupportMutationVault;
  advance: (time: number) => void;
}> => {
  const rows = new Map<string, string>();
  const store: OpaqueTokenStore = {
    putIfAbsent: (key, value, ttl) => {
      expect(ttl).toBe(300);
      const absent = !rows.has(key);
      if (absent) rows.set(key, value);
      return Promise.resolve(absent);
    },
    get: (key) => Promise.resolve(rows.get(key)),
  };
  let now = 100000;
  return {
    rows,
    store,
    vault: new TelegramAdminSupportMutationVault(
      store,
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      () => now,
    ),
    advance: (time) => {
      now = time;
    },
  };
};
describe('encrypted Telegram admin read confirmations', () => {
  it('converges concurrent allocation, accepts reordered equivalent fields and stores no plaintext identifiers, tokens or reason', async () => {
    const f = fixture();
    const references = await Promise.all(
      Array.from({ length: 20 }, () => f.vault.issue(actor, command, 'operation-1')),
    );
    expect(new Set(references).size).toBe(1);
    const reference = references[0]!;
    expect(reference).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(f.rows.size).toBe(1);
    await expect(f.vault.resolve(actor, reference)).resolves.toEqual(command);
    const reordered = {
      ...command,
      command: {
        ...command.command,
        data: {
          reason: command.command.data.reason,
          text: 'confidential support response',
          expectedTargetVersion: 1,
          confirmationToken: command.command.data.confirmationToken,
          adminActionToken: command.command.data.adminActionToken,
        },
      },
    };
    await expect(f.vault.issue(actor, reordered, 'operation-1')).resolves.toBe(reference);
    const encoded = [...f.rows.values()].join('');
    for (const value of [
      actor.userId,
      command.command.commandId,
      command.command.data.reason,
      command.command.data.confirmationToken,
      command.command.data.adminActionToken,
    ])
      expect(encoded).not.toContain(value);
    expect([...f.rows.keys()][0]).not.toContain(actor.userId);
  });
  it('rejects changed operations without replacing or extending the first stored confirmation', async () => {
    const f = fixture();
    const reference = await f.vault.issue(actor, command, 'operation-1');
    const before = [...f.rows.values()][0];
    await expect(
      f.vault.issue(
        actor,
        {
          ...command,
          command: {
            ...command.command,
            data: { ...command.command.data, reason: 'changed reason' },
          },
        },
        'operation-1',
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect([...f.rows.values()][0]).toBe(before);
    f.advance(400000);
    await expect(f.vault.resolve(actor, reference)).resolves.toBeUndefined();
    await expect(f.vault.issue(actor, command, 'operation-1')).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect([...f.rows.values()][0]).toBe(before);
  });
  it('denies other actors, altered handles, substitution, tampering and cache loss', async () => {
    const f = fixture();
    const reference = await f.vault.issue(actor, command, 'operation-1');
    await expect(
      f.vault.resolve({ kind: 'user', userId: actor.userId }, reference),
    ).resolves.toBeUndefined();
    await expect(
      f.vault.resolve({ kind: 'admin', userId: randomUUID() }, reference),
    ).resolves.toBeUndefined();
    await expect(f.vault.resolve(actor, reference + 'x')).resolves.toBeUndefined();
    const value = [...f.rows.values()][0]!;
    f.rows.set(`telegram-admin-support-mutation:${'z'.repeat(22)}`, value);
    await expect(f.vault.resolve(actor, 'z'.repeat(22))).resolves.toBeUndefined();
    f.rows.set(
      `telegram-admin-support-mutation:${reference}`,
      value.replace('"version":1', '"version":2'),
    );
    await expect(f.vault.resolve(actor, reference)).resolves.toBeUndefined();
    const envelope = JSON.parse(value) as {
      version: number;
      nonce: string;
      ciphertext: string;
      tag: string;
    };
    envelope.tag = 'e'.repeat(22);
    f.rows.set(`telegram-admin-support-mutation:${reference}`, JSON.stringify(envelope));
    await expect(f.vault.resolve(actor, reference)).resolves.toBeUndefined();
    f.rows.clear();
    await expect(f.vault.resolve(actor, reference)).resolves.toBeUndefined();
  });
  it('sanitizes cache failures and rejects shared encryption/reference keys', async () => {
    const store = {
      putIfAbsent: vi
        .fn<OpaqueTokenStore['putIfAbsent']>()
        .mockRejectedValue(new Error('private cache parameters')),
      get: vi.fn<OpaqueTokenStore['get']>().mockRejectedValue(new Error('private cache identity')),
    };
    const vault = new TelegramAdminSupportMutationVault(
      store,
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
    );
    await expect(vault.issue(actor, command, 'operation')).rejects.toMatchObject({
      message: 'error.m7.internal',
    });
    await expect(vault.resolve(actor, 'x'.repeat(22))).rejects.toMatchObject({
      message: 'error.m7.internal',
    });
    expect(
      () => new TelegramAdminSupportMutationVault(store, new Uint8Array(32), new Uint8Array(32)),
    ).toThrow('configuration invalid');
  });
  it('rejects invalid calendar times and overlong channel identity before storing state', async () => {
    const f = fixture();
    for (const changes of [
      { occurredAt: '2026-02-30T00:00:00Z' },
      { channelContext: { channel: 'telegram' as const, channelIdentityId: 'x'.repeat(129) } },
    ])
      await expect(
        f.vault.issue(
          actor,
          { ...command, command: { ...command.command, ...changes } },
          'invalid',
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.rows.size).toBe(0);
  });
  it('retains the first native prepared tokens while rejecting changed payload or selected target', async () => {
    const f = fixture();
    const ref = await f.vault.retainPrepared(actor, command, 'operation');
    const retry = {
      ...command,
      command: {
        ...command.command,
        data: {
          ...command.command.data,
          adminActionToken: `v1.ad.${'e'.repeat(16)}.${'f'.repeat(16)}`,
          confirmationToken: `v1.cf.${'g'.repeat(16)}.${'h'.repeat(16)}`,
        },
      },
    };
    await expect(f.vault.retainPrepared(actor, retry, 'operation')).resolves.toBe(ref);
    await expect(f.vault.resolve(actor, ref)).resolves.toEqual(command);
    for (const changed of [
      { ...command, binding: 'b'.repeat(43) },
      {
        ...command,
        command: { ...command.command, data: { ...command.command.data, text: 'Changed reply' } },
      },
      { ...command, command: { ...command.command, locale: 'fa' } },
    ])
      await expect(f.vault.retainPrepared(actor, changed, 'operation')).rejects.toMatchObject({
        code: 'idempotency_conflict',
      });
    expect([...f.rows.values()].join('')).not.toContain('confidential support response');
  });
  it.each(['confirm', 'cancel'] as const)(
    'makes %s the first decision under a mixed concurrent race, without undoing it',
    async (decision) => {
      const f = fixture();
      const ref = await f.vault.issue(actor, command, 'operation');
      const opposite = decision === 'confirm' ? 'cancel' : 'confirm';
      const results = await Promise.all([
        f.vault.decide(actor, ref, decision),
        ...Array.from({ length: 20 }, () => f.vault.decide(actor, ref, opposite)),
      ]);
      expect(results).toEqual([true, ...Array.from({ length: 20 }, () => false)]);
      await expect(f.vault.decide(actor, ref, decision)).resolves.toBe(true);
      await expect(f.vault.pending(actor, ref)).resolves.toBeUndefined();
      await expect(
        f.vault.decide({ kind: 'admin', userId: randomUUID() }, ref, decision),
      ).resolves.toBe(false);
      f.advance(400000);
      await expect(f.vault.decide(actor, ref, decision)).resolves.toBe(false);
    },
  );
  it('accepts the full scalar limits including emoji while rejecting unnormalized or overlong replies', async () => {
    const f = fixture();
    const reply = {
      ...command,
      command: {
        ...command.command,
        data: { ...command.command.data, reason: '😀'.repeat(1024), text: '😀'.repeat(2000) },
      },
    };
    const ref = await f.vault.issue(actor, reply, 'unicode');
    await expect(f.vault.resolve(actor, ref)).resolves.toEqual(reply);
    for (const text of ['😀'.repeat(2001), ' ', ' e\u0301 '])
      await expect(
        f.vault.issue(
          actor,
          { ...command, command: { ...command.command, data: { ...command.command.data, text } } },
          'invalid',
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
