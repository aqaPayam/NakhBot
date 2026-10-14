-- Security grants remain immutable audit facts. Root revocation requires its
-- original life, a live phase-5 lease, exact source roster and a separate digest.
CREATE FUNCTION identity.user_session_epoch(source_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE AS $$
DECLARE a platform.audit_logs; epoch numeric; expiry timestamptz;
BEGIN
 SELECT * INTO a FROM platform.audit_logs WHERE id=source_id;
 IF a.id IS NULL OR a.category<>'security' OR a.event_type<>'identity.user-session-issued.v1'
  OR a.actor_type<>'user' OR a.actor_user_id IS NULL OR a.actor_admin_id IS NOT NULL
  OR a.subject_type<>'user_session' OR a.subject_id<>a.id OR a.result_code<>'issued'
  OR a.metadata_schema_version<>1 OR a.command_id<>a.request_id
  OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>2
  OR jsonb_typeof(a.metadata->'productEpoch') IS DISTINCT FROM 'number'
  OR jsonb_typeof(a.metadata->'expiresAt') IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
 epoch:=(a.metadata->>'productEpoch')::numeric;
 IF epoch<>trunc(epoch) OR epoch<0 OR epoch>2147483647 THEN RETURN NULL; END IF;
 expiry:=(a.metadata->>'expiresAt')::timestamptz;
 IF NOT isfinite(expiry) OR NOT isfinite(a.occurred_at) OR a.occurred_at>clock_timestamp()
  OR expiry<>a.occurred_at+interval '15 minutes'
  OR to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>a.metadata->>'expiresAt'
  THEN RETURN NULL; END IF;
 RETURN epoch::integer;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='identity.user-session-issued.v1'
   AND identity.user_session_epoch(id) IS NULL)
  OR EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='identity.user-session-root-revoked.v1') THEN
  RAISE EXCEPTION 'legacy session authority requires explicit provenance' USING ERRCODE='55000';
 END IF;
END $$;

CREATE TABLE identity.account_deletion_session_receipts (
 audit_id uuid PRIMARY KEY REFERENCES platform.audit_logs(id) ON DELETE RESTRICT,
 deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
 proof_hash text NOT NULL CHECK(proof_hash~'^[0-9a-f]{64}$')
);
CREATE INDEX deletion_session_receipts_root_idx ON identity.account_deletion_session_receipts(deletion_record_id,audit_id);

CREATE FUNCTION identity.deletion_session_digest(batch_id uuid) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'audit',(to_jsonb(batch)-'occurred_at')||jsonb_build_object('occurredAtEpoch',extract(epoch FROM batch.occurred_at)),
  'root',jsonb_build_object('id',root.id,'userId',root.user_id,'productEpoch',root.product_epoch,
    'accountVersion',root.account_version,'commandId',root.command_id,'requestId',root.request_id),
  'sources',(SELECT jsonb_agg((to_jsonb(source)-'occurred_at')||jsonb_build_object('occurredAtEpoch',extract(epoch FROM source.occurred_at)) ORDER BY source.id)
    FROM platform.audit_logs source WHERE batch.metadata->'grantIds' @> jsonb_build_array(source.id)))::text,'UTF8')),'hex')
 FROM platform.audit_logs batch JOIN identity.account_deletion_records root ON root.id=batch.subject_id WHERE batch.id=batch_id
$$;

CREATE FUNCTION identity.deletion_session_context(a platform.audit_logs,live boolean) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work; owner identity.accounts;
 ids uuid[]; expiry timestamptz; worker uuid; generation integer;
