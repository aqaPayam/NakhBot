-- Existing audit facts carry launch authority. No new user-data table or outbox.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type IN
 ('platform.launch-policy-applied.v1','platform.launch-cohort-granted.v1')) THEN
  RAISE EXCEPTION 'Untrusted launch history predates admission guards' USING ERRCODE='55000';
 END IF;
END $$;

CREATE FUNCTION platform.launch_policy_version(source_id uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE a platform.audit_logs; v numeric; size numeric; expiry timestamptz;
BEGIN
 SELECT * INTO a FROM platform.audit_logs WHERE id=source_id;
 IF a.id IS NULL OR a.category IS DISTINCT FROM 'security' OR a.event_type IS DISTINCT FROM 'platform.launch-policy-applied.v1'
 OR a.actor_type IS DISTINCT FROM 'system' OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NOT NULL
 OR a.subject_type IS DISTINCT FROM 'launch_policy' OR a.subject_id IS DISTINCT FROM '00000000-0000-4000-8000-000000000009'::uuid
 OR (a.result_code IS NULL OR a.result_code NOT IN ('closed','cohort')) OR a.metadata_schema_version IS DISTINCT FROM 1
 OR a.command_id IS DISTINCT FROM a.id OR a.request_id IS DISTINCT FROM a.id
 OR NOT (a.metadata ?& ARRAY['operatorId','sourceSha','requestDigest','reviewDigest','version','cohortSize','expiresAt','environment','telegramBotId'])
 OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>9
 OR jsonb_typeof(a.metadata->'operatorId')<>'string'
 OR (a.metadata->>'operatorId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR jsonb_typeof(a.metadata->'sourceSha')<>'string' OR (a.metadata->>'sourceSha') !~ '^[a-f0-9]{40}$'
 OR jsonb_typeof(a.metadata->'environment') IS DISTINCT FROM 'string' OR (a.metadata->>'environment') NOT IN ('staging','production')
 OR jsonb_typeof(a.metadata->'telegramBotId') IS DISTINCT FROM 'string' OR (a.metadata->>'telegramBotId') !~ '^[1-9][0-9]{0,15}$'
 OR jsonb_typeof(a.metadata->'requestDigest')<>'string' OR (a.metadata->>'requestDigest') !~ '^[a-f0-9]{64}$'
 OR jsonb_typeof(a.metadata->'reviewDigest')<>'string' OR (a.metadata->>'reviewDigest') !~ '^[a-f0-9]{64}$'
 OR jsonb_typeof(a.metadata->'version')<>'number' OR jsonb_typeof(a.metadata->'cohortSize')<>'number'
 OR a.occurred_at IS NULL OR NOT isfinite(a.occurred_at) THEN RETURN NULL; END IF;
 IF (a.metadata->>'telegramBotId')::numeric>9007199254740991 THEN RETURN NULL; END IF;
 v:=(a.metadata->>'version')::numeric; size:=(a.metadata->>'cohortSize')::numeric;
 IF v<>trunc(v) OR v<1 OR v>2147483647 OR size<>trunc(size) OR size<0 OR size>100
 THEN RETURN NULL; END IF;
 IF a.result_code='closed' THEN
  IF size<>0 OR a.metadata->'expiresAt'<>'null'::jsonb THEN RETURN NULL; END IF;
 ELSE
  IF size<1 OR jsonb_typeof(a.metadata->'expiresAt')<>'string' THEN RETURN NULL; END IF;
  expiry:=(a.metadata->>'expiresAt')::timestamptz;
  IF NOT isfinite(expiry) OR expiry<=a.occurred_at OR expiry>a.occurred_at+interval '24 hours'
  OR to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>a.metadata->>'expiresAt'
  THEN RETURN NULL; END IF;
 END IF;
 RETURN v::bigint;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

CREATE FUNCTION platform.launch_member_epoch(source_id uuid) RETURNS integer
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE a platform.audit_logs; policy platform.audit_logs; epoch numeric;
BEGIN
 SELECT * INTO a FROM platform.audit_logs WHERE id=source_id;
 IF a.id IS NULL OR a.category IS DISTINCT FROM 'security' OR a.event_type IS DISTINCT FROM 'platform.launch-cohort-granted.v1'
 OR a.actor_type IS DISTINCT FROM 'system' OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NOT NULL
 OR a.subject_type IS DISTINCT FROM 'user' OR a.subject_id IS NULL OR a.result_code IS DISTINCT FROM 'admitted' OR a.metadata_schema_version IS DISTINCT FROM 1
 OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>2
 OR jsonb_typeof(a.metadata->'policyId') IS DISTINCT FROM 'string'
 OR (a.metadata->>'policyId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR a.command_id IS DISTINCT FROM (a.metadata->>'policyId')::uuid OR a.request_id IS DISTINCT FROM a.command_id
 OR jsonb_typeof(a.metadata->'productEpoch') IS DISTINCT FROM 'number' THEN RETURN NULL; END IF;
 SELECT * INTO policy FROM platform.audit_logs WHERE id=(a.metadata->>'policyId')::uuid;
 IF platform.launch_policy_version(policy.id) IS NULL OR policy.result_code IS DISTINCT FROM 'cohort'
 OR a.occurred_at IS DISTINCT FROM policy.occurred_at THEN RETURN NULL; END IF;
 epoch:=(a.metadata->>'productEpoch')::numeric;
 IF epoch<>trunc(epoch) OR epoch<0 OR epoch>2147483647 THEN RETURN NULL; END IF;
 RETURN epoch::integer;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

CREATE UNIQUE INDEX launch_policy_version_idx ON platform.audit_logs(((metadata->>'version')::bigint) DESC)
 WHERE event_type='platform.launch-policy-applied.v1';
CREATE UNIQUE INDEX launch_member_policy_user_idx ON platform.audit_logs(((metadata->>'policyId')::uuid),subject_id)
 WHERE event_type='platform.launch-cohort-granted.v1';

CREATE FUNCTION platform.guard_launch_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 -- A runtime purpose login can append ordinary audits, never launch authority.
 IF CURRENT_USER<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='platform.audit_logs'::regclass))
 OR SESSION_USER<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='platform.audit_logs'::regclass))
 THEN RAISE EXCEPTION 'Launch authority requires the protected operator' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER launch_authority_owner BEFORE INSERT ON platform.audit_logs
 FOR EACH ROW WHEN (NEW.event_type IN ('platform.launch-policy-applied.v1','platform.launch-cohort-granted.v1'))
 EXECUTE FUNCTION platform.guard_launch_authority();

