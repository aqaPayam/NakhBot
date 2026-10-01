import { reportUnavailable, type ReportPhotoContent } from '@nakh/application';
import type { NakhDatabase } from './database.js';

/** Media-owned internal port. Caller supplies the governing Report transaction. */
export async function retainPhotoEvidenceInTransaction(
  transaction: NakhDatabase,
  input: Readonly<{ evidenceId: string; photoId: string }>,
): Promise<ReportPhotoContent> {
  const source = await transaction
    .selectFrom('media.profile_photos as photo')
    .innerJoin('media.media_assets as asset', 'asset.id', 'photo.asset_id')
    .innerJoin('media.photo_variants as variant', 'variant.asset_id', 'asset.id')
    .select([
      'photo.id',
      'photo.is_primary',
      'asset.id as asset_id',
      'variant.id as variant_id',
      'variant.sha256',
    ])
    .where('photo.id', '=', input.photoId)
    .where('photo.status', '=', 'visible')
    .where('asset.validation_state', '=', 'valid')
    .where('asset.deleted_at', 'is', null)
    .where('asset.storage_deleted_at', 'is', null)
    .where('asset.cleanup_lease_owner', 'is', null)
    .where('variant.variant_type', '=', 'thumbnail')
    .where('variant.transformation_version', '=', 1)
    .where('variant.deleted_at', 'is', null)
    .where('variant.storage_deleted_at', 'is', null)
    .forShare()
    .executeTakeFirst();
  if (source === undefined) throw reportUnavailable();
  const digest = source.sha256.toString('hex');
  await transaction
    .insertInto('media.report_photo_evidence_holds')
    .values({
      report_evidence_id: input.evidenceId,
      photo_id: source.id,
      asset_id: source.asset_id,
      variant_id: source.variant_id,
      content_sha256: digest,
      captured_primary: source.is_primary,
    })
    .execute();
  return {
    evidenceType: 'photo',
    evidenceObjectRef: `v1.pe.${input.evidenceId}`,
    contentSha256: digest,
    primary: source.is_primary,
  };
}