BEGIN
 IF a.category<>'security' OR a.event_type<>'identity.user-session-root-revoked.v1'
  OR a.actor_type<>'system' OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NOT NULL
  OR a.subject_type<>'account_deletion' OR a.result_code<>'deletion_sessions_revoked' OR a.metadata_schema_version<>1
  OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>7
  OR jsonb_typeof(a.metadata->'grantIds') IS DISTINCT FROM 'array'
  OR jsonb_array_length(a.metadata->'grantIds') NOT BETWEEN 1 AND 100
  OR a.metadata->'rows' IS DISTINCT FROM to_jsonb(jsonb_array_length(a.metadata->'grantIds'))
  OR jsonb_typeof(a.metadata->'productEpoch') IS DISTINCT FROM 'number'
  OR jsonb_typeof(a.metadata->'owner') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'generation') IS DISTINCT FROM 'number'
  OR jsonb_typeof(a.metadata->'leaseExpiresAt') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'transactionId') IS DISTINCT FROM 'string'
  OR (a.metadata->>'transactionId')!~'^[1-9][0-9]{0,19}$' THEN RETURN false; END IF;
 SELECT array_agg(value::uuid ORDER BY value::uuid) INTO ids FROM jsonb_array_elements_text(a.metadata->'grantIds');
 IF cardinality(ids)<>(SELECT count(DISTINCT id) FROM unnest(ids) id) THEN RETURN false; END IF;
 worker:=(a.metadata->>'owner')::uuid; generation:=(a.metadata->>'generation')::integer;
 expiry:=(a.metadata->>'leaseExpiresAt')::timestamptz;
 IF generation<1 OR a.metadata->'generation' IS DISTINCT FROM to_jsonb(generation)
  OR NOT isfinite(expiry) OR a.occurred_at>=expiry OR a.occurred_at>clock_timestamp() THEN RETURN false; END IF;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=a.subject_id;
 IF root.id IS NULL OR a.command_id<>root.command_id OR a.request_id<>root.request_id
  OR a.occurred_at<root.requested_at OR a.metadata->'productEpoch' IS DISTINCT FROM to_jsonb(root.product_epoch)
  OR cardinality(ids)<>(SELECT count(*) FROM platform.audit_logs source WHERE source.id=ANY(ids)
    AND source.actor_user_id=root.user_id AND identity.user_session_epoch(source.id)=root.product_epoch) THEN RETURN false; END IF;
 IF live THEN
  SELECT * INTO owner FROM identity.accounts WHERE user_id=root.user_id;
  SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=root.id;
  IF owner.user_id IS NULL OR owner.state<>'deleted' OR owner.version<>root.account_version OR owner.product_epoch<>root.product_epoch
   OR root.phase<>'ephemeral_access' OR root.checkpoint_version<>5 OR root.completed_at IS NOT NULL
   OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version OR job.lease_owner IS DISTINCT FROM worker
   OR job.lease_generation<>generation OR job.lease_expires_at IS DISTINCT FROM expiry OR expiry<=clock_timestamp()
   OR (a.metadata->>'transactionId')::xid8<>pg_current_xact_id() THEN RETURN false; END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION identity.deletion_session_audit_valid(batch_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE a platform.audit_logs;
BEGIN
 SELECT * INTO a FROM platform.audit_logs WHERE id=batch_id;
 IF a.id IS NULL OR identity.deletion_session_context(a,false) IS NOT TRUE THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM identity.account_deletion_session_receipts receipt
  WHERE receipt.audit_id=a.id AND receipt.deletion_record_id=a.subject_id
    AND receipt.proof_hash=identity.deletion_session_digest(a.id));
END $$;

