DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index index_row
    JOIN pg_class index_table ON index_table.oid = index_row.indexrelid
    JOIN pg_namespace namespace ON namespace.oid = index_table.relnamespace
    WHERE namespace.nspname = 'identity'
      AND index_table.relname = 'account_history_moderation_actor_idx'
      AND index_row.indrelid = 'identity.account_state_history'::regclass
      AND index_row.indisvalid AND index_row.indisready AND NOT index_row.indisunique
      AND index_row.indpred IS NULL
      AND pg_get_indexdef(index_row.indexrelid) LIKE
        '%(user_id, actor_admin_id, actor_type, reason_code, changed_at, next_state)%'
  ) THEN
    RAISE EXCEPTION 'moderation actor-bound account history index is missing or invalid';
  END IF;
END $$;
