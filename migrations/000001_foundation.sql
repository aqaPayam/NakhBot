CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE platform.idempotency_records (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  scope text NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 160),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
  status text NOT NULL CHECK (status IN ('processing', 'completed')),
  response_json jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT idempotency_completed_response_ck CHECK (
    (status = 'processing' AND response_json IS NULL)
    OR (status = 'completed' AND response_json IS NOT NULL)
  ),
  UNIQUE (actor_user_id, scope, idempotency_key)
);

CREATE INDEX idempotency_expiry_idx
  ON platform.idempotency_records (expires_at, id)
  WHERE status = 'completed';

CREATE TABLE platform.sample_effects (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL
);

CREATE TABLE platform.outbox_events (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (char_length(aggregate_type) BETWEEN 1 AND 80),
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 160),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  published_at timestamptz,
  last_error_code text,
  lease_owner text,
  lease_expires_at timestamptz,
  correlation_id uuid NOT NULL,
  causation_id uuid NOT NULL,
  CONSTRAINT outbox_lease_shape_ck CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX outbox_dispatch_idx
  ON platform.outbox_events (available_at, id)
  WHERE published_at IS NULL;

CREATE TABLE platform.inbox_messages (
  id uuid PRIMARY KEY,
  consumer text NOT NULL CHECK (char_length(consumer) BETWEEN 1 AND 160),
  message_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (char_length(payload_hash) = 64),
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  result_code text,
  UNIQUE (consumer, message_id)
);

CREATE INDEX inbox_received_idx ON platform.inbox_messages (received_at, id);

CREATE TABLE platform.sample_projections (
  id uuid PRIMARY KEY,
  source_event_id uuid NOT NULL UNIQUE,
  effect_id uuid NOT NULL UNIQUE REFERENCES platform.sample_effects(id) ON DELETE RESTRICT,
  projected_name text NOT NULL,
  projected_at timestamptz NOT NULL
);

CREATE TABLE platform.scheduled_jobs (
  id uuid PRIMARY KEY,
  job_type text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  schedule_config jsonb NOT NULL,
  last_run_at timestamptz,
  next_run_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX scheduled_jobs_due_idx
  ON platform.scheduled_jobs (next_run_at, id)
  WHERE is_active;

CREATE TABLE platform.job_run_logs (
  id uuid PRIMARY KEY,
  scheduled_job_id uuid NOT NULL REFERENCES platform.scheduled_jobs(id) ON DELETE RESTRICT,
  run_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'skipped')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  error_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (scheduled_job_id, run_key)
);

COMMENT ON TABLE platform.sample_effects IS
  'M0 walking-skeleton aggregate. Removed when the first real vertical slice supersedes it.';
