-- Original-life source membership, not authority to release retained data.
-- No approved period, row contents, key roster or retrospective ownership guess.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='account.retained-source-recorded.v1') THEN
  RAISE EXCEPTION 'legacy retained source lacks provenance' USING ERRCODE='55000'; END IF;
END $$;
CREATE UNIQUE INDEX retained_source_membership_idx ON platform.audit_logs(subject_id,(metadata->>'resource'),(metadata->>'rowKeyHash'))
 WHERE event_type='account.retained-source-recorded.v1';

-- SQL identifiers/predicates come only from the reviewed manifest descriptor and
-- the real primary key. The exact catalog still has to match the migration.
CREATE FUNCTION identity.retained_source_expressions(resource text) RETURNS TABLE(relation_name text,predicate text,key_expression text)
LANGUAGE plpgsql STABLE AS $$
DECLARE descriptor jsonb; key_parts text;
BEGIN
 SELECT value INTO descriptor FROM jsonb_array_elements(identity.retention_descriptors())
  WHERE value->>'table'=resource AND value->>'action'='approved_policy_release';
 IF descriptor IS NULL OR descriptor->>'subjectScope' IS NULL THEN
  RAISE EXCEPTION 'retained source unavailable' USING ERRCODE='23514'; END IF;
 SELECT string_agg('row.'||quote_ident(a.attname),',' ORDER BY key.ordinality) INTO key_parts
 FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum,ordinality)
 JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum
 WHERE i.indrelid=(descriptor->>'table')::regclass AND i.indisprimary AND i.indisvalid AND key.ordinality<=i.indnkeyatts;
 IF key_parts IS NULL THEN RAISE EXCEPTION 'retained source primary key unavailable' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT descriptor->>'table',replace(descriptor->>'subjectScope',':userId','$1'),
  'encode(sha256(convert_to(jsonb_build_array('||key_parts||')::text,''UTF8'')),''hex'')';
END $$;

CREATE FUNCTION identity.retained_source_candidates(root_id uuid,resource text,batch_size integer)
RETURNS TABLE(row_key_hash text,row_hash text) LANGUAGE plpgsql VOLATILE SET TimeZone='UTC' AS $$
DECLARE root identity.account_deletion_records; expressions record;
BEGIN
 -- A bounded, content-free candidate read is not capture authority. The batch
 -- and both source-audit guards independently require the complete catalog.
 IF batch_size IS NULL OR batch_size<1 OR batch_size>10 THEN
  RAISE EXCEPTION 'retained source batch unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=root_id;
 IF root.id IS NULL OR root.phase<>'retention_manifest' OR root.checkpoint_version<>6 OR root.completed_at IS NOT NULL THEN
  RAISE EXCEPTION 'retained source capture unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO expressions FROM identity.retained_source_expressions(resource);
 -- JSON timestamp rendering must be independent of the caller's session zone.
 RETURN QUERY EXECUTE 'SELECT '||expressions.key_expression||',encode(sha256(convert_to(to_jsonb(row)::text,''UTF8'')),''hex'')
  FROM '||expressions.relation_name||' AS row WHERE ('||expressions.predicate||') AND NOT EXISTS(
   SELECT 1 FROM platform.audit_logs a WHERE a.subject_id=$2 AND a.event_type=''account.retained-source-recorded.v1''
    AND a.metadata->>''resource''=$3 AND a.metadata->>''rowKeyHash''='||expressions.key_expression||')
  ORDER BY '||expressions.key_expression||' LIMIT $4' USING root.user_id,root.id,resource,batch_size;
END $$;

