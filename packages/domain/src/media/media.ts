import { ApplicationError } from '../foundation.js';

export const MEDIA_LIMITS = {
  maximumUploadBytes: 10 * 1024 * 1024,
  minimumWidth: 600,
  minimumHeight: 600,
  maximumDimension: 12_000,
  maximumPixels: 40_000_000,
  maximumSavedPhotos: 6,
  minimumVisiblePhotos: 2,
  uploadAttemptsPerWindow: 20,
  uploadAttemptWindowMs: 24 * 60 * 60 * 1_000,
} as const;

export const ACCEPTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type AcceptedMediaType = (typeof ACCEPTED_MEDIA_TYPES)[number];
export type MediaValidationState = 'pending' | 'valid' | 'rejected' | 'failed';
export type PhotoStatus = 'visible' | 'hidden' | 'deleted';
export type PhotoVariantType = 'thumbnail' | 'blurred_preview';
export type PhotoModerationAction = 'hide' | 'restore' | 'delete';

export type PhotoState = Readonly<{
  id: string;
  status: PhotoStatus;
  isPrimary: boolean;
  displayOrder: number;
}>;

export type PhotoCollectionEvaluation = Readonly<{
  savedCount: number;
  visibleCount: number;
  visiblePrimaryId: string | null;
  profileMediaEligible: boolean;
}>;

export function assertUploadAttemptAvailable(attemptCount: number): void {
  if (!Number.isInteger(attemptCount) || attemptCount < 0) {
    throw new ApplicationError('invalid_request', 'error.media.upload_attempts.invalid', 400);
  }
  if (attemptCount >= MEDIA_LIMITS.uploadAttemptsPerWindow) {
    throw new ApplicationError(
      'photo_upload_limit_reached',
      'error.media.upload_attempt_limit',
      429,
    );
  }
}

export function assertDeclaredUpload(
  input: Readonly<{ sizeBytes?: number; mediaType?: string }>,
): void {
  if (
    input.sizeBytes !== undefined &&
    (!Number.isInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      input.sizeBytes > MEDIA_LIMITS.maximumUploadBytes)
  ) {
    throw new ApplicationError('media_too_large', 'error.media.size', 400);
  }
  if (
    input.mediaType !== undefined &&
    !(ACCEPTED_MEDIA_TYPES as readonly string[]).includes(input.mediaType)
  ) {
    throw new ApplicationError('unsupported_media_type', 'error.media.type', 400);
  }
}

export function assertDecodedImage(
  input: Readonly<{
    mediaType: string;
    sizeBytes: number;
    width: number;
    height: number;
    frameCount: number;
  }>,
): asserts input is Readonly<{
  mediaType: AcceptedMediaType;
  sizeBytes: number;
  width: number;
  height: number;
  frameCount: 1;
}> {
  assertDeclaredUpload(input);
  const dimensionsAreSafe =
    Number.isInteger(input.width) &&
    Number.isInteger(input.height) &&
    input.width >= MEDIA_LIMITS.minimumWidth &&
    input.height >= MEDIA_LIMITS.minimumHeight &&
    input.width <= MEDIA_LIMITS.maximumDimension &&
    input.height <= MEDIA_LIMITS.maximumDimension &&
    input.width * input.height <= MEDIA_LIMITS.maximumPixels;
  if (!dimensionsAreSafe) {
    throw new ApplicationError('media_dimensions_invalid', 'error.media.dimensions', 400);
  }
  if (input.frameCount !== 1) {
    throw new ApplicationError('unsupported_media_type', 'error.media.animation', 400);
  }
}

export function transitionValidationState(
  current: MediaValidationState,
  next: MediaValidationState,
): MediaValidationState {
  if (current !== 'pending' || next === 'pending') {
    throw new ApplicationError('media_invalid_state', 'error.media.state', 409);
  }
  return next;
}

export function evaluatePhotoCollection(photos: readonly PhotoState[]): PhotoCollectionEvaluation {
  const active = photos.filter((photo) => photo.status !== 'deleted');
  const visible = active.filter((photo) => photo.status === 'visible');
  const primaries = visible.filter((photo) => photo.isPrimary);
  return {
    savedCount: active.length,
    visibleCount: visible.length,
    visiblePrimaryId: primaries.length === 1 ? primaries[0]!.id : null,
    profileMediaEligible:
      active.length <= MEDIA_LIMITS.maximumSavedPhotos &&
      visible.length >= MEDIA_LIMITS.minimumVisiblePhotos &&
      primaries.length === 1,
  };
}

