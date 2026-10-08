import { sql, type RawBuilder } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import catalog from './deletion-registry.json' with { type: 'json' };
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';

export type DeletionCatalog = Readonly<{
  tables: readonly Readonly<{
    schema: string;
    table: string;
    columns: readonly Readonly<{ name: string; type: string; nullable: boolean }>[];
  }>[];
  foreignKeys: readonly Readonly<{ table: string; target: string; definition: string }>[];
}>;
export type DeletionRegistryEntry = Readonly<{
  table: string;
  owner: string;
  classification: string;
  action: string;
  purpose: string;
  subjectScope: string | null;
  scopeCoverage: string;
  releasePolicy: string | null;
  columns: readonly Readonly<{ name: string; type: string; nullable: boolean }>[];
  foreignKeys: readonly Readonly<{ target: string; definition: string }>[];
}>;
function freeze(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
freeze(catalog);
/** Reviewed code-owned inventory. Neither clients nor runtime policy can add SQL. */
export const DELETION_REGISTRY: readonly DeletionRegistryEntry[] = catalog.tables;
export const DELETION_OBJECT_PREFIXES = catalog.objectPrefixes;

const ACTIONS: Readonly<Record<string, string>> = {
  reference: 'retain_reference',
  workforce: 'separate_workforce_policy',
  financial: 'retain_financial_obligation',
  retained_safety: 'approved_policy_release',
  retained_compliance: 'approved_policy_release',
  lifecycle: 'retain_lifecycle_proof',
  stable_identity: 'minimize_stable_identity',
  ordinary_owned: 'purge_product',
  ordinary_shared: 'close_snapshot_then_purge',
  financial_projection: 'fence_epoch_then_reset',
  media: 'revoke_verify_objects_then_purge',
  transport: 'cancel_then_expire_or_redact',
  operations: 'typed_operational_policy',
  test_only: 'purge_test_data',
};
if (
  catalog.retainedDataReleaseEnabled !== false ||
  DELETION_REGISTRY.some(
    (entry) =>
      ACTIONS[entry.classification] !== entry.action ||
      entry.owner !== entry.table.split('.')[0] ||
      !entry.purpose ||
      !/^[a-z_]+\.[a-z_]+$/u.test(entry.table) ||
      (entry.subjectScope !== null && !entry.subjectScope.includes(':userId')) ||
      ([
        'financial',
        'retained_safety',
        'retained_compliance',
        'workforce',
        'lifecycle',
        'operations',
      ].includes(entry.classification) &&
        entry.releasePolicy !== 'approval_required'),
  )
)
  throw conflict();

function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
function canonical(value: unknown): string {
  return JSON.stringify(value);
}
/** A schema change must classify every new/changed column and foreign-key action.
 * Returns a fixed denial, never catalog details or private row values. */
export function assertDeletionCatalogCoverage(actual: DeletionCatalog): void {
  const tableNames = actual.tables.map((item) => `${item.schema}.${item.table}`).sort();
  if (canonical(tableNames) !== canonical(DELETION_REGISTRY.map((item) => item.table).sort()))
    throw conflict();
  for (const expected of DELETION_REGISTRY) {
    const table = actual.tables.find((item) => `${item.schema}.${item.table}` === expected.table);
    const columns = (
      items: DeletionCatalog['tables'][number]['columns'],
    ): readonly (readonly [string, string, boolean])[] =>
      items.map(({ name, type, nullable }) => [name, type, nullable] as const);
    if (
      table === undefined ||
      canonical(columns(table.columns)) !== canonical(columns(expected.columns))
    )
      throw conflict();
    const keys = actual.foreignKeys
      .filter((item) => item.table === expected.table)
      .map(({ target, definition }) => ({ target, definition }))
      .sort((a, b) => a.definition.localeCompare(b.definition));
    if (canonical(keys) !== canonical(expected.foreignKeys)) throw conflict();
  }
  if (actual.foreignKeys.some((item) => !tableNames.includes(item.table))) throw conflict();
}
export async function readDeletionCatalog(database: NakhDatabase): Promise<DeletionCatalog> {
  if (!database.isTransaction) return database.transaction().execute(readDeletionCatalog);
  // pg_get_constraintdef is search-path sensitive. A qualified path makes exact
  // dependencies independent of the application's usual owning-schema path.
  const path = (
    await sql<{ path: string }>`SELECT current_setting('search_path') AS path`.execute(database)
  ).rows[0]!.path;
  await sql`SELECT set_config('search_path','pg_catalog',true)`.execute(database);
  try {
    const tables = (
      await sql<DeletionCatalog['tables'][number]>`SELECT n.nspname AS schema,c.relname AS table,
        (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
          'nullable',NOT a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
        ORDER BY n.nspname,c.relname`.execute(database)
    ).rows;
    const foreignKeys = (
      await sql<DeletionCatalog['foreignKeys'][number]>`SELECT n.nspname||'.'||c.relname AS table,
        rn.nspname||'.'||rc.relname AS target,pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class rc ON rc.oid=con.confrelid
        JOIN pg_namespace rn ON rn.oid=rc.relnamespace
        WHERE con.contype='f' AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
        ORDER BY n.nspname,c.relname,pg_get_constraintdef(con.oid)`.execute(database)
    ).rows;
    return { tables, foreignKeys };
  } finally {
    await sql`SELECT set_config('search_path',${path},true)`.execute(database);
  }
}
function subjectPredicate(entry: DeletionRegistryEntry, userId: string): RawBuilder<unknown> {
  if (entry.subjectScope === null) throw conflict();
  return sql.join(
    entry.subjectScope.split(':userId').map((part) => sql.raw(part)),
    sql`${userId}::uuid`,
  );
}
export type DeletionRegistryObservation = Readonly<{
  resourceIndex: number;
  classification: string;
  action: string;
  scope: 'linked_rows' | 'global_typed_obligations';
  present: boolean | null;
  hasMore: boolean;
}>;
/** Bounded, fenced existence observation only. No content, subject identifiers,
 * exact row counts, purge permission or phase-completion claim leaves the store.
 * Global/polymorphic operational obligations remain unknown until their owning
 * typed executor proves them; null must never be interpreted as absence. */
export class PostgresDeletionRegistryStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  public async observe(
    lease: AccountDeletionLease,
    resourceIndex: number,
  ): Promise<DeletionRegistryObservation> {
    if (!Number.isSafeInteger(resourceIndex) || resourceIndex < 0) throw conflict();
    const entry = DELETION_REGISTRY[resourceIndex];
    if (entry === undefined) throw conflict();
    try {
      return await this.work.withLease(lease, async (tx, scope) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const present =
          entry.subjectScope === null
            ? null
            : (
                await sql<{
                  present: boolean;
                }>`SELECT EXISTS(SELECT 1 FROM ${sql.table(entry.table)} AS row
          WHERE ${subjectPredicate(entry, scope.userId)} LIMIT 1) AS present`.execute(tx)
              ).rows[0]!.present;
        return {
          resourceIndex,
          classification: entry.classification,
          action: entry.action,
          scope: entry.subjectScope === null ? 'global_typed_obligations' : 'linked_rows',
          present,
          hasMore: resourceIndex < DELETION_REGISTRY.length - 1,
        };
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw conflict();
    }
  }
}
