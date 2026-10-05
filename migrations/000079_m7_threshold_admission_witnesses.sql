-- Historical visibility cannot be reconstructed from today's Reports. Preserve old episodes as
-- explicitly unverified; every ordinary new admission must capture its original distinct roster.
ALTER TABLE moderation.restriction_episodes ADD COLUMN witness_required boolean NOT NULL DEFAULT false;
ALTER TABLE moderation.restriction_episodes ALTER COLUMN witness_required SET DEFAULT true;
ALTER TABLE moderation.restriction_episodes ADD COLUMN witness_capture_xid xid8;
ALTER TABLE moderation.restriction_episodes ALTER COLUMN witness_capture_xid SET DEFAULT pg_current_xact_id();
ALTER TABLE moderation.restriction_episodes ADD CONSTRAINT restriction_episode_witness_mode_ck
  CHECK (witness_required = (witness_capture_xid IS NOT NULL));

CREATE TABLE moderation.threshold_admission_witnesses (
  restriction_episode_id uuid NOT NULL REFERENCES moderation.restriction_episodes(id) ON DELETE RESTRICT,
  reporter_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  report_id uuid NOT NULL REFERENCES moderation.reports(id) ON DELETE RESTRICT,
  submitted_at timestamptz NOT NULL,
  PRIMARY KEY (restriction_episode_id, reporter_user_id),
  UNIQUE (restriction_episode_id, report_id)
);

CREATE FUNCTION moderation.guard_episode_witness_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND (NOT NEW.witness_required OR NEW.witness_capture_xid IS DISTINCT FROM pg_current_xact_id()))
    OR (TG_OP = 'UPDATE' AND (NEW.witness_required IS DISTINCT FROM OLD.witness_required
      OR NEW.witness_capture_xid IS DISTINCT FROM OLD.witness_capture_xid)) THEN
    RAISE EXCEPTION 'threshold admission witness mode is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER restriction_episode_witness_mode BEFORE INSERT OR UPDATE ON moderation.restriction_episodes
FOR EACH ROW EXECUTE FUNCTION moderation.guard_episode_witness_mode();

CREATE FUNCTION moderation.guard_threshold_admission_witness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'threshold admission witnesses are retained immutable history' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM moderation.restriction_episodes episode JOIN moderation.reports report
      ON report.id = NEW.report_id AND report.target_user_id = episode.target_user_id
      AND report.reporter_user_id = NEW.reporter_user_id AND report.submitted_at = NEW.submitted_at
    WHERE episode.id = NEW.restriction_episode_id AND episode.witness_required
      -- Only nested capture from the parent episode trigger may add members. This also prevents
      -- later direct appends if logical restore happens to reuse a historical transaction ID.
      AND pg_trigger_depth() >= 2
      AND episode.witness_capture_xid = pg_current_xact_id()
      AND report.status IN ('submitted','pending_review')
      AND report.submitted_at > episode.started_at - interval '30 days'
      AND report.submitted_at <= episode.started_at
  ) THEN
    RAISE EXCEPTION 'threshold admission witness binding is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER threshold_admission_witness_guard BEFORE INSERT OR UPDATE OR DELETE
ON moderation.threshold_admission_witnesses FOR EACH ROW EXECUTE FUNCTION moderation.guard_threshold_admission_witness();

CREATE FUNCTION moderation.capture_threshold_admission_witnesses() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE captured integer;
BEGIN
  INSERT INTO moderation.threshold_admission_witnesses
    (restriction_episode_id,reporter_user_id,report_id,submitted_at)
  SELECT NEW.id, reporter_user_id, id, submitted_at FROM (
    SELECT DISTINCT ON (reporter_user_id) reporter_user_id,id,submitted_at
    FROM moderation.reports WHERE target_user_id = NEW.target_user_id
      AND status IN ('submitted','pending_review')
      AND submitted_at > NEW.started_at - interval '30 days' AND submitted_at <= NEW.started_at
    ORDER BY reporter_user_id,submitted_at,id
  ) admitted;
  GET DIAGNOSTICS captured = ROW_COUNT;
  IF captured <> NEW.distinct_reporter_count THEN
    RAISE EXCEPTION 'threshold admission witness cardinality is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER restriction_episode_capture_witnesses AFTER INSERT ON moderation.restriction_episodes
FOR EACH ROW EXECUTE FUNCTION moderation.capture_threshold_admission_witnesses();

CREATE FUNCTION moderation.verify_threshold_witness_cardinality() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected integer; required boolean; actual integer;
BEGIN
  SELECT distinct_reporter_count,witness_required INTO expected,required
  FROM moderation.restriction_episodes WHERE id = NEW.id;
  SELECT count(*) INTO actual FROM moderation.threshold_admission_witnesses
  WHERE restriction_episode_id = NEW.id;
  IF NOT required OR actual <> expected THEN
    RAISE EXCEPTION 'threshold admission witness cardinality is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
-- Validate once per episode at commit. The captured top-level transaction ID prevents any later
-- transaction from appending; the immutable keys prevent rewriting or removing original members.
CREATE CONSTRAINT TRIGGER threshold_admission_witness_cardinality AFTER INSERT
ON moderation.restriction_episodes DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION moderation.verify_threshold_witness_cardinality();

COMMENT ON TABLE moderation.threshold_admission_witnesses IS
  'Restricted immutable original distinct-reporter admission roster; no Report prose or reconstructed legacy proof.';
