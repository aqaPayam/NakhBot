-- Bind protected changes to their actual native Profile/life. No private value,
-- retained source fingerprint, financial fact or approved retention period changes.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type IN
  ('profile.protected-change-life-bound.v1','profile.protected-change-closed.v1')) THEN
  RAISE EXCEPTION 'legacy profile change proof lacks provenance' USING ERRCODE='55000'; END IF;
END $$;
CREATE UNIQUE INDEX profile_change_life_bound_idx ON platform.audit_logs(subject_id)
 WHERE event_type='profile.protected-change-life-bound.v1';
CREATE UNIQUE INDEX profile_change_closed_idx ON platform.audit_logs(subject_id)
 WHERE event_type='profile.protected-change-closed.v1';
CREATE UNIQUE INDEX profile_change_life_command_idx ON platform.audit_logs(command_id)
 WHERE event_type='profile.protected-change-life-bound.v1';
CREATE INDEX profile_change_requested_subject_idx ON platform.audit_logs(subject_id)
 WHERE event_type='profile.protected-change-requested.v1';
CREATE INDEX profile_change_command_idx ON platform.audit_logs(event_type,command_id)
 WHERE event_type IN('profile.protected-change-requested.v1','profile.protected-change-reviewed.v1');

CREATE FUNCTION profile.change_body_hash(r profile.profile_change_requests) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET TimeZone='UTC' AS $$
 SELECT encode(sha256(convert_to((to_jsonb(r)-'status'-'resolved_at')::text,'UTF8')),'hex')
$$;
CREATE FUNCTION profile.change_life_valid(a platform.audit_logs) RETURNS boolean
LANGUAGE plpgsql STABLE SET TimeZone='UTC' AS $$
DECLARE target profile.profile_change_requests; source platform.audit_logs;
BEGIN
 IF a.category<>'account' OR a.event_type<>'profile.protected-change-life-bound.v1' OR a.actor_type<>'system'
  OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NOT NULL OR a.subject_type<>'profile_change_request'
  OR a.result_code<>'life_bound' OR a.metadata_schema_version<>1 OR jsonb_typeof(a.metadata)<>'object'
  OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>6
  OR jsonb_typeof(a.metadata->'sourceAuditId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'profileId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'productEpoch') IS DISTINCT FROM 'number'
  OR a.metadata->>'productEpoch'!~'^[0-9]{1,10}$'
  OR jsonb_typeof(a.metadata->'bodyHash') IS DISTINCT FROM 'string' OR a.metadata->>'bodyHash'!~'^[0-9a-f]{64}$'
  OR jsonb_typeof(a.metadata->'transactionId') IS DISTINCT FROM 'string' OR a.metadata->>'transactionId'!~'^[1-9][0-9]{0,19}$'
  OR jsonb_typeof(a.metadata->'mode') IS DISTINCT FROM 'string' OR a.metadata->>'mode' NOT IN('admission','legacy')
  OR (a.metadata->>'productEpoch')::integer<0 OR NOT isfinite(a.occurred_at) THEN RETURN false; END IF;
 SELECT * INTO target FROM profile.profile_change_requests WHERE id=a.subject_id;
 SELECT * INTO source FROM platform.audit_logs WHERE id=(a.metadata->>'sourceAuditId')::uuid;
 IF target.id IS NULL OR source.id IS NULL OR source.event_type<>'profile.protected-change-requested.v1'
  OR source.category<>'account' OR source.actor_type<>'user' OR source.actor_user_id IS DISTINCT FROM target.user_id
  OR source.actor_admin_id IS NOT NULL OR source.subject_type<>'profile_change_request' OR source.subject_id<>target.id
  OR source.result_code<>'pending' OR source.metadata_schema_version<>1
  OR source.metadata<>jsonb_build_object('field',target.field_name)
  OR (SELECT count(*) FROM (SELECT 1 FROM platform.audit_logs WHERE event_type='profile.protected-change-requested.v1' AND subject_id=target.id LIMIT 2) seen)<>1
  OR (SELECT count(*) FROM (SELECT 1 FROM platform.audit_logs WHERE event_type='profile.protected-change-requested.v1' AND command_id=source.command_id LIMIT 2) seen)<>1
  OR a.command_id<>source.command_id OR a.request_id<>source.request_id
  OR profile.change_body_hash(target) IS DISTINCT FROM a.metadata->>'bodyHash'
  OR NOT EXISTS(SELECT 1 FROM profile.profile_reference_anchors anchor
    WHERE anchor.id=(a.metadata->>'profileId')::uuid AND anchor.user_id=target.user_id)
  OR (a.metadata->>'mode'='legacy' AND (a.metadata->>'productEpoch')::integer<>0) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION profile.change_is_current(change_id uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM profile.profile_change_requests r
  JOIN identity.accounts account ON account.user_id=r.user_id
  JOIN profile.profiles current_profile ON current_profile.user_id=r.user_id
  JOIN platform.audit_logs a ON a.subject_id=r.id AND a.event_type='profile.protected-change-life-bound.v1'
  WHERE r.id=change_id AND r.user_id=subject AND account.state<>'deleted'
   AND profile.change_life_valid(a)
   AND (a.metadata->>'productEpoch')::integer=account.product_epoch
   AND (a.metadata->>'profileId')::uuid=current_profile.id)
