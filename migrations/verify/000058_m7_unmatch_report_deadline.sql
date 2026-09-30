DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'moderation.report_evidence'::regclass
      AND tgname = 'report_unmatch_deadline_valid' AND NOT tgisinternal AND tgenabled = 'O'
  ) OR position('clock_timestamp()' in pg_get_functiondef(
    'moderation.validate_unmatch_report_deadline()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'unmatch report insert requires a post-lock database deadline guard';
  END IF;
END $$;
