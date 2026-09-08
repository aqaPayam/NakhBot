import { sql } from 'kysely';
import type {
  ConfirmationMediaSelection,
  ProfileMediaEligibilityPort,
  ProfileMediaEligibilityProof,
} from '@nakh/application';
import { ApplicationError, MEDIA_LIMITS, type IdGenerator } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

function denied(): never {
  throw new ApplicationError('media_not_eligible', 'error.profile.media_not_eligible', 409);
}

/** The caller holds User then Profile/draft locks. Lock assets and variants in ID order
 * so a concurrent soft-delete cannot invalidate the selection before commit. */
export async function lockEligibleMedia(
  database: NakhDatabase,
  userId: string,
  selection: ConfirmationMediaSelection,
): Promise<readonly string[]> {
  const ids = [selection.primaryMediaAssetId, ...selection.additionalMediaAssetIds];
  if (
    ids.length < MEDIA_LIMITS.minimumVisiblePhotos ||
    ids.length > MEDIA_LIMITS.maximumSavedPhotos ||
    new Set(ids).size !== ids.length
  )
    denied();
  const assets = await database
    .selectFrom('media.media_assets')
    .selectAll()
    .where('id', 'in', ids)
    .orderBy('id')
    .forUpdate()
    .execute();
  if (
    assets.length !== ids.length ||
    assets.some(
      (asset) =>
        asset.owner_user_id !== userId ||
        asset.validation_state !== 'valid' ||
        asset.deleted_at !== null ||
        asset.storage_deleted_at !== null,
    )
  )
    denied();
  const variants = await database
    .selectFrom('media.photo_variants')
    .select(['asset_id', 'deleted_at', 'storage_deleted_at'])
    .where('asset_id', 'in', ids)
    .where('variant_type', '=', 'thumbnail')
    .where('transformation_version', '=', 1)
    .orderBy('id')
    .forUpdate()
    .execute();
  if (
    variants.length !== ids.length ||
    variants.some((variant) => variant.deleted_at !== null || variant.storage_deleted_at !== null)
  )
    denied();
  const assigned = await database
    .selectFrom('media.profile_photos')
    .select('id')
    .where('asset_id', 'in', ids)
    .execute();
  if (assigned.length !== 0) denied();
  return ids;
}

/** Called while holding the Profile lock; all lifecycle writers must follow the same lock order. */
export async function profilePhotosAreEligible(
  database: NakhDatabase,
  profileId: string,
): Promise<boolean> {
  const photos = await database
    .selectFrom('media.profile_photos as photo')
    .innerJoin('media.media_assets as asset', 'asset.id', 'photo.asset_id')
    .innerJoin('profile.profiles as profile', 'profile.id', 'photo.profile_id')
    .leftJoin('media.photo_variants as variant', (join) =>
      join
        .onRef('variant.asset_id', '=', 'asset.id')
        .on('variant.variant_type', '=', 'thumbnail')
        .on('variant.transformation_version', '=', 1),
    )
    .select([
      'photo.status',
      'photo.is_primary',
      'asset.owner_user_id',
      'profile.user_id',
      'asset.validation_state',
      'asset.deleted_at as assetDeleted',
      'asset.storage_deleted_at as assetPurged',
      'variant.id as variantId',
      'variant.deleted_at as variantDeleted',
      'variant.storage_deleted_at as variantPurged',
    ])
    .where('photo.profile_id', '=', profileId)
    .where('photo.status', '!=', 'deleted')
    .execute();
  const visible = photos.filter((photo) => photo.status === 'visible');
  return (
    photos.length <= MEDIA_LIMITS.maximumSavedPhotos &&
    visible.length >= MEDIA_LIMITS.minimumVisiblePhotos &&
    visible.filter((photo) => photo.is_primary).length === 1 &&
    visible.every(
      (photo) =>
        photo.owner_user_id === photo.user_id &&
        photo.validation_state === 'valid' &&
        photo.assetDeleted === null &&
        photo.assetPurged === null &&
        photo.variantId !== null &&
        photo.variantDeleted === null &&
        photo.variantPurged === null,
    )
  );
}

export class PostgresProfileMediaEligibility implements ProfileMediaEligibilityPort {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly ids: IdGenerator,
  ) {}

  public async issueProof(
    userId: string,
    selection: ConfirmationMediaSelection,
  ): Promise<ProfileMediaEligibilityProof> {
    return this.database.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined) denied();
      const acceptedMediaAssetIds = await lockEligibleMedia(transaction, userId, selection);
      const { now } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`
        .execute(transaction)
        .then((result) => result.rows[0]!);
      return {
        proofId: this.ids.uuid(),
        userId,
        primaryMediaAssetId: selection.primaryMediaAssetId,
        acceptedMediaAssetIds,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      };
    });
  }
}
