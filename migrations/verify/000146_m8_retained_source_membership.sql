DO $$ DECLARE descriptor jsonb; expressions record; BEGIN
 IF to_regclass('platform.retained_source_membership_idx') IS NULL
  OR to_regprocedure('identity.record_retained_source_batch(uuid,uuid,uuid,integer)') IS NULL
  OR to_regprocedure('identity.retained_source_proof_valid(platform.audit_logs,boolean)') IS NULL
  OR identity.retention_catalog_valid() IS NOT TRUE THEN RAISE EXCEPTION 'M8 retained source controls incomplete'; END IF;
 FOR descriptor IN SELECT value FROM jsonb_array_elements(identity.retention_descriptors()) WHERE value->>'action'='approved_policy_release' LOOP
  SELECT * INTO expressions FROM identity.retained_source_expressions(descriptor->>'table');
  IF expressions.key_expression IS NULL OR expressions.predicate IS NULL THEN RAISE EXCEPTION 'retained source descriptor incomplete'; END IF;
 END LOOP;
END $$;
