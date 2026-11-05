-- A protected operator may delegate a bounded staging invitation. Existing launch
-- policy/member authority remains immutable and owner-only. Tokens are never stored.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type IN
 ('platform.trial-invitation-created.v1','platform.trial-invitation-redeemed.v1')) THEN
  RAISE EXCEPTION 'Untrusted trial history predates admission guards' USING ERRCODE='55000';
 END IF;
END $$;

CREATE FUNCTION platform.trial_invitation_policy(source_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE a platform.audit_logs; p platform.audit_logs; capacity numeric; expiry timestamptz;
BEGIN
 SELECT * INTO a FROM platform.audit_logs WHERE id=source_id;
 IF a.id IS NULL OR a.event_type IS DISTINCT FROM 'platform.trial-invitation-created.v1'
 OR a.category IS DISTINCT FROM 'security' OR a.actor_type IS DISTINCT FROM 'system'
 OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NOT NULL
 OR a.subject_type IS DISTINCT FROM 'launch_policy' OR a.result_code IS DISTINCT FROM 'ready'
 OR a.metadata_schema_version IS DISTINCT FROM 1 OR a.command_id IS DISTINCT FROM a.id
 OR a.request_id IS DISTINCT FROM a.id OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>4
 OR NOT (a.metadata ?& ARRAY['policyId','tokenHash','capacity','expiresAt'])
 OR jsonb_typeof(a.metadata->'policyId') IS DISTINCT FROM 'string'
 OR (a.metadata->>'policyId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR jsonb_typeof(a.metadata->'tokenHash') IS DISTINCT FROM 'string'
 OR (a.metadata->>'tokenHash') !~ '^[a-f0-9]{64}$'
 OR jsonb_typeof(a.metadata->'capacity') IS DISTINCT FROM 'number'
 OR jsonb_typeof(a.metadata->'expiresAt') IS DISTINCT FROM 'string'
 OR a.occurred_at IS NULL OR NOT isfinite(a.occurred_at) THEN RETURN NULL; END IF;
 SELECT * INTO p FROM platform.audit_logs WHERE id=(a.metadata->>'policyId')::uuid;
 IF platform.launch_policy_version(p.id) IS NULL OR p.result_code IS DISTINCT FROM 'cohort'
 OR p.metadata->>'environment' IS DISTINCT FROM 'staging' OR a.subject_id IS DISTINCT FROM p.id
 OR a.occurred_at<p.occurred_at THEN RETURN NULL; END IF;
 capacity:=(a.metadata->>'capacity')::numeric; expiry:=(a.metadata->>'expiresAt')::timestamptz;
 IF capacity<>trunc(capacity) OR capacity<1 OR capacity+(p.metadata->>'cohortSize')::integer>10
 OR NOT isfinite(expiry) OR expiry<=a.occurred_at OR expiry>(p.metadata->>'expiresAt')::timestamptz
 OR to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>a.metadata->>'expiresAt'
 THEN RETURN NULL; END IF;
 RETURN p.id;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

WITH seed(text_key,body) AS (VALUES
 ('trial.invitation.unavailable','This trial invitation is unavailable, expired or full. Ask the person who invited you for access.'),
 ('trial.feedback.prompt','Send /feedback followed by a rating from 1 to 5 and your comments. Example: /feedback 4 Easy to use, but photos loaded slowly.'),
 ('trial.feedback.sent','Thank you. Your rating and comments were saved as private trial feedback.'))
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,'message','[]'::jsonb,true,
 '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM seed;

CREATE FUNCTION platform.trial_claim_epoch(source_id uuid) RETURNS integer
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE a platform.audit_logs; invitation platform.audit_logs; epoch numeric;
BEGIN
 SELECT * INTO a FROM platform.audit_logs WHERE id=source_id;
 IF a.id IS NULL OR a.event_type IS DISTINCT FROM 'platform.trial-invitation-redeemed.v1'
 OR a.category IS DISTINCT FROM 'security' OR a.actor_type IS DISTINCT FROM 'user'
 OR a.subject_type IS DISTINCT FROM 'user' OR a.subject_id IS NULL
 OR a.actor_user_id IS DISTINCT FROM a.subject_id OR a.actor_admin_id IS NOT NULL
 OR a.result_code IS DISTINCT FROM 'admitted' OR a.metadata_schema_version IS DISTINCT FROM 1
 OR a.command_id IS DISTINCT FROM a.id OR a.request_id IS DISTINCT FROM a.id
 OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>2
 OR NOT (a.metadata ?& ARRAY['invitationId','productEpoch'])
 OR jsonb_typeof(a.metadata->'invitationId') IS DISTINCT FROM 'string'
 OR (a.metadata->>'invitationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR jsonb_typeof(a.metadata->'productEpoch') IS DISTINCT FROM 'number'
 OR a.occurred_at IS NULL OR NOT isfinite(a.occurred_at) THEN RETURN NULL; END IF;
 SELECT * INTO invitation FROM platform.audit_logs WHERE id=(a.metadata->>'invitationId')::uuid;
 IF platform.trial_invitation_policy(invitation.id) IS NULL OR a.occurred_at<invitation.occurred_at
 OR a.occurred_at>=(invitation.metadata->>'expiresAt')::timestamptz THEN RETURN NULL; END IF;
 epoch:=(a.metadata->>'productEpoch')::numeric;
 IF epoch<>trunc(epoch) OR epoch<0 OR epoch>2147483647 THEN RETURN NULL; END IF;
 RETURN epoch::integer;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

CREATE UNIQUE INDEX trial_invitation_policy_idx ON platform.audit_logs(((metadata->>'policyId')::uuid))
 WHERE event_type='platform.trial-invitation-created.v1';
CREATE UNIQUE INDEX trial_invitation_token_idx ON platform.audit_logs((metadata->>'tokenHash'))
 WHERE event_type='platform.trial-invitation-created.v1';
CREATE UNIQUE INDEX trial_claim_invitation_user_idx ON platform.audit_logs(((metadata->>'invitationId')::uuid),subject_id)
 WHERE event_type='platform.trial-invitation-redeemed.v1';

CREATE FUNCTION platform.guard_trial_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE owner_name text; p platform.audit_logs; invitation platform.audit_logs; account identity.accounts;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid='platform.audit_logs'::regclass;
 -- Redemption is inserted only inside the token-checking SECURITY DEFINER function.
 IF current_user<>owner_name OR
 (NEW.event_type='platform.trial-invitation-created.v1' AND session_user<>owner_name)
 THEN RAISE EXCEPTION 'Protected trial authority required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('nakh-launch-cohort'));
 SELECT * INTO p FROM platform.audit_logs WHERE event_type='platform.launch-policy-applied.v1'
 ORDER BY ((metadata->>'version')::bigint) DESC LIMIT 1;
 IF platform.launch_policy_version(p.id) IS NULL OR p.result_code<>'cohort'
 OR p.metadata->>'environment'<>'staging' OR (p.metadata->>'expiresAt')::timestamptz<=clock_timestamp()
 THEN RAISE EXCEPTION 'Trial is closed' USING ERRCODE='23514'; END IF;
 IF NEW.event_type='platform.trial-invitation-created.v1' THEN
  IF NEW.subject_id IS DISTINCT FROM p.id OR (NEW.metadata->>'policyId')::uuid IS DISTINCT FROM p.id
  THEN RAISE EXCEPTION 'Wrong trial policy' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO invitation FROM platform.audit_logs WHERE id=(NEW.metadata->>'invitationId')::uuid;
  IF platform.trial_invitation_policy(invitation.id) IS DISTINCT FROM p.id
  OR (invitation.metadata->>'expiresAt')::timestamptz<=clock_timestamp()
  OR (SELECT count(*) FROM platform.audit_logs WHERE event_type='platform.trial-invitation-redeemed.v1'
    AND (metadata->>'invitationId')::uuid=invitation.id)>=(invitation.metadata->>'capacity')::integer
  THEN RAISE EXCEPTION 'Trial invitation unavailable' USING ERRCODE='23514'; END IF;
  SELECT * INTO account FROM identity.accounts WHERE user_id=NEW.subject_id FOR UPDATE;
  IF account.user_id IS NULL OR account.state='deleted' OR account.product_epoch IS DISTINCT FROM (NEW.metadata->>'productEpoch')::integer
  THEN RAISE EXCEPTION 'Trial life unavailable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trial_authority_guard BEFORE INSERT ON platform.audit_logs FOR EACH ROW
 WHEN (NEW.event_type IN ('platform.trial-invitation-created.v1','platform.trial-invitation-redeemed.v1'))
 EXECUTE FUNCTION platform.guard_trial_authority();

CREATE FUNCTION platform.require_trial_fact() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (CASE WHEN NEW.event_type='platform.trial-invitation-created.v1'
 THEN platform.trial_invitation_policy(NEW.id) IS NULL ELSE platform.trial_claim_epoch(NEW.id) IS NULL END)
 THEN RAISE EXCEPTION 'Invalid trial fact' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER trial_fact_valid AFTER INSERT ON platform.audit_logs FOR EACH ROW
 WHEN (NEW.event_type IN ('platform.trial-invitation-created.v1','platform.trial-invitation-redeemed.v1'))
 EXECUTE FUNCTION platform.require_trial_fact();

CREATE FUNCTION platform.redeem_trial_invitation(token text, member_id uuid, epoch integer,
 source_sha text, bot_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p platform.audit_logs; invitation platform.audit_logs; previous platform.audit_logs; account identity.accounts; claim_id uuid;
BEGIN
 IF token IS NULL OR token !~ '^[A-Za-z0-9_-]{32}$' OR epoch IS NULL OR epoch<0
 OR source_sha IS NULL OR source_sha !~ '^[a-f0-9]{40}$' OR bot_id IS NULL OR bot_id !~ '^[1-9][0-9]{0,15}$'
 THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('nakh-launch-cohort'));
 SELECT * INTO p FROM platform.audit_logs WHERE event_type='platform.launch-policy-applied.v1'
 ORDER BY ((metadata->>'version')::bigint) DESC LIMIT 1;
 IF platform.launch_policy_version(p.id) IS NULL OR p.result_code<>'cohort'
 OR p.metadata->>'environment'<>'staging' OR p.metadata->>'sourceSha'<>source_sha
 OR p.metadata->>'telegramBotId'<>bot_id OR (p.metadata->>'expiresAt')::timestamptz<=clock_timestamp()
 THEN RETURN false; END IF;
 SELECT * INTO invitation FROM platform.audit_logs WHERE event_type='platform.trial-invitation-created.v1'
 AND metadata->>'tokenHash'=encode(sha256(convert_to(token,'UTF8')),'hex');
 IF platform.trial_invitation_policy(invitation.id) IS DISTINCT FROM p.id
 OR (invitation.metadata->>'expiresAt')::timestamptz<=clock_timestamp() THEN RETURN false; END IF;
 -- Same lock order as ordinary account and ledger operations.
 PERFORM id FROM identity.users WHERE id=member_id FOR NO KEY UPDATE;
 SELECT * INTO account FROM identity.accounts WHERE user_id=member_id FOR UPDATE;
 IF account.user_id IS NULL OR account.state='deleted' OR account.product_epoch IS DISTINCT FROM epoch THEN RETURN false; END IF;
 SELECT * INTO previous FROM platform.audit_logs WHERE event_type='platform.trial-invitation-redeemed.v1'
 AND (metadata->>'invitationId')::uuid=invitation.id AND subject_id=member_id;
 IF previous.id IS NOT NULL THEN RETURN platform.trial_claim_epoch(previous.id)=epoch; END IF;
 -- Existing explicitly approved members never consume an invitation seat.
 IF EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='platform.launch-cohort-granted.v1'
  AND (metadata->>'policyId')::uuid=p.id AND subject_id=member_id AND platform.launch_member_epoch(id)=epoch)
 THEN RETURN true; END IF;
 IF (SELECT count(*) FROM platform.audit_logs WHERE event_type='platform.trial-invitation-redeemed.v1'
 AND (metadata->>'invitationId')::uuid=invitation.id)>=(invitation.metadata->>'capacity')::integer THEN RETURN false; END IF;
 claim_id:=gen_random_uuid();
 INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,
 subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
 VALUES(claim_id,'security','platform.trial-invitation-redeemed.v1','user',member_id,NULL,'user',member_id,
 'admitted',1,jsonb_build_object('invitationId',invitation.id,'productEpoch',epoch),claim_id,claim_id,clock_timestamp());
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION platform.redeem_trial_invitation(text,uuid,integer,text,text) FROM PUBLIC;

-- Retain only validated, content-free original-life security facts through Root.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('platform.deletion_operational_blocker(uuid)'::regprocedure) INTO definition;
 IF position('WHEN audit.event_type=''platform.launch-cohort-granted.v1''' IN definition)=0 THEN
  RAISE EXCEPTION 'Operational blocker shape changed' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,'WHEN audit.event_type=''platform.launch-cohort-granted.v1''',
 'WHEN audit.event_type=''platform.trial-invitation-redeemed.v1'' THEN platform.trial_claim_epoch(audit.id) IS NULL WHEN audit.event_type=''platform.launch-cohort-granted.v1''');
 EXECUTE definition;
END $$;
