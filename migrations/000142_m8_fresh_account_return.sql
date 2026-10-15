-- Native, own-account Return only. Public ingress/Redis activation stay disabled
-- until composed separately. No retention period or release is authorized here.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='account.returned.v1') THEN
  RAISE EXCEPTION 'legacy Return requires explicit provenance' USING ERRCODE='55000'; END IF;
END $$;
CREATE UNIQUE INDEX account_return_root_idx ON platform.audit_logs(subject_id) WHERE event_type='account.returned.v1';
CREATE UNIQUE INDEX account_return_command_idx ON platform.audit_logs(command_id) WHERE event_type='account.returned.v1';
CREATE UNIQUE INDEX account_return_idempotency_idx ON platform.audit_logs(actor_user_id,(metadata->>'idempotencyHash')) WHERE event_type='account.returned.v1';

CREATE FUNCTION identity.account_return_grant_valid(source_id uuid,subject uuid,epoch integer,at timestamptz,live boolean)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM platform.audit_logs grant_fact WHERE grant_fact.id=source_id
  AND grant_fact.actor_user_id=subject AND identity.account_control_epoch(grant_fact.id)=epoch
  AND grant_fact.occurred_at<=at AND (grant_fact.metadata->>'expiresAt')::timestamptz>at
  AND NOT EXISTS(SELECT 1 FROM platform.audit_logs revoked WHERE revoked.subject_id=source_id
   AND revoked.event_type='identity.account-control-revoked.v1' AND revoked.occurred_at<=at)
  AND (NOT live OR ((grant_fact.metadata->>'expiresAt')::timestamptz>clock_timestamp()
   AND NOT identity.account_control_authority_revoked(source_id)))) $$;

