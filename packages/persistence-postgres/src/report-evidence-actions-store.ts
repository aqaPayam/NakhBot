import {
  AdminActionAuthorizationService,
  GetReportEvidenceActionsHandler,
  type OpaqueTokenStore,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresGetReportEvidenceMetadataHandler } from './report-evidence-metadata-store.js';

export class PostgresGetReportEvidenceActionsHandler extends GetReportEvidenceActionsHandler {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    now: () => number = Date.now,
    supportedTypes: readonly ('profile' | 'photo' | 'chat' | 'unmatched_user')[] = ['profile'],
  ) {
    const authorization = new AdminActionAuthorizationService(
      new PostgresAdminAuthorizationStore(database),
      tokens,
      key,
      now,
    );
    super(
      new PostgresGetReportEvidenceMetadataHandler(database, tokens, key, now),
      async (actor, evidenceId) => {
        if (actor.kind !== 'admin')
          throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
        const admin = await database
          .selectFrom('administration.admin_users')
          .select('telegram_user_id')
          .where('user_id', '=', actor.userId)
          .executeTakeFirst();
        if (admin === undefined)
          throw new ApplicationError('forbidden', 'error.admin.unauthorized', 403);
        // Identity, active state and current permission are rechecked by issuance. Token storage is outside SQL transactions.
        return authorization.issue({
          actorUserId: actor.userId,
          telegramUserId: admin.telegram_user_id,
          scope: {
            commandCode: 'moderation.reveal-evidence',
            requiredPermission: 'view_reports',
            targetType: 'report_evidence',
            targetId: evidenceId,
            expectedTargetVersion: 1,
          },
        });
      },
      supportedTypes,
    );
  }
}
