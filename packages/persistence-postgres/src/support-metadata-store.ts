import { sql } from 'kysely';
import {
  AdminActionAuthorizationService,
  GetSupportMetadataHandler,
  SafetyMetadataCursors,
  type OpaqueTokenStore,
  type SupportMetadataReadStore,
  type SafetyMetadataViewer,
  type SafetyMetadataPosition,
} from '@nakh/application';
import type { SupportThreadStatus, SupportMetadataPage } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
export class PostgresSupportMetadataStore implements SupportMetadataReadStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async page(
    viewer: SafetyMetadataViewer,
    status: SupportThreadStatus,
    limit: number,
    after?: SafetyMetadataPosition,
  ): Promise<
    Readonly<{ items: SupportMetadataPage['items']; next: SafetyMetadataPosition | undefined }>
  > {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    return this.database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('administration.admin_users')
        .select('id')
        .where('id', '=', viewer.adminUserId)
        .forShare()
        .executeTakeFirst();
      const facts = await new PostgresAdminAuthorizationStore(tx).loadCurrent(viewer);
      if (
        facts === undefined ||
        !facts.adminActive ||
        !facts.activePermissions.includes('review_support')
      )
        throw new ApplicationError('forbidden', 'error.admin.unauthorized', 403);
      const position =
        after === undefined
          ? sql`TRUE`
          : sql`(thread.created_at, thread.id) > (${after.at}::timestamptz, ${after.id}::uuid)`;
      const result = await sql<{
        id: string;
        status: SupportThreadStatus;
        version: number;
        created_at: Date;
        last_message_at: Date;
        cursor_time: string;
      }>`SELECT thread.id, thread.status, thread.version, thread.created_at, thread.last_message_at,
        to_char(thread.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
        FROM support.support_threads thread WHERE thread.status = ${status} AND ${position} ORDER BY thread.created_at, thread.id LIMIT ${limit + 1}`.execute(
        tx,
      );
      const rows = result.rows.slice(0, limit),
        last = rows.at(-1);
      return {
        items: rows.map((row) => ({
          threadId: row.id,
          status: row.status,
          version: row.version,
          createdAt: row.created_at.toISOString(),
          lastMessageAt: row.last_message_at.toISOString(),
        })),
        next:
          result.rows.length > limit && last !== undefined
            ? { at: last.cursor_time, id: last.id }
            : undefined,
      };
    });
  }
}
export class PostgresGetSupportMetadataHandler extends GetSupportMetadataHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresSupportMetadataStore(database),
      new SafetyMetadataCursors(tokens, key),
    );
  }
}
