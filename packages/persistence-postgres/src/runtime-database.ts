import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { sql } from 'kysely';
import { createDatabase, type NakhDatabase } from './database.js';
import {
  BILLING_SUMMARY_COLUMNS,
  RUNTIME_APPEND_ONLY_TABLES,
  RUNTIME_CODE_OWNED_TABLES,
  RUNTIME_DATABASE_ROLES,
  RUNTIME_DATABASE_READ_VIEWS,
  RUNTIME_DATABASE_SCHEMAS,
  type RuntimeDatabasePurpose,
} from './runtime-database-policy.js';

function unavailable(): never {
  throw new Error('Runtime database role unavailable.');
}
export function runtimeDatabaseUrl(value: string): URL {
  try {
    if (typeof value !== 'string' || value.length > 8192) unavailable();
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname)
      unavailable();
    if (
      [...url.searchParams.keys()].some(
        (key) =>
          !['sslmode', 'sslrootcert'].includes(key) || url.searchParams.getAll(key).length !== 1,
      )
    )
      unavailable();
    return url;
  } catch {
    return unavailable();
  }
}
/** Read-only native permission proof. A matching login name alone is not authority. */
export async function verifyRuntimeDatabaseRole(
  database: NakhDatabase,
  purpose: RuntimeDatabasePurpose,
  requireTls = false,
): Promise<void> {
  try {
    const row = (
      await sql<{
        login: string;
        role: string;
        unsafe: boolean;
        member: boolean;
        owner: boolean;
        create: boolean;
        mutableProof: boolean;
        mutableCatalog: boolean;
        privateRead: boolean;
        tls: boolean;
        auth: string | null;
        permissionLock: boolean;
        reasonLock: boolean;
        trialRedemption: boolean;
        missingViewRead: boolean;
        custodyKeyRead: boolean;
        appealAdmissionMissing: boolean;
        appealReviewWrite: boolean;
      }>`SELECT session_user::text AS login,current_user::text AS role,
      (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR NOT r.rolcanlogin) AS unsafe,
      EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid) AS member,
      (EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN (${sql.join(RUNTIME_DATABASE_SCHEMAS)}) AND c.relowner=r.oid)
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname IN (${sql.join(RUNTIME_DATABASE_SCHEMAS)}) AND n.nspowner=r.oid)
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname=current_database() AND d.datdba=r.oid)) AS owner,
      (has_database_privilege(r.oid,current_database(),'CREATE') OR EXISTS(
        SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname IN (${sql.join([...RUNTIME_DATABASE_SCHEMAS, 'public'])})
        AND has_schema_privilege(r.oid,n.oid,'CREATE'))) AS "create",
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname||'.'||c.relname IN (${sql.join(RUNTIME_APPEND_ONLY_TABLES)})
        AND (has_any_column_privilege(r.oid,c.oid,'UPDATE') OR has_table_privilege(r.oid,c.oid,'DELETE,TRUNCATE'))) AS "mutableProof",
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE (n.nspname='catalog' OR n.nspname||'.'||c.relname IN (${sql.join(RUNTIME_CODE_OWNED_TABLES)}))
        AND c.relkind IN ('r','p') AND (has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE') OR has_table_privilege(r.oid,c.oid,'DELETE,TRUNCATE'))) AS "mutableCatalog",
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE n.nspname='billing' AND c.relkind IN ('r','p','v','m')
        AND has_column_privilege(r.oid,c.oid,a.attnum,'SELECT')
        AND NOT EXISTS(SELECT 1 FROM jsonb_each(${JSON.stringify(BILLING_SUMMARY_COLUMNS)}::jsonb) allowed
          WHERE allowed.key=c.relname AND (allowed.value='"*"'::jsonb OR allowed.value ? a.attname::text))) AS "privateRead",
      coalesce((SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()),false) AS tls,
      system_user::text AS auth,
      has_function_privilege(r.oid,'administration.lock_runtime_admin_permission(uuid,text)'::regprocedure,'EXECUTE') AS "permissionLock",
      has_function_privilege(r.oid,'moderation.lock_runtime_report_reason(text)'::regprocedure,'EXECUTE') AS "reasonLock",
      has_function_privilege(r.oid,'platform.redeem_trial_invitation(text,uuid,integer,text,text)'::regprocedure,'EXECUTE') AS "trialRedemption",
      EXISTS(SELECT 1 FROM jsonb_each(${JSON.stringify(RUNTIME_DATABASE_READ_VIEWS)}::jsonb) projection
        CROSS JOIN LATERAL jsonb_array_elements_text(projection.value) field(name)
        WHERE NOT has_column_privilege(r.oid,projection.key,field.name,'SELECT')) AS "missingViewRead",
      has_column_privilege(r.oid,'media.report_photo_source_facts','storage_key','SELECT') AS "custodyKeyRead",
      (NOT has_table_privilege(r.oid,'moderation.appeal_submissions','INSERT') OR EXISTS(
        SELECT 1 FROM unnest(ARRAY['id','user_id','ban_state_history_id','message_text']) field(name)
        WHERE NOT has_column_privilege(r.oid,'moderation.user_appeals',field.name,'INSERT'))) AS "appealAdmissionMissing",
      (has_any_column_privilege(r.oid,'moderation.user_appeals','UPDATE')
        OR has_table_privilege(r.oid,'moderation.user_appeals','DELETE,TRUNCATE') OR EXISTS(
        SELECT 1 FROM unnest(ARRAY['status','reviewed_by_admin_id','admin_note','submitted_at','reviewed_at','version']) field(name)
        WHERE has_column_privilege(r.oid,'moderation.user_appeals',field.name,'INSERT'))) AS "appealReviewWrite"
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`.execute(database)
    ).rows[0];
    if (
      row === undefined ||
      row.login !== RUNTIME_DATABASE_ROLES[purpose] ||
      row.role !== row.login ||
      row.unsafe ||
      row.member ||
      row.owner ||
      row.create ||
      row.mutableProof ||
      row.mutableCatalog ||
      row.permissionLock !== (purpose === 'administration') ||
      row.reasonLock !== (purpose === 'user' || purpose === 'administration') ||
      row.trialRedemption !== (purpose === 'user') ||
      row.missingViewRead ||
      row.custodyKeyRead !== (purpose === 'administration' || purpose === 'maintenance') ||
      (purpose === 'user' && (row.appealAdmissionMissing || row.appealReviewWrite)) ||
      (['user', 'scheduler'].includes(purpose) && row.privateRead) ||
      (requireTls && (!row.tls || !row.auth?.startsWith('scram-sha-256:')))
    )
      unavailable();
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && /^[A-Z0-9]{5}$/u.test(code)) {
      // Native errors can contain credentials or private SQL values. Retain only
      // SQLSTATE; attaching the original error would defeat this boundary.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Runtime database role unavailable (${code}).`);
    }
    unavailable();
  }
}

