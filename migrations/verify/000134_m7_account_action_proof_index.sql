DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_index definition
    JOIN pg_class index_table ON index_table.oid=definition.indexrelid
    JOIN pg_am method ON method.oid=index_table.relam
    WHERE definition.indrelid='administration.admin_action_logs'::regclass
      AND index_table.relname='admin_action_logs_account_proof_idx'
      AND definition.indisvalid AND definition.indisready
      AND method.amname='btree'
      AND NOT definition.indisunique AND definition.indnkeyatts=2 AND definition.indnatts=5
      AND pg_get_indexdef(definition.indexrelid) LIKE '%(admin_user_id, command_id) INCLUDE (request_id, request_digest, target_id)%'
      AND pg_get_expr(definition.indpred,definition.indrelid)=
        '((result = ''succeeded''::text) AND (command_code = ''moderation.apply-account-action''::text) AND (target_type = ''user''::text))') THEN
    RAISE EXCEPTION 'exact account-action proof covering index missing';
  END IF;
END $$;
