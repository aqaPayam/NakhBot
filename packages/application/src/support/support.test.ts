import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { OpenSupportThreadCommand } from '@nakh/contracts';
import type { IdGenerator } from '@nakh/domain';

import type { OpaqueTokenStore } from '../security/opaque-token.js';
import {
  OpenSupportThreadHandler,
  SupportOpaqueReferences,
  type StoredSupportResult,
  type UserSupportWrite,
} from './support.js';

class MemoryTokens implements OpaqueTokenStore {
  private readonly values = new Map<string, string>();

  public putIfAbsent(id: string, value: string): Promise<boolean> {
    if (this.values.has(id)) return Promise.resolve(false);
    this.values.set(id, value);
    return Promise.resolve(true);
  }

  public get(id: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(id));
  }
}

describe('Support application boundary', () => {
  it('issues stable signed references bound to the exact user and thread', async () => {
    const now = 1_800_000_000_000;
    const references = new SupportOpaqueReferences(
      new MemoryTokens(),
      Buffer.alloc(32, 9),
      () => now,
    );
    const userId = randomUUID();
    const threadId = randomUUID();
    const commandId = randomUUID();
    const token = await references.issue(userId, threadId, commandId);
    expect(await references.issue(userId, threadId, commandId)).toBe(token);
    expect(await references.resolve(token, userId)).toBe(threadId);
    expect(await references.resolve(token, randomUUID())).toBeUndefined();
    const tampered = token.slice(0, -1) + (token.endsWith('x') ? 'y' : 'x');
    expect(await references.resolve(tampered, userId)).toBeUndefined();
  });

  it('normalizes restricted text and returns only the opaque support reference', async () => {
    const userId = randomUUID();
    const commandId = randomUUID();
    const generated = [randomUUID(), randomUUID(), randomUUID()];
    const ids: IdGenerator = { uuid: () => generated.shift()! };
    const stored: StoredSupportResult = {
      supportThreadId: generated[0]!,
      status: 'open',
      unansweredUserMessages: 1,
      version: 1,
      changedAt: new Date('2026-09-28T00:00:00.000Z'),
      replayed: false,
    };
    const open = vi.fn((write: UserSupportWrite) => {
      expect(write.normalizedText).toBe('Please help');
      return Promise.resolve({ ...stored, supportThreadId: write.supportThreadId });
    });
    const issue = vi.fn(() => Promise.resolve('v1.sp.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB'));
    const command: OpenSupportThreadCommand = {
      commandId,
      commandType: 'support.open-thread',
      schemaVersion: 1,
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      idempotencyKey: `support:${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { text: '  Please help  ' },
    };
    const result = await new OpenSupportThreadHandler(
      { open },
      { issue, resolve: vi.fn() },
      ids,
    ).execute(command);
    expect(result).toMatchObject({
      supportActionToken: 'v1.sp.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB',
      unansweredUserMessages: 1,
      changedAt: '2026-09-28T00:00:00.000Z',
    });
    expect(issue).toHaveBeenCalledWith(userId, result.supportThreadId, commandId);
  });
});
