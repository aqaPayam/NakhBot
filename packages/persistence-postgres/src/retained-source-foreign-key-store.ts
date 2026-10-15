import { sql } from 'kysely';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import {
  assertDeletionCatalogCoverage,
  readDeletionCatalog,
  DELETION_REGISTRY,
} from './deletion-registry.js';
import {
  PostgresRetentionPeriodReviewStore,
  type RetentionPeriodReview,
} from './retention-policy-store.js';

export type RetainedSourceForeignKeyReview = Readonly<{
  sourceAuditId: string;
  period: RetentionPeriodReview;
  sourceStatus: 'not_checked' | 'changed' | 'matches';
  foreignKeysChecked: boolean;
  blockers: readonly Readonly<{ resource: string; classification: string; action: string }>[];
  releaseEnabled: false;
}>;
function unavailable(): never {
  throw new ApplicationError('conflict', 'error.deletion.unavailable', 409);
}
/** One exact original source, in the policy transaction. Incoming references
 * always block, including CASCADE/SET NULL and another participant's rows.
 * Absence of FKs does not clear logical, provider, legal or safety obligations.
 * A returned review is never a lease or permission to mutate retained data. */
export class PostgresRetainedSourceForeignKeyStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async review(
    input: Readonly<{
      deletionRecordId: string;
      sourceAuditId: string;
      expectedRootVersion: number;
    }>,
  ): Promise<RetainedSourceForeignKeyReview> {
    const { deletionRecordId, sourceAuditId, expectedRootVersion } = input;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
    if (
      !uuid.test(deletionRecordId) ||
      !uuid.test(sourceAuditId) ||
      !Number.isSafeInteger(expectedRootVersion) ||
      expectedRootVersion < 0 ||
      expectedRootVersion > 2147483647
    )
      throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
    const review = async (tx: NakhDatabase): Promise<RetainedSourceForeignKeyReview> => {
      const proof = async (): Promise<{
        recordId: string;
        resource: string;
        keyHash: string;
        rowHash: string;
        userId: string;
      }> => {
        const row = (
          await sql<{
            recordId: string;
            resource: string;
            keyHash: string;
            rowHash: string;
            userId: string;
          }>`SELECT a.metadata->>'retentionRecordId' AS "recordId",
          a.metadata->>'resource' AS resource,a.metadata->>'rowKeyHash' AS "keyHash",a.metadata->>'rowHash' AS "rowHash",root.user_id AS "userId"
          FROM platform.audit_logs a JOIN identity.account_deletion_records root ON root.id=a.subject_id
          WHERE a.id=${sourceAuditId}::uuid AND a.subject_id=${deletionRecordId}::uuid AND a.event_type='account.retained-source-recorded.v1'
          AND identity.retained_source_proof_valid(a,false)`.execute(tx)
        ).rows[0];
        return row ?? unavailable();
      };
      const original = await proof();
      // Reuses this transaction, including User/Account/Root locks. Opening a
      // second transaction here would wait on our own locks and permit stale
      // policy or Return observations between the two reviews.
      const period = await new PostgresRetentionPeriodReviewStore(tx).review({
        deletionRecordId,
        retentionRecordId: original.recordId,
        expectedRootVersion,
      });
      const result = (
        sourceStatus: RetainedSourceForeignKeyReview['sourceStatus'],
        foreignKeysChecked: boolean,
        blockers: RetainedSourceForeignKeyReview['blockers'],
      ): RetainedSourceForeignKeyReview =>
        Object.freeze({
          sourceAuditId,
          period,
          sourceStatus,
          foreignKeysChecked,
          blockers: Object.freeze(blockers),
          releaseEnabled: false,
        });
      if (period.status !== 'period_elapsed') return result('not_checked', false, []);
      const current = await proof();
      if (
        current.resource !== period.resource ||
        current.recordId !== period.retentionRecordId ||
        current.keyHash !== original.keyHash ||
        current.rowHash !== original.rowHash
      )
        unavailable();
      const resource = DELETION_REGISTRY.find((entry) => entry.table === current.resource);
      if (resource?.action !== 'approved_policy_release' || resource.subjectScope === null)
        return unavailable();
      assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
      const keys = (
        await sql<{ name: string }>`SELECT a.attname AS name FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY key(attnum,ordinality)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum
        WHERE i.indrelid=${resource.table}::regclass AND i.indisprimary AND i.indisvalid AND key.ordinality<=i.indnkeyatts ORDER BY key.ordinality`.execute(
          tx,
        )
      ).rows;
      if (
        keys.length === 0 ||
        keys.some(
          (key) =>
            !resource.columns.some(
              (column) =>
                column.name === key.name &&
                ['uuid', 'integer', 'bigint', 'smallint', 'text'].includes(column.type),
            ),
        )
      )
        unavailable();
      const keyHash = sql`encode(sha256(convert_to(jsonb_build_array(${sql.join(keys.map((key) => sql.ref(`row.${key.name}`)))})::text,'UTF8')),'hex')`;
      const subject = sql.join(
        resource.subjectScope.split(':userId').map((part) => sql.raw(part)),
        sql`${current.userId}::uuid`,
      );
      // Lock only the captured PK before hashing the row in the native UTC
      // context. FOR UPDATE also fences FK admission until this transaction ends.
      const locked = (
        await sql`SELECT 1 FROM ${sql.table(resource.table)} AS row
        WHERE (${subject}) AND ${keyHash}=${current.keyHash} LIMIT 2 FOR UPDATE OF row`.execute(tx)
      ).rows;
      const matches =
        locked.length === 1 &&
        (
          await sql<{ matches: boolean }>`SELECT identity.retained_source_matches(
        ${deletionRecordId}::uuid,${resource.table},${current.keyHash},${current.rowHash}) AS matches`.execute(
            tx,
          )
        ).rows[0]?.matches === true;
      if (!matches) return result('changed', false, []);
      const path = (
        await sql<{ path: string }>`SELECT current_setting('search_path') AS path`.execute(tx)
      ).rows[0]!.path;
      await sql`SELECT set_config('search_path','pg_catalog',true)`.execute(tx);
      const references = (
        await sql<{
          resource: string;
          definition: string;
          columns: { child: string; parent: string }[];
        }>`SELECT n.nspname||'.'||child.relname AS resource,pg_get_constraintdef(c.oid) AS definition,
        (SELECT jsonb_agg(jsonb_build_object('child',a.attname,'parent',p.attname) ORDER BY k.ordinality)
          FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality)
          JOIN unnest(c.confkey) WITH ORDINALITY r(attnum,ordinality) ON r.ordinality=k.ordinality
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
          JOIN pg_attribute p ON p.attrelid=c.confrelid AND p.attnum=r.attnum) AS columns
        FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_namespace n ON n.oid=child.relnamespace
        WHERE c.contype='f' AND c.confrelid=${resource.table}::regclass ORDER BY n.nspname,child.relname,c.conname`.execute(
          tx,
        )
      ).rows;
      await sql`SELECT set_config('search_path',${path},true)`.execute(tx);
      const blockers = new Map<string, RetainedSourceForeignKeyReview['blockers'][number]>();
      for (const reference of references) {
        const child = DELETION_REGISTRY.find((entry) => entry.table === reference.resource);
        if (
          child === undefined ||
          !child.foreignKeys.some(
            (key) => key.target === resource.table && key.definition === reference.definition,
          ) ||
          !Array.isArray(reference.columns) ||
          reference.columns.length === 0 ||
          reference.columns.some(
            (pair) =>
              !child.columns.some((column) => column.name === pair.child) ||
              !resource.columns.some((column) => column.name === pair.parent),
          )
        )
          unavailable();
        const pairs = sql.join(
          reference.columns.map(
            (pair) => sql`${sql.ref(`dependent.${pair.child}`)}=${sql.ref(`row.${pair.parent}`)}`,
          ),
          sql` AND `,
        );
        const present = (
          await sql<{
            present: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM ${sql.table(child.table)} AS dependent
          JOIN ${sql.table(resource.table)} AS row ON ${pairs}
          WHERE (${subject}) AND ${keyHash}=${current.keyHash}) AS present`.execute(tx)
        ).rows[0]?.present;
        if (present === undefined) unavailable();
        if (present)
          blockers.set(
            child.table,
            Object.freeze({
              resource: child.table,
              classification: child.classification,
              action: child.action,
            }),
          );
      }
      return result('matches', true, [...blockers.values()]);
    };
    return this.database.isTransaction
      ? review(this.database)
      : this.database.transaction().execute(review);
  }
}
