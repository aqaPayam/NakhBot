import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SubmitAppealCommand } from '@nakh/contracts';
import type { OpaqueTokenStore } from '../security/opaque-token.js';
import { BanOpaqueReferences, SubmitAppealHandler, type UserAppealWrite } from './appeal.js';
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

describe('Ban references', () => {
  it('binds the normalized submission digest to the resolved event and refuses invalid references', async () => {
    const userId = randomUUID();
    let banId = randomUUID();
    const writes: UserAppealWrite[] = [];
    const submit = vi.fn((write: UserAppealWrite) => {
      writes.push(write);
      return Promise.resolve({
        appealId: write.appealId,
        status: 'submitted' as const,
        version: 1,
        changedAt: new Date().toISOString(),
        replayed: false,
      });
    });
    const resolve = vi.fn((): Promise<string | undefined> => Promise.resolve(banId));
    const handler = new SubmitAppealHandler({ submit }, { resolve }, { uuid: randomUUID });
    const command: SubmitAppealCommand = {
      commandId: randomUUID(),
      commandType: 'moderation.submit-appeal',
      schemaVersion: 1,
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { banActionToken: 'opaque', text: '  Please reconsider  ' },
    };
    await handler.execute(command);
    await handler.execute({ ...command, data: { ...command.data, text: 'Please reconsider' } });
    expect(writes[0]!.normalizedText).toBe('Please reconsider');
    expect(writes[0]!.requestDigest).toBe(writes[1]!.requestDigest);
    banId = randomUUID();
    await handler.execute(command);
    expect(writes[2]!.requestDigest).not.toBe(writes[0]!.requestDigest);
    resolve.mockResolvedValueOnce(undefined);
    await expect(handler.execute(command)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      handler.execute({ ...command, data: { ...command.data, text: ' ' } }),
    ).rejects.toMatchObject({ code: 'appeal_text_invalid' });
    expect(submit).toHaveBeenCalledTimes(3);
  });
  it('binds opaque references to an exact user and event with expiry and purpose separation', async () => {
    let now = 1800000000000;
    const tokens = new MemoryTokens();
    const refs = new BanOpaqueReferences(tokens, Buffer.alloc(32, 1), () => now);
    const user = randomUUID(),
      ban = randomUUID(),
      command = randomUUID();
    const token = await refs.issue(user, ban, command);
    expect(token).not.toContain(user);
    expect(token).not.toContain(ban);
    expect(await refs.issue(user, ban, command)).toBe(token);
    expect(await refs.resolve(token, user)).toBe(ban);
    expect(await refs.resolve(token, randomUUID())).toBeUndefined();
    expect(await refs.resolve(token.replace('v1.bn', 'v1.sp'), user)).toBeUndefined();
    const tampered = token.slice(0, -1) + (token.endsWith('x') ? 'y' : 'x');
    expect(await refs.resolve(tampered, user)).toBeUndefined();
    expect(await refs.issue(user, randomUUID(), command)).not.toBe(token);
    now += 86400000;
    expect(await refs.resolve(token, user)).toBeUndefined();
  });
});
