import {
  AdminActionAuthorizationService,
  ClaimModerationReviewsHandler,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresModerationReviewWorkflow } from './moderation-review-store.js';
import { SystemIdGenerator } from './foundation-store.js';

export class PostgresClaimModerationReviewsHandler extends ClaimModerationReviewsHandler {
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
      new PostgresModerationReviewWorkflow(database),
      new SystemIdGenerator(),
      now,
    );
  }
}
