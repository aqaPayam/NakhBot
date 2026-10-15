-- Explicit, revocable policy attestations. No approved periods are seeded.
-- Immutable manifests and retained-data release remain unchanged and disabled.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type IN('account.retention-policy-approved.v1','account.retention-policy-revoked.v1')) THEN
  RAISE EXCEPTION 'legacy retention policy lacks provenance' USING ERRCODE='55000'; END IF;
END $$;
INSERT INTO administration.admin_permissions(code,description)
 VALUES('approve_retention_policy','Attest or revoke an original-deletion retention policy; no physical release authority');
INSERT INTO administration.admin_role_permissions(role_code,permission_code) VALUES('super_admin','approve_retention_policy');
CREATE UNIQUE INDEX retention_policy_version_idx ON platform.audit_logs(subject_id,(metadata->>'resource'),((metadata->>'policyVersion')::integer))
 WHERE event_type='account.retention-policy-approved.v1';
CREATE UNIQUE INDEX retention_policy_revocation_idx ON platform.audit_logs((metadata->>'approvalId'))
 WHERE event_type='account.retention-policy-revoked.v1';

CREATE FUNCTION identity.retention_policy_eligible(root_id uuid,record_id uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
  JOIN identity.data_retention_records record ON record.deletion_record_id=root.id AND record.user_id=root.user_id
  JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
  WHERE root.id=root_id AND record.id=record_id AND root.phase='completed' AND root.checkpoint_version=8
   AND root.completed_at IS NOT NULL AND root.product_purged_at=root.completed_at AND root.last_error_code IS NULL
   AND work.phase='completed' AND work.checkpoint_version=8 AND work.lease_owner IS NULL AND work.lease_expires_at IS NULL
   AND record.policy_status='pending_approval' AND identity.retention_record_valid(record)
   AND identity.retention_catalog_valid()
   AND (SELECT count(*) FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=root.id)=7
   AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts receipt WHERE receipt.deletion_record_id=root.id
    AND receipt.completed_phase='verification' AND receipt.next_phase='completed' AND receipt.next_checkpoint_version=8
    AND receipt.verified_at=root.completed_at AND identity.ephemeral_reconciliation_valid(root.id,receipt.verified_at))) $$;

CREATE FUNCTION identity.retention_policy_proof_valid(a platform.audit_logs,live boolean) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE root identity.account_deletion_records; record identity.data_retention_records;
 session administration.admin_sessions; entry administration.admin_action_logs; approval platform.audit_logs;
 tuple jsonb; seconds bigint; version integer; action text;
