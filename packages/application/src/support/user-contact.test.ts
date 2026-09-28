import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { UserSafetyContactHandler, type SafetyContactState } from './user-contact.js';

const fixture = (
  state: SafetyContactState,
): {
  states: { get: Mock };
  support: { execute: Mock };
  prepare: { execute: Mock };
  appeals: { execute: Mock };
  handler: UserSafetyContactHandler;
} => {
  const states = { get: vi.fn().mockResolvedValue(state) };
  const support = { execute: vi.fn().mockResolvedValue({}) };
  const prepare = { execute: vi.fn().mockResolvedValue('opaque-ban-reference') };
  const appeals = { execute: vi.fn().mockResolvedValue({}) };
  return {
    states,
    support,
    prepare,
    appeals,
    handler: new UserSafetyContactHandler(states, support, prepare, appeals),
  };
};

describe('authenticated safety contact routing', () => {
  const input = {
    userId: randomUUID(),
    commandId: randomUUID(),
    kind: 'support' as const,
    text: 'restricted help text',
  };
  it('routes banned support requests to the appeal prompt without submitting their text', async () => {
    const f = fixture({ route: 'appeal' });
    expect(await f.handler.execute(input)).toEqual({ key: 'appeal.prompt', variables: {} });
    expect(f.support.execute).not.toHaveBeenCalled();
    expect(f.prepare.execute).not.toHaveBeenCalled();
    expect(f.appeals.execute).not.toHaveBeenCalled();
  });
  it('denies unavailable accounts and appeals from nonbanned accounts without writes', async () => {
    for (const state of [{ route: 'unavailable' }, { route: 'support' }] as const) {
      const f = fixture(state);
      expect(await f.handler.execute({ ...input, kind: 'appeal' })).toEqual({
        key: 'error.m7.unavailable',
        variables: {},
      });
      expect(f.support.execute).not.toHaveBeenCalled();
      expect(f.appeals.execute).not.toHaveBeenCalled();
    }
  });
  it.each(['submitted', 'in_review', 'accepted', 'rejected'] as const)(
    'returns only the current appeal status %s',
    async (status) => {
      const f = fixture({ route: 'appeal', status });
      expect(await f.handler.execute({ ...input, kind: 'appeal', text: '' })).toEqual({
        key: `appeal.${status}`,
        variables: {},
      });
      expect(f.appeals.execute).not.toHaveBeenCalled();
    },
  );
  it('passes repeated submissions through the transactional replay boundary even when an appeal exists', async () => {
    const f = fixture({ route: 'appeal', status: 'submitted' });
    for (let n = 0; n < 2; n++)
      expect(await f.handler.execute({ ...input, kind: 'appeal' })).toEqual({
        key: 'appeal.submitted',
        variables: {},
      });
    expect(f.appeals.execute).toHaveBeenCalledTimes(2);
    expect(f.appeals.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        commandId: input.commandId,
        idempotencyKey: input.commandId,
        actor: { kind: 'user', userId: input.userId },
        data: { text: input.text, banActionToken: 'opaque-ban-reference' },
      }),
    );
  });
  it('shows support help without writes and returns no submitted text or identifiers', async () => {
    const f = fixture({ route: 'support' });
    expect(await f.handler.execute({ ...input, text: '' })).toEqual({
      key: 'support.prompt',
      variables: {},
    });
    expect(f.support.execute).not.toHaveBeenCalled();
    expect(await f.handler.execute(input)).toEqual({ key: 'support.sent', variables: {} });
    expect(f.support.execute).toHaveBeenCalledWith(
      expect.objectContaining({ commandType: 'support.open-thread', data: { text: input.text } }),
    );
  });
});
