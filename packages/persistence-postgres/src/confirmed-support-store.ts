import {
  AdminActionAuthorizationService,
  AdminConfirmationTokens,
  ConfirmedAdminCommandBoundary,
  ConfirmedSupportCommands,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresSupportAdminWorkflow } from './support-store.js';
import { SystemIdGenerator } from './foundation-store.js';
export function postgresConfirmationBoundary(
  database: NakhDatabase,
  tokens: OpaqueTokenStore,
  key: Uint8Array,
  now: () => number = Date.now,
): ConfirmedAdminCommandBoundary {
  return new ConfirmedAdminCommandBoundary(
    new AdminActionAuthorizationService(
      new PostgresAdminAuthorizationStore(database),
      tokens,
      key,
      now,
    ),
    new AdminConfirmationTokens(tokens, key, now),
    new SystemIdGenerator(),
    now,
  );
}
export class PostgresConfirmedSupportCommands extends ConfirmedSupportCommands {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    now: () => number = Date.now,
  ) {
    super(
      postgresConfirmationBoundary(database, tokens, key, now),
      new PostgresSupportAdminWorkflow(database),
    );
  }
}