BEGIN
 IF a.category<>'account' OR a.event_type NOT IN('account.retention-policy-approved.v1','account.retention-policy-revoked.v1')
  OR a.actor_type<>'admin' OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NULL OR a.subject_type<>'account_deletion'
  OR a.metadata_schema_version<>1 OR jsonb_typeof(a.metadata)<>'object'
  OR jsonb_typeof(a.metadata->'adminLogId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'sessionId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'transactionId') IS DISTINCT FROM 'string'
  OR (a.metadata->>'transactionId')!~'^[1-9][0-9]{0,19}$' THEN RETURN false; END IF;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=a.subject_id;
 SELECT * INTO session FROM administration.admin_sessions WHERE id=(a.metadata->>'sessionId')::uuid;
 SELECT * INTO entry FROM administration.admin_action_logs WHERE id=(a.metadata->>'adminLogId')::uuid;
 IF root.id IS NULL OR root.phase<>'completed' OR root.checkpoint_version<>8 OR root.completed_at IS NULL
  OR a.occurred_at<root.completed_at OR a.occurred_at>clock_timestamp()
  OR session.id IS NULL OR session.admin_user_id<>a.actor_admin_id OR session.issued_at>a.occurred_at
  OR session.expires_at<=a.occurred_at OR session.mfa_expires_at<=a.occurred_at
  OR entry.id IS NULL OR entry.admin_user_id<>a.actor_admin_id OR entry.command_id<>a.command_id OR entry.request_id<>a.request_id
  OR entry.target_type<>'account_deletion' OR entry.target_id<>root.id OR entry.expected_target_version IS DISTINCT FROM root.account_version
  OR entry.result<>'succeeded' OR entry.metadata<>'{}'::jsonb THEN RETURN false; END IF;
 IF a.event_type='account.retention-policy-approved.v1' THEN
  action:='approve';
  IF (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>10
   OR jsonb_typeof(a.metadata->'retentionRecordId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(a.metadata->'resource') IS DISTINCT FROM 'string' OR length(a.metadata->>'resource')>128
   OR (a.metadata->>'resource')!~'^[a-z_]+\.[a-z_]+$'
   OR jsonb_typeof(a.metadata->'retentionSeconds') IS DISTINCT FROM 'number'
   OR (a.metadata->>'retentionSeconds')!~'^[1-9][0-9]{0,9}$'
   OR a.metadata->>'basis' IS DISTINCT FROM 'deletion_completed_at'
   OR jsonb_typeof(a.metadata->'evidenceHash') IS DISTINCT FROM 'string' OR (a.metadata->>'evidenceHash')!~'^[0-9a-f]{64}$'
   OR jsonb_typeof(a.metadata->'registryHash') IS DISTINCT FROM 'string'
   OR jsonb_typeof(a.metadata->'policyVersion') IS DISTINCT FROM 'number'
   OR (a.metadata->>'policyVersion')!~'^[1-9][0-9]{0,9}$' THEN RETURN false; END IF;
  seconds:=(a.metadata->>'retentionSeconds')::bigint; version:=(a.metadata->>'policyVersion')::integer;
  IF seconds<1 OR seconds>3155760000 OR version<1 THEN RETURN false; END IF;
  SELECT * INTO record FROM identity.data_retention_records WHERE id=(a.metadata->>'retentionRecordId')::uuid;
  IF record.id IS NULL OR record.deletion_record_id<>root.id OR record.user_id<>root.user_id
   OR record.retained_data_type<>a.metadata->>'resource' OR record.registry_hash<>a.metadata->>'registryHash'
   OR record.policy_status<>'pending_approval' OR NOT identity.retention_record_valid(record) THEN RETURN false; END IF;
  tuple:=jsonb_build_array('m8-retention-policy-v1',root.id,root.account_version,action,record.retained_data_type,
    seconds,'deletion_completed_at',a.metadata->>'evidenceHash',version-1);
  IF a.result_code<>'retention_policy_approved' THEN RETURN false; END IF;
 ELSE
  action:='revoke';
  IF (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>4 OR jsonb_typeof(a.metadata->'approvalId') IS DISTINCT FROM 'string'
   THEN RETURN false; END IF;
  SELECT * INTO approval FROM platform.audit_logs WHERE id=(a.metadata->>'approvalId')::uuid;
  IF approval.id IS NULL OR approval.event_type<>'account.retention-policy-approved.v1' OR approval.subject_id<>root.id
   OR approval.occurred_at>a.occurred_at OR identity.retention_policy_proof_valid(approval,false) IS NOT TRUE THEN RETURN false; END IF;
  record.id:=(approval.metadata->>'retentionRecordId')::uuid;
  tuple:=jsonb_build_array('m8-retention-policy-v1',root.id,root.account_version,action,approval.id);
  IF a.result_code<>'retention_policy_revoked' THEN RETURN false; END IF;
 END IF;
 -- All tuple strings have constrained ASCII alphabets; no commas or spaces.
 IF entry.command_code<>'retention.'||action||'-policy' OR entry.safe_code<>a.result_code
  OR entry.request_digest<>encode(sha256(convert_to(replace(tuple::text,', ',','),'UTF8')),'hex') THEN RETURN false; END IF;
 IF live THEN
  IF (a.metadata->>'transactionId')::xid8<>pg_current_xact_id() OR NOT identity.retention_policy_eligible(root.id,record.id)
   OR session.revoked_at IS NOT NULL OR session.expires_at<=clock_timestamp() OR session.mfa_expires_at<=clock_timestamp()
   OR NOT EXISTS(SELECT 1 FROM administration.admin_users admin
     JOIN identity.telegram_identities identity ON identity.user_id=admin.user_id AND identity.telegram_user_id=admin.telegram_user_id
     WHERE admin.id=a.actor_admin_id AND admin.is_active AND admin.identity_verified_at IS NOT NULL AND admin.version=session.admin_version)
   OR NOT EXISTS(SELECT 1 FROM administration.admin_user_roles assignment
     JOIN administration.admin_roles role ON role.code=assignment.role_code AND role.is_active
     JOIN administration.admin_role_permissions permission ON permission.role_code=role.code AND permission.permission_code='approve_retention_policy'
     WHERE assignment.admin_user_id=a.actor_admin_id AND assignment.revoked_at IS NULL)
   OR (session.totp_credential_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM administration.admin_totp_credentials credential
     WHERE credential.id=session.totp_credential_id AND credential.admin_user_id=a.actor_admin_id AND credential.revoked_at IS NULL)) THEN RETURN false; END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION identity.guard_retention_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid; record_id uuid; previous platform.audit_logs; version integer;
BEGIN
 IF NEW.event_type NOT IN('account.retention-policy-approved.v1','account.retention-policy-revoked.v1') THEN RETURN NEW; END IF;
 SELECT user_id INTO subject FROM identity.account_deletion_records WHERE id=NEW.subject_id;
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 PERFORM id FROM identity.account_deletion_records WHERE id=NEW.subject_id FOR UPDATE;
 IF NEW.event_type='account.retention-policy-approved.v1' THEN
  record_id:=(NEW.metadata->>'retentionRecordId')::uuid;
  version:=(NEW.metadata->>'policyVersion')::integer;
  SELECT * INTO previous FROM platform.audit_logs WHERE subject_id=NEW.subject_id
   AND event_type='account.retention-policy-approved.v1' AND metadata->>'resource'=NEW.metadata->>'resource'
   ORDER BY (metadata->>'policyVersion')::integer DESC LIMIT 1;
  IF (previous.id IS NULL AND version IS DISTINCT FROM 1) OR (previous.id IS NOT NULL AND
    (version IS DISTINCT FROM (previous.metadata->>'policyVersion')::integer+1 OR NOT EXISTS(
     SELECT 1 FROM platform.audit_logs WHERE event_type='account.retention-policy-revoked.v1' AND metadata->>'approvalId'=previous.id::text))) THEN
   RAISE EXCEPTION 'retention policy version conflict' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO previous FROM platform.audit_logs WHERE id=(NEW.metadata->>'approvalId')::uuid
   AND event_type='account.retention-policy-approved.v1' AND subject_id=NEW.subject_id;
  record_id:=(previous.metadata->>'retentionRecordId')::uuid;
  IF previous.id IS NULL OR EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='account.retention-policy-revoked.v1'
    AND metadata->>'approvalId'=previous.id::text) OR EXISTS(SELECT 1 FROM platform.audit_logs
    WHERE event_type='account.retention-policy-approved.v1' AND subject_id=NEW.subject_id
     AND metadata->>'resource'=previous.metadata->>'resource'
     AND (metadata->>'policyVersion')::integer>(previous.metadata->>'policyVersion')::integer) THEN
   RAISE EXCEPTION 'retention policy revocation unavailable' USING ERRCODE='23514'; END IF;
 END IF;
 IF identity.retention_policy_eligible(NEW.subject_id,record_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'retention policy unavailable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retention_policy_guard BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION identity.guard_retention_policy();

CREATE FUNCTION identity.require_retention_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy platform.audit_logs;
BEGIN
 IF TG_TABLE_SCHEMA='platform' THEN
  IF NEW.event_type NOT IN('account.retention-policy-approved.v1','account.retention-policy-revoked.v1') THEN RETURN NULL; END IF;
  SELECT * INTO policy FROM platform.audit_logs WHERE id=NEW.id;
  IF identity.retention_policy_proof_valid(policy,true) IS NOT TRUE THEN
   RAISE EXCEPTION 'retention policy proof incomplete' USING ERRCODE='23514'; END IF;
 ELSIF NEW.command_code IN('retention.approve-policy','retention.revoke-policy') AND NEW.result='succeeded' THEN
  SELECT * INTO policy FROM platform.audit_logs WHERE metadata->>'adminLogId'=NEW.id::text
   AND event_type=CASE NEW.command_code WHEN 'retention.approve-policy' THEN 'account.retention-policy-approved.v1' ELSE 'account.retention-policy-revoked.v1' END;
  IF policy.id IS NULL OR identity.retention_policy_proof_valid(policy,true) IS NOT TRUE THEN
   RAISE EXCEPTION 'retention policy audit missing' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER retention_policy_commit AFTER INSERT ON platform.audit_logs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_retention_policy();
CREATE CONSTRAINT TRIGGER retention_policy_command_commit AFTER INSERT ON administration.admin_action_logs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_retention_policy();

CREATE FUNCTION identity.record_retention_policy(audit_id uuid,admin_id uuid,root_id uuid,root_version integer,
 action text,payload jsonb,log_id uuid,session_id uuid,command_id uuid,request_id uuid)
RETURNS TABLE(policy_version integer,rejection text) LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; record identity.data_retention_records;
 previous platform.audit_logs; version integer; policy_metadata jsonb; policy_event text; code text;
BEGIN
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=root_id;
 IF root.id IS NULL THEN RETURN QUERY SELECT 0,'unavailable'; RETURN; END IF;
 PERFORM id FROM identity.users WHERE id=root.user_id FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=root.user_id FOR UPDATE;
 PERFORM id FROM identity.account_deletion_records WHERE id=root.id FOR UPDATE;
 IF root.account_version IS DISTINCT FROM root_version THEN RETURN QUERY SELECT 0,'version_conflict'; RETURN; END IF;
 IF action='approve' THEN
  SELECT * INTO record FROM identity.data_retention_records WHERE deletion_record_id=root.id AND retained_data_type=payload->>'resource';
  SELECT * INTO previous FROM platform.audit_logs WHERE subject_id=root.id AND event_type='account.retention-policy-approved.v1'
   AND metadata->>'resource'=payload->>'resource' ORDER BY (metadata->>'policyVersion')::integer DESC LIMIT 1;
  version:=coalesce((previous.metadata->>'policyVersion')::integer,0);
  IF version IS DISTINCT FROM (payload->>'expectedPolicyVersion')::integer THEN RETURN QUERY SELECT version,'version_conflict'; RETURN; END IF;
  IF previous.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='account.retention-policy-revoked.v1' AND metadata->>'approvalId'=previous.id::text)
   THEN RETURN QUERY SELECT version,'unavailable'; RETURN; END IF;
  version:=version+1; policy_event:='account.retention-policy-approved.v1'; code:='retention_policy_approved';
  policy_metadata:=jsonb_build_object('retentionRecordId',record.id,'resource',record.retained_data_type,
   'retentionSeconds',payload->'retentionSeconds','basis',payload->'basis','evidenceHash',payload->'evidenceHash',
   'registryHash',record.registry_hash,'policyVersion',version);
 ELSIF action='revoke' THEN
  SELECT * INTO previous FROM platform.audit_logs WHERE id=(payload->>'approvalId')::uuid AND subject_id=root.id AND event_type='account.retention-policy-approved.v1';
  SELECT * INTO record FROM identity.data_retention_records WHERE id=(previous.metadata->>'retentionRecordId')::uuid;
  version:=(previous.metadata->>'policyVersion')::integer;
  IF previous.id IS NULL OR EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='account.retention-policy-revoked.v1' AND metadata->>'approvalId'=previous.id::text)
   OR EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='account.retention-policy-approved.v1' AND subject_id=root.id
    AND metadata->>'resource'=previous.metadata->>'resource' AND (metadata->>'policyVersion')::integer>version)
   THEN RETURN QUERY SELECT coalesce(version,0),'unavailable'; RETURN; END IF;
  policy_event:='account.retention-policy-revoked.v1'; code:='retention_policy_revoked'; policy_metadata:=jsonb_build_object('approvalId',previous.id);
 ELSE RETURN QUERY SELECT 0,'unavailable'; RETURN;
 END IF;
 IF record.id IS NULL OR identity.retention_policy_eligible(root.id,record.id) IS NOT TRUE THEN RETURN QUERY SELECT 0,'unavailable'; RETURN; END IF;
 INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,
  metadata_schema_version,metadata,command_id,request_id,occurred_at)
 VALUES(audit_id,'account',policy_event,'admin',NULL,admin_id,'account_deletion',root.id,code,1,
  policy_metadata||jsonb_build_object('adminLogId',log_id,'sessionId',session_id,'transactionId',pg_current_xact_id()::text),command_id,request_id,clock_timestamp());
 RETURN QUERY SELECT version,NULL::text;
END $$;

-- Valid historical policy reviews are lifecycle facts, never current product authority.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('platform.deletion_operational_blocker(uuid)'::regprocedure) INTO definition;
 IF position('AND (audit.metadata_schema_version<>1 OR' IN definition)=0 THEN RAISE EXCEPTION 'operational blocker shape changed' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,'AND (audit.metadata_schema_version<>1 OR',
  'AND NOT (audit.event_type IN(''account.retention-policy-approved.v1'',''account.retention-policy-revoked.v1'') AND identity.retention_policy_proof_valid(audit,false)) AND (audit.metadata_schema_version<>1 OR');
 EXECUTE definition;
END $$;
