import {
  ConfirmedReviewDecisions,
  type OpaqueTokenStore,
  type ReviewNoteProtector,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { postgresConfirmationBoundary } from './confirmed-support-store.js';
import { PostgresReviewDecisionWorkflow } from './review-decision-store.js';
export class PostgresConfirmedReviewDecisions extends ConfirmedReviewDecisions {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    notes: ReviewNoteProtector,
    now: () => number = Date.now,
  ) {
    super(
      postgresConfirmationBoundary(database, tokens, key, now),
      new PostgresReviewDecisionWorkflow(database, notes),
    );
  }
}
