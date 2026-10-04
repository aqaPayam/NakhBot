import {
  AdminActionAuthorizationService,
  PrepareSupportActionHandler,
  type SupportActionPreparationStore,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
class PostgresSupportActionPreparationStore implements SupportActionPreparationStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async get(threadId: string): ReturnType<SupportActionPreparationStore['get']> {
    return this.database
      .selectFrom('support.support_threads')
      .select(['version', 'status'])
      .where('id', '=', threadId)
      .executeTakeFirst();
  }
}
export class PostgresPrepareSupportActionHandler extends PrepareSupportActionHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAdminQueueIdentityStore(database),
      new PostgresSupportActionPreparationStore(database),
    );
  }
}
