DO $$
DECLARE definition pg_catalog.pg_proc; signature text;
BEGIN
 FOR signature IN SELECT unnest(ARRAY['administration.lock_runtime_admin_permission(uuid,text)', 'moderation.lock_runtime_report_reason(text)']) LOOP
  SELECT * INTO definition FROM pg_catalog.pg_proc
    WHERE oid=pg_catalog.to_regprocedure(signature);
  IF NOT FOUND OR NOT definition.prosecdef OR definition.provolatile<>'v'
    OR NOT definition.proretset OR definition.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
    OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(definition.proacl,
      pg_catalog.acldefault('f',definition.proowner))) permission
      WHERE permission.grantee=0 AND permission.privilege_type='EXECUTE') THEN
    RAISE EXCEPTION 'runtime permission lock capability is not protected';
  END IF;
 END LOOP;
END $$;
