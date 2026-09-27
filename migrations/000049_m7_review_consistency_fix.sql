CREATE OR REPLACE FUNCTION moderation.verify_review_report_state() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  review_status text;
  report_status text;
  governed_report_id uuid;
BEGIN
  governed_report_id := CASE
    WHEN TG_TABLE_NAME = 'reports' THEN (to_jsonb(NEW) ->> 'id')::uuid
    ELSE (to_jsonb(NEW) ->> 'report_id')::uuid
  END;
  SELECT status INTO review_status FROM moderation.moderation_reviews
    WHERE report_id = governed_report_id;
  SELECT status INTO report_status FROM moderation.reports WHERE id = governed_report_id;
  IF review_status IS NOT NULL AND NOT (
    (review_status = 'pending' AND report_status = 'pending_review')
    OR (review_status = 'in_review' AND report_status = 'pending_review')
    OR (review_status = 'dismissed' AND report_status = 'dismissed')
    OR (review_status = 'actioned' AND report_status = 'actioned')
  ) THEN
    RAISE EXCEPTION 'review and report states disagree' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

COMMENT ON FUNCTION moderation.verify_review_report_state() IS
  'Deferred cross-table review consistency using trigger-record JSON for both source row shapes.';
