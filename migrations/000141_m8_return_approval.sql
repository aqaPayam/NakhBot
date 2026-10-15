-- Approval is a separate immutable fact. This migration does not enable Return,
-- change a completed Root, release retained data, or restore product authority.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='account.return-approved.v1') THEN
  RAISE EXCEPTION 'legacy return approval requires explicit provenance' USING ERRCODE='55000'; END IF;
END $$;
INSERT INTO administration.admin_permissions(code,description)
VALUES('approve_account_return','Approve a fresh guest return after completed account deletion');
INSERT INTO administration.admin_role_permissions(role_code,permission_code)
VALUES('super_admin','approve_account_return');

CREATE UNIQUE INDEX account_return_approval_root_idx ON platform.audit_logs(subject_id)
 WHERE event_type='account.return-approved.v1';

CREATE FUNCTION identity.account_return_reviewable(root_id uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
  JOIN identity.accounts account ON account.user_id=root.user_id
  JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
  WHERE root.id=root_id AND root.phase='completed' AND root.checkpoint_version=8
   AND root.completed_at IS NOT NULL AND root.product_purged_at=root.completed_at
   AND root.safety_bar='none' AND NOT root.reactivation_allowed AND root.last_error_code IS NULL
   AND account.state='deleted' AND account.version=root.account_version AND account.product_epoch=root.product_epoch
   AND work.phase='completed' AND work.checkpoint_version=8 AND work.lease_owner IS NULL AND work.lease_expires_at IS NULL
   AND (SELECT count(*) FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=root.id)=7
   AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts receipt WHERE receipt.deletion_record_id=root.id
    AND receipt.completed_phase='verification' AND receipt.next_phase='completed' AND receipt.next_checkpoint_version=8
    AND receipt.verified_at=root.completed_at AND identity.ephemeral_reconciliation_valid(root.id,receipt.verified_at))
   AND identity.deletion_verification_blocker(root.id,root.user_id) IS NULL) $$;

CREATE FUNCTION identity.account_return_approval_valid(a platform.audit_logs,live boolean) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE root identity.account_deletion_records; session administration.admin_sessions; entry administration.admin_action_logs;
BEGIN
 IF a.category<>'account' OR a.event_type<>'account.return-approved.v1' OR a.actor_type<>'admin'
  OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NULL OR a.subject_type<>'account_deletion'
  OR a.result_code<>'return_approved' OR a.metadata_schema_version<>1
  OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>5
  OR jsonb_typeof(a.metadata->'productEpoch') IS DISTINCT FROM 'number'
  OR jsonb_typeof(a.metadata->'accountVersion') IS DISTINCT FROM 'number'
  OR jsonb_typeof(a.metadata->'adminLogId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'sessionId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'transactionId') IS DISTINCT FROM 'string'
  OR (a.metadata->>'transactionId')!~'^[1-9][0-9]{0,19}$' THEN RETURN false; END IF;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=a.subject_id;
 SELECT * INTO session FROM administration.admin_sessions WHERE id=(a.metadata->>'sessionId')::uuid;
 SELECT * INTO entry FROM administration.admin_action_logs WHERE id=(a.metadata->>'adminLogId')::uuid;
 IF root.id IS NULL OR root.phase<>'completed' OR root.checkpoint_version<>8 OR root.completed_at IS NULL
  OR root.safety_bar<>'none' OR a.occurred_at<root.completed_at OR a.occurred_at>clock_timestamp()
  OR a.metadata->'productEpoch' IS DISTINCT FROM to_jsonb(root.product_epoch)
  OR a.metadata->'accountVersion' IS DISTINCT FROM to_jsonb(root.account_version)
  OR session.id IS NULL OR session.admin_user_id<>a.actor_admin_id OR session.issued_at>a.occurred_at
  OR session.expires_at<=a.occurred_at OR session.mfa_expires_at<=a.occurred_at
  OR entry.id IS NULL OR entry.admin_user_id<>a.actor_admin_id OR entry.command_id<>a.command_id OR entry.request_id<>a.request_id
  OR entry.command_code<>'account.approve-return' OR entry.target_type<>'account_deletion' OR entry.target_id<>root.id
  OR entry.expected_target_version IS DISTINCT FROM root.account_version OR entry.result<>'succeeded'
  OR entry.safe_code<>'return_approved' OR entry.metadata<>'{}'::jsonb THEN RETURN false; END IF;
 IF live THEN
  IF (a.metadata->>'transactionId')::xid8<>pg_current_xact_id()
   OR identity.account_return_reviewable(root.id) IS NOT TRUE
   OR session.revoked_at IS NOT NULL OR session.expires_at<=clock_timestamp() OR session.mfa_expires_at<=clock_timestamp()
   OR NOT EXISTS(SELECT 1 FROM administration.admin_users admin
     JOIN identity.telegram_identities identity ON identity.user_id=admin.user_id AND identity.telegram_user_id=admin.telegram_user_id
     WHERE admin.id=a.actor_admin_id AND admin.is_active AND admin.identity_verified_at IS NOT NULL AND admin.version=session.admin_version)
   OR NOT EXISTS(SELECT 1 FROM administration.admin_user_roles assignment
     JOIN administration.admin_roles role ON role.code=assignment.role_code AND role.is_active
     JOIN administration.admin_role_permissions permission ON permission.role_code=role.code AND permission.permission_code='approve_account_return'
     WHERE assignment.admin_user_id=a.actor_admin_id AND assignment.revoked_at IS NULL)
   OR (session.totp_credential_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM administration.admin_totp_credentials credential
     WHERE credential.id=session.totp_credential_id AND credential.admin_user_id=a.actor_admin_id AND credential.revoked_at IS NULL)) THEN RETURN false; END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION identity.guard_account_return_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid;