$$;
CREATE FUNCTION profile.guard_change_life() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target profile.profile_change_requests; source platform.audit_logs; subject uuid; epoch integer;
BEGIN
 IF NEW.event_type<>'profile.protected-change-life-bound.v1' THEN RETURN NEW; END IF;
 SELECT user_id INTO subject FROM profile.profile_change_requests WHERE id=NEW.subject_id;
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 SELECT * INTO target FROM profile.profile_change_requests WHERE id=NEW.subject_id FOR UPDATE;
 IF profile.change_life_valid(NEW) IS NOT TRUE OR (NEW.metadata->>'transactionId')::xid8<>pg_current_xact_id() THEN
  RAISE EXCEPTION 'profile change life proof unavailable' USING ERRCODE='23514'; END IF;
 IF TG_WHEN='BEFORE' THEN
  SELECT product_epoch INTO epoch FROM identity.accounts WHERE user_id=subject AND state<>'deleted';
  IF epoch IS NULL OR epoch<>(NEW.metadata->>'productEpoch')::integer
   OR NOT EXISTS(SELECT 1 FROM profile.profiles WHERE id=(NEW.metadata->>'profileId')::uuid AND user_id=subject) THEN
   RAISE EXCEPTION 'profile change original life unavailable' USING ERRCODE='23514'; END IF;
  IF NEW.metadata->>'mode'='legacy' THEN
   IF epoch<>0 OR EXISTS(SELECT 1 FROM identity.account_deletion_records WHERE user_id=subject) THEN
    RAISE EXCEPTION 'legacy profile change life is ambiguous' USING ERRCODE='23514'; END IF;
  ELSE
   IF target.status<>'pending' OR NOT EXISTS(SELECT 1 FROM profile.profile_change_requests r
    JOIN platform.audit_logs a ON a.id=(NEW.metadata->>'sourceAuditId')::uuid
    WHERE r.id=target.id AND r.xmin=a.xmin) THEN
    RAISE EXCEPTION 'profile change admission transaction unavailable' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_change_life_guard BEFORE INSERT ON platform.audit_logs
 FOR EACH ROW EXECUTE FUNCTION profile.guard_change_life();
CREATE CONSTRAINT TRIGGER profile_change_life_commit AFTER INSERT ON platform.audit_logs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION profile.guard_change_life();

CREATE FUNCTION profile.bind_change_life(source_id uuid,legacy boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SET TimeZone='UTC' AS $$
DECLARE source platform.audit_logs; target profile.profile_change_requests; native_profile uuid; epoch integer;
 receipt uuid; affected integer;
BEGIN
 SELECT * INTO source FROM platform.audit_logs WHERE id=source_id;
 SELECT * INTO target FROM profile.profile_change_requests WHERE id=source.subject_id;
 PERFORM id FROM identity.users WHERE id=target.user_id FOR NO KEY UPDATE;
 SELECT product_epoch INTO epoch FROM identity.accounts WHERE user_id=target.user_id AND state<>'deleted' FOR UPDATE;
 SELECT id INTO native_profile FROM profile.profiles WHERE user_id=target.user_id FOR SHARE;
 IF target.id IS NULL OR epoch IS NULL OR native_profile IS NULL THEN
  RAISE EXCEPTION 'profile change native life unavailable' USING ERRCODE='23514'; END IF;
 SELECT id INTO receipt FROM platform.audit_logs a WHERE subject_id=target.id AND event_type='profile.protected-change-life-bound.v1'
  AND metadata->>'sourceAuditId'=source_id::text AND profile.change_life_valid(a);
 IF receipt IS NOT NULL THEN RETURN receipt; END IF;
 receipt:=gen_random_uuid();
 INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,metadata_schema_version,
  metadata,command_id,request_id,occurred_at)
 VALUES(receipt,'account','profile.protected-change-life-bound.v1','system','profile_change_request',target.id,'life_bound',1,
  jsonb_build_object('sourceAuditId',source.id,'profileId',native_profile,'productEpoch',epoch,'bodyHash',profile.change_body_hash(target),
    'transactionId',pg_current_xact_id()::text,'mode',CASE WHEN legacy THEN 'legacy' ELSE 'admission' END),
  source.command_id,source.request_id,clock_timestamp());
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'profile change life audit missing' USING ERRCODE='23514'; END IF;
 RETURN receipt;
