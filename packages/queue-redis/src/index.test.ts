import { describe, expect, it } from 'vitest';

import { DOMAIN_EVENT_QUEUE } from './index.js';

describe('queue contracts', () => {
  it('uses a stable queue name', () => {
    expect(DOMAIN_EVENT_QUEUE).toBe('domain-events');
  });
});