BEGIN
 IF NEW.event_type<>'account.return-approved.v1' THEN RETURN NEW; END IF;
 SELECT user_id INTO subject FROM identity.account_deletion_records WHERE id=NEW.subject_id;
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 PERFORM id FROM identity.account_deletion_records WHERE id=NEW.subject_id FOR UPDATE;
 IF identity.account_return_reviewable(NEW.subject_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'account return approval unavailable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_return_approval_guard BEFORE INSERT ON platform.audit_logs
FOR EACH ROW EXECUTE FUNCTION identity.guard_account_return_approval();

CREATE FUNCTION identity.require_account_return_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approval platform.audit_logs;
BEGIN
 IF TG_TABLE_SCHEMA='platform' THEN
  IF NEW.event_type<>'account.return-approved.v1' THEN RETURN NULL; END IF;
  SELECT * INTO approval FROM platform.audit_logs WHERE id=NEW.id;
  IF identity.account_return_approval_valid(approval,true) IS NOT TRUE THEN
   RAISE EXCEPTION 'account return approval proof incomplete' USING ERRCODE='23514'; END IF;
 ELSIF NEW.command_code='account.approve-return' AND NEW.result='succeeded' THEN
  SELECT * INTO approval FROM platform.audit_logs WHERE event_type='account.return-approved.v1' AND subject_id=NEW.target_id;
  IF approval.id IS NULL OR identity.account_return_approval_valid(approval,false) IS NOT TRUE
   OR identity.account_return_reviewable(NEW.target_id) IS NOT TRUE THEN
   RAISE EXCEPTION 'account return approval audit missing' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER account_return_approval_commit AFTER INSERT ON platform.audit_logs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_account_return_approval();
CREATE CONSTRAINT TRIGGER account_return_approval_command_commit AFTER INSERT ON administration.admin_action_logs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_account_return_approval();

-- The approval is retained lifecycle proof only when its complete immutable
-- provenance validates. Unknown/malformed audit content keeps blocking deletion.
-- Historical validation never calls the current-product blocker recursively.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('platform.deletion_operational_blocker(uuid)'::regprocedure) INTO definition;
 IF position('AND (audit.metadata_schema_version<>1 OR' IN definition)=0 THEN
  RAISE EXCEPTION 'operational blocker shape changed' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,'AND (audit.metadata_schema_version<>1 OR',
  'AND NOT (audit.event_type=''account.return-approved.v1'' AND identity.account_return_approval_valid(audit,false)) AND (audit.metadata_schema_version<>1 OR');
 EXECUTE definition;
END $$;
