DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'moderation.report_evidence'::regclass
    AND tgname = 'report_photo_capture_complete' AND tgdeferrable AND tginitdeferred
    AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'new photo evidence requires atomic retained encrypted capture';
  END IF;
END $$;