CREATE FUNCTION platform.require_launch_manifest() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE policy platform.audit_logs; policy_id uuid; amount integer;
BEGIN
 policy_id:=CASE WHEN NEW.event_type='platform.launch-policy-applied.v1' THEN NEW.id ELSE (NEW.metadata->>'policyId')::uuid END;
 SELECT * INTO policy FROM platform.audit_logs WHERE id=policy_id;
 IF platform.launch_policy_version(policy_id) IS NULL THEN
  RAISE EXCEPTION 'Invalid launch policy' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO amount FROM platform.audit_logs WHERE event_type='platform.launch-cohort-granted.v1' AND (metadata->>'policyId')::uuid=policy_id;
 IF amount<>(policy.metadata->>'cohortSize')::integer OR EXISTS(
  SELECT 1 FROM platform.audit_logs member LEFT JOIN identity.accounts account ON account.user_id=member.subject_id
  WHERE member.event_type='platform.launch-cohort-granted.v1' AND (member.metadata->>'policyId')::uuid=policy_id
   AND (platform.launch_member_epoch(member.id) IS NULL OR account.user_id IS NULL OR account.state='deleted'
        OR account.product_epoch IS DISTINCT FROM platform.launch_member_epoch(member.id))) THEN
  RAISE EXCEPTION 'Incomplete launch cohort' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER launch_manifest_complete AFTER INSERT ON platform.audit_logs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.event_type IN ('platform.launch-policy-applied.v1','platform.launch-cohort-granted.v1'))
 EXECUTE FUNCTION platform.require_launch_manifest();

-- Exact, content-free security facts remain proof after expiry and Root. The
-- current Account epoch independently denies them after deletion/fresh Return.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('platform.deletion_operational_blocker(uuid)'::regprocedure) INTO definition;
 IF position('AND (audit.metadata_schema_version<>1 OR' IN definition)=0 THEN
  RAISE EXCEPTION 'Operational blocker shape changed' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,'AND (audit.metadata_schema_version<>1 OR',
  'AND CASE WHEN audit.event_type=''platform.launch-cohort-granted.v1'' THEN platform.launch_member_epoch(audit.id) IS NULL ELSE true END AND (audit.metadata_schema_version<>1 OR');
 EXECUTE definition;
END $$;
