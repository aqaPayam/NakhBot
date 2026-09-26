import { describe, expect, it } from 'vitest';

import { roundRobinWork } from './load-smoke-order.js';

describe('load-smoke work ordering', () => {
  it('distributes a bounded connection window evenly across independent scopes', () => {
    const scopes = Array.from({ length: 10 }, (_, index) => `session-${index}`);
    const work = roundRobinWork(scopes, 20, (scope, round) => ({ scope, round }));

    expect(work).toHaveLength(200);
    for (const scope of scopes) {
      const scoped = work.filter((item) => item.scope === scope);
      expect(scoped).toHaveLength(20);
      expect(scoped.map((item) => item.round)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    }

    const initialPoolWindow = work.slice(0, 60);
    expect(
      Object.fromEntries(
        scopes.map((scope) => [
          scope,
          initialPoolWindow.filter((item) => item.scope === scope).length,
        ]),
      ),
    ).toEqual(Object.fromEntries(scopes.map((scope) => [scope, 6])));
  });

  it('rejects invalid round counts', () => {
    expect(() => roundRobinWork(['scope'], -1, () => 'work')).toThrow(RangeError);
    expect(() => roundRobinWork(['scope'], 0.5, () => 'work')).toThrow(RangeError);
  });
});