CREATE FUNCTION identity.account_return_proof_valid(a platform.audit_logs,completed boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE root identity.account_deletion_records; approval platform.audit_logs; history identity.account_state_history;
BEGIN
 IF a.id IS NULL OR a.category<>'account' OR a.event_type<>'account.returned.v1' OR a.actor_type<>'user'
  OR a.actor_user_id IS NULL OR a.actor_admin_id IS NOT NULL OR a.subject_type<>'account_deletion'
  OR a.result_code<>'returned' OR a.metadata_schema_version<>1
  OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>13
  OR NOT a.metadata?&ARRAY['approvalId','fromEpoch','toEpoch','fromVersion','toVersion','controlGrantId','historyId','eventId','transactionId','requestDigest','idempotencyHash','previewHash','uiLocale']
  OR EXISTS(SELECT 1 FROM jsonb_each(a.metadata) member WHERE member.key NOT IN('fromEpoch','toEpoch','fromVersion','toVersion') AND jsonb_typeof(member.value) IS DISTINCT FROM 'string')
  OR a.metadata->>'requestDigest'!~'^[0-9a-f]{64}$' OR a.metadata->>'idempotencyHash'!~'^[0-9a-f]{64}$'
  OR a.metadata->>'previewHash'!~'^[0-9a-f]{64}$' OR a.metadata->>'transactionId'!~'^[1-9][0-9]{0,19}$'
  OR a.metadata->>'uiLocale'!~'^[a-z]{2}(-[A-Z]{2})?$'
  OR NOT isfinite(a.occurred_at) OR a.occurred_at>clock_timestamp() THEN RETURN false; END IF;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=a.subject_id;
 SELECT * INTO approval FROM platform.audit_logs WHERE id=(a.metadata->>'approvalId')::uuid;
 SELECT * INTO history FROM identity.account_state_history WHERE id=(a.metadata->>'historyId')::uuid;
 IF root.id IS NULL OR root.user_id<>a.actor_user_id OR root.phase<>'completed' OR root.checkpoint_version<>8
  OR root.completed_at IS NULL OR root.product_purged_at<>root.completed_at OR root.safety_bar<>'none'
  OR (completed AND NOT root.reactivation_allowed) OR a.occurred_at<root.completed_at
  OR a.metadata->'fromEpoch' IS DISTINCT FROM to_jsonb(root.product_epoch)
  OR a.metadata->'toEpoch' IS DISTINCT FROM to_jsonb(root.product_epoch::bigint+1)
  OR a.metadata->'fromVersion' IS DISTINCT FROM to_jsonb(root.account_version)
  OR a.metadata->'toVersion' IS DISTINCT FROM to_jsonb(root.account_version::bigint+1)
  OR approval.subject_id IS DISTINCT FROM root.id OR approval.occurred_at>a.occurred_at
  OR identity.account_return_approval_valid(approval,false) IS NOT TRUE
  OR identity.account_return_grant_valid((a.metadata->>'controlGrantId')::uuid,root.user_id,root.product_epoch,a.occurred_at,false) IS NOT TRUE
  OR history.id IS NULL OR history.user_id<>root.user_id OR history.previous_state IS DISTINCT FROM 'deleted' OR history.next_state<>'guest'
  OR history.reason_code<>'approved_return' OR history.actor_type<>'user' OR history.actor_user_id IS DISTINCT FROM root.user_id
  OR history.actor_admin_id IS NOT NULL OR history.changed_at<>a.occurred_at THEN RETURN false; END IF;
 PERFORM (a.metadata->>'eventId')::uuid;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION identity.account_return_completed(root_id uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM platform.audit_logs a WHERE a.event_type='account.returned.v1'
  AND a.subject_id=root_id AND identity.account_return_proof_valid(a,true)) $$;
CREATE FUNCTION identity.account_return_intent_current(root_id uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM platform.audit_logs a JOIN identity.account_deletion_records root ON root.id=a.subject_id
  JOIN identity.accounts account ON account.user_id=root.user_id
  WHERE root.id=root_id AND a.event_type='account.returned.v1' AND identity.account_return_proof_valid(a,false)
   AND (a.metadata->>'transactionId')::xid8=pg_current_xact_id()
   AND account.state='deleted' AND account.version=root.account_version AND account.product_epoch=root.product_epoch
   AND identity.account_return_grant_valid((a.metadata->>'controlGrantId')::uuid,root.user_id,root.product_epoch,a.occurred_at,true)) $$;

-- Preserve all old admission/checkpoint guards. Only the exact immutable completed
-- Root's false->true approval bit may change, in the same native Return transaction.
DO $$ DECLARE definition text; restriction text; BEGIN
 SELECT conname INTO STRICT restriction FROM pg_constraint WHERE conrelid='identity.account_deletion_records'::regclass
  AND contype='c' AND pg_get_constraintdef(oid) LIKE '%NOT reactivation_allowed%';
 EXECUTE format('ALTER TABLE identity.account_deletion_records DROP CONSTRAINT %I',restriction);
 SELECT pg_get_functiondef('identity.guard_deletion_checkpoint()'::regprocedure) INTO definition;
 IF position('BEGIN' IN definition)=0 OR position('OR OLD.phase=''completed'' OR NEW.reactivation_allowed' IN definition)=0 THEN
  RAISE EXCEPTION 'checkpoint guard shape changed' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,'BEGIN',
  'BEGIN
   IF TG_OP=''UPDATE'' AND OLD.phase=''completed'' AND NOT OLD.reactivation_allowed AND NEW.reactivation_allowed
    AND (to_jsonb(NEW)-''reactivation_allowed'')=(to_jsonb(OLD)-''reactivation_allowed'')
    AND identity.account_return_intent_current(OLD.id) THEN RETURN NEW; END IF;');
 EXECUTE definition;
 SELECT pg_get_functiondef('identity.guard_account_product_epoch()'::regprocedure) INTO definition;
 IF position('OR NOT root.reactivation_allowed OR root.safety_bar<>''none''' IN definition)=0 THEN
  RAISE EXCEPTION 'account epoch guard shape changed' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,'OR NOT root.reactivation_allowed OR root.safety_bar<>''none''',
  'OR NOT root.reactivation_allowed OR root.safety_bar<>''none'' OR identity.account_return_intent_current(root.id) IS NOT TRUE');
 EXECUTE definition;