CREATE FUNCTION identity.retained_source_matches(root_id uuid,resource text,key_hash text,source_hash text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET TimeZone='UTC' AS $$
DECLARE subject uuid; expressions record; matches boolean;
BEGIN
 IF key_hash IS NULL OR key_hash!~'^[0-9a-f]{64}$' OR source_hash IS NULL OR source_hash!~'^[0-9a-f]{64}$'
  OR identity.retention_catalog_valid() IS NOT TRUE THEN RETURN false; END IF;
 SELECT user_id INTO subject FROM identity.account_deletion_records WHERE id=root_id;
 IF subject IS NULL THEN RETURN false; END IF;
 SELECT * INTO expressions FROM identity.retained_source_expressions(resource);
 EXECUTE 'SELECT EXISTS(SELECT 1 FROM '||expressions.relation_name||' AS row WHERE ('||expressions.predicate||')
  AND '||expressions.key_expression||'=$2 AND encode(sha256(convert_to(to_jsonb(row)::text,''UTF8'')),''hex'')=$3)'
 INTO matches USING subject,key_hash,source_hash;
 RETURN matches;
END $$;

CREATE FUNCTION identity.retained_source_proof_valid(a platform.audit_logs,live boolean) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE root identity.account_deletion_records; manifest identity.data_retention_records; job identity.account_deletion_work;
BEGIN
 IF a.category<>'account' OR a.event_type<>'account.retained-source-recorded.v1' OR a.actor_type<>'system'
  OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NOT NULL OR a.subject_type<>'account_deletion'
  OR a.result_code<>'retained_source_recorded' OR a.metadata_schema_version<>1 OR jsonb_typeof(a.metadata)<>'object'
  OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>9
  OR jsonb_typeof(a.metadata->'retentionRecordId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'resource') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'registryHash') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'rowKeyHash') IS DISTINCT FROM 'string' OR a.metadata->>'rowKeyHash'!~'^[0-9a-f]{64}$'
  OR jsonb_typeof(a.metadata->'rowHash') IS DISTINCT FROM 'string' OR a.metadata->>'rowHash'!~'^[0-9a-f]{64}$'
  OR jsonb_typeof(a.metadata->'leaseOwner') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'leaseGeneration') IS DISTINCT FROM 'number' OR a.metadata->>'leaseGeneration'!~'^[1-9][0-9]{0,9}$'
  OR jsonb_typeof(a.metadata->'leaseExpiresAtEpoch') IS DISTINCT FROM 'number'
  OR jsonb_typeof(a.metadata->'transactionId') IS DISTINCT FROM 'string' OR a.metadata->>'transactionId'!~'^[1-9][0-9]{0,19}$'
  THEN RETURN false; END IF;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=a.subject_id;
 SELECT * INTO manifest FROM identity.data_retention_records WHERE id=(a.metadata->>'retentionRecordId')::uuid;
 IF root.id IS NULL OR manifest.id IS NULL OR manifest.deletion_record_id<>root.id OR manifest.user_id<>root.user_id
  OR manifest.retained_data_type<>a.metadata->>'resource' OR manifest.disposition<>'approved_policy_release'
  OR manifest.registry_hash<>a.metadata->>'registryHash' OR identity.retention_record_valid(manifest) IS NOT TRUE
  OR a.command_id IS DISTINCT FROM root.command_id OR a.request_id IS DISTINCT FROM root.request_id OR a.occurred_at<manifest.created_at
  OR NOT isfinite(a.occurred_at) OR a.occurred_at>clock_timestamp()
  OR a.occurred_at>=to_timestamp((a.metadata->>'leaseExpiresAtEpoch')::double precision)
  OR (a.metadata->>'leaseOwner')::uuid IS NULL OR (a.metadata->>'leaseGeneration')::integer<1 THEN RETURN false; END IF;
 IF live THEN
  SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=root.id;
  IF root.phase<>'retention_manifest' OR root.checkpoint_version<>6 OR root.completed_at IS NOT NULL
   OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version
   OR job.lease_owner IS DISTINCT FROM (a.metadata->>'leaseOwner')::uuid
   OR job.lease_generation IS DISTINCT FROM (a.metadata->>'leaseGeneration')::integer
   OR job.lease_expires_at IS NULL OR extract(epoch FROM job.lease_expires_at) IS DISTINCT FROM (a.metadata->>'leaseExpiresAtEpoch')::numeric
   OR job.lease_expires_at<=clock_timestamp() OR (a.metadata->>'transactionId')::xid8<>pg_current_xact_id()
   OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=root.user_id AND state='deleted'
    AND version=root.account_version AND product_epoch=root.product_epoch)
   OR identity.retained_source_matches(root.id,manifest.retained_data_type,a.metadata->>'rowKeyHash',a.metadata->>'rowHash') IS NOT TRUE
   THEN RETURN false; END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION identity.guard_retained_source_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid; a platform.audit_logs;
