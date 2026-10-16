DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform.idempotency_records'::regclass
   AND conname='profile_review_response_minimal_ck' AND convalidated)
  OR EXISTS(SELECT 1 FROM platform.idempotency_records WHERE scope='profile.resolve-protected-change'
   AND status='completed' AND profile.review_response_receipt_valid(response_json) IS NOT TRUE)
  OR profile.review_response_receipt_valid('{"receiptSchemaVersion":1,"profileChangeRequestId":"00000000-0000-4000-8000-000000000001","decision":"approved","profileVersion":1}') IS NOT TRUE
  OR profile.review_response_receipt_valid('{"receiptSchemaVersion":1,"profileChangeRequestId":"00000000-0000-4000-8000-000000000001","decision":"approved","profileVersion":1,"request":{"oldValue":1995}}') IS NOT FALSE THEN
  RAISE EXCEPTION 'minimal profile review response contract missing';
 END IF;
END $$;
