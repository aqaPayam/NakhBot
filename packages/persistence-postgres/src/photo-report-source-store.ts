import {
  PrepareSingleReportEvidenceHandler,
  type ReportEvidenceIntent,
  type ReportSource,
  type ReportTokens,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { resolveProfileReportSource } from './profile-report-source-store.js';

/** Selected-photo context is retained server-side; it cannot override authoritative target ownership. */
export async function resolvePhotoReportSource(
  database: NakhDatabase,
  actorUserId: string,
  source: ReportSource,
  lockSource = false,
): Promise<ReportEvidenceIntent | undefined> {
  if (source.photoId === undefined) return undefined;
  const profile = await resolveProfileReportSource(database, actorUserId, source, lockSource);
  if (profile === undefined) return undefined;
  let query = database
    .selectFrom('media.profile_photos as photo')
    .innerJoin('media.media_assets as asset', 'asset.id', 'photo.asset_id')
    .innerJoin('media.photo_variants as variant', 'variant.asset_id', 'asset.id')
    .select('photo.id')
    .where('photo.id', '=', source.photoId)
    .where('photo.profile_id', '=', profile.evidence[0]!.referenceId)
    .where('photo.status', '=', 'visible')
    .where('asset.owner_user_id', '=', profile.targetUserId)
    .where('asset.validation_state', '=', 'valid')
    .where('asset.deleted_at', 'is', null)
    .where('asset.storage_deleted_at', 'is', null)
    .where('asset.cleanup_lease_owner', 'is', null)
    .where('variant.variant_type', '=', 'thumbnail')
    .where('variant.deleted_at', 'is', null)
    .where('variant.storage_deleted_at', 'is', null);
  if (lockSource) query = query.forShare();
  const photo = await query.executeTakeFirst();
  return photo === undefined
    ? undefined
    : {
        source,
        targetUserId: profile.targetUserId,
        evidence: [{ evidenceType: 'photo', referenceId: photo.id }],
      };
}
export class PostgresPreparePhotoReportEvidenceHandler extends PrepareSingleReportEvidenceHandler {
  public constructor(database: NakhDatabase, tokens: ReportTokens) {
    super(
      tokens,
      { resolve: (actor, source) => resolvePhotoReportSource(database, actor, source) },
      'photo',
    );
  }
}
