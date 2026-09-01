import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import pg from 'pg';

const { Pool } = pg;

type JsonObject = Readonly<Record<string, unknown>>;

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

export interface DatabaseSchema {
  'platform.idempotency_records': IdempotencyTable;
  'platform.sample_effects': SampleEffectTable;
  'platform.outbox_events': OutboxEventTable;
  'platform.inbox_messages': InboxMessageTable;
  'platform.sample_projections': SampleProjectionTable;
  'platform.scheduled_jobs': ScheduledJobTable;
  'platform.job_run_logs': JobRunLogTable;
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
