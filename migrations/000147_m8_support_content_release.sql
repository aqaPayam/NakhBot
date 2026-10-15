-- Deployable implementation; activation needs a separate reviewed deployment
-- after real retention/hold approval. Neither a session GUC nor a policy period
-- enables this switch. No production policy or release is seeded.
CREATE FUNCTION identity.retained_content_release_enabled() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='account.support-content-released.v1') THEN
  RAISE EXCEPTION 'legacy support release lacks provenance' USING ERRCODE='55000'; END IF;
END $$;

CREATE UNIQUE INDEX support_content_release_source_idx ON platform.audit_logs((metadata->>'sourceAuditId'))
 WHERE event_type='account.support-content-released.v1';

CREATE FUNCTION support.content_release_valid(a platform.audit_logs,live boolean) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET TimeZone='UTC' AS $$
DECLARE source platform.audit_logs; approval platform.audit_logs; root identity.account_deletion_records;
BEGIN
 IF a.category<>'account' OR a.event_type<>'account.support-content-released.v1' OR a.actor_type<>'system'
  OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NOT NULL OR a.subject_type<>'account_deletion'
  OR a.result_code<>'support_content_released' OR a.metadata_schema_version<>1 OR jsonb_typeof(a.metadata)<>'object'
  OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>5
  OR jsonb_typeof(a.metadata->'sourceAuditId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'approvalId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'rootVersion') IS DISTINCT FROM 'number'
  OR a.metadata->>'rootVersion'!~'^[0-9]{1,10}$'
  OR jsonb_typeof(a.metadata->'rowHashAfter') IS DISTINCT FROM 'string' OR a.metadata->>'rowHashAfter'!~'^[0-9a-f]{64}$'
  OR jsonb_typeof(a.metadata->'transactionId') IS DISTINCT FROM 'string' OR a.metadata->>'transactionId'!~'^[1-9][0-9]{0,19}$'
  THEN RETURN false; END IF;
 SELECT * INTO source FROM platform.audit_logs WHERE id=(a.metadata->>'sourceAuditId')::uuid;
 SELECT * INTO approval FROM platform.audit_logs WHERE id=(a.metadata->>'approvalId')::uuid;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=a.subject_id;
 IF source.id IS NULL OR approval.id IS NULL OR root.id IS NULL
  OR source.subject_id<>root.id OR source.metadata->>'resource'<>'support.support_messages'
  OR identity.retained_source_proof_valid(source,false) IS NOT TRUE
  OR approval.event_type<>'account.retention-policy-approved.v1' OR approval.subject_id<>root.id
  OR approval.metadata->>'retentionRecordId' IS DISTINCT FROM source.metadata->>'retentionRecordId'
  OR identity.retention_policy_proof_valid(approval,false) IS NOT TRUE
  OR root.account_version IS DISTINCT FROM (a.metadata->>'rootVersion')::integer
  OR a.command_id IS DISTINCT FROM root.command_id OR a.request_id IS DISTINCT FROM root.request_id
  OR NOT isfinite(a.occurred_at) OR a.occurred_at>clock_timestamp() OR a.occurred_at<approval.occurred_at
  OR a.occurred_at<root.completed_at+make_interval(secs=>(approval.metadata->>'retentionSeconds')::double precision)
  OR a.metadata->>'rowHashAfter'=source.metadata->>'rowHash'
  OR EXISTS(SELECT 1 FROM platform.audit_logs revoked WHERE revoked.event_type='account.retention-policy-revoked.v1'
    AND revoked.metadata->>'approvalId'=approval.id::text AND revoked.occurred_at<=a.occurred_at)
  THEN RETURN false; END IF;
 IF live AND (
  identity.retained_content_release_enabled() IS NOT TRUE
  OR (a.metadata->>'transactionId')::xid8<>pg_current_xact_id()
  OR identity.retention_policy_eligible(root.id,(source.metadata->>'retentionRecordId')::uuid) IS NOT TRUE
  OR root.safety_bar<>'none'
  OR EXISTS(SELECT 1 FROM platform.audit_logs revoked WHERE revoked.event_type='account.retention-policy-revoked.v1'
    AND revoked.metadata->>'approvalId'=approval.id::text)
  OR EXISTS(SELECT 1 FROM platform.audit_logs newer WHERE newer.subject_id=root.id
    AND newer.event_type='account.retention-policy-approved.v1' AND newer.metadata->>'resource'='support.support_messages'
    AND (newer.metadata->>'policyVersion')::integer>(approval.metadata->>'policyVersion')::integer)
 ) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION support.content_released(message_id uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM platform.audit_logs a JOIN platform.audit_logs source ON source.id=(a.metadata->>'sourceAuditId')::uuid
  WHERE a.event_type='account.support-content-released.v1' AND source.event_type='account.retained-source-recorded.v1'
   AND source.metadata->>'rowKeyHash'=encode(sha256(convert_to(jsonb_build_array(message_id)::text,'UTF8')),'hex')
   AND support.content_release_valid(a,false)) $$;