export function planVisiblePhoto(photos: readonly PhotoState[], photoId: string): PhotoState {
  const evaluation = evaluatePhotoCollection(photos);
  if (evaluation.savedCount >= MEDIA_LIMITS.maximumSavedPhotos) {
    throw new ApplicationError('photo_limit_reached', 'error.media.photo_limit', 409);
  }
  if (photos.some((photo) => photo.id === photoId)) {
    throw new ApplicationError('duplicate_media', 'error.media.duplicate', 409);
  }
  return {
    id: photoId,
    status: 'visible',
    isPrimary: evaluation.visiblePrimaryId === null,
    displayOrder: Math.max(-1, ...photos.map((photo) => photo.displayOrder)) + 1,
  };
}

function activePhoto(photos: readonly PhotoState[], photoId: string): PhotoState {
  const photo = photos.find(
    (candidate) => candidate.id === photoId && candidate.status !== 'deleted',
  );
  if (!photo) throw new ApplicationError('photo_not_found', 'error.media.photo_not_found', 404);
  return photo;
}

export function selectPrimaryPhoto(
  photos: readonly PhotoState[],
  photoId: string,
): readonly PhotoState[] {
  const selected = activePhoto(photos, photoId);
  if (selected.status !== 'visible') {
    throw new ApplicationError('media_invalid_state', 'error.media.primary_not_visible', 409);
  }
  return photos.map((photo) => ({
    ...photo,
    isPrimary: photo.status === 'visible' && photo.id === photoId,
  }));
}

export function reorderPhotos(
  photos: readonly PhotoState[],
  orderedPhotoIds: readonly string[],
): readonly PhotoState[] {
  const activeIds = photos
    .filter((photo) => photo.status !== 'deleted')
    .map((photo) => photo.id)
    .sort();
  const requestedIds = [...orderedPhotoIds].sort();
  if (
    orderedPhotoIds.length !== new Set(orderedPhotoIds).size ||
    activeIds.length !== requestedIds.length ||
    activeIds.some((id, index) => id !== requestedIds[index])
  ) {
    throw new ApplicationError('invalid_request', 'error.media.photo_order', 400);
  }
  const order = new Map(orderedPhotoIds.map((id, index) => [id, index]));
  return photos.map((photo) =>
    photo.status === 'deleted' ? photo : { ...photo, displayOrder: order.get(photo.id)! },
  );
}

export function deleteOwnPhoto(
  photos: readonly PhotoState[],
  photoId: string,
): readonly PhotoState[] {
  const selected = activePhoto(photos, photoId);
  if (selected.isPrimary) {
    throw new ApplicationError(
      'photo_primary_delete_denied',
      'error.media.select_primary_before_delete',
      409,
    );
  }
  return photos.map((photo) =>
    photo.id === photoId ? { ...photo, status: 'deleted', isPrimary: false } : photo,
  );
}

export function moderatePhoto(
  photos: readonly PhotoState[],
  photoId: string,
  action: PhotoModerationAction,
): readonly PhotoState[] {
  const selected = activePhoto(photos, photoId);
  if (action === 'hide' && selected.status !== 'visible') {
    throw new ApplicationError('media_invalid_state', 'error.media.state', 409);
  }
  if (action === 'restore' && selected.status !== 'hidden') {
    throw new ApplicationError('media_invalid_state', 'error.media.state', 409);
  }

  const nextStatus: PhotoStatus =
    action === 'hide' ? 'hidden' : action === 'restore' ? 'visible' : 'deleted';
  let result: readonly PhotoState[] = photos.map((photo) =>
    photo.id === photoId ? { ...photo, status: nextStatus, isPrimary: false } : photo,
  );
  if (selected.isPrimary && action !== 'restore') {
    const replacement = result
      .filter((photo) => photo.status === 'visible')
      .sort((left, right) => left.displayOrder - right.displayOrder)[0];
    if (replacement) result = selectPrimaryPhoto(result, replacement.id);
  }
  const evaluation = evaluatePhotoCollection(result);
  if (evaluation.visibleCount > 0 && evaluation.visiblePrimaryId === null) {
    const replacement = result
      .filter((photo) => photo.status === 'visible')
      .sort((left, right) => left.displayOrder - right.displayOrder)[0]!;
    result = selectPrimaryPhoto(result, replacement.id);
  }
  return result;
}

export function variantFailureInvalidatesPhoto(type: PhotoVariantType): boolean {
  return type === 'thumbnail';
}
