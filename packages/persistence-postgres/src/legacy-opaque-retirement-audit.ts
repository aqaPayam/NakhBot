import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { LegacyOpaqueRetirementAudit } from '@nakh/application';
import type { NakhDatabase } from './database.js';

const AUTHORIZED = 'platform.legacy-opaque-retirement-authorized.v1';
const OBSERVED = 'platform.legacy-opaque-retirement-observed.v1';
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function unavailable(): never {
  throw new Error('Legacy opaque retirement audit is unavailable.');
}

/** Internal deployment migration authority, not a user deletion phase receipt.
 * Prepared facts survive uncertain provider outcomes. No missing observation is
 * interpreted as successful removal; Root completion needs independent evidence. */
export class PostgresLegacyOpaqueRetirementAudit implements LegacyOpaqueRetirementAudit {
  public constructor(private readonly database: NakhDatabase) {}
  private async safe<T>(execute: () => Promise<T>): Promise<T> {
    try {
      return await execute();
    } catch {
      unavailable();
    }
  }
  public async prepare(
    input: Parameters<LegacyOpaqueRetirementAudit['prepare']>[0],
  ): Promise<string> {
    if (
      !HASH.test(input.namespaceHash) ||
      !HASH.test(input.cursorHash) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      unavailable();
    return this.safe(async () => {
      const id = randomUUID();
      await this.database
        .insertInto('platform.audit_logs')
        .values({
          id,
          category: 'security',
          event_type: AUTHORIZED,
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          subject_type: 'opaque_retirement',
          subject_id: id,
          result_code: 'authorized',
          metadata_schema_version: 1,
          metadata: {
            namespaceHash: input.namespaceHash,
            cursorHash: input.cursorHash,
            limit: input.limit,
          },
          command_id: id,
          request_id: id,
          occurred_at: sql<Date>`clock_timestamp()`,
        })
        .execute();
      return id;
    });
  }
  public async observe(
    id: string,
    observation: Parameters<LegacyOpaqueRetirementAudit['observe']>[1],
  ): Promise<void> {
    if (
      !UUID.test(id) ||
      !Number.isSafeInteger(observation.removed) ||
      observation.removed < 0 ||
      !HASH.test(observation.nextCursorHash) ||
      typeof observation.hasMore !== 'boolean'
    )
      unavailable();
    const metadata = {
      removed: observation.removed,
      nextCursorHash: observation.nextCursorHash,
      hasMore: observation.hasMore,
    };
    await this.safe(() =>
      this.database.transaction().execute(async (transaction) => {
        const authorized = await transaction
          .selectFrom('platform.audit_logs')
          .select('metadata')
          .where('id', '=', id)
          .where('category', '=', 'security')
          .where('event_type', '=', AUTHORIZED)
          .where('actor_type', '=', 'system')
          .where('actor_user_id', 'is', null)
          .where('actor_admin_id', 'is', null)
          .where('subject_type', '=', 'opaque_retirement')
          .where('subject_id', '=', id)
          .where('result_code', '=', 'authorized')
          .where('metadata_schema_version', '=', 1)
          .where('command_id', '=', id)
          .where('request_id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        const source = authorized?.metadata;
        if (
          source === undefined ||
          Object.keys(source).length !== 3 ||
          typeof source.namespaceHash !== 'string' ||
          !HASH.test(source.namespaceHash) ||
          typeof source.cursorHash !== 'string' ||
          !HASH.test(source.cursorHash) ||
          typeof source.limit !== 'number' ||
          !Number.isSafeInteger(source.limit) ||
          source.limit < 1 ||
          source.limit > 100 ||
          metadata.removed > source.limit
        )
          unavailable();
        const existing = await transaction
          .selectFrom('platform.audit_logs')
          .select(['id', 'metadata'])
          .where('category', '=', 'security')
          .where('event_type', '=', OBSERVED)
          .where('subject_type', '=', 'opaque_retirement')
          .where('subject_id', '=', id)
          .where('actor_type', '=', 'system')
          .where('actor_user_id', 'is', null)
          .where('actor_admin_id', 'is', null)
          .where('command_id', '=', id)
          .where('request_id', '=', id)
          .where('result_code', '=', 'observed')
          .where('metadata_schema_version', '=', 1)
          .execute();
        if (existing.length > 0) {
          const same = await sql<{
            same: boolean;
          }>`SELECT ${JSON.stringify(existing[0]!.metadata)}::jsonb = ${JSON.stringify(metadata)}::jsonb AS same`.execute(
            transaction,
          );
          if (existing.length !== 1 || same.rows[0]?.same !== true) unavailable();
          return;
        }
        await transaction
          .insertInto('platform.audit_logs')
          .values({
            id: randomUUID(),
            category: 'security',
            event_type: OBSERVED,
            actor_type: 'system',
            actor_user_id: null,
            actor_admin_id: null,
            subject_type: 'opaque_retirement',
            subject_id: id,
            result_code: 'observed',
            metadata_schema_version: 1,
            metadata,
            command_id: id,
            request_id: id,
            occurred_at: sql<Date>`clock_timestamp()`,
          })
          .execute();
      }),
    );
  }
}
