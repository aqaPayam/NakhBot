import {
  AdminActionAuthorizationService,
  type AdminActionScope,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { Actor } from '@nakh/domain';
import type { NakhDatabase } from '../database.js';
import { PostgresAdminAuthorizationStore } from '../admin-authorization-store.js';

export async function confirmationFixture(
  database: NakhDatabase,
  adminId: string,
): Promise<
  Readonly<{
    actor: Actor & { kind: 'admin' };
    tokens: OpaqueTokenStore;
    key: Uint8Array;
    issue: (scope: AdminActionScope) => Promise<string>;
  }>
> {
  const admin = await database
    .selectFrom('administration.admin_users')
    .selectAll()
    .where('id', '=', adminId)
    .executeTakeFirstOrThrow();
  const values = new Map<string, string>();
  const tokens: OpaqueTokenStore = {
    get: (id) => Promise.resolve(values.get(id)),
    putIfAbsent: (id, value) => {
      if (values.has(id)) return Promise.resolve(false);
      values.set(id, value);
      return Promise.resolve(true);
    },
  };
  const key = Buffer.alloc(32, 8);
  const authorization = new AdminActionAuthorizationService(
    new PostgresAdminAuthorizationStore(database),
    tokens,
    key,
  );
  return {
    actor: { kind: 'admin', userId: admin.user_id },
    tokens,
    key,
    issue: (scope) =>
      authorization.issue({
        actorUserId: admin.user_id,
        telegramUserId: admin.telegram_user_id,
        scope,
      }),
  };
}
