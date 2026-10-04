import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConfirmedSupportReveals,
  ConfirmedAppealReveals,
  OpaqueTokenStore,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { TelegramAdminSafetyReadVault } from './admin-safety-read-vault.js';
import {
  TelegramAdminSafetyReadPreparation,
  type TelegramSafetyReadDraft,
} from './admin-safety-read-preparation.js';

describe('native Telegram admin read preparation', () => {
  it.each(['support', 'appeal'] as const)(
    'retains one %s confirmation under concurrent native preparations and rejects changed drafts',
    async (kind) => {
      const actor = { kind: 'admin' as const, userId: randomUUID() },
        now = new Date();
      const session = {
        actor,
        telegramUserId: '123',
        locale: 'en',
        expiresAt: new Date(now.getTime() + 300000),
        mfaExpiresAt: new Date(now.getTime() + 300000),
      };
      const base = {
        actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        schemaVersion: 1 as const,
        occurredAt: now.toISOString(),
        locale: 'en',
        data: {
          reason: 'review',
          expectedTargetVersion: 1,
          adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
        },
      };
      const draft: TelegramSafetyReadDraft =
        kind === 'support'
          ? { kind, command: { ...base, commandType: 'support.reveal-thread' } }
          : { kind, command: { ...base, commandType: 'moderation.reveal-appeal' } };
      const support = vi
        .fn<ConfirmedSupportReveals['prepare']>()
        .mockImplementation(() =>
          Promise.resolve(`v1.cf.${randomBytes(12).toString('base64url')}.${'c'.repeat(16)}`),
        );
      const appeals = vi
        .fn<ConfirmedAppealReveals['prepare']>()
        .mockImplementation(() =>
          Promise.resolve(`v1.cf.${randomBytes(12).toString('base64url')}.${'c'.repeat(16)}`),
        );
      const values = new Map<string, string>();
      const store: OpaqueTokenStore = {
        get: (id) => Promise.resolve(values.get(id)),
        putIfAbsent: (id, value) => {
          if (values.has(id)) return Promise.resolve(false);
          values.set(id, value);
          return Promise.resolve(true);
        },
      };
      const vault = new TelegramAdminSafetyReadVault(
        store,
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
      const present = vi
        .fn<(recipient: string, reference: string) => Promise<void>>()
        .mockResolvedValue(undefined);
      const preparation = new TelegramAdminSafetyReadPreparation(
        { current: () => Promise.resolve(session) },
        { prepare: support },
        { prepare: appeals },
        vault,
        { present },
      );
      const references = await Promise.all(
        Array.from({ length: 20 }, () => preparation.prepare('123', draft, 'operation')),
      );
      expect(new Set(references).size).toBe(1);
      expect(values.size).toBe(1);
      expect(kind === 'support' ? appeals : support).not.toHaveBeenCalled();
      const stored = await vault.resolve(actor, references[0]!);
      expect(stored?.command.commandId).toBe(base.commandId);
      if (draft.kind !== 'support') return;
      await expect(
        preparation.prepare(
          '123',
          {
            ...draft,
            command: {
              ...draft.command,
              data: { ...draft.command.data, reason: 'changed reason' },
            },
          },
          'operation',
        ),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      await expect(vault.resolve(actor, references[0]!)).resolves.toEqual(stored);
      support.mockRejectedValueOnce(new ApplicationError('forbidden', 'error.m7.unavailable', 403));
      await expect(preparation.prepare('123', draft, 'operation')).rejects.toMatchObject({
        code: 'forbidden',
      });
      expect(present).toHaveBeenCalledTimes(20);
      await vault.withdraw(actor, references[0]!);
      await expect(preparation.prepare('123', draft, 'operation')).rejects.toMatchObject({
        code: 'internal_error',
      });
    },
  );
});
