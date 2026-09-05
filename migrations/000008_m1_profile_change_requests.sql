CREATE SCHEMA IF NOT EXISTS administration;

CREATE TABLE administration.admin_users (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES identity.users(id) ON DELETE RESTRICT,
  telegram_user_id bigint NOT NULL UNIQUE CHECK (telegram_user_id > 0),
  is_active boolean NOT NULL DEFAULT true,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT admin_user_active_state_ck CHECK (is_active = (disabled_at IS NULL))
);

CREATE TABLE profile.profile_change_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  field_name text NOT NULL CHECK (field_name IN ('birth_year', 'gender')),
  old_value_snapshot jsonb NOT NULL,
  requested_value jsonb NOT NULL,
  value_schema_version integer NOT NULL CHECK (value_schema_version = 1),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1024),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  submitted_at timestamptz NOT NULL,
  resolved_at timestamptz,
  CONSTRAINT profile_change_request_value_shape_ck CHECK (
    (field_name = 'birth_year'
      AND jsonb_typeof(old_value_snapshot) = 'number'
      AND jsonb_typeof(requested_value) = 'number'
      AND (old_value_snapshot #>> '{}') ~ '^[0-9]+$'
      AND (requested_value #>> '{}') ~ '^[0-9]+$')
    OR (field_name = 'gender'
      AND jsonb_typeof(old_value_snapshot) = 'string'
      AND jsonb_typeof(requested_value) = 'string'
      AND (old_value_snapshot #>> '{}') ~ '^[a-z][a-z0-9_]{0,63}$'
      AND (requested_value #>> '{}') ~ '^[a-z][a-z0-9_]{0,63}$')
  ),
  CONSTRAINT profile_change_request_resolution_ck CHECK (
    (status = 'pending' AND resolved_at IS NULL)
    OR (status <> 'pending' AND resolved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX profile_change_requests_one_pending_idx
  ON profile.profile_change_requests (user_id, field_name)
  WHERE status = 'pending';
CREATE INDEX profile_change_requests_review_queue_idx
  ON profile.profile_change_requests (status, submitted_at, id);
CREATE INDEX profile_change_requests_user_history_idx
  ON profile.profile_change_requests (user_id, submitted_at DESC, id);

CREATE TABLE profile.profile_change_reviews (
  request_id uuid PRIMARY KEY REFERENCES profile.profile_change_requests(id) ON DELETE RESTRICT,
  admin_user_id uuid NOT NULL REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  admin_note text CHECK (admin_note IS NULL OR char_length(admin_note) <= 4096),
  reviewed_at timestamptz NOT NULL
);

CREATE INDEX profile_change_reviews_admin_time_idx
  ON profile.profile_change_reviews (admin_user_id, reviewed_at DESC, request_id);

CREATE FUNCTION profile.reject_profile_change_review_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Profile change reviews are append-only' USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER profile_change_reviews_immutable
BEFORE UPDATE OR DELETE ON profile.profile_change_reviews
FOR EACH ROW EXECUTE FUNCTION profile.reject_profile_change_review_mutation();

INSERT INTO catalog.ui_texts (
  id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at
) VALUES
  (md5('en:error.profile.change.pending')::uuid, 'en', 'error.profile.change.pending', 'A change request for this field is already pending.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.profile.change.invalid')::uuid, 'en', 'error.profile.change.invalid', 'This protected profile change is no longer valid.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.profile.change.reviewer_unauthorized')::uuid, 'en', 'error.profile.change.reviewer_unauthorized', 'This reviewer is not authorized.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.profile.change.not_found')::uuid, 'en', 'error.profile.change.not_found', 'This profile change request was not found.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