END $$;
CREATE FUNCTION profile.bind_requested_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.event_type='profile.protected-change-requested.v1' THEN
  IF (SELECT count(*) FROM (SELECT 1 FROM platform.audit_logs WHERE event_type='profile.protected-change-requested.v1' AND subject_id=NEW.subject_id LIMIT 2) seen)<>1 THEN
   RAISE EXCEPTION 'profile change request audit is ambiguous' USING ERRCODE='23514'; END IF;
  PERFORM profile.bind_change_life(NEW.id,false);
 ELSIF NEW.event_type='profile.protected-change-reviewed.v1' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('profile-change-review-command:'||NEW.command_id::text,0));
  IF (SELECT count(*) FROM (SELECT 1 FROM platform.audit_logs WHERE event_type='profile.protected-change-reviewed.v1'
    AND command_id=NEW.command_id LIMIT 2) seen)<>1 THEN
   RAISE EXCEPTION 'profile change review command already used' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_change_requested_life AFTER INSERT ON platform.audit_logs
 FOR EACH ROW EXECUTE FUNCTION profile.bind_requested_change();

CREATE FUNCTION profile.change_close_valid(a platform.audit_logs,live boolean) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET TimeZone='UTC' AS $$
DECLARE target profile.profile_change_requests; root identity.account_deletion_records;
BEGIN
 IF a.category<>'account' OR a.event_type<>'profile.protected-change-closed.v1' OR a.actor_type<>'system'
  OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NOT NULL OR a.subject_type<>'profile_change_request'
  OR a.result_code<>'cancelled' OR a.metadata_schema_version<>1 OR jsonb_typeof(a.metadata)<>'object'
  OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>5
  OR jsonb_typeof(a.metadata->'mode') IS DISTINCT FROM 'string' OR a.metadata->>'mode' NOT IN('deletion','unbound')
  OR jsonb_typeof(a.metadata->'rowHashBefore') IS DISTINCT FROM 'string' OR a.metadata->>'rowHashBefore'!~'^[0-9a-f]{64}$'
  OR jsonb_typeof(a.metadata->'rowHashAfter') IS DISTINCT FROM 'string' OR a.metadata->>'rowHashAfter'!~'^[0-9a-f]{64}$'
  OR jsonb_typeof(a.metadata->'transactionId') IS DISTINCT FROM 'string' OR a.metadata->>'transactionId'!~'^[1-9][0-9]{0,19}$'
  OR a.metadata->>'rowHashBefore'=a.metadata->>'rowHashAfter' OR NOT isfinite(a.occurred_at) THEN RETURN false; END IF;
 SELECT * INTO target FROM profile.profile_change_requests WHERE id=a.subject_id;
 IF target.id IS NULL THEN RETURN false; END IF;
 IF a.metadata->>'mode'='deletion' THEN
  IF jsonb_typeof(a.metadata->'deletionRecordId') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=(a.metadata->>'deletionRecordId')::uuid;
  IF root.id IS NULL OR root.user_id<>target.user_id OR a.command_id<>root.command_id OR a.request_id<>root.request_id
   OR a.occurred_at<root.requested_at THEN RETURN false; END IF;
  IF live AND (root.phase<>'shared_closure' OR NOT EXISTS(SELECT 1 FROM identity.accounts
    WHERE user_id=root.user_id AND state='deleted' AND version=root.account_version AND product_epoch=root.product_epoch)) THEN RETURN false; END IF;
 ELSE
  IF a.metadata->'deletionRecordId' IS DISTINCT FROM 'null'::jsonb OR a.command_id<>a.id OR a.request_id<>a.id THEN RETURN false; END IF;
  IF live AND EXISTS(SELECT 1 FROM platform.audit_logs proof WHERE proof.subject_id=target.id
    AND proof.event_type='profile.protected-change-life-bound.v1') THEN RETURN false; END IF;
 END IF;
 IF live AND (a.metadata->>'transactionId')::xid8<>pg_current_xact_id() THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION profile.guard_change_close() RETURNS trigger LANGUAGE plpgsql SET TimeZone='UTC' AS $$