/** Host-owned pools are selected before startup and cannot be rebound by a request.
 * Production cannot fall back to the migration credential. Local legacy composition
 * retains its single pool until purpose isolation is explicitly enabled. */
export class RuntimeDatabases {
  private readonly settings: AppConfig['database'];
  private readonly enabled: boolean;
  private readonly production: boolean;
  private readonly pools = new Map<RuntimeDatabasePurpose | 'legacy', NakhDatabase>();
  private readonly allowed: ReadonlySet<RuntimeDatabasePurpose>;
  private readonly maximum: number;
  private sealed = false;
  private destroyed = false;
  public constructor(
    config: Pick<AppConfig, 'database' | 'environment'> & Partial<Pick<AppConfig, 'serviceName'>>,
    private readonly secret: (reference: string) => string = resolveSecretReference,
  ) {
    this.settings = structuredClone(config.database);
    this.enabled = config.database.roleIsolationEnabled === true;
    this.production = config.environment === 'production';
    if (this.production && !this.enabled) unavailable();
    const services: Readonly<Record<string, readonly RuntimeDatabasePurpose[]>> = {
      api: ['user', 'administration'],
      'telegram-gateway': ['user', 'financial', 'administration'],
      worker: ['user', 'financial', 'maintenance'],
      scheduler: ['scheduler', 'financial'],
    };
    if (this.production && services[config.serviceName ?? ''] === undefined) unavailable();
    const purposes =
      services[config.serviceName ?? ''] ??
      (Object.keys(RUNTIME_DATABASE_ROLES) as RuntimeDatabasePurpose[]);
    this.allowed = new Set(purposes);
    this.maximum = this.enabled
      ? Math.floor(this.settings.poolMax / purposes.length)
      : this.settings.poolMax;
    if (this.maximum < 1) unavailable();
  }
  public get(purpose: RuntimeDatabasePurpose): NakhDatabase {
    if (this.destroyed) unavailable();
    if (this.enabled && !this.allowed.has(purpose)) unavailable();
    const key = this.enabled ? purpose : 'legacy';
    const prior = this.pools.get(key);
    if (prior !== undefined) return prior;
    if (this.sealed) unavailable();
    let url = this.settings.url;
    if (this.enabled) {
      const reference = {
        financial: this.settings.financialUrlRef ?? 'NAKH_FINANCIAL_DATABASE_URL',
        administration: this.settings.administrationUrlRef ?? 'NAKH_ADMIN_DATABASE_URL',
        maintenance: this.settings.maintenanceUrlRef ?? 'NAKH_MAINTENANCE_DATABASE_URL',
      };
      if (purpose !== 'user' && purpose !== 'scheduler') url = this.secret(reference[purpose]);
      const target = runtimeDatabaseUrl(url),
        base = runtimeDatabaseUrl(this.settings.url);
      if (
        decodeURIComponent(target.username) !== RUNTIME_DATABASE_ROLES[purpose] ||
        !target.password ||
        target.hostname.toLowerCase() !== base.hostname.toLowerCase() ||
        (target.port || '5432') !== (base.port || '5432') ||
        target.pathname !== base.pathname ||
        target.search !== base.search
      )
        unavailable();
    }
    const database = createDatabase({ ...this.settings, url, poolMax: this.maximum });
    this.pools.set(key, database);
    return database;
  }
  public async verify(): Promise<void> {
    if (this.destroyed) unavailable();
    this.sealed = true;
    if (!this.enabled) return;
    for (const [purpose, database] of this.pools)
      if (purpose !== 'legacy') await verifyRuntimeDatabaseRole(database, purpose, this.production);
  }
  public async destroy(): Promise<void> {
    this.destroyed = true;
    const results = await Promise.allSettled(
      [...this.pools.values()].map((database) => database.destroy()),
    );
    if (results.some((result) => result.status === 'rejected')) unavailable();
  }
}

