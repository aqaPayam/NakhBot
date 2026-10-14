-- Limited account controls use immutable security facts, not restored product
-- sessions. No tables/columns/FKs change; provisional manifest proof stays valid.
CREATE FUNCTION identity.account_control_epoch(source_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE AS $$
DECLARE a platform.audit_logs; epoch numeric; expiry timestamptz;
BEGIN
 SELECT * INTO a FROM platform.audit_logs WHERE id=source_id;
 IF a.id IS NULL OR a.category<>'security' OR a.event_type<>'identity.account-control-issued.v1'
  OR a.actor_type<>'user' OR a.actor_user_id IS NULL OR a.actor_admin_id IS NOT NULL
  OR a.subject_type<>'account_control' OR a.subject_id<>a.id OR a.result_code<>'issued'
  OR a.metadata_schema_version<>1 OR a.command_id<>a.request_id
  OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>2
  OR jsonb_typeof(a.metadata->'productEpoch') IS DISTINCT FROM 'number'
  OR jsonb_typeof(a.metadata->'expiresAt') IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
 epoch:=(a.metadata->>'productEpoch')::numeric;
 IF epoch<>trunc(epoch) OR epoch<0 OR epoch>2147483647 THEN RETURN NULL; END IF;
 expiry:=(a.metadata->>'expiresAt')::timestamptz;
 IF NOT isfinite(expiry) OR NOT isfinite(a.occurred_at) OR a.occurred_at>clock_timestamp()
  OR expiry<a.occurred_at+interval '1 second' OR expiry>a.occurred_at+interval '15 minutes' OR extract(epoch FROM expiry-a.occurred_at)<>trunc(extract(epoch FROM expiry-a.occurred_at))
  OR to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>a.metadata->>'expiresAt' THEN RETURN NULL; END IF;
 RETURN epoch::integer;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
CREATE FUNCTION identity.account_control_authority_revoked(source_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM platform.audit_logs source JOIN platform.audit_logs revoked ON revoked.subject_id=source.id
  WHERE source.id=source_id AND identity.account_control_epoch(source.id) IS NOT NULL
   AND revoked.category='security' AND revoked.event_type='identity.account-control-revoked.v1'
   AND revoked.actor_type='user' AND revoked.actor_user_id=source.actor_user_id AND revoked.actor_admin_id IS NULL
   AND revoked.subject_type='account_control' AND revoked.result_code='revoked'
   AND revoked.metadata_schema_version=1 AND revoked.metadata='{}'::jsonb
   AND revoked.request_id=revoked.command_id AND revoked.occurred_at>=source.occurred_at
   AND revoked.occurred_at<=clock_timestamp()) $$;
CREATE FUNCTION identity.guard_account_control() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source platform.audit_logs; epoch integer;
BEGIN
 IF NEW.event_type NOT IN('identity.account-control-issued.v1','identity.account-control-revoked.v1') THEN RETURN NEW; END IF;
 PERFORM id FROM identity.users WHERE id=NEW.actor_user_id FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=NEW.actor_user_id FOR UPDATE;
 IF NEW.event_type='identity.account-control-issued.v1' THEN
  -- Pure validation of NEW before it is visible to the lookup validator.
  IF NEW.category<>'security' OR NEW.actor_type<>'user' OR NEW.actor_user_id IS NULL OR NEW.actor_admin_id IS NOT NULL
   OR NEW.subject_type<>'account_control' OR NEW.subject_id<>NEW.id OR NEW.result_code<>'issued'
   OR NEW.metadata_schema_version<>1 OR NEW.command_id<>NEW.request_id
   OR (SELECT count(*) FROM jsonb_object_keys(NEW.metadata))<>2
   OR jsonb_typeof(NEW.metadata->'productEpoch') IS DISTINCT FROM 'number'
   OR jsonb_typeof(NEW.metadata->'expiresAt') IS DISTINCT FROM 'string'
   OR (NEW.metadata->>'productEpoch')::numeric<>trunc((NEW.metadata->>'productEpoch')::numeric)
   OR EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type=NEW.event_type AND actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id)
   OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=NEW.actor_user_id AND product_epoch::numeric=(NEW.metadata->>'productEpoch')::numeric)
   OR NEW.occurred_at<clock_timestamp()-interval '5 seconds' OR NEW.occurred_at>clock_timestamp()
   OR NOT isfinite(NEW.occurred_at)
   OR (NEW.metadata->>'expiresAt')::timestamptz<NEW.occurred_at+interval '1 second'
   OR (NEW.metadata->>'expiresAt')::timestamptz>NEW.occurred_at+interval '15 minutes'
   OR extract(epoch FROM (NEW.metadata->>'expiresAt')::timestamptz-NEW.occurred_at)<>trunc(extract(epoch FROM (NEW.metadata->>'expiresAt')::timestamptz-NEW.occurred_at))
   OR to_char((NEW.metadata->>'expiresAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>NEW.metadata->>'expiresAt' THEN
   RAISE EXCEPTION 'account control admission invalid' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO source FROM platform.audit_logs WHERE id=NEW.subject_id;
  epoch:=identity.account_control_epoch(source.id);
  IF epoch IS NULL OR NEW.category<>'security' OR NEW.actor_type<>'user' OR NEW.actor_user_id IS DISTINCT FROM source.actor_user_id
   OR NEW.actor_admin_id IS NOT NULL OR NEW.subject_type<>'account_control' OR NEW.result_code<>'revoked'
   OR NEW.metadata_schema_version<>1 OR NEW.metadata<>'{}'::jsonb OR NEW.command_id<>NEW.request_id
   OR NEW.occurred_at<source.occurred_at OR NEW.occurred_at<clock_timestamp()-interval '5 seconds' OR NEW.occurred_at>clock_timestamp()
   OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=source.actor_user_id AND product_epoch=epoch) THEN
   RAISE EXCEPTION 'account control revocation invalid' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_control_admission BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION identity.guard_account_control();
CREATE FUNCTION identity.require_account_control() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.event_type='identity.account-control-issued.v1' AND
  (identity.account_control_epoch(NEW.id) IS NULL OR NOT EXISTS(SELECT 1 FROM identity.accounts
    WHERE user_id=NEW.actor_user_id AND product_epoch=identity.account_control_epoch(NEW.id))
   OR (NEW.metadata->>'expiresAt')::timestamptz<=clock_timestamp()) THEN
  RAISE EXCEPTION 'account control commit fence invalid' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER account_control_commit AFTER INSERT ON platform.audit_logs DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION identity.require_account_control();

CREATE FUNCTION identity.account_control_current(source_id uuid,subject uuid,epoch integer) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM platform.audit_logs a JOIN identity.accounts owner ON owner.user_id=a.actor_user_id
  WHERE a.id=source_id AND a.actor_user_id=subject AND owner.product_epoch=epoch
   AND identity.account_control_epoch(a.id)=epoch AND NOT identity.account_control_authority_revoked(a.id)
   AND (a.metadata->>'expiresAt')::timestamptz>clock_timestamp()) $$;
