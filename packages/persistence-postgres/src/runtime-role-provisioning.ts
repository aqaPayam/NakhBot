import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';
import { runtimeDatabaseUrl } from './runtime-database.js';
import {
  BILLING_SUMMARY_COLUMNS,
  RUNTIME_APPEND_ONLY_TABLES,
  RUNTIME_CODE_OWNED_TABLES,
  RUNTIME_DATABASE_ROLES,
  RUNTIME_DATABASE_READ_VIEWS,
  RUNTIME_CUSTODY_READ_VIEWS,
  RUNTIME_DATABASE_SCHEMAS,
  type RuntimeDatabasePurpose,
} from './runtime-database-policy.js';

const PURPOSES = Object.keys(RUNTIME_DATABASE_ROLES) as RuntimeDatabasePurpose[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EVENT = 'platform.runtime-database-roles-provisioned.v1';
const WRITABLE: Readonly<Record<RuntimeDatabasePurpose, readonly string[]>> = {
  user: [
    'platform',
    'identity',
    'profile',
    'discovery',
    'interaction',
    'matching',
    'chat',
    'media',
    'nakh',
    'notification',
    'support',
    'channel_telegram',
  ],
  financial: ['platform', 'billing', 'nakh', 'interaction', 'matching', 'notification'],
  administration: RUNTIME_DATABASE_SCHEMAS.filter((name) => name !== 'catalog'),
  maintenance: [
    'platform',
    'identity',
    'profile',
    'discovery',
    'interaction',
    'matching',
    'chat',
    'media',
    'nakh',
    'notification',
    'support',
    'channel_telegram',
  ],
  scheduler: [
    'platform',
    'identity',
    'profile',
    'discovery',
    'chat',
    'media',
    'moderation',
    'notification',
    'support',
    'channel_telegram',
  ],
};
function denied(): never {
  throw new Error('Runtime database provisioning unavailable.');
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export const RUNTIME_ROLE_POLICY_DIGEST = digest([
  4,
  RUNTIME_DATABASE_ROLES,
  RUNTIME_DATABASE_SCHEMAS,
  BILLING_SUMMARY_COLUMNS,
  RUNTIME_APPEND_ONLY_TABLES,
  RUNTIME_CODE_OWNED_TABLES,
  WRITABLE,
  RUNTIME_DATABASE_READ_VIEWS,
  RUNTIME_CUSTODY_READ_VIEWS,
]);

/** ASCII-only server-generated role credentials. Send PostgreSQL a SCRAM verifier,
 * never a clear password in a DDL statement. PostgreSQL 17 pg_authid / RFC 7677. */
export function runtimeRoleScramVerifier(password: string, salt = randomBytes(16)): string {
  if (!/^[\x21-\x7e]{1,128}$/u.test(password) || salt.length !== 16) denied();
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const server = createHmac('sha256', salted).update('Server Key').digest();
  try {
    return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${createHash('sha256').update(client).digest('base64')}:${server.toString('base64')}`;
  } finally {
    salted.fill(0);
    client.fill(0);
    server.fill(0);
  }
}
export type RuntimeRoleProvisioning = Readonly<{
  commandId: string;
  sourceSha: string;
  urls: Readonly<Record<RuntimeDatabasePurpose, string>>;
  migrations: readonly Readonly<{ name: string; sha256: string }>[];
}>;
type Relation = { schema: string; table: string; kind: string; columns: string[] };
/** Only a trusted migration host with native CREATEROLE/grant authority can use
 * this capability. It is absent from public/admin route composition. */
export class PostgresRuntimeRoleProvisioning {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly targetUrl: string,
  ) {}
  public async provision(value: RuntimeRoleProvisioning): Promise<
    Readonly<{
      status: 'provisioned';
      replayed: boolean;
      roles: number;
      policyDigest: string;
    }>
  > {
    try {
      const input = structuredClone(value),
        target = runtimeDatabaseUrl(this.targetUrl);
      if (
        Object.keys(input).sort().join(',') !== 'commandId,migrations,sourceSha,urls' ||
        !UUID.test(input.commandId) ||
        !/^[a-f0-9]{40}$/u.test(input.sourceSha) ||
        Object.keys(input.urls).sort().join(',') !== [...PURPOSES].sort().join(',') ||
        !Array.isArray(input.migrations) ||
        input.migrations.length < 1 ||
        input.migrations.length > 4096
      )
        denied();
      const expected = input.migrations.map(
        (entry: RuntimeRoleProvisioning['migrations'][number]) => {
          if (
            Object.keys(entry).sort().join(',') !== 'name,sha256' ||
            !/^\d{6}_[a-z0-9_]+\.sql$/u.test(entry.name) ||
            !/^[a-f0-9]{64}$/u.test(entry.sha256)
          )
            denied();
          return { name: entry.name, sha256: entry.sha256 };
        },
      );
      if (
        new Set(expected.map((entry) => entry.name)).size !== expected.length ||
        [...expected]
          .sort((a, b) => a.name.localeCompare(b.name))
          .some((entry, index) => entry.name !== expected[index]?.name)
      )
        denied();
      const passwords = new Map<RuntimeDatabasePurpose, string>();
      for (const purpose of PURPOSES) {
        const url = runtimeDatabaseUrl(input.urls[purpose]),
          password = decodeURIComponent(url.password);
        if (
          !['postgres:', 'postgresql:'].includes(url.protocol) ||
          decodeURIComponent(url.username) !== RUNTIME_DATABASE_ROLES[purpose] ||
          url.hostname.toLowerCase() !== target.hostname.toLowerCase() ||
          (url.port || '5432') !== (target.port || '5432') ||
          url.pathname !== target.pathname ||
          url.search !== target.search ||
          !/^[A-Za-z0-9_-]{43}$/u.test(password) ||
          Buffer.from(password, 'base64url').byteLength !== 32 ||
          Buffer.from(password, 'base64url').toString('base64url') !== password
        )
          denied();
        passwords.set(purpose, password);
      }
      if (new Set(passwords.values()).size !== PURPOSES.length) denied();
      const requestDigest = digest([
        1,
        input.sourceSha,
        RUNTIME_ROLE_POLICY_DIGEST,
        expected,
        PURPOSES.map((purpose) => [purpose, input.urls[purpose]]),
      ]);
      return await this.database
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (tx) => {
          // Match the migrator's existing lock. Read the ledger AFTER waiting;
          // a concurrent upgrade must never qualify the previous role policy.
          await sql`SELECT pg_advisory_xact_lock_shared(hashtext('nakh-schema-migrations'))`.execute(
            tx,
          );
          await sql`SELECT pg_advisory_xact_lock(hashtextextended('nakh-runtime-database-roles',0))`.execute(
            tx,
          );
          const ledger = await tx
            .selectFrom('platform.schema_migrations')
            .select(['name', 'sha256'])
            .orderBy('name')
            .execute();
          if (JSON.stringify(ledger) !== JSON.stringify(expected)) denied();
          const caller = (
            await sql<{
              permitted: boolean;
              database: string;
            }>`SELECT (rolsuper OR rolcreaterole) AS permitted,
          current_database() AS database FROM pg_catalog.pg_roles WHERE rolname=current_user`.execute(
              tx,
            )
          ).rows[0];
          if (
            !caller?.permitted ||
            caller.database !== decodeURIComponent(target.pathname.slice(1))
          )
            denied();
          const previous = (
            await sql<{
              metadata: Record<string, unknown>;
            }>`SELECT metadata FROM platform.audit_logs
          WHERE event_type=${EVENT} AND subject_id=${input.commandId}::uuid LIMIT 2`.execute(tx)
          ).rows;
          if (
            previous.length > 1 ||
            (previous[0] !== undefined && previous[0].metadata.requestDigest !== requestDigest)
          )
            denied();
          // An audit receipt never grants permission or skips policy application.
          // Reapply under the lock even on replay, including removal of ACL drift.
          const relations = (
            await sql<Relation>`SELECT n.nspname::text AS schema,c.relname::text AS table,c.relkind::text AS kind,
          json_agg(a.attname::text ORDER BY a.attnum) AS columns FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
          WHERE n.nspname IN (${sql.join(RUNTIME_DATABASE_SCHEMAS)}) AND c.relkind IN ('r','p','v')
          AND a.attnum>0 AND NOT a.attisdropped GROUP BY n.nspname,c.relname,c.relkind ORDER BY n.nspname,c.relname`.execute(
              tx,
            )
          ).rows;
          for (const purpose of PURPOSES) {
            const role = RUNTIME_DATABASE_ROLES[purpose];
            const old = (
              await sql<{
                unsafe: boolean;
                managed: boolean;
              }>`SELECT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
            OR NOT rolcanlogin OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid)) AS unsafe
            ,((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) OR EXISTS(
              SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles caller ON caller.oid=m.member
              WHERE m.roleid=r.oid AND caller.rolname=current_user AND m.admin_option)) AS managed
            FROM pg_catalog.pg_roles r WHERE rolname=${role}`.execute(tx)
            ).rows[0];
            if (old !== undefined && (old.unsafe || !old.managed)) denied();
            // Only a verifier reaches SQL parameters/utility text; clear credentials
            // and complete URLs stay outside PostgreSQL statement/error logs.
            const verifier = runtimeRoleScramVerifier(passwords.get(purpose)!);
            await sql`SELECT set_config('nakh.runtime_role_name',${role},true),set_config('nakh.runtime_role_verifier',${verifier},true)`.execute(
              tx,
            );
            await sql`DO $policy$ BEGIN
            IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_setting('nakh.runtime_role_name')) THEN
              EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',current_setting('nakh.runtime_role_name'));
            END IF;
            EXECUTE format('ALTER ROLE %I PASSWORD %L',current_setting('nakh.runtime_role_name'),current_setting('nakh.runtime_role_verifier'));
          END $policy$`.execute(tx);
            for (const schema of RUNTIME_DATABASE_SCHEMAS) {
              await sql`REVOKE ALL PRIVILEGES ON SCHEMA ${sql.id(schema)} FROM ${sql.id(role)}`.execute(
                tx,
              );
              await sql`GRANT USAGE ON SCHEMA ${sql.id(schema)} TO ${sql.id(role)}`.execute(tx);
              await sql`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${sql.id(schema)} FROM ${sql.id(role)}`.execute(
                tx,
              );
              await sql`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${sql.id(schema)} FROM ${sql.id(role)}`.execute(
                tx,
              );
              await sql`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${sql.id(schema)} TO ${sql.id(role)}`.execute(
                tx,
              );
            }
            for (const relation of relations) {
              const name = relation.schema + '.' + relation.table;
              // Table-level REVOKE does not remove previously granted column ACLs.
              const allColumns = sql.join(relation.columns.map((column) => sql.id(column)));
              await sql`REVOKE SELECT (${allColumns}),INSERT (${allColumns}),UPDATE (${allColumns}),REFERENCES (${allColumns})
              ON TABLE ${sql.table(name)} FROM ${sql.id(role)}`.execute(tx);
              if (relation.kind === 'v') continue;
              let columns: readonly string[] | '*' = '*';
              if (relation.schema === 'billing' && (purpose === 'user' || purpose === 'scheduler'))
                columns = BILLING_SUMMARY_COLUMNS[relation.table] ?? [];
              if (
                relation.schema === 'administration' &&
                purpose !== 'administration' &&
                purpose !== 'maintenance'
              )
                columns = relation.columns.filter(
                  (column) =>
                    !['ciphertext', 'nonce', 'invitation_hash', 'token_hash'].includes(column),
                );
              if (columns === '*')
                await sql`GRANT SELECT ON TABLE ${sql.table(name)} TO ${sql.id(role)}`.execute(tx);
              else if (columns.length > 0)
                await sql`GRANT SELECT (${sql.join(columns.map((column) => sql.id(column)))}) ON TABLE ${sql.table(name)} TO ${sql.id(role)}`.execute(
                  tx,
                );
              const codeOwned =
                relation.schema === 'catalog' ||
                RUNTIME_CODE_OWNED_TABLES.some((table) => table === name);
              if (!codeOwned && WRITABLE[purpose].includes(relation.schema)) {
                const appendOnly = RUNTIME_APPEND_ONLY_TABLES.some((table) => table === name);
                await (
                  appendOnly
                    ? sql`GRANT INSERT ON TABLE ${sql.table(name)} TO ${sql.id(role)}`
                    : sql`GRANT INSERT,UPDATE,DELETE ON TABLE ${sql.table(name)} TO ${sql.id(role)}`
                ).execute(tx);
              }
            }
            for (const [view, columns] of Object.entries(RUNTIME_DATABASE_READ_VIEWS)) {
              await sql`GRANT SELECT (${sql.join(columns.map((column) => sql.id(column)))}) ON TABLE ${sql.table(view)} TO ${sql.id(role)}`.execute(
                tx,
              );
            }
            await sql`REVOKE ALL ON FUNCTION administration.lock_runtime_admin_permission(uuid,text) FROM ${sql.id(role)}`.execute(
              tx,
            );
            if (WRITABLE[purpose].includes('matching')) {
              await sql`GRANT UPDATE(id) ON matching.current_match_lives TO ${sql.id(role)}`.execute(
                tx,
              );
            }
            if (WRITABLE[purpose].includes('interaction')) {
              await sql`GRANT UPDATE(id) ON interaction.current_like_lives TO ${sql.id(role)}`.execute(
                tx,
              );
            }
            if (purpose === 'administration' || purpose === 'maintenance') {
              for (const [view, columns] of Object.entries(RUNTIME_CUSTODY_READ_VIEWS)) {
                await sql`GRANT SELECT (${sql.join(columns.map((column) => sql.id(column)))}) ON TABLE ${sql.table(view)} TO ${sql.id(role)}`.execute(
                  tx,
                );
              }
            }
            if (purpose === 'scheduler') {
              await sql`GRANT SELECT(report_evidence_id,asset_id,variant_id,sha256,variant_type,transformation_version)
                ON media.report_photo_source_facts TO ${sql.id(role)}`.execute(tx);
              await sql`GRANT INSERT(id,run_type,status,cursor,failure_code,finished_at),UPDATE(status,cursor,scanned_count,anomaly_count,finished_at,failure_code)
                ON billing.reconciliation_runs TO ${sql.id(role)}`.execute(tx);
              await sql`GRANT INSERT(id,run_id,anomaly_type,entity_type,entity_id,disposition,safe_detail,idempotency_key)
                ON billing.reconciliation_anomalies TO ${sql.id(role)}`.execute(tx);
            }
            if (purpose === 'administration') {
              await sql`GRANT EXECUTE ON FUNCTION administration.lock_runtime_admin_permission(uuid,text) TO ${sql.id(role)}`.execute(
                tx,
              );
            }
            await sql`REVOKE ALL ON FUNCTION moderation.lock_runtime_report_reason(text) FROM ${sql.id(role)}`.execute(
              tx,
            );
            if (purpose === 'user' || purpose === 'administration') {
              await sql`GRANT EXECUTE ON FUNCTION moderation.lock_runtime_report_reason(text) TO ${sql.id(role)}`.execute(
                tx,
              );
            }
            await sql`REVOKE ALL ON FUNCTION platform.redeem_trial_invitation(text,uuid,integer,text,text) FROM ${sql.id(role)}`.execute(
              tx,
            );
            if (purpose === 'user')
              await sql`GRANT EXECUTE ON FUNCTION platform.redeem_trial_invitation(text,uuid,integer,text,text) TO ${sql.id(role)}`.execute(
                tx,
              );
            if (purpose === 'user') {
              await sql`GRANT INSERT(id,user_id,ban_state_history_id,message_text) ON moderation.user_appeals TO ${sql.id(role)}`.execute(
                tx,
              );
              await sql`GRANT INSERT ON moderation.appeal_submissions TO ${sql.id(role)}`.execute(
                tx,
              );
              for (const table of ['moderation.report_evidence', 'moderation.report_snapshots']) {
                await sql`GRANT INSERT ON TABLE ${sql.table(table)} TO ${sql.id(role)}`.execute(tx);
              }
              await sql`GRANT INSERT(id,reporter_user_id,target_user_id,reason_id,extra_text,status,command_id,request_id,idempotency_key,request_digest)
                ON moderation.reports TO ${sql.id(role)}`.execute(tx);
              await sql`GRANT UPDATE(status,priority,version) ON moderation.reports TO ${sql.id(role)}`.execute(
                tx,
              );
              await sql`GRANT INSERT(id,report_id,created_at,updated_at) ON moderation.moderation_reviews TO ${sql.id(role)}`.execute(
                tx,
              );
              await sql`GRANT INSERT(id,target_user_id,source_report_id,distinct_reporter_count,started_at) ON moderation.restriction_episodes TO ${sql.id(role)}`.execute(
                tx,
              );
              await sql`GRANT INSERT(restriction_episode_id,reporter_user_id,report_id,submitted_at) ON moderation.threshold_admission_witnesses TO ${sql.id(role)}`.execute(
                tx,
              );
              await sql`GRANT INSERT(id,action_type,actor_type,target_user_id,source_report_id,restriction_episode_id,audit_log_id,notification_id,command_id,request_id,request_digest,reason_code,occurred_at)
                ON moderation.moderation_actions TO ${sql.id(role)}`.execute(tx);
            }
            if (purpose === 'financial') {
              // Financial eligibility reads retain their profile row lock;
              // no profile content or completion field becomes writable.
              await sql`GRANT UPDATE(id) ON profile.profiles TO ${sql.id(role)}`.execute(tx);
              await sql`GRANT INSERT(viewer_user_id,target_user_id,reason,consumed_at) ON discovery.explore_consumptions TO ${sql.id(role)}`.execute(
                tx,
              );
              for (const relation of relations.filter((row) => row.schema === 'identity')) {
                const lockColumn = relation.columns.includes('id')
                  ? 'id'
                  : relation.columns.includes('user_id')
                    ? 'user_id'
                    : undefined;
                if (lockColumn)
                  await sql`GRANT UPDATE (${sql.id(lockColumn)}) ON TABLE ${sql.table(relation.schema + '.' + relation.table)} TO ${sql.id(role)}`.execute(
                    tx,
                  );
              }
              for (const name of ['chat.chat_sessions', 'chat.chat_reference_anchors'])
                await sql`GRANT INSERT,UPDATE ON TABLE ${sql.table(name)} TO ${sql.id(role)}`.execute(
                  tx,
                );
            }
            if (purpose === 'user' || purpose === 'maintenance') {
              for (const name of ['billing.credit_accounts', 'billing.credit_epoch_accounts'])
                await sql`GRANT INSERT,UPDATE ON TABLE ${sql.table(name)} TO ${sql.id(role)}`.execute(
                  tx,
                );
              await sql`GRANT INSERT ON TABLE billing.credit_epoch_closures TO ${sql.id(role)}`.execute(
                tx,
              );
              if (purpose === 'user') {
                await sql`GRANT INSERT ON TABLE billing.credit_transactions TO ${sql.id(role)}`.execute(
                  tx,
                );
                await sql`GRANT INSERT,UPDATE,DELETE ON TABLE billing.pending_payments TO ${sql.id(role)}`.execute(
                  tx,
                );
                await sql`GRANT UPDATE(status,cancelled_at,expired_at,version) ON TABLE billing.payment_records TO ${sql.id(role)}`.execute(
                  tx,
                );
              }
              await sql`GRANT UPDATE(revoked_at) ON TABLE administration.admin_sessions TO ${sql.id(role)}`.execute(
                tx,
              );
            }
          }
          // Audit failure rolls role/password/grant changes back in the same transaction.
          if (previous.length === 0)
            await tx
              .insertInto('platform.audit_logs')
              .values({
                id: randomUUID(),
                category: 'security',
                event_type: EVENT,
                actor_type: 'system',
                actor_user_id: null,
                actor_admin_id: null,
                subject_type: 'runtime_database_policy',
                subject_id: input.commandId,
                request_id: input.commandId,
                command_id: input.commandId,
                result_code: 'provisioned',
                metadata_schema_version: 1,
                metadata: {
                  requestDigest,
                  policyDigest: RUNTIME_ROLE_POLICY_DIGEST,
                  sourceSha: input.sourceSha,
                  roles: PURPOSES.map((purpose) => RUNTIME_DATABASE_ROLES[purpose]),
                },
                occurred_at: sql<Date>`clock_timestamp()`,
              })
              .execute();
          return {
            status: 'provisioned' as const,
            replayed: previous.length === 1,
            roles: PURPOSES.length,
            policyDigest: RUNTIME_ROLE_POLICY_DIGEST,
          };
        });
    } catch {
      return denied();
    }
  }
}
