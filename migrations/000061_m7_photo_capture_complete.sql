-- Existing legacy rows remain untouched; every new photo evidence commit must
-- include both its media retention obligation and matching encrypted snapshot.
CREATE FUNCTION moderation.require_complete_photo_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.evidence_type = 'photo' AND (
    NOT EXISTS (SELECT 1 FROM media.report_photo_evidence_holds
      WHERE report_evidence_id = NEW.id AND photo_id = NEW.profile_photo_id)
    OR NOT EXISTS (SELECT 1 FROM moderation.report_snapshots
      WHERE report_evidence_id = NEW.id AND report_id = NEW.report_id AND snapshot_type = 'photo')
  ) THEN
    RAISE EXCEPTION 'photo evidence requires retained encrypted capture'
      USING ERRCODE = '23514', CONSTRAINT = 'report_photo_capture_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_photo_capture_complete
AFTER INSERT ON moderation.report_evidence DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION moderation.require_complete_photo_capture();