DECLARE target profile.profile_change_requests; subject uuid;
BEGIN
 IF NEW.event_type<>'profile.protected-change-closed.v1' THEN RETURN NEW; END IF;
 SELECT user_id INTO subject FROM profile.profile_change_requests WHERE id=NEW.subject_id;
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 IF NEW.metadata->>'mode'='deletion' THEN
  PERFORM id FROM identity.account_deletion_records WHERE id=(NEW.metadata->>'deletionRecordId')::uuid FOR UPDATE;
 END IF;
 SELECT * INTO target FROM profile.profile_change_requests WHERE id=NEW.subject_id FOR UPDATE;
 IF profile.change_close_valid(NEW,true) IS NOT TRUE THEN
  RAISE EXCEPTION 'profile change closure authority unavailable' USING ERRCODE='23514'; END IF;
 IF TG_WHEN='BEFORE' THEN
  IF target.status<>'pending'
   OR encode(sha256(convert_to(to_jsonb(target)::text,'UTF8')),'hex') IS DISTINCT FROM NEW.metadata->>'rowHashBefore'
   OR encode(sha256(convert_to((to_jsonb(target)||jsonb_build_object('status','cancelled','resolved_at',NEW.occurred_at))::text,'UTF8')),'hex')
     IS DISTINCT FROM NEW.metadata->>'rowHashAfter' THEN
   RAISE EXCEPTION 'profile change closure source changed' USING ERRCODE='23514'; END IF;
 ELSE
  IF target.status<>'cancelled' OR target.resolved_at IS DISTINCT FROM NEW.occurred_at
   OR encode(sha256(convert_to(to_jsonb(target)::text,'UTF8')),'hex') IS DISTINCT FROM NEW.metadata->>'rowHashAfter' THEN
   RAISE EXCEPTION 'profile change closure incomplete' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_change_close_guard BEFORE INSERT ON platform.audit_logs
 FOR EACH ROW EXECUTE FUNCTION profile.guard_change_close();
CREATE CONSTRAINT TRIGGER profile_change_close_commit AFTER INSERT ON platform.audit_logs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION profile.guard_change_close();
CREATE FUNCTION profile.close_change(change_id uuid,root_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SET TimeZone='UTC' AS $$
DECLARE target profile.profile_change_requests; root identity.account_deletion_records; receipt uuid; at timestamptz; affected integer;
BEGIN
 SELECT * INTO target FROM profile.profile_change_requests WHERE id=change_id;
 PERFORM id FROM identity.users WHERE id=target.user_id FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=target.user_id FOR UPDATE;
 IF root_id IS NOT NULL THEN SELECT * INTO root FROM identity.account_deletion_records WHERE id=root_id FOR UPDATE; END IF;
 SELECT * INTO target FROM profile.profile_change_requests WHERE id=change_id FOR UPDATE;
 SELECT id INTO receipt FROM platform.audit_logs a WHERE subject_id=change_id AND event_type='profile.protected-change-closed.v1'
  AND ((root_id IS NULL AND metadata->>'mode'='unbound') OR (metadata->>'mode'='deletion' AND metadata->>'deletionRecordId'=root_id::text))
  AND profile.change_close_valid(a,false);
 IF receipt IS NOT NULL THEN RETURN receipt; END IF;
 IF target.id IS NULL OR target.status<>'pending' THEN
  RAISE EXCEPTION 'pending profile change unavailable' USING ERRCODE='23514'; END IF;
 receipt:=gen_random_uuid();at:=clock_timestamp();
 INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,metadata_schema_version,
  metadata,command_id,request_id,occurred_at)
 VALUES(receipt,'account','profile.protected-change-closed.v1','system','profile_change_request',target.id,'cancelled',1,
  jsonb_build_object('mode',CASE WHEN root_id IS NULL THEN 'unbound' ELSE 'deletion' END,'deletionRecordId',root_id,
    'rowHashBefore',encode(sha256(convert_to(to_jsonb(target)::text,'UTF8')),'hex'),
    'rowHashAfter',encode(sha256(convert_to((to_jsonb(target)||jsonb_build_object('status','cancelled','resolved_at',at))::text,'UTF8')),'hex'),
    'transactionId',pg_current_xact_id()::text),
  CASE WHEN root_id IS NULL THEN receipt ELSE root.command_id END,
  CASE WHEN root_id IS NULL THEN receipt ELSE root.request_id END,at);
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'profile change closure audit missing' USING ERRCODE='23514'; END IF;
 UPDATE profile.profile_change_requests SET status='cancelled',resolved_at=at WHERE id=target.id AND status='pending';
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'profile change closure effect missing' USING ERRCODE='23514'; END IF;
 RETURN receipt;