CREATE FUNCTION support.guard_content_release() RETURNS trigger LANGUAGE plpgsql SET TimeZone='UTC' AS $$
DECLARE subject uuid; source platform.audit_logs; target support.support_messages;
BEGIN
 IF NEW.event_type<>'account.support-content-released.v1' THEN RETURN NEW; END IF;
 SELECT user_id INTO subject FROM identity.account_deletion_records WHERE id=NEW.subject_id;
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 PERFORM id FROM identity.account_deletion_records WHERE id=NEW.subject_id FOR UPDATE;
 IF support.content_release_valid(NEW,true) IS NOT TRUE THEN
  RAISE EXCEPTION 'support release authority unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM platform.audit_logs WHERE id=(NEW.metadata->>'sourceAuditId')::uuid;
 PERFORM thread.id FROM support.support_threads thread JOIN support.support_messages message ON message.support_thread_id=thread.id
  WHERE thread.user_id=subject AND encode(sha256(convert_to(jsonb_build_array(message.id)::text,'UTF8')),'hex')=source.metadata->>'rowKeyHash'
  FOR NO KEY UPDATE OF thread;
 SELECT message.* INTO target FROM support.support_messages message JOIN support.support_threads thread ON thread.id=message.support_thread_id
  WHERE thread.user_id=subject AND thread.status='closed'
   AND thread.product_epoch=(SELECT product_epoch FROM identity.account_deletion_records WHERE id=NEW.subject_id)
   AND encode(sha256(convert_to(jsonb_build_array(message.id)::text,'UTF8')),'hex')=source.metadata->>'rowKeyHash'
  FOR UPDATE OF message;
 IF target.id IS NULL THEN RAISE EXCEPTION 'original support source unavailable' USING ERRCODE='23514'; END IF;
 IF TG_WHEN='BEFORE' THEN
  IF identity.retained_source_matches(NEW.subject_id,'support.support_messages',source.metadata->>'rowKeyHash',source.metadata->>'rowHash') IS NOT TRUE
   OR encode(sha256(convert_to((to_jsonb(target)||jsonb_build_object('message_text','[retained support content released]'))::text,'UTF8')),'hex')
     IS DISTINCT FROM NEW.metadata->>'rowHashAfter' THEN
   RAISE EXCEPTION 'original support source changed' USING ERRCODE='23514'; END IF;
 ELSE
  IF target.message_text<>'[retained support content released]'
   OR encode(sha256(convert_to(to_jsonb(target)::text,'UTF8')),'hex') IS DISTINCT FROM NEW.metadata->>'rowHashAfter' THEN
   RAISE EXCEPTION 'support content release incomplete' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER support_content_release_guard BEFORE INSERT ON platform.audit_logs
 FOR EACH ROW EXECUTE FUNCTION support.guard_content_release();
CREATE CONSTRAINT TRIGGER support_content_release_commit AFTER INSERT ON platform.audit_logs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION support.guard_content_release();

CREATE OR REPLACE FUNCTION support.reject_message_mutation() RETURNS trigger LANGUAGE plpgsql SET TimeZone='UTC' AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.message_text='[retained support content released]'
  AND NEW.message_text IS DISTINCT FROM OLD.message_text
  AND to_jsonb(NEW)-'message_text'=to_jsonb(OLD)-'message_text'
  AND EXISTS(SELECT 1 FROM platform.audit_logs a JOIN platform.audit_logs source ON source.id=(a.metadata->>'sourceAuditId')::uuid
    WHERE a.event_type='account.support-content-released.v1' AND support.content_release_valid(a,true)
     AND source.metadata->>'rowKeyHash'=encode(sha256(convert_to(jsonb_build_array(OLD.id)::text,'UTF8')),'hex')
     AND source.metadata->>'rowHash'=encode(sha256(convert_to(to_jsonb(OLD)::text,'UTF8')),'hex')
     AND a.metadata->>'rowHashAfter'=encode(sha256(convert_to(to_jsonb(NEW)::text,'UTF8')),'hex')) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'support messages are immutable' USING ERRCODE='55000';
