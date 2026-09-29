import { ConfirmedReviewAssignments, type OpaqueTokenStore } from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { postgresConfirmationBoundary } from './confirmed-support-store.js';
import { PostgresModerationReviewWorkflow } from './moderation-review-store.js';
export class PostgresConfirmedReviewAssignments extends ConfirmedReviewAssignments {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    now: () => number = Date.now,
  ) {
    super(
      postgresConfirmationBoundary(database, tokens, key, now),
      new PostgresModerationReviewWorkflow(database),
    );
  }
}
