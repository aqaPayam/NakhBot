DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef('moderation.verify_review_report_state()'::regprocedure)
    INTO definition;
  IF position('to_jsonb(NEW)' IN definition) = 0
    OR position('report_id' IN definition) = 0 THEN
    RAISE EXCEPTION 'M7 review/report consistency trigger is not row-shape safe';
  END IF;
END $$;