/** Read-only rollback qualification. Validate every fixed purpose and target
 * before connecting; never provision, repair ACLs, or rotate credentials here. */
export async function verifyRuntimeDatabaseBindings(
  input: Readonly<{
    baseUrl: string;
    urls: Readonly<Record<RuntimeDatabasePurpose, string>>;
    requireTls: boolean;
  }>,
): Promise<void> {
  const base = runtimeDatabaseUrl(input.baseUrl);
  const purposes = Object.keys(RUNTIME_DATABASE_ROLES) as RuntimeDatabasePurpose[];
  if (Object.keys(input.urls).sort().join(',') !== [...purposes].sort().join(',')) unavailable();
  const urls = purposes.map((purpose) => {
    const value = input.urls[purpose],
      target = runtimeDatabaseUrl(value);
    if (
      decodeURIComponent(target.username) !== RUNTIME_DATABASE_ROLES[purpose] ||
      !target.password ||
      target.hostname.toLowerCase() !== base.hostname.toLowerCase() ||
      (target.port || '5432') !== (base.port || '5432') ||
      target.pathname !== base.pathname ||
      target.search !== base.search
    )
      unavailable();
    return { purpose, url: value };
  });
  for (const { purpose, url } of urls) {
    const database = createDatabase({
      url,
      poolMax: 1,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 1000,
    });
    try {
      await verifyRuntimeDatabaseRole(database, purpose, input.requireTls);
    } finally {
      await database.destroy();
    }
  }
}
