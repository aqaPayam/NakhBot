import {
  AdminActionAuthorizationService,
  GetAppealMetadataHandler,
  SafetyMetadataCursors,
  type OpaqueTokenStore,
  type AppealMetadataReadStore,
  type SafetyMetadataViewer,
  type SafetyMetadataPosition,
} from '@nakh/application';
import type { AppealStatus, AppealMetadataPage } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { appealMetadataStatement } from './m7-queue-statements.js';
export class PostgresAppealMetadataStore implements AppealMetadataReadStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async page(
    viewer: SafetyMetadataViewer,
    status: AppealStatus,
    limit: number,
    after?: SafetyMetadataPosition,
  ): Promise<
    Readonly<{ items: AppealMetadataPage['items']; next: SafetyMetadataPosition | undefined }>
  > {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    return this.database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('administration.admin_users')
        .select('id')
        .where('id', '=', viewer.adminUserId)
        .forShare()
        .executeTakeFirst();
      const facts = await new PostgresAdminAuthorizationStore(tx).loadCurrent(viewer);
      if (
        facts === undefined ||
        !facts.adminActive ||
        !facts.activePermissions.includes('review_appeals')
      )
        throw new ApplicationError('forbidden', 'error.admin.unauthorized', 403);
      const result = await appealMetadataStatement(status, limit, after).execute(tx);
      const rows = result.rows.slice(0, limit),
        last = rows.at(-1);
      return {
        items: rows.map((row) => ({
          appealId: row.id,
          status: row.status,
          version: row.version,
          submittedAt: row.submitted_at.toISOString(),
        })),
        next:
          result.rows.length > limit && last !== undefined
            ? { at: last.cursor_time, id: last.id }
            : undefined,
      };
    });
  }
}
export class PostgresGetAppealMetadataHandler extends GetAppealMetadataHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAppealMetadataStore(database),
      new SafetyMetadataCursors(tokens, key),
    );
  }
}
