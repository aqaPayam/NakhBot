import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { AccountReturnActivationAuthority, UserProductLife } from '@nakh/application';
import {
  RedisAccountReturnActivation,
  type AccountReturnRedisScripts,
} from './account-return-activation.js';

function scene(): {
  life: { userId: string; productEpoch: number };
  returnAuditId: string;
  evalScript: Mock<AccountReturnRedisScripts['eval']>;
  authorize: Mock<AccountReturnActivationAuthority['withCurrentReturn']>;
  authority: AccountReturnActivationAuthority;
  activation: RedisAccountReturnActivation;
} {
  const life = { userId: randomUUID(), productEpoch: 1 },
    returnAuditId = randomUUID();
  const evalScript = vi.fn<AccountReturnRedisScripts['eval']>().mockResolvedValue(1);
  const authorize = vi.fn<AccountReturnActivationAuthority['withCurrentReturn']>(
    async (captured, _hash, effect) => {
      await effect({ ...captured, previousProductEpoch: captured.productEpoch - 1, returnAuditId });
    },
  );
  const authority: AccountReturnActivationAuthority = { withCurrentReturn: authorize };
  return {
    life,
    returnAuditId,
    evalScript,
    authority,
    authorize,
    activation: new RedisAccountReturnActivation({ eval: evalScript }, 'm8-return-unit', authority),
  };
}
describe('native-bound opaque state activation', () => {
  it('binds exact life/namespace, stores no raw identity or proof in Redis and accepts only applied/replayed results', async () => {
    const f = scene();
    await f.activation.activate(f.life);
    expect(f.authorize).toHaveBeenCalledWith(
      f.life,
      f.activation.namespaceHash,
      expect.any(Function),
    );
    const args = f.evalScript.mock.calls[0]!;
    expect(args[1]).toBe(3);
    expect(args.slice(-2)).toEqual(['0', '1']);
    expect(JSON.stringify(args)).not.toContain(f.life.userId);
    expect(JSON.stringify(args)).not.toContain(f.returnAuditId);
    f.evalScript.mockResolvedValueOnce(0);
    await expect(f.activation.activate(f.life)).resolves.toBeUndefined();
    for (const value of [-1, 2, '1', null, undefined]) {
      f.evalScript.mockResolvedValueOnce(value);
      await expect(f.activation.activate(f.life)).rejects.toThrow(
        'Opaque state activation is unavailable.',
      );
    }
  });
  it('freezes the original life before native/provider waits', async () => {
    const f = scene(),
      original = { ...f.life };
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.authority.withCurrentReturn = async (captured, _hash, effect) => {
      await gate;
      await effect({
        ...captured,
        previousProductEpoch: captured.productEpoch - 1,
        returnAuditId: f.returnAuditId,
      });
    };
    const result = f.activation.activate(f.life);
    f.life.userId = randomUUID();
    f.life.productEpoch = 2;
    release();
    await result;
    expect(f.evalScript.mock.calls[0]!.slice(-2)).toEqual(['0', '1']);
    expect(JSON.stringify(f.evalScript.mock.calls)).not.toContain(original.userId);
  });
  it('rejects invalid life/configuration and substituted native proof before Redis', async () => {
    const f = scene();
    for (const life of [
      { ...f.life, productEpoch: 0 },
      { ...f.life, productEpoch: 2147483648 },
      { ...f.life, userId: 'invalid' },
    ])
      await expect(f.activation.activate(life)).rejects.toThrow('unavailable');
    expect(f.evalScript).not.toHaveBeenCalled();
    for (const change of [
      { userId: randomUUID() },
      { productEpoch: 2 },
      { previousProductEpoch: 1 },
      { returnAuditId: 'invalid' },
    ]) {
      f.authority.withCurrentReturn = async (captured, _hash, effect) =>
        effect({ ...captured, previousProductEpoch: 0, returnAuditId: f.returnAuditId, ...change });
      await expect(f.activation.activate(f.life)).rejects.toThrow('unavailable');
    }
    expect(f.evalScript).not.toHaveBeenCalled();
    expect(
      () => new RedisAccountReturnActivation({ eval: f.evalScript }, 'invalid space', f.authority),
    ).toThrow('unavailable');
  });
  it('never calls Redis after native denial and strips native/provider error content', async () => {
    const f = scene();
    f.authority.withCurrentReturn = () => Promise.reject(new Error('private native proof'));
    await expect(f.activation.activate(f.life)).rejects.toThrow(
      'Opaque state activation is unavailable.',
    );
    expect(f.evalScript).not.toHaveBeenCalled();
    const g = scene();
    g.evalScript.mockRejectedValue(new Error('private Redis body'));
    await expect(g.activation.activate(g.life as UserProductLife)).rejects.toThrow(
      'Opaque state activation is unavailable.',
    );
  });
  it('bounds an unavailable provider while safely observing a late result', async () => {
    vi.useFakeTimers();
    try {
      const f = scene();
      let finish!: (value: unknown) => void;
      f.evalScript.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const result = f.activation.activate(f.life).then(
        () => ({ completed: true }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toMatchObject({
        error: new Error('Opaque state activation is unavailable.'),
      });
      finish(1);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
});
