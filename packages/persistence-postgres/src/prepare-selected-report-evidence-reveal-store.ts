import {
  AdminActionAuthorizationService,
  GetSelectedReportEvidenceMetadataHandler,
  PrepareSelectedReportEvidenceRevealHandler,
  type GetReportEvidenceActionsHandler,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
import { PostgresSelectedReportEvidenceMetadataStore } from './selected-report-evidence-metadata-store.js';

/** Uses the owning host's native actions so reader support has one source of truth. */
export class PostgresPrepareSelectedReportEvidenceRevealHandler extends PrepareSelectedReportEvidenceRevealHandler {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    actions: Pick<GetReportEvidenceActionsHandler, 'execute'>,
  ) {
    super(
      new GetSelectedReportEvidenceMetadataHandler(
        new AdminActionAuthorizationService(
          new PostgresAdminAuthorizationStore(database),
          tokens,
          key,
        ),
        new PostgresAdminQueueIdentityStore(database),
        new PostgresSelectedReportEvidenceMetadataStore(database),
        actions,
      ),
    );
  }
}
