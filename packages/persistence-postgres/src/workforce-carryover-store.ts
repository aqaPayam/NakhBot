import { createHash, randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import type { NakhDatabase } from './database.js';

type Migration = Readonly<{ name: string; sha256: string }>;
export type WorkforceCarryoverRequest = Readonly<{
  version: 1;
  commandId: string;
  operatorId: string;
  sourceSha: string;
  targetSha: string;
  adminIds: readonly string[];
  sourceMigrations: readonly Migration[];
  targetMigrations: readonly Migration[];
}>;
export type WorkforceCarryoverResult = Readonly<{
  status: 'restored';
  replayed: boolean;
  staffUsers: number;
  activeAdministrators: number;
  credentials: number;
  roleAssignments: number;
  requestDigest: string;
  capsuleDigest: string;
}>;
const TABLES = [
  'identity.users',
  'identity.telegram_identities',
  'administration.admin_users',
  'administration.admin_user_roles',
  'administration.admin_totp_credentials',
  'platform.audit_logs',
] as const;
type Table = (typeof TABLES)[number];
type Row = Record<string, unknown>;
type Rows = Record<Table, Row[]>;
type Columns = Readonly<Record<Table, unknown>>;
const EVENT = 'administration.workforce-carried-over.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function denied(): never {
  throw new Error('Workforce carryover unavailable.');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) denied();
    return encoded;
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
      .join(',') +
    '}'
  );
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function ids(values: readonly unknown[]): string[] {
  if (
    !values.length ||
    values.length > 100 ||
    values.some((v) => typeof v !== 'string' || !UUID.test(v))
  )
    denied();
  return [...new Set(values as string[])].sort();
}
function validateLedger(rows: readonly Migration[]): void {
  const entries: readonly Migration[] = rows;
  if (
    !Array.isArray(rows) ||
    !entries.length ||
    entries.length > 1000 ||
    entries.some(
      (r) =>
        !r ||
        Object.keys(r).sort().join(',') !== 'name,sha256' ||
        !/^\d{6}_[a-z0-9_]+\.sql$/u.test(r.name) ||
        !/^[a-f0-9]{64}$/u.test(r.sha256),
    ) ||
    new Set(entries.map((r) => r.name)).size !== entries.length ||
    entries.some((r, i) => i > 0 && r.name <= entries[i - 1]!.name)
  )
    denied();
}
async function authority(
  db: NakhDatabase,
  expected: readonly Migration[],
): Promise<{ cluster: string; database: string }> {
  await sql`SELECT pg_advisory_xact_lock_shared(hashtext('nakh-schema-migrations'))`.execute(db);
  const caller = (
    await sql<{
      permitted: boolean;
    }>`SELECT rolsuper AS permitted FROM pg_roles WHERE rolname=current_user`.execute(db)
  ).rows[0];
  if (!caller?.permitted) denied();
  const ledger = await db
    .selectFrom('platform.schema_migrations')
    .select(['name', 'sha256'])
    .orderBy('name')
    .execute();
  if (canonical(ledger) !== canonical(expected)) denied();
  return (
    await sql<{
      cluster: string;
      database: string;
    }>`SELECT system_identifier::text AS cluster,current_database() AS database FROM pg_control_system()`.execute(
      db,
    )
  ).rows[0]!;
}
async function columns(db: NakhDatabase): Promise<Columns> {
  const result = {} as Record<Table, unknown>;
  for (const table of TABLES) {
    const row = (
      await sql<{
        columns: unknown;
      }>`SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull) ORDER BY attnum) AS columns FROM pg_attribute WHERE attrelid=to_regclass(${table}) AND attnum>0 AND NOT attisdropped`.execute(
        db,
      )
    ).rows[0];
    if (!row?.columns) denied();
    result[table] = row.columns;
  }
  return result;
}
async function readRows(
  db: NakhDatabase,
  table: Table,
  selector: RawBuilder<unknown>,
  order: RawBuilder<unknown>,
): Promise<Row[]> {
  const extra =
    table === 'identity.telegram_identities' || table === 'administration.admin_users'
      ? sql`jsonb_build_object('telegram_user_id',data.telegram_user_id::text)`
      : table === 'administration.admin_totp_credentials'
        ? sql`jsonb_build_object('last_used_step',data.last_used_step::text)`
        : sql`'{}'::jsonb`;
  return (
    await sql<{
      body: Row;
    }>`SELECT to_jsonb(data)||${extra} AS body FROM ${sql.id(...table.split('.'))} data WHERE ${selector} ORDER BY ${order}`.execute(
      db,
    )
  ).rows.map((r) => r.body);
}
async function capture(db: NakhDatabase, selected: readonly string[]): Promise<Rows> {
  const active = await db
    .selectFrom('administration.admin_users')
    .select('id')
    .where('is_active', '=', true)
    .orderBy('id')
    .execute();
  if (canonical(active.map((r) => r.id)) !== canonical(selected)) denied();
  const roles = await db
    .selectFrom('administration.admin_user_roles')
    .select(['admin_user_id', 'assigned_by_admin_id'])
    .where('admin_user_id', 'in', [...selected])
    .where('revoked_at', 'is', null)
    .execute();
  if (roles.length > 60 || selected.some((id) => !roles.some((r) => r.admin_user_id === id)))
    denied();
  const staff = ids([...selected, ...roles.map((r) => r.assigned_by_admin_id)]);
  const admins = await db
    .selectFrom('administration.admin_users')
    .select(['id', 'user_id'])
    .where('id', 'in', staff)
    .orderBy('id')
    .execute();
  if (admins.length !== staff.length) denied();
  const users = ids(admins.map((r) => r.user_id));
  await db
    .selectFrom('identity.users')
    .select('id')
    .where('id', 'in', users)
    .orderBy('id')
    .forNoKeyUpdate()
    .execute();
  await db
    .selectFrom('administration.admin_users')
    .select('id')
    .where('id', 'in', staff)
    .orderBy('id')
    .forUpdate()
    .execute();
  // Source application hosts must be stopped by the operator. These native row
  // locks additionally fence concurrent OTP verification until target commit.
  const credentials = (
    await sql<{
      id: string;
      activation_audit_id: string;
    }>`SELECT id,activation_audit_id FROM administration.admin_totp_credentials WHERE admin_user_id=ANY(${[...selected]}::uuid[]) AND revoked_at IS NULL ORDER BY id FOR UPDATE`.execute(
      db,
    )
  ).rows;
  if (credentials.length !== selected.length) denied();
  const valid = (
    await sql<{ valid: boolean }>`SELECT count(*)=${selected.length} AND coalesce(bool_and(
    admin.is_active AND admin.disabled_at IS NULL AND admin.identity_verified_at IS NOT NULL
    AND channel.telegram_user_id=admin.telegram_user_id AND credential.revoked_at IS NULL
    AND credential.last_used_step>=GREATEST(0,floor(extract(epoch FROM credential.activated_at)/30)::bigint-1)
    AND audit.category='security' AND audit.event_type='administration.totp-activated.v1'
    AND audit.actor_type='user' AND audit.actor_user_id=admin.user_id AND audit.actor_admin_id IS NULL
    AND audit.subject_type='admin_totp_credential' AND audit.subject_id=credential.id
    AND audit.metadata_schema_version=1 AND audit.metadata='{}'::jsonb AND audit.result_code='activated'
    AND audit.occurred_at=credential.activated_at),false) AS valid
    FROM administration.admin_totp_credentials credential JOIN administration.admin_users admin ON admin.id=credential.admin_user_id
    JOIN identity.telegram_identities channel ON channel.user_id=admin.user_id
    JOIN platform.audit_logs audit ON audit.id=credential.activation_audit_id
    WHERE admin.id=ANY(${[...selected]}::uuid[]) AND credential.revoked_at IS NULL`.execute(db)
  ).rows[0]!.valid;
  if (!valid) denied();
  const rows = {} as Rows;
  rows['identity.users'] = await readRows(
    db,
    'identity.users',
    sql`data.id=ANY(${users}::uuid[])`,
    sql`data.id`,
  );
  rows['identity.telegram_identities'] = await readRows(
    db,
    'identity.telegram_identities',
    sql`data.user_id=ANY(${users}::uuid[])`,
    sql`data.user_id`,
  );
  rows['administration.admin_users'] = await readRows(
    db,
    'administration.admin_users',
    sql`data.id=ANY(${staff}::uuid[])`,
    sql`data.id`,
  );
  rows['administration.admin_user_roles'] = await readRows(
    db,
    'administration.admin_user_roles',
    sql`data.admin_user_id=ANY(${[...selected]}::uuid[]) AND data.revoked_at IS NULL`,
    sql`data.admin_user_id,data.role_code`,
  );
  rows['administration.admin_totp_credentials'] = await readRows(
    db,
    'administration.admin_totp_credentials',
    sql`data.id=ANY(${credentials.map((r) => r.id)}::uuid[])`,
    sql`data.id`,
  );
  rows['platform.audit_logs'] = await readRows(
    db,
    'platform.audit_logs',
    sql`data.id=ANY(${credentials.map((r) => r.activation_audit_id)}::uuid[])`,
    sql`data.id`,
  );
  if (
    rows['identity.users'].length !== users.length ||
    rows['identity.telegram_identities'].length !== users.length ||
    rows['platform.audit_logs'].length !== credentials.length
  )
    denied();
  return rows;
}
async function insertRows(db: NakhDatabase, table: Table, rows: readonly Row[]): Promise<void> {
  if (!rows.length) return;
  await sql`INSERT INTO ${sql.id(...table.split('.'))} SELECT * FROM jsonb_populate_recordset(NULL::${sql.id(...table.split('.'))},${JSON.stringify(rows)}::jsonb)`.execute(
    db,
  );
}
/** Root-only database maintenance, not an application endpoint or MFA recovery
 * bypass. The host must hold/drain/stop the old apps and preserve the old cluster
 * and encrypted backup. Only encrypted workforce state crosses databases.
 * Source timestamps/bigints remain native JSON/text; no seed is decrypted and no
 * session, proof, enrollment, dating profile, photo or balance is transferred. */