END $$;

CREATE FUNCTION identity.guard_account_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid;
BEGIN
 IF NEW.event_type<>'account.returned.v1' THEN RETURN NEW; END IF;
 SELECT user_id INTO subject FROM identity.account_deletion_records WHERE id=NEW.subject_id;
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 PERFORM id FROM identity.account_deletion_records WHERE id=NEW.subject_id FOR UPDATE;
 IF identity.account_return_reviewable(NEW.subject_id) IS NOT TRUE OR identity.account_return_proof_valid(NEW,false) IS NOT TRUE
  OR (NEW.metadata->>'transactionId')::xid8<>pg_current_xact_id()
  OR identity.account_return_grant_valid((NEW.metadata->>'controlGrantId')::uuid,subject,(NEW.metadata->>'fromEpoch')::integer,NEW.occurred_at,true) IS NOT TRUE THEN
  RAISE EXCEPTION 'account Return lacks original authority' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_return_guard BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION identity.guard_account_return();

CREATE FUNCTION identity.require_account_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a platform.audit_logs; root identity.account_deletion_records; resource jsonb; present boolean;
BEGIN
 IF TG_TABLE_SCHEMA='platform' AND TG_TABLE_NAME='audit_logs' THEN
  IF NEW.event_type<>'account.returned.v1' THEN RETURN NULL; END IF;
  SELECT * INTO a FROM platform.audit_logs WHERE id=NEW.id;
 ELSIF TG_TABLE_NAME='account_deletion_records' THEN
  IF NOT NEW.reactivation_allowed OR OLD.reactivation_allowed THEN RETURN NULL; END IF;
  SELECT * INTO a FROM platform.audit_logs WHERE event_type='account.returned.v1' AND subject_id=NEW.id;
 ELSIF TG_TABLE_NAME='accounts' THEN
  IF OLD.state<>'deleted' OR NEW.state<>'guest' THEN RETURN NULL; END IF;
  SELECT * INTO a FROM platform.audit_logs WHERE event_type='account.returned.v1' AND actor_user_id=NEW.user_id AND metadata->'toEpoch'=to_jsonb(NEW.product_epoch);
 ELSIF TG_TABLE_NAME='account_state_history' THEN
  IF NEW.reason_code<>'approved_return' THEN RETURN NULL; END IF;
  SELECT * INTO a FROM platform.audit_logs WHERE event_type='account.returned.v1' AND metadata->>'historyId'=NEW.id::text;
 ELSE
  IF NEW.event_type<>'account.returned.v1' THEN RETURN NULL; END IF;
  SELECT * INTO a FROM platform.audit_logs WHERE event_type='account.returned.v1' AND metadata->>'eventId'=NEW.id::text;
 END IF;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=a.subject_id;
 IF identity.account_return_proof_valid(a,true) IS NOT TRUE OR (a.metadata->>'transactionId')::xid8<>pg_current_xact_id()
  OR identity.account_return_grant_valid((a.metadata->>'controlGrantId')::uuid,root.user_id,root.product_epoch,a.occurred_at,true) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=root.user_id AND state='guest' AND version=root.account_version+1
    AND product_epoch=root.product_epoch+1 AND state_reason='approved_return' AND state_changed_at=a.occurred_at)
  OR a.metadata->>'previewHash' IS DISTINCT FROM (SELECT encode(sha256(convert_to(to_jsonb(c)::text,'UTF8')),'hex') FROM identity.guest_preview_counters c WHERE user_id=root.user_id)
  OR NOT EXISTS(SELECT 1 FROM identity.user_settings WHERE user_id=root.user_id AND visibility_enabled AND ui_locale_code=a.metadata->>'uiLocale'
    AND version=1 AND created_at=a.occurred_at AND updated_at=a.occurred_at)
  OR NOT EXISTS(SELECT 1 FROM notification.notification_preferences WHERE user_id=root.user_id AND chat_enabled AND like_enabled AND nakh_enabled AND match_enabled
    AND version=1 AND created_at=a.occurred_at AND updated_at=a.occurred_at)
  OR NOT EXISTS(SELECT 1 FROM billing.credit_accounts WHERE user_id=root.user_id AND product_epoch=root.product_epoch+1 AND balance=0 AND version=1)
  OR NOT EXISTS(SELECT 1 FROM billing.credit_epoch_accounts WHERE user_id=root.user_id AND product_epoch=root.product_epoch+1 AND balance=0 AND version=1)
  OR EXISTS(SELECT 1 FROM billing.credit_transactions WHERE credit_account_id=root.user_id AND product_epoch=root.product_epoch+1)
  OR EXISTS(SELECT 1 FROM media.media_assets WHERE owner_user_id=root.user_id)
  OR NOT EXISTS(SELECT 1 FROM platform.outbox_events event WHERE event.id=(a.metadata->>'eventId')::uuid
    AND event.aggregate_type='account_return' AND event.aggregate_id=root.id AND event.event_type='account.returned.v1' AND event.schema_version=1
    AND event.payload=jsonb_build_object('userId',root.user_id,'accountVersion',root.account_version+1)
    AND event.correlation_id=a.request_id AND event.causation_id=a.command_id AND event.occurred_at=a.occurred_at) THEN
  RAISE EXCEPTION 'account Return commit proof incomplete' USING ERRCODE='23514'; END IF;
 FOR resource IN SELECT value FROM jsonb_array_elements(identity.deletion_product_selectors())
  WHERE value->>'table' NOT IN('identity.user_settings','notification.notification_preferences') LOOP
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM '||(resource->>'table')||' row WHERE '||(resource->>'predicate')||')' INTO present USING root.user_id;
  IF present THEN RAISE EXCEPTION 'account Return is not empty' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER account_return_audit_commit AFTER INSERT ON platform.audit_logs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_account_return();
