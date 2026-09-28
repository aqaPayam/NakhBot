import {
  AdminActionAuthorizationService,
  AdminConfirmationTokens,
  ConfirmedAppealCommands,
  type OpaqueTokenStore,
} from '@nakh/application';

import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAppealReviewWorkflow } from './appeal-review-store.js';
import { PostgresAppealUnbanWorkflow } from './appeal-unban-store.js';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';

export class PostgresConfirmedAppealCommands extends ConfirmedAppealCommands {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    now: () => number = Date.now,
  ) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
        now,
      ),
      new AdminConfirmationTokens(tokens, key, now),
      new PostgresAppealReviewWorkflow(database),
      new PostgresAppealUnbanWorkflow(database),
      new SystemIdGenerator(),
      now,
    );
  }
}
