import { describe, expect, it } from 'vitest';

import { ApplicationError, SystemClock } from './index.js';

describe('domain foundation', () => {
  it('keeps stable application error information', () => {
    const error = new ApplicationError('conflict', 'conflict', 409, { field: 'name' });

    expect(error).toMatchObject({ name: 'ApplicationError', code: 'conflict', status: 409 });
    expect(error.details).toEqual({ field: 'name' });
  });

  it('provides a UTC-capable system clock', () => {
    expect(new SystemClock().now()).toBeInstanceOf(Date);
  });
});
