import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import type { AccountState } from '@nakh/domain';
import pg from 'pg';

const { Pool } = pg;

type JsonObject = Readonly<Record<string, unknown>>;
type JsonArray = readonly unknown[];

export interface IdempotencyTable {
  id: string;
  actor_user_id: string;
  scope: string;
  idempotency_key: string;
  request_hash: string;
  status: 'processing' | 'completed';
  response_json: ColumnType<JsonObject | null, object | null, object | null>;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface SampleEffectTable {
  id: string;
  actor_user_id: string;
  name: string;
  created_at: Date;
}

export interface OutboxEventTable {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  schema_version: number;
  payload: ColumnType<JsonObject, object, object>;
  occurred_at: Date;
  available_at: Date;
  attempt_count: Generated<number>;
  published_at: Date | null;
  last_error_code: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  correlation_id: string;
  causation_id: string;
}

export interface InboxMessageTable {
  id: string;
  consumer: string;
  message_id: string;
  payload_hash: string;
  received_at: Date;
  processed_at: Date | null;
  result_code: string | null;
}

export interface SampleProjectionTable {
  id: string;
  source_event_id: string;
  effect_id: string;
  projected_name: string;
  projected_at: Date;
}

export interface ScheduledJobTable {
  id: string;
  job_type: string;
  is_active: Generated<boolean>;
  schedule_config: ColumnType<JsonObject, object, object>;
  last_run_at: Date | null;
  next_run_at: Date;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
}

export interface JobRunLogTable {
  id: string;
  scheduled_job_id: string;
  run_key: string;
  status: 'started' | 'succeeded' | 'failed' | 'skipped';
  started_at: Date;
  finished_at: Date | null;
  error_code: string | null;
  metadata: ColumnType<JsonObject, object, object>;
}

export interface LocaleTable {
  code: string;
  english_name: string;
  native_name: string;
  is_active: boolean;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UiTextTable {
  id: string;
  locale_code: string;
  text_key: string;
  value: string;
  category: 'button' | 'message' | 'error' | 'admin' | 'payment' | 'notification' | 'safety';
  variables: ColumnType<JsonArray, readonly unknown[], readonly unknown[]>;
  is_active: Generated<boolean>;
  created_at: Date;
  updated_at: Date;
}

export interface UserTable {
  id: string;
  last_activity_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface TelegramIdentityTable {
  user_id: string;
  telegram_user_id: string;
  username: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
}

export interface AccountTable {
  user_id: string;
  state: AccountState;
  state_reason: string | null;
  state_changed_at: Date;
  version: Generated<number>;
}

export interface AccountStateHistoryTable {
  id: string;
  user_id: string;
  previous_state: AccountState | null;
  next_state: AccountState;
  reason_code: string;
  actor_type: 'user' | 'admin' | 'system';
  actor_user_id: string | null;
  actor_admin_id: string | null;
  changed_at: Date;
}

export interface GuestPreviewCounterTable {
  user_id: string;
  preview_count: Generated<number>;
  limit_count: number;
  first_preview_at: Date | null;
  last_preview_at: Date | null;
}

export interface UserSettingsTable {
  user_id: string;
  visibility_enabled: Generated<boolean>;
  ui_locale_code: Generated<string>;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
}

export interface CreditAccountTable {
  user_id: string;
  balance: Generated<string>;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
}

export interface NotificationPreferenceTable {
  user_id: string;
  chat_enabled: Generated<boolean>;
  like_enabled: Generated<boolean>;
  nakh_enabled: Generated<boolean>;
  match_enabled: Generated<boolean>;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
}

export interface AuditLogTable {
  id: string;
  category: 'product' | 'account' | 'security' | 'admin';
  event_type: string;
  actor_type: 'user' | 'admin' | 'system';
  actor_user_id: string | null;
  actor_admin_id: string | null;
  subject_type: string;
  subject_id: string;
  result_code: string;
  metadata_schema_version: number;
  metadata: ColumnType<JsonObject, object, object>;
  request_id: string;
  command_id: string;
  occurred_at: Date;
}

export interface DatabaseSchema {
  'platform.idempotency_records': IdempotencyTable;
  'platform.sample_effects': SampleEffectTable;
  'platform.outbox_events': OutboxEventTable;
  'platform.inbox_messages': InboxMessageTable;
  'platform.sample_projections': SampleProjectionTable;
  'platform.scheduled_jobs': ScheduledJobTable;
  'platform.job_run_logs': JobRunLogTable;
  'catalog.locales': LocaleTable;
  'catalog.ui_texts': UiTextTable;
  'identity.users': UserTable;
  'identity.telegram_identities': TelegramIdentityTable;
  'identity.accounts': AccountTable;
  'identity.account_state_history': AccountStateHistoryTable;
  'identity.guest_preview_counters': GuestPreviewCounterTable;
  'identity.user_settings': UserSettingsTable;
  'billing.credit_accounts': CreditAccountTable;
  'notification.notification_preferences': NotificationPreferenceTable;
  'platform.audit_logs': AuditLogTable;
}

export type NakhDatabase = Kysely<DatabaseSchema>;

export type DatabaseConfig = Readonly<{
  url: string;
  poolMax: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}>;

export function createDatabase(config: DatabaseConfig): NakhDatabase {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    statement_timeout: config.statementTimeoutMs,
    options: `-c lock_timeout=${config.lockTimeoutMs}ms -c timezone=UTC`,
    application_name: 'nakh',
  });
  return new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
}

export class PostgresUnitOfWork {
  public constructor(private readonly database: NakhDatabase) {}

  public async execute<T>(operation: (transaction: NakhDatabase) => Promise<T>): Promise<T> {
    return this.database.transaction().execute(operation);
  }
}