BEGIN
 IF NEW.event_type<>'account.retained-source-recorded.v1' THEN RETURN NEW; END IF;
 SELECT user_id INTO subject FROM identity.account_deletion_records WHERE id=NEW.subject_id;
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 PERFORM id FROM identity.account_deletion_records WHERE id=NEW.subject_id FOR UPDATE;
 PERFORM deletion_record_id FROM identity.account_deletion_work WHERE deletion_record_id=NEW.subject_id FOR UPDATE;
 IF TG_WHEN='AFTER' THEN SELECT * INTO a FROM platform.audit_logs WHERE id=NEW.id; ELSE a:=NEW; END IF;
 IF identity.retained_source_proof_valid(a,true) IS NOT TRUE THEN
  RAISE EXCEPTION 'retained source proof incomplete' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retained_source_proof_guard BEFORE INSERT ON platform.audit_logs
 FOR EACH ROW EXECUTE FUNCTION identity.guard_retained_source_proof();
CREATE CONSTRAINT TRIGGER retained_source_proof_commit AFTER INSERT ON platform.audit_logs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.guard_retained_source_proof();

CREATE FUNCTION identity.record_retained_source_batch(root_id uuid,subject uuid,worker uuid,generation integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work; manifest identity.data_retention_records;
 source record; written integer:=0; affected integer; at timestamptz; checked boolean;
BEGIN
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=root_id AND user_id=subject FOR UPDATE;
 SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=root_id FOR UPDATE;
 IF root.id IS NULL OR root.phase<>'retention_manifest' OR root.checkpoint_version<>6 OR root.completed_at IS NOT NULL
  OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version OR job.lease_owner IS DISTINCT FROM worker
  OR job.lease_generation IS DISTINCT FROM generation OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=subject AND state='deleted' AND version=root.account_version AND product_epoch=root.product_epoch) THEN
  RAISE EXCEPTION 'retained source capture unavailable' USING ERRCODE='40001'; END IF;
 FOR manifest IN SELECT * FROM identity.data_retention_records WHERE deletion_record_id=root_id AND disposition='approved_policy_release' ORDER BY retained_data_type LOOP
  checked:=false;
  FOR source IN SELECT * FROM identity.retained_source_candidates(root_id,manifest.retained_data_type,10-written) LOOP
   -- Empty replay is a read, not capture. Every writing batch still checks the
   -- complete catalog before its first write, as do both independent guards.
   IF written=0 AND identity.retention_catalog_valid() IS NOT TRUE THEN
    RAISE EXCEPTION 'retained source catalog invalid' USING ERRCODE='23514'; END IF;
   IF NOT checked THEN
    IF identity.retention_record_valid(manifest) IS NOT TRUE THEN RAISE EXCEPTION 'retained source manifest invalid' USING ERRCODE='23514'; END IF;
    checked:=true;
   END IF;
   at:=clock_timestamp();
   INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
   VALUES(gen_random_uuid(),'account','account.retained-source-recorded.v1','system',NULL,NULL,'account_deletion',root.id,'retained_source_recorded',1,
    jsonb_build_object('retentionRecordId',manifest.id,'resource',manifest.retained_data_type,'registryHash',manifest.registry_hash,
     'rowKeyHash',source.row_key_hash,'rowHash',source.row_hash,'leaseOwner',worker,'leaseGeneration',generation,
     'leaseExpiresAtEpoch',extract(epoch FROM job.lease_expires_at),'transactionId',pg_current_xact_id()::text),root.command_id,root.request_id,at);
   GET DIAGNOSTICS affected=ROW_COUNT; IF affected<>1 THEN RAISE EXCEPTION 'retained source audit missing' USING ERRCODE='23514'; END IF;
   written:=written+1;
  END LOOP;
  IF written=10 THEN EXIT; END IF;
 END LOOP;
 RETURN written;
