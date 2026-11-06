import { describe, expect, it } from 'vitest';
import { fullProfileTextParts, type FullProfileDisplay } from './profile-detail-text.js';
const profile: FullProfileDisplay = {
  name: 'Synthetic',
  age: 30,
  locationLabelKeys: [],
  genderLabelKey: 'gender',
  preferenceLabelKey: 'preference',
  goalLabelKey: 'goal',
  interestLabelKeys: [],
  highlight: '',
  bio: '',
  optional: [],
};
describe('private profile text presentation', () => {
  it('preserves every Unicode point across bounded message chunks', () => {
    const text = 'a'.repeat(3499) + '😀'.repeat(4000);
    const parts = fullProfileTextParts(profile, (key) =>
      key === 'profile.ui.details' ? text : key,
    );
    expect(parts.join('')).toBe(text);
    expect(
      parts.every(
        (p) => p.length <= 3500 && !/[\uD800-\uDBFF]$/u.test(p) && !/^[\uDC00-\uDFFF]/u.test(p),
      ),
    ).toBe(true);
  });
  it('rejects empty or unexpectedly oversized rendered profiles', () => {
    for (const text of ['', 'x'.repeat(16001)])
      expect(() => fullProfileTextParts(profile, () => text)).toThrow();
  });
});
