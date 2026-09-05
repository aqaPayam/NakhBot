import { describe, expect, it } from 'vitest';

import {
  normalizeProfileChangeReviewNote,
  normalizeProtectedProfileChange,
} from './protected-change.js';

const clock = { now: () => new Date('2026-09-05T00:00:00.000Z') };

describe('protected Profile changes', () => {
  it('normalizes a valid reason and applies the signup age rule', () => {
    expect(
      normalizeProtectedProfileChange(
        { field: 'birth_year', requestedValue: 2000, reason: '  correction  ' },
        clock,
      ),
    ).toEqual({ field: 'birth_year', requestedValue: 2000, reason: 'correction' });
    expect(() =>
      normalizeProtectedProfileChange(
        { field: 'birth_year', requestedValue: 2010, reason: 'correction' },
        clock,
      ),
    ).toThrowError(expect.objectContaining({ code: 'underage' }));
  });

  it('rejects malformed gender codes and normalizes an optional review note', () => {
    expect(() =>
      normalizeProtectedProfileChange(
        { field: 'gender', requestedValue: 'Not A Code', reason: 'correction' },
        clock,
      ),
    ).toThrowError(expect.objectContaining({ code: 'profile_change_invalid' }));
    expect(normalizeProfileChangeReviewNote('  reviewed  ')).toBe('reviewed');
  });
});
