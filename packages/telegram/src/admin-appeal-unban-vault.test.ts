import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OpaqueTokenStore } from '@nakh/application';
import {
  TelegramAdminSafetyMutationVault,
  type TelegramConfirmedAppealUnban,
} from './admin-safety-mutation-vault.js';

function fixture(): {
  actor: { kind: 'admin'; userId: string };
  rows: Map<string, string>;
  store: OpaqueTokenStore;
  command: TelegramConfirmedAppealUnban;
  vault: TelegramAdminSafetyMutationVault<'appeal-unban'>;
  advance: () => void;
} {
  const actor = { kind: 'admin' as const, userId: randomUUID() },
    rows = new Map<string, string>();
  let now = 100000;
  const store: OpaqueTokenStore = {
    get: (key) => Promise.resolve(rows.get(key)),
    putIfAbsent: (key, value, ttl) => {
      expect(ttl).toBe(300);
      const absent = !rows.has(key);
      if (absent) rows.set(key, value);
      return Promise.resolve(absent);
    },
  };
  const command: TelegramConfirmedAppealUnban = {
    binding: 'a'.repeat(43),
    command: {
      actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      commandType: 'moderation.unban-appeal',
      schemaVersion: 1,
      occurredAt: '2026-10-04T00:00:00.000Z',
      locale: 'en',
      data: {
        adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
        confirmationToken: `v1.cf.${'c'.repeat(16)}.${'d'.repeat(16)}`,
        expectedTargetVersion: 2,
        expectedAccountVersion: 3,
        reason: 'Confidential restoration reason',
      },
    },
  };
  return {
    actor,
    rows,
    store,
    command,
    vault: new TelegramAdminSafetyMutationVault(
      'appeal-unban',
      store,
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      () => now,
    ),
    advance: () => {
      now += 300000;
    },
  };
}
describe('purpose-specific encrypted accepted-appeal unban state', () => {
  it('converges concurrent native preparations, hides all identities/tokens/reasons and binds both versions', async () => {
    const f = fixture();
    const refs = await Promise.all(
      Array.from({ length: 20 }, () => f.vault.retainPrepared(f.actor, f.command, 'operation')),
    );
    expect(new Set(refs).size).toBe(1);
    const ref = refs[0]!;
    await expect(f.vault.resolve(f.actor, ref)).resolves.toEqual(f.command);
    const retry = {
      ...f.command,
      command: {
        ...f.command.command,
        data: {
          ...f.command.command.data,
          adminActionToken: `v1.ad.${'e'.repeat(16)}.${'f'.repeat(16)}`,
          confirmationToken: `v1.cf.${'g'.repeat(16)}.${'h'.repeat(16)}`,
        },
      },
    };
    await expect(f.vault.retainPrepared(f.actor, retry, 'operation')).resolves.toBe(ref);
    for (const change of [
      { expectedTargetVersion: 3 },
      { expectedAccountVersion: 4 },
      { reason: 'Changed reason' },
    ])
      await expect(
        f.vault.retainPrepared(
          f.actor,
          {
            ...f.command,
            command: { ...f.command.command, data: { ...f.command.command.data, ...change } },
          },
          'operation',
        ),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const encoded = [...f.rows.values()].join('');
    for (const value of [
      f.actor.userId,
      f.command.command.commandId,
      f.command.command.data.reason,
      f.command.command.data.adminActionToken,
      f.command.command.data.confirmationToken,
    ])
      expect(encoded).not.toContain(value);
  });
  it('rejects invalid account versions, payload fields and review/support command substitution', async () => {
    const f = fixture();
    for (const expectedAccountVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined])
      await expect(
        f.vault.issue(
          f.actor,
          {
            ...f.command,
            command: {
              ...f.command.command,
              data: { ...f.command.command.data, expectedAccountVersion },
            },
          } as unknown as TelegramConfirmedAppealUnban,
          'invalid',
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    for (const data of [
      { ...f.command.command.data, note: 'Private note' },
      { ...f.command.command.data, decision: 'accepted' },
    ])
      await expect(
        f.vault.issue(
          f.actor,
          { ...f.command, command: { ...f.command.command, data } },
          'invalid',
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    for (const commandType of ['moderation.review-appeal', 'support.close-thread'])
      await expect(
        f.vault.issue(
          f.actor,
          {
            ...f.command,
            command: { ...f.command.command, commandType },
          } as unknown as TelegramConfirmedAppealUnban,
          'invalid',
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.rows.size).toBe(0);
  });
  it('denies cross-actor and cross-purpose envelopes, tampering, expiry and lost state', async () => {
    const f = fixture();
    const ref = await f.vault.issue(f.actor, f.command, 'operation');
    await expect(
      f.vault.resolve({ kind: 'admin', userId: randomUUID() }, ref),
    ).resolves.toBeUndefined();
    const original = f.rows.get(`telegram-admin-appeal-unban-mutation:${ref}`)!;
    for (const purpose of ['support', 'appeal-review'] as const) {
      const other = new TelegramAdminSafetyMutationVault(
        purpose,
        f.store,
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
        () => 100000,
      );
      f.rows.set(`telegram-admin-${purpose}-mutation:${ref}`, original);
      await expect(other.resolve(f.actor, ref)).resolves.toBeUndefined();
    }
    f.rows.set(
      `telegram-admin-appeal-unban-mutation:${ref}`,
      original.replace('"version":1', '"version":2'),
    );
    await expect(f.vault.resolve(f.actor, ref)).resolves.toBeUndefined();
    f.rows.set(`telegram-admin-appeal-unban-mutation:${ref}`, original);
    f.advance();
    await expect(f.vault.resolve(f.actor, ref)).resolves.toBeUndefined();
    await expect(f.vault.decide(f.actor, ref, 'confirm')).resolves.toBe(false);
    f.rows.clear();
    await expect(f.vault.resolve(f.actor, ref)).resolves.toBeUndefined();
  });
  it.each(['confirm', 'cancel'] as const)(
    'retains one %s winner across concurrent opposite decisions',
    async (decision) => {
      const f = fixture();
      const ref = await f.vault.issue(f.actor, f.command, 'operation');
      const opposite = decision === 'confirm' ? 'cancel' : 'confirm';
      expect(
        await Promise.all([
          f.vault.decide(f.actor, ref, decision),
          ...Array.from({ length: 20 }, () => f.vault.decide(f.actor, ref, opposite)),
        ]),
      ).toEqual([true, ...Array.from({ length: 20 }, () => false)]);
      await expect(f.vault.pending(f.actor, ref)).resolves.toBeUndefined();
      await expect(f.vault.decide(f.actor, ref, decision)).resolves.toBe(true);
    },
  );
});
