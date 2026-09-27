CREATE SCHEMA IF NOT EXISTS moderation;

CREATE TABLE moderation.report_reasons (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{0,79}$'),
  label_key text NOT NULL UNIQUE CHECK (label_key ~ '^[a-z][a-z0-9_.]{0,159}$'),
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL UNIQUE CHECK (display_order >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);

WITH seed(code, display_order) AS (
  VALUES
    ('fake_profile', 1),
    ('harassment', 2),
    ('inappropriate_photo', 3),
    ('spam_or_scam', 4),
    ('under_18', 5),
    ('offensive_behavior', 6),
    ('other', 7)
)
INSERT INTO moderation.report_reasons (
  id, code, label_key, is_active, display_order, created_at, updated_at
)
SELECT md5('moderation:report-reason:' || code)::uuid, code,
  'report.reason.' || code, true, display_order,
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
FROM seed;

CREATE FUNCTION moderation.guard_report_reason() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['is_active','updated_at','version'])
      <> (to_jsonb(OLD) - ARRAY['is_active','updated_at','version'])
    OR NEW.is_active = OLD.is_active
    OR NEW.updated_at <= OLD.updated_at
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'report reason identity is immutable and updates must toggle active state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER report_reasons_guard
BEFORE UPDATE ON moderation.report_reasons
FOR EACH ROW EXECUTE FUNCTION moderation.guard_report_reason();

CREATE TABLE moderation.reports (
  id uuid PRIMARY KEY,
  reporter_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  target_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  reason_id uuid NOT NULL REFERENCES moderation.report_reasons(id) ON DELETE RESTRICT,
  extra_text text CHECK (
    extra_text IS NULL OR char_length(extra_text) BETWEEN 1 AND 1024
  ),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN (
    'submitted','pending_review','dismissed','actioned','closed'
  )),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','threshold')),
  command_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  submitted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  reviewed_at timestamptz,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT reports_not_self_ck CHECK (reporter_user_id <> target_user_id),
  CONSTRAINT reports_lifecycle_ck CHECK (
    (status IN ('submitted','pending_review') AND reviewed_at IS NULL AND closed_at IS NULL)
    OR (status IN ('dismissed','actioned') AND reviewed_at IS NOT NULL AND closed_at IS NULL
      AND reviewed_at >= submitted_at)
    OR (status = 'closed' AND reviewed_at IS NOT NULL AND closed_at IS NOT NULL
      AND reviewed_at >= submitted_at AND closed_at >= reviewed_at)
  ),
  UNIQUE (reporter_user_id, idempotency_key)
);

CREATE INDEX reports_reporter_window_idx
  ON moderation.reports (reporter_user_id, submitted_at DESC, id DESC);
CREATE INDEX reports_target_threshold_idx
  ON moderation.reports (target_user_id, submitted_at DESC, reporter_user_id, id)
  WHERE status IN ('submitted','pending_review');
CREATE INDEX reports_review_queue_idx
  ON moderation.reports (priority DESC, submitted_at, id)
  WHERE status IN ('submitted','pending_review');

CREATE FUNCTION moderation.admit_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  replay_digest text;
  committed_count integer;
BEGIN
  SELECT request_digest INTO replay_digest
  FROM moderation.reports
  WHERE reporter_user_id = NEW.reporter_user_id
    AND idempotency_key = NEW.idempotency_key;

  IF FOUND THEN
    IF replay_digest <> NEW.request_digest THEN
      RAISE EXCEPTION 'report idempotency key was reused for different data'
        USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('moderation-report:' || NEW.reporter_user_id::text, 0)
  );
  SELECT count(*) INTO committed_count
  FROM moderation.reports
  WHERE reporter_user_id = NEW.reporter_user_id
    AND submitted_at > transaction_timestamp() - interval '24 hours';
  IF committed_count >= 10 THEN
    RAISE EXCEPTION 'user report limit exceeded' USING ERRCODE = 'P0001';
  END IF;

  NEW.submitted_at := transaction_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER reports_admission
BEFORE INSERT ON moderation.reports
FOR EACH ROW EXECUTE FUNCTION moderation.admit_report();

CREATE FUNCTION moderation.guard_report_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','priority','reviewed_at','closed_at','version'])
      <> (to_jsonb(OLD) - ARRAY['status','priority','reviewed_at','closed_at','version'])
    OR NEW.version <> OLD.version + 1
    OR NOT (
      (OLD.status = 'submitted' AND NEW.status IN ('pending_review','dismissed','actioned','closed'))
      OR (OLD.status = 'pending_review' AND NEW.status IN ('dismissed','actioned','closed'))
      OR (OLD.status IN ('dismissed','actioned') AND NEW.status = 'closed')
      OR (OLD.status = NEW.status AND OLD.priority = 'normal' AND NEW.priority = 'threshold')
    ) THEN
    RAISE EXCEPTION 'report transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reports_update_guard
BEFORE UPDATE ON moderation.reports
FOR EACH ROW EXECUTE FUNCTION moderation.guard_report_update();

CREATE FUNCTION moderation.reject_report_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reports cannot be deleted outside the retention purge' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER reports_delete_guard
BEFORE DELETE ON moderation.reports
FOR EACH ROW EXECUTE FUNCTION moderation.reject_report_delete();

COMMENT ON TABLE moderation.report_reasons IS
  'Code-owned active report reason catalog; labels are localized separately.';
COMMENT ON TABLE moderation.reports IS
  'Confidential user reports with durable replay binding and a serialized rolling 24-hour limit.';