CREATE FUNCTION identity.deletion_session_revoked(grant_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE AS $$ SELECT EXISTS(
 SELECT 1 FROM platform.audit_logs source JOIN identity.account_deletion_records root
   ON root.user_id=source.actor_user_id AND root.product_epoch=identity.user_session_epoch(source.id)
 JOIN identity.account_deletion_session_receipts receipt ON receipt.deletion_record_id=root.id
 JOIN platform.audit_logs batch ON batch.id=receipt.audit_id
 WHERE source.id=grant_id AND batch.metadata->'grantIds' @> jsonb_build_array(grant_id)
   AND identity.deletion_session_audit_valid(batch.id)) $$;

CREATE FUNCTION identity.user_session_authority_revoked(grant_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE AS $$ SELECT identity.deletion_session_revoked(grant_id) OR EXISTS(
 SELECT 1 FROM platform.audit_logs source JOIN platform.audit_logs revoked ON revoked.subject_id=source.id
 WHERE source.id=grant_id AND revoked.category='security' AND revoked.event_type='identity.user-session-revoked.v1'
  AND revoked.actor_type='user' AND revoked.actor_user_id=source.actor_user_id AND revoked.actor_admin_id IS NULL
  AND revoked.subject_type='user_session' AND revoked.result_code='revoked'
  AND revoked.metadata_schema_version=1 AND revoked.metadata='{}'::jsonb) $$;

CREATE FUNCTION identity.guard_deletion_session_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid;
BEGIN
 IF NEW.event_type<>'identity.user-session-root-revoked.v1' THEN RETURN NEW; END IF;
 SELECT user_id INTO subject FROM identity.account_deletion_records WHERE id=NEW.subject_id;
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 PERFORM id FROM identity.account_deletion_records WHERE id=NEW.subject_id FOR UPDATE;
 PERFORM deletion_record_id FROM identity.account_deletion_work WHERE deletion_record_id=NEW.subject_id FOR UPDATE;
 IF identity.deletion_session_context(NEW,true) IS NOT TRUE THEN
  RAISE EXCEPTION 'session revocation lacks original deletion authority' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER deletion_session_audit_guard BEFORE INSERT ON platform.audit_logs
 FOR EACH ROW EXECUTE FUNCTION identity.guard_deletion_session_audit();

CREATE FUNCTION identity.guard_deletion_session_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a platform.audit_logs;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'session revocation history requires controlled release' USING ERRCODE='55000'; END IF;
 SELECT * INTO a FROM platform.audit_logs WHERE id=NEW.audit_id;
 IF a.id IS NULL OR NEW.deletion_record_id<>a.subject_id OR identity.deletion_session_context(a,true) IS NOT TRUE
   OR NEW.proof_hash IS DISTINCT FROM identity.deletion_session_digest(a.id) THEN
  RAISE EXCEPTION 'session revocation receipt lacks original proof' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER deletion_session_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_deletion_session_receipts
 FOR EACH ROW EXECUTE FUNCTION identity.guard_deletion_session_receipt();

CREATE FUNCTION identity.require_deletion_session_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_id uuid; a platform.audit_logs;
BEGIN
 IF TG_TABLE_NAME='audit_logs' THEN
  IF NEW.event_type<>'identity.user-session-root-revoked.v1' THEN RETURN NULL; END IF;
  batch_id:=NEW.id;
 ELSE batch_id:=NEW.audit_id; END IF;
 SELECT * INTO a FROM platform.audit_logs WHERE id=batch_id;
 IF identity.deletion_session_context(a,true) IS NOT TRUE OR identity.deletion_session_audit_valid(batch_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'session revocation proof or lease changed before commit' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER deletion_session_audit_required AFTER INSERT ON platform.audit_logs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_deletion_session_receipt();
CREATE CONSTRAINT TRIGGER deletion_session_receipt_required AFTER INSERT ON identity.account_deletion_session_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_deletion_session_receipt();

CREATE FUNCTION identity.deletion_session_blocker(root_id uuid,subject uuid) RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE epoch integer;
BEGIN
 SELECT product_epoch INTO epoch FROM identity.account_deletion_records WHERE id=root_id AND user_id=subject;
 IF epoch IS NULL THEN RETURN 'scope'; END IF;
 IF EXISTS(SELECT 1 FROM identity.account_deletion_session_receipts receipt WHERE receipt.deletion_record_id=root_id
   AND identity.deletion_session_audit_valid(receipt.audit_id) IS NOT TRUE) THEN RETURN 'invalid_sessions'; END IF;
 IF EXISTS(SELECT 1 FROM platform.audit_logs source WHERE source.event_type='identity.user-session-issued.v1'
   AND source.actor_user_id=subject AND (identity.user_session_epoch(source.id) IS NULL OR identity.user_session_epoch(source.id)>epoch)) THEN RETURN 'invalid_sessions'; END IF;
 IF EXISTS(SELECT 1 FROM platform.audit_logs source WHERE source.event_type='identity.user-session-issued.v1'
   AND source.actor_user_id=subject AND identity.user_session_epoch(source.id)=epoch
   AND (source.metadata->>'expiresAt')::timestamptz>clock_timestamp()
   AND NOT identity.user_session_authority_revoked(source.id)) THEN RETURN 'sessions'; END IF;
 RETURN NULL;
END $$;

-- Original-life session expiry metadata is security authority, not ordinary
-- operational content. Exempt only fully validated grant facts; malformed facts
-- still stop the earlier product checkpoint and the independent session check.
DO $$ DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('platform.deletion_operational_blocker(uuid)'::regprocedure) INTO definition;
 IF position('AND (audit.metadata_schema_version<>1 OR' IN definition)=0 THEN
  RAISE EXCEPTION 'operational blocker shape changed' USING ERRCODE='55000';
 END IF;
 definition:=replace(definition,'AND (audit.metadata_schema_version<>1 OR',
  'AND NOT (audit.event_type=''identity.user-session-issued.v1'' AND identity.user_session_epoch(audit.id) IS NOT NULL) AND (audit.metadata_schema_version<>1 OR');
 EXECUTE definition;
END $$;
