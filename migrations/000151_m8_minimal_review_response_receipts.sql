-- Administrator transport responses must not duplicate another subject's
-- protected profile values. Native requests, reviews and audits remain intact.
CREATE FUNCTION profile.review_response_receipt_valid(body jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
 IF jsonb_typeof(body) IS DISTINCT FROM 'object'
  OR body->'receiptSchemaVersion' IS DISTINCT FROM '1'::jsonb
  OR jsonb_typeof(body->'profileChangeRequestId') IS DISTINCT FROM 'string'
  OR body->>'profileChangeRequestId'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR jsonb_typeof(body->'decision') IS DISTINCT FROM 'string'
  OR body->>'decision' NOT IN('approved','rejected')
  OR jsonb_typeof(body->'profileVersion') IS DISTINCT FROM 'number'
  OR body->>'profileVersion'!~'^[1-9][0-9]{0,9}$' THEN RETURN false; END IF;
 IF (body->>'profileVersion')::bigint>2147483647 THEN RETURN false; END IF;
 RETURN body=jsonb_build_object('receiptSchemaVersion',1,
  'profileChangeRequestId',body->'profileChangeRequestId',
  'decision',body->'decision','profileVersion',body->'profileVersion');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

LOCK TABLE platform.idempotency_records IN SHARE ROW EXCLUSIVE MODE;
DO $$ DECLARE original platform.idempotency_records; changed platform.idempotency_records;
 receipt jsonb; action text; affected integer; audit_id uuid;
BEGIN
 FOR original IN SELECT * FROM platform.idempotency_records
  WHERE scope='profile.resolve-protected-change' AND status='completed'
   AND profile.review_response_receipt_valid(response_json) IS NOT TRUE
  ORDER BY id FOR UPDATE
 LOOP
  receipt:=jsonb_build_object('receiptSchemaVersion',1,
   'profileChangeRequestId',original.response_json#>'{request,requestId}',
   'decision',original.response_json->'decision',
   'profileVersion',original.response_json->'profileVersion');
  IF profile.review_response_receipt_valid(receipt) THEN
   UPDATE platform.idempotency_records SET response_json=receipt WHERE id=original.id RETURNING * INTO changed;
   action:='response_minimized';
  ELSE
   DELETE FROM platform.idempotency_records WHERE id=original.id;
   changed:=NULL; action:='response_discarded';
  END IF;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'review response minimization missing'; END IF;
  audit_id:=gen_random_uuid();
  INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,
   result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
  VALUES(audit_id,'security','profile.review-response-minimized.v1','system','command_response',original.id,
   action,1,jsonb_build_object(
    'rowHashBefore',encode(sha256(convert_to(to_jsonb(original)::text,'UTF8')),'hex'),
    'rowHashAfter',CASE WHEN action='response_minimized' THEN encode(sha256(convert_to(to_jsonb(changed)::text,'UTF8')),'hex') ELSE NULL END),
   original.id,original.id,clock_timestamp());
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'review response minimization audit missing'; END IF;
 END LOOP;
END $$;
ALTER TABLE platform.idempotency_records ADD CONSTRAINT profile_review_response_minimal_ck
 CHECK(scope<>'profile.resolve-protected-change' OR status<>'completed'
  OR profile.review_response_receipt_valid(response_json) IS TRUE);