CREATE CONSTRAINT TRIGGER account_return_root_commit AFTER UPDATE ON identity.account_deletion_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_account_return();
CREATE CONSTRAINT TRIGGER account_return_account_commit AFTER UPDATE ON identity.accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_account_return();
CREATE CONSTRAINT TRIGGER account_return_history_commit AFTER INSERT ON identity.account_state_history DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_account_return();
CREATE CONSTRAINT TRIGGER account_return_event_commit AFTER INSERT ON platform.outbox_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_account_return();

CREATE FUNCTION identity.return_account(subject uuid,epoch integer,grant_id uuid,command uuid,request uuid,digest text,idempotency text,expected_version integer)
RETURNS TABLE(account_version integer,replayed boolean) LANGUAGE plpgsql AS $$
DECLARE owner identity.accounts; root identity.account_deletion_records; approval platform.audit_logs; existing platform.audit_logs;
 at timestamptz; history uuid:=gen_random_uuid(); event uuid:=gen_random_uuid(); audit uuid:=gen_random_uuid(); preview text; locale text; writes integer; matches integer;
BEGIN
 IF digest IS NULL OR idempotency IS NULL OR expected_version IS NULL OR epoch IS NULL OR command IS NULL OR request IS NULL
  OR digest!~'^[0-9a-f]{64}$' OR idempotency!~'^[0-9a-f]{64}$' OR expected_version<1 OR epoch<0 THEN
  RAISE EXCEPTION 'account Return input invalid' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('account-return-command:'||command::text,0));
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 SELECT * INTO owner FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 IF identity.account_return_grant_valid(grant_id,subject,epoch,clock_timestamp(),true) IS NOT TRUE THEN
  RAISE EXCEPTION 'account Return control unavailable' USING ERRCODE='42501'; END IF;
 SELECT count(*) INTO matches FROM platform.audit_logs WHERE event_type='account.returned.v1'
  AND (command_id=command OR (actor_user_id=subject AND metadata->>'idempotencyHash'=idempotency));
 IF matches>1 THEN RAISE EXCEPTION 'account Return idempotency conflict' USING ERRCODE='22023'; END IF;
 SELECT * INTO existing FROM platform.audit_logs WHERE event_type='account.returned.v1'
  AND (command_id=command OR (actor_user_id=subject AND metadata->>'idempotencyHash'=idempotency));
 IF FOUND THEN
  IF existing.actor_user_id IS DISTINCT FROM subject OR existing.request_id IS DISTINCT FROM request
   OR existing.metadata->>'requestDigest' IS DISTINCT FROM digest OR existing.metadata->>'idempotencyHash' IS DISTINCT FROM idempotency
   OR existing.metadata->'fromEpoch' IS DISTINCT FROM to_jsonb(epoch) OR existing.metadata->'fromVersion' IS DISTINCT FROM to_jsonb(expected_version) THEN
   RAISE EXCEPTION 'account Return idempotency conflict' USING ERRCODE='22023'; END IF;
  IF identity.account_return_proof_valid(existing,true) IS NOT TRUE OR owner.product_epoch<>epoch+1 OR owner.state='deleted' THEN
   RAISE EXCEPTION 'account Return lifecycle unavailable' USING ERRCODE='55000'; END IF;
  RETURN QUERY SELECT (existing.metadata->>'toVersion')::integer,true; RETURN;
 END IF;
 IF owner.user_id IS NULL OR owner.state<>'deleted' OR owner.product_epoch<>epoch OR owner.version<>expected_version THEN
  RAISE EXCEPTION 'account Return lifecycle unavailable' USING ERRCODE='55000'; END IF;
 SELECT * INTO root FROM identity.account_deletion_records WHERE user_id=subject AND product_epoch=epoch FOR UPDATE;
 SELECT * INTO approval FROM platform.audit_logs WHERE event_type='account.return-approved.v1' AND subject_id=root.id;
 IF identity.account_return_reviewable(root.id) IS NOT TRUE OR identity.account_return_approval_valid(approval,false) IS NOT TRUE
  OR owner.version=2147483647 OR epoch=2147483647 THEN RAISE EXCEPTION 'account Return approval unavailable' USING ERRCODE='55000'; END IF;
 SELECT encode(sha256(convert_to(to_jsonb(c)::text,'UTF8')),'hex') INTO preview FROM identity.guest_preview_counters c WHERE user_id=subject FOR UPDATE;
 SELECT code INTO locale FROM catalog.locales WHERE is_default AND is_active FOR SHARE;
 IF preview IS NULL OR locale IS NULL THEN RAISE EXCEPTION 'account Return defaults unavailable' USING ERRCODE='55000'; END IF;
 at:=clock_timestamp();
 INSERT INTO identity.account_state_history(id,user_id,previous_state,next_state,reason_code,actor_type,actor_user_id,actor_admin_id,changed_at)
 VALUES(history,subject,'deleted','guest','approved_return','user',subject,NULL,at);
 GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'account Return history missing' USING ERRCODE='23514'; END IF;
 INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
 VALUES(audit,'account','account.returned.v1','user',subject,NULL,'account_deletion',root.id,'returned',1,
  jsonb_build_object('approvalId',approval.id,'fromEpoch',epoch,'toEpoch',epoch+1,'fromVersion',owner.version,'toVersion',owner.version+1,
   'controlGrantId',grant_id,'historyId',history,'eventId',event,'transactionId',pg_current_xact_id()::text,'requestDigest',digest,'idempotencyHash',idempotency,'previewHash',preview,'uiLocale',locale),command,request,at);
 GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'account Return audit missing' USING ERRCODE='23514'; END IF;
 UPDATE identity.account_deletion_records SET reactivation_allowed=true WHERE id=root.id;
 GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'account Return Root missing' USING ERRCODE='23514'; END IF;
 UPDATE identity.accounts SET state='guest',state_reason='approved_return',state_changed_at=at,version=owner.version+1,product_epoch=epoch+1 WHERE user_id=subject;
 GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'account Return transition missing' USING ERRCODE='23514'; END IF;
 INSERT INTO identity.user_settings(user_id,visibility_enabled,ui_locale_code,version,created_at,updated_at) VALUES(subject,true,locale,1,at,at);
 GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'account Return settings missing' USING ERRCODE='23514'; END IF;
 INSERT INTO notification.notification_preferences(user_id,chat_enabled,like_enabled,nakh_enabled,match_enabled,version,created_at,updated_at) VALUES(subject,true,true,true,true,1,at,at);
 GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'account Return preferences missing' USING ERRCODE='23514'; END IF;
 INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,correlation_id,causation_id)
 VALUES(event,'account_return',root.id,'account.returned.v1',1,jsonb_build_object('userId',subject,'accountVersion',owner.version+1),at,at,request,command);
 GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'account Return event missing' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT owner.version+1,false;