END $$;

-- Existing first lives can be bound without a timestamp inference. A previous
-- deletion, absent Profile or ambiguous/malformed source leaves the life unknown.
-- Retire only unknown pending workflow state; preserve every private field.
DO $$ DECLARE r profile.profile_change_requests; source uuid;
BEGIN
 FOR r IN SELECT * FROM profile.profile_change_requests ORDER BY user_id,id FOR UPDATE LOOP
  SELECT min(id::text)::uuid INTO source FROM platform.audit_logs
   WHERE subject_id=r.id AND event_type='profile.protected-change-requested.v1'
   HAVING count(*)=1;
  IF source IS NOT NULL AND EXISTS(SELECT 1 FROM identity.accounts account JOIN profile.profiles p ON p.user_id=account.user_id
    WHERE account.user_id=r.user_id AND account.product_epoch=0 AND account.state<>'deleted'
     AND NOT EXISTS(SELECT 1 FROM identity.account_deletion_records WHERE user_id=r.user_id))
   AND EXISTS(SELECT 1 FROM platform.audit_logs a WHERE a.id=source AND a.actor_type='user' AND a.actor_user_id=r.user_id
    AND a.category='account' AND a.actor_admin_id IS NULL AND a.subject_type='profile_change_request'
    AND a.result_code='pending' AND a.metadata_schema_version=1 AND a.metadata=jsonb_build_object('field',r.field_name)
    AND (SELECT count(*) FROM (SELECT 1 FROM platform.audit_logs prior
      WHERE prior.event_type='profile.protected-change-requested.v1' AND prior.command_id=a.command_id LIMIT 2) seen)=1) THEN
   PERFORM profile.bind_change_life(source,true);
  ELSIF r.status='pending' THEN PERFORM profile.close_change(r.id,NULL);
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION profile.guard_change_request() RETURNS trigger LANGUAGE plpgsql SET TimeZone='UTC' AS $$
DECLARE subject uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'profile change requires controlled release' USING ERRCODE='55000'; END IF;
 subject:=NEW.user_id;
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.resolved_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM identity.accounts
    WHERE user_id=subject AND state<>'deleted') OR NOT EXISTS(SELECT 1 FROM profile.profiles WHERE user_id=subject) THEN
   RAISE EXCEPTION 'profile change admission unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF to_jsonb(NEW)-'status'-'resolved_at' IS DISTINCT FROM to_jsonb(OLD)-'status'-'resolved_at'
  OR OLD.status<>'pending' OR NEW.resolved_at IS NULL THEN
  RAISE EXCEPTION 'profile change original fields are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.status IN('approved','rejected') AND profile.change_is_current(OLD.id,OLD.user_id) THEN RETURN NEW; END IF;
 IF NEW.status='cancelled' AND EXISTS(SELECT 1 FROM platform.audit_logs a WHERE a.subject_id=OLD.id
   AND a.event_type='profile.protected-change-closed.v1' AND profile.change_close_valid(a,true)
   AND a.metadata->>'rowHashBefore'=encode(sha256(convert_to(to_jsonb(OLD)::text,'UTF8')),'hex')
   AND a.metadata->>'rowHashAfter'=encode(sha256(convert_to(to_jsonb(NEW)::text,'UTF8')),'hex')) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'profile change current life unavailable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER profile_change_request_guard BEFORE INSERT OR UPDATE OR DELETE ON profile.profile_change_requests
 FOR EACH ROW EXECUTE FUNCTION profile.guard_change_request();
