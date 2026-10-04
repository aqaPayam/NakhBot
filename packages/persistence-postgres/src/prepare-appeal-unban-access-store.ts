import {
  AdminActionAuthorizationService,
  PrepareAppealUnbanAccessHandler,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
import { PostgresAppealActionPreparationStore } from './prepare-appeal-review-access-store.js';
export class PostgresPrepareAppealUnbanAccessHandler extends PrepareAppealUnbanAccessHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAdminQueueIdentityStore(database),
      new PostgresAppealActionPreparationStore(database),
    );
  }
}