CREATE FUNCTION identity.require_account_control_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof text:=current_setting('nakh.account_control_grant',true); source platform.audit_logs;
BEGIN
 IF proof IS NULL OR proof='' THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='accounts' THEN
  IF NEW.state<>'deleted' THEN RETURN NULL; END IF;
 END IF;
 SELECT * INTO source FROM platform.audit_logs WHERE id=proof::uuid;
 IF identity.account_control_current(source.id,NEW.user_id,identity.account_control_epoch(source.id)) IS NOT TRUE THEN
  RAISE EXCEPTION 'account control effect lacks current authority' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER account_control_account_effect AFTER UPDATE ON identity.accounts DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION identity.require_account_control_effect();
CREATE CONSTRAINT TRIGGER account_control_confirmation_effect AFTER INSERT OR UPDATE ON identity.deletion_confirmations DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION identity.require_account_control_effect();
CREATE CONSTRAINT TRIGGER account_control_command_effect AFTER INSERT ON identity.account_deletion_commands DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION identity.require_account_control_effect();

-- Retain only fully validated limited-grant facts as security proof. The expiry
-- applies to current authority, never to classification of an immutable past fact.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('platform.deletion_operational_blocker(uuid)'::regprocedure) INTO definition;
 IF position('AND (audit.metadata_schema_version<>1 OR' IN definition)=0 THEN
  RAISE EXCEPTION 'operational blocker shape changed' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,'AND (audit.metadata_schema_version<>1 OR',
  'AND NOT (audit.event_type=''identity.account-control-issued.v1'' AND identity.account_control_epoch(audit.id) IS NOT NULL) AND (audit.metadata_schema_version<>1 OR');
 EXECUTE definition;
END $$;