CREATE FUNCTION profile.guard_change_review_life() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid;
BEGIN
 PERFORM id FROM administration.admin_users WHERE id=NEW.admin_user_id AND is_active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'profile change reviewer unavailable' USING ERRCODE='23514'; END IF;
 SELECT user_id INTO subject FROM profile.profile_change_requests WHERE id=NEW.request_id;
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 PERFORM id FROM profile.profile_change_requests WHERE id=NEW.request_id AND status='pending' FOR UPDATE;
 IF NOT FOUND OR profile.change_is_current(NEW.request_id,subject) IS NOT TRUE THEN
  RAISE EXCEPTION 'profile change review life unavailable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_change_review_life_guard BEFORE INSERT ON profile.profile_change_reviews
 FOR EACH ROW EXECUTE FUNCTION profile.guard_change_review_life();
CREATE FUNCTION profile.guard_change_review_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change_id uuid;
BEGIN
 IF TG_TABLE_NAME='profile_change_requests' THEN
  IF NEW.status NOT IN('approved','rejected') THEN RETURN NEW; END IF;
  change_id:=NEW.id;
 ELSE change_id:=NEW.request_id; END IF;
 IF NOT EXISTS(SELECT 1 FROM profile.profile_change_requests r
  JOIN profile.profile_change_reviews review ON review.request_id=r.id AND review.decision=r.status AND review.xmin=r.xmin
  JOIN platform.audit_logs a ON a.subject_id=r.id AND a.subject_type='profile_change_request'
   AND a.event_type='profile.protected-change-reviewed.v1' AND a.actor_type='admin' AND a.actor_admin_id=review.admin_user_id
   AND a.actor_user_id IS NULL AND a.category='admin' AND a.result_code=review.decision
   AND a.metadata_schema_version=1 AND a.metadata=jsonb_build_object('field',r.field_name,'decision',review.decision)
   AND a.occurred_at=review.reviewed_at AND a.xmin=review.xmin
  WHERE r.id=change_id AND r.status IN('approved','rejected')) THEN
  RAISE EXCEPTION 'profile change review proof incomplete' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER profile_change_review_commit AFTER INSERT ON profile.profile_change_reviews
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION profile.guard_change_review_completion();
CREATE CONSTRAINT TRIGGER profile_change_resolution_commit AFTER UPDATE ON profile.profile_change_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION profile.guard_change_review_completion();
CREATE FUNCTION profile.require_change_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM platform.audit_logs a WHERE a.subject_id=NEW.id
   AND a.event_type='profile.protected-change-life-bound.v1' AND profile.change_life_valid(a)
   AND (a.metadata->>'transactionId')::xid8=pg_current_xact_id() AND a.metadata->>'mode'='admission') THEN
  RAISE EXCEPTION 'profile change native admission missing' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER profile_change_admission_commit AFTER INSERT ON profile.profile_change_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION profile.require_change_admission();
CREATE FUNCTION profile.close_deletion_changes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; n integer:=0;
BEGIN
 PERFORM id FROM identity.users WHERE id=NEW.user_id FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=NEW.user_id FOR UPDATE;
 FOR r IN SELECT id FROM profile.profile_change_requests WHERE user_id=NEW.user_id AND status='pending' ORDER BY id FOR UPDATE LOOP
  n:=n+1; IF n>2 THEN RAISE EXCEPTION 'profile change closure bound exceeded' USING ERRCODE='23514'; END IF;
  PERFORM profile.close_change(r.id,NEW.id);
 END LOOP;
 IF EXISTS(SELECT 1 FROM profile.profile_change_requests WHERE user_id=NEW.user_id AND status='pending') THEN
  RAISE EXCEPTION 'profile change closure incomplete' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER profile_change_deletion_commit AFTER INSERT ON identity.account_deletion_records
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION profile.close_deletion_changes();

-- The new facts carry hashes/native life identity, never profile/change content.
-- Only fully verified facts bypass the existing ordinary-content metadata blocker.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('platform.deletion_operational_blocker(uuid)'::regprocedure) INTO definition;
 IF position('AND (audit.metadata_schema_version<>1 OR' IN definition)=0 THEN
  RAISE EXCEPTION 'operational blocker shape changed' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,'AND (audit.metadata_schema_version<>1 OR',
  'AND NOT ((audit.event_type=''profile.protected-change-life-bound.v1'' AND profile.change_life_valid(audit)) OR
    (audit.event_type=''profile.protected-change-closed.v1'' AND profile.change_close_valid(audit,false)))
   AND (audit.metadata_schema_version<>1 OR');
 EXECUTE definition;
END $$;
