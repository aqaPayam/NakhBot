import {
  AdminActionAuthorizationService,
  GetSafetyQueueActionsHandler,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
export class PostgresGetSafetyQueueActionsHandler extends GetSafetyQueueActionsHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new PostgresAdminQueueIdentityStore(database),
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
    );
  }
}