export class PostgresWorkforceCarryover {
  public constructor(
    private readonly source: NakhDatabase,
    private readonly target: NakhDatabase,
  ) {}
  public async execute(input: WorkforceCarryoverRequest): Promise<WorkforceCarryoverResult> {
    try {
      const request = structuredClone(input);
      if (
        request.version !== 1 ||
        ![request.commandId, request.operatorId].every((id) => UUID.test(id)) ||
        ![request.sourceSha, request.targetSha].every((sha) => /^[a-f0-9]{40}$/u.test(sha)) ||
        !Array.isArray(request.adminIds) ||
        request.adminIds.length > 20 ||
        canonical(ids(request.adminIds)) !== canonical(request.adminIds) ||
        this.source === this.target ||
        this.source.isTransaction ||
        this.target.isTransaction
      )
        denied();
      validateLedger(request.sourceMigrations);
      validateLedger(request.targetMigrations);
      return await this.source
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (source) => {
          await sql`SET LOCAL TIME ZONE 'UTC'`.execute(source);
          const sourceIdentity = await authority(source, request.sourceMigrations);
          await sql`SELECT pg_advisory_xact_lock(hashtextextended('nakh-workforce-carryover-source',0))`.execute(
            source,
          );
          const sourceColumns = await columns(source),
            rows = await capture(source, request.adminIds),
            capsuleDigest = digest(rows);
          return this.target
            .transaction()
            .setIsolationLevel('read committed')
            .execute(async (target) => {
              await sql`SET LOCAL TIME ZONE 'UTC'`.execute(target);
              const targetIdentity = await authority(target, request.targetMigrations);
              if (
                canonical(sourceIdentity) === canonical(targetIdentity) ||
                canonical(await columns(target)) !== canonical(sourceColumns)
              )
                denied();
              await sql`SELECT pg_advisory_xact_lock(hashtextextended('nakh-workforce-carryover-target',0))`.execute(
                target,
              );
              const requestDigest = digest([
                request,
                sourceIdentity,
                targetIdentity,
                capsuleDigest,
              ]);
              const result: WorkforceCarryoverResult = {
                status: 'restored',
                replayed: false,
                staffUsers: rows['identity.users'].length,
                activeAdministrators: request.adminIds.length,
                credentials: rows['administration.admin_totp_credentials'].length,
                roleAssignments: rows['administration.admin_user_roles'].length,
                requestDigest,
                capsuleDigest,
              };
              const previous = await target
                .selectFrom('platform.audit_logs')
                .select([
                  'metadata',
                  'category',
                  'actor_type',
                  'event_type',
                  'subject_type',
                  'result_code',
                ])
                .where('subject_id', '=', request.commandId)
                .where('event_type', '=', EVENT)
                .execute();
              if (previous.length) {
                if (
                  previous.length !== 1 ||
                  previous[0]!.category !== 'security' ||
                  previous[0]!.actor_type !== 'system' ||
                  previous[0]!.event_type !== EVENT ||
                  previous[0]!.subject_type !== 'workforce_carryover' ||
                  previous[0]!.result_code !== 'restored' ||
                  previous[0]!.metadata.requestDigest !== requestDigest
                )
                  denied();
                // Historical completion is not current authorization. Never overwrite
                // credentials or reduce an advanced target replay floor on retry.
                return { ...result, replayed: true };
              }
              for (const table of [
                'identity.users',
                'identity.accounts',
                'administration.admin_users',
                'administration.admin_totp_credentials',
                'administration.admin_sessions',
                'administration.admin_totp_proofs',
                'administration.admin_totp_enrollments',
                'profile.profiles',
                'media.media_assets',
                'platform.outbox_events',
              ] as const) {
                const count = (
                  await sql<{
                    count: string;
                  }>`SELECT count(*)::text AS count FROM ${sql.id(...table.split('.'))}`.execute(
                    target,
                  )
                ).rows[0]!.count;
                if (count !== '0') denied();
              }
              await insertRows(target, 'identity.users', rows['identity.users']);
              await insertRows(
                target,
                'identity.telegram_identities',
                rows['identity.telegram_identities'],
              );
              for (const user of rows['identity.users']) {
                const userId = String(user.id);
                await target
                  .insertInto('identity.accounts')
                  .values({
                    user_id: userId,
                    state: 'guest',
                    state_reason: null,
                    state_changed_at: sql<Date>`clock_timestamp()`,
                  })
                  .execute();
                await target
                  .insertInto('identity.user_settings')
                  .values({
                    user_id: userId,
                    created_at: sql<Date>`clock_timestamp()`,
                    updated_at: sql<Date>`clock_timestamp()`,
                  })
                  .execute();
                await target
                  .insertInto('identity.guest_preview_counters')
                  .values({
                    user_id: userId,
                    limit_count: 10,
                    first_preview_at: null,
                    last_preview_at: null,
                  })
                  .execute();
                await target
                  .insertInto('billing.credit_accounts')
                  .values({
                    user_id: userId,
                    created_at: sql<Date>`clock_timestamp()`,
                    updated_at: sql<Date>`clock_timestamp()`,
                  })
                  .execute();
                await target
                  .insertInto('notification.notification_preferences')
                  .values({
                    user_id: userId,
                    created_at: sql<Date>`clock_timestamp()`,
                    updated_at: sql<Date>`clock_timestamp()`,
                  })
                  .execute();
              }
              await insertRows(
                target,
                'administration.admin_users',
                rows['administration.admin_users'],
              );
              await insertRows(
                target,
                'administration.admin_user_roles',
                rows['administration.admin_user_roles'],
              );
              await insertRows(target, 'platform.audit_logs', rows['platform.audit_logs']);
              for (const credential of rows['administration.admin_totp_credentials']) {
                // Stage at the LOWEST insertion-valid native floor. The original may
                // legitimately be activation-step-minus-one; never require rollback.
                await sql`WITH original AS(SELECT jsonb_populate_record(NULL::administration.admin_totp_credentials,${JSON.stringify(credential)}::jsonb) AS value)
              INSERT INTO administration.admin_totp_credentials SELECT (jsonb_populate_record(NULL::administration.admin_totp_credentials,
                to_jsonb(value)||jsonb_build_object('last_used_step',GREATEST(0,floor(extract(epoch FROM (value).activated_at)/30)::bigint-1)))).* FROM original`.execute(
                  target,
                );
                await sql`UPDATE administration.admin_totp_credentials SET last_used_step=${String(credential.last_used_step)}::bigint WHERE id=${String(credential.id)}::uuid`.execute(
                  target,
                );
              }
              // Compare native JSON (including microseconds, ciphertext and exact
              // bigint strings) before committing any restored authority.
              const copied = await capture(target, request.adminIds);
              if (canonical(copied) !== canonical(rows)) denied();
              await target
                .insertInto('platform.audit_logs')
                .values({
                  id: randomUUID(),
                  category: 'security',
                  event_type: EVENT,
                  actor_type: 'system',
                  actor_user_id: null,
                  actor_admin_id: null,
                  subject_type: 'workforce_carryover',
                  subject_id: request.commandId,
                  command_id: request.commandId,
                  request_id: request.commandId,
                  result_code: 'restored',
                  metadata_schema_version: 1,
                  metadata: {
                    requestDigest,
                    capsuleDigest,
                    operatorId: request.operatorId,
                    sourceSha: request.sourceSha,
                    targetSha: request.targetSha,
                    staffUsers: result.staffUsers,
                    credentials: result.credentials,
                  },
                  occurred_at: sql<Date>`clock_timestamp()`,
                })
                .execute();
              return result;
            });
        });
    } catch {
      return denied();
    }
  }
}
