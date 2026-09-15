import { describe, expect, it, vi } from 'vitest';

import type { Clock, IdGenerator } from '@nakh/domain';

import {
  ListOwnPhotosHandler,
  ModeratePhotoHandler,
  MutateOwnPhotosHandler,
  type PhotoManagementStore,
} from './photo-management.js';

const collection = { profileVersion: 3, photos: [] } as const;
const clock: Clock = { now: () => new Date('2026-09-10T00:00:00.000Z') };
let sequence = 0;
const ids: IdGenerator = { uuid: () => `id-${++sequence}` };

function store(): Readonly<{
  persistence: PhotoManagementStore;
  listOwn: ReturnType<typeof vi.fn>;
  mutateOwn: ReturnType<typeof vi.fn>;
  moderate: ReturnType<typeof vi.fn>;
}> {
  const listOwn = vi.fn().mockResolvedValue(collection);
  const mutateOwn = vi.fn().mockResolvedValue(collection);
  const moderate = vi.fn().mockResolvedValue(undefined);
  return { persistence: { listOwn, mutateOwn, moderate }, listOwn, mutateOwn, moderate };
}

describe('photo management handlers', () => {
  it('keeps list and mutation ownership bound to the authenticated user', async () => {
    sequence = 0;
    const { persistence, mutateOwn } = store();
    await expect(
      new ListOwnPhotosHandler(persistence).execute({ kind: 'user', userId: 'user-1' }),
    ).resolves.toBe(collection);
    await new MutateOwnPhotosHandler(persistence, ids, clock).execute({
      actor: { kind: 'user', userId: 'user-1' },
      expectedProfileVersion: 3,
      action: { type: 'select_primary', photoId: 'photo-2' },
      commandId: 'command-1',
      requestId: 'request-1',
      idempotencyKey: 'telegram-update:1',
    });
    expect(mutateOwn).toHaveBeenCalledWith({
      userId: 'user-1',
      expectedProfileVersion: 3,
      action: { type: 'select_primary', photoId: 'photo-2' },
      commandId: 'command-1',
      requestId: 'request-1',
      idempotencyKey: 'telegram-update:1',
      auditId: 'id-1',
      eventId: 'id-2',
      profileEventId: 'id-3',
      occurredAt: clock.now(),
    });
  });

  it.each(['admin', 'system'] as const)('denies %s access to owner operations', (kind) => {
    const { persistence, listOwn } = store();
    expect(() =>
      new ListOwnPhotosHandler(persistence).execute({ kind, userId: 'actor' }),
    ).toThrowError(expect.objectContaining({ code: 'unauthorized' }));
    expect(listOwn).not.toHaveBeenCalled();
  });

  it('validates moderation authority and stable reason codes before persistence', async () => {
    sequence = 0;
    const { persistence, moderate } = store();
    const handler = new ModeratePhotoHandler(persistence, ids, clock);
    expect(() =>
      handler.execute({
        actor: { kind: 'user', userId: 'user-1' },
        photoId: 'photo',
        action: 'hide',
        reasonCode: 'report',
      }),
    ).toThrowError(expect.objectContaining({ code: 'reviewer_unauthorized' }));
    expect(() =>
      handler.execute({
        actor: { kind: 'admin', userId: 'admin-1' },
        photoId: 'photo',
        action: 'hide',
        reasonCode: 'BAD CODE',
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    await handler.execute({
      actor: { kind: 'admin', userId: 'admin-1' },
      photoId: 'photo',
      action: 'hide',
      reasonCode: 'report_confirmed',
    });
    expect(moderate).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: 'admin-1',
        photoId: 'photo',
        action: 'hide',
        reasonCode: 'report_confirmed',
      }),
    );
  });
});
