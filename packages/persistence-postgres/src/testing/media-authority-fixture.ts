import { createHash, randomUUID } from 'node:crypto';
import type { NakhDatabase } from '../database.js';
import { createReportLike, createReportPhoto, createReportUser } from './report-fixture.js';

export async function createMediaAuthorityFixture(
  database: NakhDatabase,
  purpose: 'owner_preview' | 'liked_by_blur' = 'owner_preview',
  registeredOwner?: string,
): Promise<{
  ownerUserId: string;
  actorUserId: string;
  photoId: string;
  assetId: string;
  variantId: string;
  likeId: string | null;
}> {
  const now = new Date();
  const ownerUserId = registeredOwner ?? (await createReportUser(database, true));
  if (registeredOwner !== undefined) {
    await database
      .updateTable('identity.accounts')
      .set({ state: 'active' })
      .where('user_id', '=', ownerUserId)
      .execute();
    await database
      .insertInto('profile.profiles')
      .values({
        id: randomUUID(),
        user_id: ownerUserId,
        name: 'Synthetic media authority subject',
        birth_year: 1995,
        gender_option_id: '20000000-0000-4000-8000-000000000001',
        gender_preference_id: '20000000-0000-4000-8000-000000000013',
        relationship_goal_id: '20000000-0000-4000-8000-000000000021',
        country_id: '20000000-0000-4000-8000-000000000101',
        province_id: '20000000-0000-4000-8000-000000000111',
        city_id: '20000000-0000-4000-8000-000000000121',
        highlight: 'Synthetic authority fixture',
        bio: null,
        completion_status: 'complete',
        ever_completed: true,
        completed_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  const actorUserId =
    purpose === 'owner_preview' ? ownerUserId : await createReportUser(database, true);
  await database
    .insertInto('identity.user_settings')
    .values({
      user_id: actorUserId,
      visibility_enabled: true,
      ui_locale_code: 'en',
      version: 1,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) => conflict.column('user_id').doNothing())
    .execute();
  const photoId = await createReportPhoto(database, ownerUserId, true, new Uint8Array([1, 2, 3]));
  const photo = await database
    .selectFrom('media.profile_photos')
    .select('asset_id')
    .where('id', '=', photoId)
    .executeTakeFirstOrThrow();
  const assetId = photo.asset_id;
  let likeId: string | null = null;
  if (purpose === 'liked_by_blur') {
    likeId = await createReportLike(database, actorUserId, ownerUserId);
    await database
      .insertInto('media.photo_variants')
      .values({
        id: randomUUID(),
        asset_id: assetId,
        variant_type: 'blurred_preview',
        transformation_version: 1,
        storage_provider: 'r2',
        storage_key: `variants/test/${assetId}/blurred-preview-v1.webp`,
        delivery_path: `/media/${assetId}/blurred-preview-v1.webp`,
        width: 96,
        height: 96,
        sha256: createHash('sha256')
          .update(new Uint8Array([1, 2, 3]))
          .digest(),
        generated_at: now,
        verified_at: now,
        deleted_at: null,
        storage_deleted_at: null,
      })
      .execute();
  }
  const variant = await database
    .selectFrom('media.photo_variants')
    .select('id')
    .where('asset_id', '=', assetId)
    .where('variant_type', '=', purpose === 'owner_preview' ? 'thumbnail' : 'blurred_preview')
    .executeTakeFirstOrThrow();
  return { ownerUserId, actorUserId, photoId, assetId, variantId: variant.id, likeId };
}
