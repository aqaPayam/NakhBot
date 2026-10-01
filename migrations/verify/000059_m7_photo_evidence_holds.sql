DO $$
BEGIN
  IF to_regclass('media.report_photo_evidence_holds') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'media.report_photo_evidence_holds'::regclass
        AND contype = 'f' AND condeferrable AND condeferred)
    OR (SELECT count(*) FROM pg_trigger
      WHERE tgrelid = 'media.report_photo_evidence_holds'::regclass
        AND NOT tgisinternal AND tgenabled = 'O') <> 3 THEN
    RAISE EXCEPTION 'photo evidence holds require deferred binding and immutable source guards';
  END IF;
END $$;
