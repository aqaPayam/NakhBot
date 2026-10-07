import { describe, expect, it } from 'vitest';
import { ACCOUNT_STATES } from './account.js';
import {
  ACCOUNT_DELETION_PHASES,
  assertDeletionAdvance,
  evaluateAccountReturn,
} from './deletion.js';

describe('M8 ordered deletion and fresh-return authority', () => {
  it('rejects skipped, repeated, reversed and terminal checkpoint changes', () => {
    for (const [index, current] of ACCOUNT_DELETION_PHASES.entries())
      for (const next of ACCOUNT_DELETION_PHASES) {
        const advance = (): void => assertDeletionAdvance(current, next);
        if (ACCOUNT_DELETION_PHASES[index + 1] === next) expect(advance).not.toThrow();
        else expect(advance).toThrow();
      }
  });
  it('requires completed purge, explicit return approval and no retained safety bar', () => {
    for (const accountState of ACCOUNT_STATES)
      for (const purgeCompleted of [false, true])
        for (const reactivationAllowed of [false, true])
          for (const retainedSafetyBar of ['none', 'restricted', 'banned', 'unresolved'] as const) {
            const decision = evaluateAccountReturn({
              accountState,
              purgeCompleted,
              reactivationAllowed,
              retainedSafetyBar,
            });
            expect(decision === 'allowed').toBe(
              accountState === 'deleted' &&
                purgeCompleted &&
                reactivationAllowed &&
                retainedSafetyBar === 'none',
            );
          }
  });
});
