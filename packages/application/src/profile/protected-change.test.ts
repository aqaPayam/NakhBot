import { describe, expect, it, vi } from 'vitest';

import type { ResolveProtectedProfileChangeCommand } from '@nakh/contracts';

import {
  ResolveProtectedProfileChangeHandler,
  type ProfileChangeReviewerAuthorizationPort,
  type ProfileChangeStore,
} from './protected-change.js';

const command: ResolveProtectedProfileChangeCommand = {
  commandId: '10000000-0000-4000-8000-000000000001',
  commandType: 'profile.resolve-protected-change',
  schemaVersion: 1,
  actor: { kind: 'admin', userId: '20000000-0000-4000-8000-000000000001' },
  requestId: '30000000-0000-4000-8000-000000000001',
  idempotencyKey: 'resolve-profile-change',
  occurredAt: '2026-09-05T00:00:00.000Z',
  locale: 'en',
  channelContext: { channel: 'internal' },
  data: {
    profileChangeRequestId: '40000000-0000-4000-8000-000000000001',
    decision: 'approved',
  },
};

describe('ResolveProtectedProfileChangeHandler', () => {
  it('refuses an unauthorized reviewer before entering the store', async () => {
    const resolveProtectedChange = vi.fn();
    const store = { resolveProtectedChange } as unknown as ProfileChangeStore;
    const authorization: ProfileChangeReviewerAuthorizationPort = {
      authorize: () => Promise.resolve(undefined),
    };
    await expect(
      new ResolveProtectedProfileChangeHandler(
        store,
        authorization,
        { uuid: () => '50000000-0000-4000-8000-000000000001' },
        { now: () => new Date('2026-09-05T00:00:00.000Z') },
      ).execute(command),
    ).rejects.toMatchObject({ code: 'reviewer_unauthorized' });
    expect(resolveProtectedChange).not.toHaveBeenCalled();
  });
});
