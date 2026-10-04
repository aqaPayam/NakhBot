import { describe, expect, it } from 'vitest';
import { canApplyAccountModerationAction } from './moderation.js';
import { ACCOUNT_STATES } from '../identity/account.js';
describe('Account moderation action state eligibility', () => {
  it('permits only the native current-state matrix, including no moderation of deleted accounts', () => {
    const allowed = {
      restrict_user: ['guest', 'incomplete', 'active'],
      unrestrict_user: ['restricted'],
      ban_user: ['guest', 'incomplete', 'active', 'restricted'],
      unban_user: ['banned'],
    };
    for (const action of ['restrict_user', 'unrestrict_user', 'ban_user', 'unban_user'] as const)
      for (const state of ACCOUNT_STATES)
        expect(canApplyAccountModerationAction(state, action), `${state}/${action}`).toBe(
          allowed[action].includes(state),
        );
  });
});
