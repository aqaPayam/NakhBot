import { sql } from 'kysely';
import type { AuditedReportPhotoRequest, AuditedReportPhotoStore } from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';

/** Media-owned physical retention resolution; logical deletion does not invalidate safety holds. */
export class PostgresAuditedReportPhotoStore implements AuditedReportPhotoStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async resolve(
    input: AuditedReportPhotoRequest,
  ): ReturnType<AuditedReportPhotoStore['resolve']> {
    if (input.actor.kind !== 'admin') return undefined;
    const facts = await new PostgresAdminAuthorizationStore(this.database).loadByTelegramIdentity({
      actorUserId: input.actor.userId,
      telegramUserId: input.recipient,
    });
    if (
      facts === undefined ||
      !facts.adminActive ||
      !facts.activePermissions.includes('view_reports')
    )
      return undefined;
    const row = await this.database
      .selectFrom('media.report_photo_evidence_holds as hold')
      .innerJoin('moderation.report_evidence as evidence', 'evidence.id', 'hold.report_evidence_id')
      .innerJoin('media.photo_variants as variant', (join) =>
        join
          .onRef('variant.id', '=', 'hold.variant_id')
          .onRef('variant.asset_id', '=', 'hold.asset_id'),
      )
      .innerJoin('media.media_assets as asset', 'asset.id', 'hold.asset_id')
      .innerJoin('moderation.evidence_access_audits as access', (join) =>
        join
          .onRef('access.report_evidence_id', '=', 'evidence.id')
          .onRef('access.report_id', '=', 'evidence.report_id'),
      )
      .innerJoin('administration.admin_action_logs as log', (join) =>
        join
          .onRef('log.command_id', '=', 'access.command_id')
          .onRef('log.admin_user_id', '=', 'access.admin_user_id')
          .onRef('log.request_id', '=', 'access.request_id')
          .onRef('log.target_id', '=', 'evidence.id'),
      )
      .select(['variant.storage_key', 'variant.sha256', 'hold.content_sha256', 'hold.asset_id'])
      .where('evidence.id', '=', input.objectRef.slice(6))
      .where('evidence.evidence_type', '=', 'photo')
      .whereRef('evidence.profile_photo_id', '=', 'hold.photo_id')
      .where('access.admin_user_id', '=', facts.adminUserId)
      .where('access.command_id', '=', input.commandId)
      .where('access.permission_code', '=', 'view_reports')
      .where('access.reason_code', '=', 'report_evidence_review')
      .where('access.outcome', '=', 'revealed')
      .where('access.safe_code', '=', 'evidence_revealed')
      .where('log.id', '=', input.logId)
      .where('log.command_code', '=', 'moderation.reveal-evidence')
      .where('log.target_type', '=', 'report_evidence')
      .where('log.expected_target_version', '=', 1)
      .where('log.result', '=', 'succeeded')
      .where('log.safe_code', '=', 'evidence_revealed')
      .where('log.created_at', '>', sql<Date>`now() - interval '5 minutes'`)
      .where('variant.variant_type', '=', 'thumbnail')
      .where('variant.transformation_version', '=', 1)
      .where('variant.storage_provider', '=', 'r2')
      .where('asset.storage_provider', '=', 'r2')
      .where('asset.validation_state', '=', 'valid')
      .where('variant.storage_deleted_at', 'is', null)
      .where('asset.storage_deleted_at', 'is', null)
      .where('asset.cleanup_lease_owner', 'is', null)
      .executeTakeFirst();
    if (
      row === undefined ||
      row.content_sha256 !== input.contentSha256 ||
      row.sha256.toString('hex') !== input.contentSha256 ||
      !new RegExp(
        `^variants/(?:development|test|staging|production)/${row.asset_id}/thumbnail-v1\\.webp$`,
        'u',
      ).test(row.storage_key)
    )
      return undefined;
    const current = await new PostgresAdminAuthorizationStore(this.database).loadByTelegramIdentity(
      {
        actorUserId: input.actor.userId,
        telegramUserId: input.recipient,
      },
    );
    if (
      current === undefined ||
      !current.adminActive ||
      current.adminUserId !== facts.adminUserId ||
      !current.activePermissions.includes('view_reports')
    )
      return undefined;
    return { storageKey: row.storage_key, sha256: row.content_sha256 };
  }
}
