DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index index_row
    JOIN pg_class index_table ON index_table.oid = index_row.indexrelid
    JOIN pg_namespace namespace ON namespace.oid = index_table.relnamespace
    JOIN pg_am access_method ON access_method.oid = index_table.relam
    WHERE namespace.nspname = 'identity'
      AND index_table.relname = 'account_history_restoration_state_idx'
      AND index_row.indrelid = 'identity.account_state_history'::regclass
      AND access_method.amname = 'btree'
      AND index_row.indisvalid AND index_row.indisready AND NOT index_row.indisunique
      AND index_row.indnkeyatts = 4 AND index_row.indnatts = 5
      AND index_row.indpred IS NULL AND index_row.indexprs IS NULL
      AND pg_get_indexdef(index_row.indexrelid) LIKE
        '%(user_id, next_state, changed_at DESC, id DESC) INCLUDE (previous_state)%'
  ) THEN
    RAISE EXCEPTION 'account restoration state history index is missing or invalid';
  END IF;
END $$;
