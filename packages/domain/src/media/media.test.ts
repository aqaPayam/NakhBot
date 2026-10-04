import { describe, expect, it } from 'vitest';

import {
  assertDecodedImage,
  assertUploadAttemptAvailable,
  canModeratePhoto,
  deleteOwnPhoto,
  evaluatePhotoCollection,
  MEDIA_LIMITS,
  moderatePhoto,
  planVisiblePhoto,
  reorderPhotos,
  selectPrimaryPhoto,
  transitionValidationState,
  variantFailureInvalidatesPhoto,
  type PhotoState,
} from './media.js';

const photos: readonly PhotoState[] = [
  { id: 'one', status: 'visible', isPrimary: true, displayOrder: 0 },
  { id: 'two', status: 'visible', isPrimary: false, displayOrder: 1 },
  { id: 'three', status: 'hidden', isPrimary: false, displayOrder: 2 },
];

describe('M2 media rules', () => {
  it.each([
    ['visible', 'hide', true],
    ['visible', 'restore', false],
    ['visible', 'delete', true],
    ['hidden', 'hide', false],
    ['hidden', 'restore', true],
    ['hidden', 'delete', true],
    ['deleted', 'hide', false],
    ['deleted', 'restore', false],
    ['deleted', 'delete', false],
  ] as const)(
    'keeps %s/%s preparation and owning lifecycle eligibility aligned',
    (status, action, allowed) => {
      expect(canModeratePhoto(status, action)).toBe(allowed);
      const selected: PhotoState = { id: 'selected', status, isPrimary: false, displayOrder: 0 };
      const apply = (): readonly PhotoState[] => moderatePhoto([selected], selected.id, action);
      if (allowed) expect(apply).not.toThrow();
      else
        expect(apply).toThrowError(
          expect.objectContaining({
            code: status === 'deleted' ? 'photo_not_found' : 'media_invalid_state',
          }),
        );
    },
  );

  it('fails closed for unknown photo states', () => {
    for (const action of ['hide', 'restore', 'delete'] as const)
      expect(canModeratePhoto('unknown', action)).toBe(false);
  });
  it('ACC-008 requires two visible photos and exactly one visible primary', () => {
    expect(evaluatePhotoCollection([photos[0]!, photos[2]!])).toMatchObject({
      savedCount: 2,
      visibleCount: 1,
      profileMediaEligible: false,
    });
    expect(evaluatePhotoCollection(photos).profileMediaEligible).toBe(true);
  });

  it('ACC-009 rejects a seventh saved photo', () => {
    const six = Array.from({ length: 6 }, (_, index): PhotoState => ({
      id: `${index}`,
      status: index === 5 ? 'hidden' : 'visible',
      isPrimary: index === 0,
      displayOrder: index,
    }));
    expect(() => planVisiblePhoto(six, 'seventh')).toThrowError(
      expect.objectContaining({ code: 'photo_limit_reached' }),
    );
  });

  it('ACC-010 and ACC-011 distinguish required thumbnail from optional blur failure', () => {
    expect(variantFailureInvalidatesPhoto('thumbnail')).toBe(true);
    expect(variantFailureInvalidatesPhoto('blurred_preview')).toBe(false);
  });

  it('ACC-012 promotes the lowest-order visible replacement after primary moderation', () => {
    const hidden = moderatePhoto(photos, 'one', 'hide');
    expect(hidden.find((photo) => photo.id === 'one')).toMatchObject({
      status: 'hidden',
      isPrimary: false,
    });
    expect(hidden.find((photo) => photo.id === 'two')?.isPrimary).toBe(true);
    expect(evaluatePhotoCollection(hidden).profileMediaEligible).toBe(false);

    const onlyPrimary: readonly PhotoState[] = [photos[0]!];
    const restored = moderatePhoto(moderatePhoto(onlyPrimary, 'one', 'hide'), 'one', 'restore');
    expect(restored[0]).toMatchObject({ status: 'visible', isPrimary: true });
  });

  it('requires a user to select another primary before deleting the current primary', () => {
    expect(() => deleteOwnPhoto(photos, 'one')).toThrowError(
      expect.objectContaining({ code: 'photo_primary_delete_denied' }),
    );
    const changed = selectPrimaryPhoto(photos, 'two');
    expect(deleteOwnPhoto(changed, 'one').find((photo) => photo.id === 'one')?.status).toBe(
      'deleted',
    );
  });

  it('requires a complete, duplicate-free ordering of saved photos', () => {
    expect(
      reorderPhotos(photos, ['three', 'one', 'two']).map((photo) => photo.displayOrder),
    ).toEqual([1, 2, 0]);
    expect(() => reorderPhotos(photos, ['one', 'one', 'two'])).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('enforces bounded single-frame decoded images independently of client claims', () => {
    expect(() =>
      assertDecodedImage({
        mediaType: 'image/jpeg',
        sizeBytes: MEDIA_LIMITS.maximumUploadBytes,
        width: 600,
        height: 600,
        frameCount: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertDecodedImage({
        mediaType: 'image/gif',
        sizeBytes: 100,
        width: 600,
        height: 600,
        frameCount: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'unsupported_media_type' }));
    expect(() =>
      assertDecodedImage({
        mediaType: 'image/webp',
        sizeBytes: 100,
        width: 600,
        height: 600,
        frameCount: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: 'unsupported_media_type' }));
  });

  it('counts every upload attempt and makes validation states terminal', () => {
    expect(() => assertUploadAttemptAvailable(19)).not.toThrow();
    expect(() => assertUploadAttemptAvailable(20)).toThrowError(
      expect.objectContaining({ code: 'photo_upload_limit_reached' }),
    );
    expect(transitionValidationState('pending', 'valid')).toBe('valid');
    expect(() => transitionValidationState('valid', 'rejected')).toThrowError(
      expect.objectContaining({ code: 'media_invalid_state' }),
    );
  });
});