END $$;

CREATE FUNCTION support.release_content(root_id uuid,source_id uuid,approval_id uuid,root_version integer) RETURNS uuid
LANGUAGE plpgsql SET TimeZone='UTC' AS $$
DECLARE root identity.account_deletion_records; source platform.audit_logs; target support.support_messages;
 receipt uuid; affected integer;
BEGIN
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=root_id;
 PERFORM id FROM identity.users WHERE id=root.user_id FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=root.user_id FOR UPDATE;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=root_id FOR UPDATE;
 SELECT * INTO source FROM platform.audit_logs WHERE id=source_id;
 IF root.id IS NULL OR root.account_version IS DISTINCT FROM root_version OR source.subject_id IS DISTINCT FROM root.id
  OR source.metadata->>'resource' IS DISTINCT FROM 'support.support_messages'
  OR identity.retained_source_proof_valid(source,false) IS NOT TRUE THEN
  RAISE EXCEPTION 'support content source unavailable' USING ERRCODE='23514'; END IF;
 SELECT id INTO receipt FROM platform.audit_logs a WHERE a.event_type='account.support-content-released.v1'
  AND a.metadata->>'sourceAuditId'=source.id::text AND a.metadata->>'approvalId'=approval_id::text
  AND support.content_release_valid(a,false);
 -- A historical replay returns only the immutable receipt, including after
 -- revocation or deployment deactivation; it cannot perform a second mutation.
 IF receipt IS NOT NULL THEN RETURN receipt; END IF;
 IF identity.retained_content_release_enabled() IS NOT TRUE THEN
  RAISE EXCEPTION 'retained release is disabled' USING ERRCODE='55000'; END IF;
 PERFORM thread.id FROM support.support_threads thread JOIN support.support_messages message ON message.support_thread_id=thread.id
  WHERE thread.user_id=root.user_id AND encode(sha256(convert_to(jsonb_build_array(message.id)::text,'UTF8')),'hex')=source.metadata->>'rowKeyHash'
  FOR NO KEY UPDATE OF thread;
 -- The closed original-life thread owns all bodies, including administrator
 -- replies. Headers remain for reply/admission/review and lifecycle proofs.
 SELECT message.* INTO target FROM support.support_messages message JOIN support.support_threads thread ON thread.id=message.support_thread_id
  WHERE thread.user_id=root.user_id AND thread.product_epoch=root.product_epoch AND thread.status='closed'
   AND encode(sha256(convert_to(jsonb_build_array(message.id)::text,'UTF8')),'hex')=source.metadata->>'rowKeyHash'
  FOR UPDATE OF message;
 IF target.id IS NULL OR target.message_text='[retained support content released]' THEN
  RAISE EXCEPTION 'support content unavailable' USING ERRCODE='23514'; END IF;
 receipt:=gen_random_uuid();
 INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,
  metadata_schema_version,metadata,command_id,request_id,occurred_at)
 VALUES(receipt,'account','account.support-content-released.v1','system',NULL,NULL,'account_deletion',root.id,'support_content_released',1,
  jsonb_build_object('sourceAuditId',source.id,'approvalId',approval_id,'rootVersion',root.account_version,'transactionId',pg_current_xact_id()::text,
   'rowHashAfter',encode(sha256(convert_to((to_jsonb(target)||jsonb_build_object('message_text','[retained support content released]'))::text,'UTF8')),'hex')),
  root.command_id,root.request_id,clock_timestamp());
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'support release audit missing' USING ERRCODE='23514'; END IF;
 UPDATE support.support_messages SET message_text='[retained support content released]' WHERE id=target.id;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'support release effect missing' USING ERRCODE='23514'; END IF;
 RETURN receipt;
END $$;

-- Preserve the historical content-free release receipt as lifecycle proof.
-- A malformed release remains an operational blocker.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('platform.deletion_operational_blocker(uuid)'::regprocedure) INTO definition;
 IF position('AND (audit.metadata_schema_version<>1 OR' IN definition)=0 THEN
  RAISE EXCEPTION 'operational blocker shape changed' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,'AND (audit.metadata_schema_version<>1 OR',
  'AND NOT (audit.event_type=''account.support-content-released.v1'' AND support.content_release_valid(audit,false)) AND (audit.metadata_schema_version<>1 OR');
 EXECUTE definition;
END $$;