END $$;

DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('identity.record_retention_batch(uuid,uuid,uuid,integer)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'identity.record_retention_batch(', 'identity.record_retention_manifest_batch(');
END $$;
CREATE OR REPLACE FUNCTION identity.record_retention_batch(root_id uuid,subject uuid,worker uuid,generation integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE manifests integer; sources integer;
BEGIN
 manifests:=identity.record_retention_manifest_batch(root_id,subject,worker,generation);
 -- First finish the bounded descriptor inventory. Repeatedly sweeping source
 -- relations while that inventory is incomplete adds no membership progress.
 IF manifests>0 THEN RETURN manifests; END IF;
 sources:=identity.record_retained_source_batch(root_id,subject,worker,generation);
 RETURN greatest(manifests,CASE WHEN sources>0 THEN 1 ELSE 0 END);
END $$;

DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('identity.deletion_retention_blocker(uuid,uuid)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'identity.deletion_retention_blocker(', 'identity.deletion_retention_manifest_blocker(');
END $$;
CREATE OR REPLACE FUNCTION identity.deletion_retention_blocker(root_id uuid,subject uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE blocker text; manifest identity.data_retention_records;
BEGIN
 blocker:=identity.deletion_retention_manifest_blocker(root_id,subject);
 IF blocker IS NOT NULL THEN RETURN blocker; END IF;
 -- Never backfill ownership from a later life or rewrite an existing completed
 -- Root. Only the owning phase-6 worker can acquire source membership.
 IF EXISTS(SELECT 1 FROM identity.account_deletion_records WHERE id=root_id AND user_id=subject AND phase='retention_manifest') THEN
  FOR manifest IN SELECT * FROM identity.data_retention_records WHERE deletion_record_id=root_id AND disposition='approved_policy_release' LOOP
   IF EXISTS(SELECT 1 FROM identity.retained_source_candidates(root_id,manifest.retained_data_type,1)) THEN RETURN 'retained_sources'; END IF;
  END LOOP;
 END IF;
 IF EXISTS(SELECT 1 FROM platform.audit_logs a WHERE a.subject_id=root_id AND a.event_type='account.retained-source-recorded.v1'
  AND identity.retained_source_proof_valid(a,false) IS NOT TRUE) THEN RETURN 'retained_sources'; END IF;
 RETURN NULL;
END $$;

DO $$ DECLARE definition text; owner_scope text; BEGIN
 SELECT pg_get_functiondef('platform.deletion_operational_blocker(uuid)'::regprocedure) INTO definition;
 IF position('AND NOT (' IN definition)=0 THEN RAISE EXCEPTION 'operational blocker shape changed'; END IF;
 definition:=replace(definition,'AND NOT (',
  'AND NOT ((audit.event_type=''account.retained-source-recorded.v1'' AND identity.retained_source_proof_valid(audit,false)) OR ');
 owner_scope:=$scope$EXISTS(SELECT 1 FROM platform.audit_logs audit WHERE (audit.actor_user_id=subject
    OR (audit.subject_type IN('user','account') AND audit.subject_id=subject)
    OR EXISTS(SELECT 1 FROM platform.deletion_original_subjects original
      WHERE original.user_id=subject AND original.resource=audit.subject_type AND original.source_id=audit.subject_id))$scope$;
 IF length(definition)-length(replace(definition,owner_scope,''))<>length(owner_scope) THEN
  RAISE EXCEPTION 'operational audit ownership shape changed' USING ERRCODE='55000'; END IF;
 -- Preserve the complete owner predicate and every proof/metadata condition.
 -- Otherwise the planner can run costly proof functions for foreign Roots
 -- before evaluating the correlated original-subject ownership subplan.
 definition:=replace(definition,owner_scope,
  replace(owner_scope,'EXISTS(SELECT 1 FROM platform.audit_logs audit WHERE (',
   'EXISTS(WITH retention_owned_audits AS MATERIALIZED (SELECT audit.* FROM platform.audit_logs audit WHERE (')
   ||') SELECT 1 FROM retention_owned_audits audit WHERE true');
 EXECUTE definition;
END $$;