END $$;

-- Historical cutover proof retains the closed original epoch. A verified Return
-- permits later changes to the *next* ledger, never to the original financial facts.
CREATE OR REPLACE FUNCTION billing.deletion_credit_cutover_valid(root_id uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM billing.credit_epoch_closures receipt
  JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
  JOIN billing.credit_epoch_accounts previous ON previous.user_id=receipt.user_id AND previous.product_epoch=receipt.product_epoch
  JOIN billing.credit_epoch_accounts next_epoch ON next_epoch.user_id=receipt.user_id AND next_epoch.product_epoch=receipt.next_product_epoch
  JOIN billing.credit_accounts current_account ON current_account.user_id=receipt.user_id
  JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
  WHERE root.id=root_id AND receipt.user_id=root.user_id AND receipt.product_epoch=root.product_epoch
   AND receipt.next_product_epoch=receipt.product_epoch+1 AND receipt.prepared_at>=root.requested_at AND receipt.prepared_at<receipt.lease_expires_at
   AND previous.balance=receipt.balance AND previous.version=receipt.account_version
   AND previous.created_at=receipt.projection_created_at AND previous.updated_at=receipt.projection_updated_at
   AND next_epoch.created_at=receipt.projection_created_at
   AND (identity.account_return_completed(root.id) OR (next_epoch.balance=0 AND next_epoch.version=1 AND next_epoch.updated_at=receipt.prepared_at
    AND current_account.product_epoch=receipt.next_product_epoch AND current_account.balance=0 AND current_account.version=1
    AND current_account.created_at=receipt.projection_created_at AND current_account.updated_at=receipt.prepared_at
    AND NOT EXISTS(SELECT 1 FROM billing.credit_transactions WHERE credit_account_id=root.user_id AND product_epoch=receipt.next_product_epoch)))
   AND audit.category='account' AND audit.event_type='account.deletion-credit-epoch-prepared.v1' AND audit.actor_type='system'
   AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
   AND audit.result_code='credit_epoch_prepared' AND audit.metadata_schema_version=1 AND audit.metadata='{"kind":"credit_epoch"}'::jsonb
   AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=receipt.prepared_at) $$;

DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('platform.deletion_operational_blocker(uuid)'::regprocedure) INTO definition;
 IF position('AND (audit.metadata_schema_version<>1 OR' IN definition)=0 THEN RAISE EXCEPTION 'operational blocker shape changed' USING ERRCODE='55000'; END IF;
 EXECUTE replace(definition,'AND (audit.metadata_schema_version<>1 OR',
  'AND NOT (audit.event_type=''account.returned.v1'' AND identity.account_return_proof_valid(audit,true)) AND (audit.metadata_schema_version<>1 OR');
 SELECT pg_get_functiondef('platform.deletion_event_policy()'::regprocedure) INTO definition;
 IF position('"shapes":{' IN definition)=0 THEN RAISE EXCEPTION 'event policy shape changed' USING ERRCODE='55000'; END IF;
 EXECUTE replace(definition,'"shapes":{','"shapes":{"account.returned.v1":{"required":"userId accountVersion"},');
END $$;
