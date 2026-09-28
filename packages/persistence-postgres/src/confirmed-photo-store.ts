import {
  ConfirmedPhotoActions,
  type OpaqueTokenStore,
  type PhotoDeliveryRevocation,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { postgresConfirmationBoundary } from './confirmed-support-store.js';
import { PostgresPhotoModerationWorkflow } from './photo-moderation-store.js';
export class PostgresConfirmedPhotoActions extends ConfirmedPhotoActions {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    delivery: PhotoDeliveryRevocation,
    now: () => number = Date.now,
  ) {
    super(
      postgresConfirmationBoundary(database, tokens, key, now),
      new PostgresPhotoModerationWorkflow(database, delivery),
    );
  }
}
