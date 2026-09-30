-- Capture may wait on other locks after source authorization. Enforce the immutable
-- window again at evidence insertion, using the post-lock wall clock, not transaction start.
CREATE FUNCTION moderation.validate_unmatch_report_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source matching.unmatch_records%ROWTYPE;
  checked_at timestamptz;
BEGIN
  IF NEW.evidence_type <> 'unmatched_user' THEN RETURN NEW; END IF;
  SELECT * INTO source FROM matching.unmatch_records
  WHERE match_id = NEW.unmatch_record_id FOR SHARE;
  checked_at := clock_timestamp();
  IF source.match_id IS NULL OR checked_at < source.unmatched_at
    OR checked_at >= source.report_window_expires_at THEN
    RAISE EXCEPTION 'unmatched user report window is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'report_unmatch_deadline_valid';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER report_unmatch_deadline_valid
BEFORE INSERT ON moderation.report_evidence
FOR EACH ROW EXECUTE FUNCTION moderation.validate_unmatch_report_deadline();
