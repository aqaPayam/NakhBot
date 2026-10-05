DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index index_row
    JOIN pg_class index_table ON index_table.oid = index_row.indexrelid
    JOIN pg_namespace namespace ON namespace.oid = index_table.relnamespace
    WHERE namespace.nspname = 'moderation'
      AND index_table.relname = 'moderation_actions_episode_resolution_idx'
      AND index_row.indrelid = 'moderation.moderation_actions'::regclass
      AND index_row.indisvalid AND index_row.indisready AND NOT index_row.indisunique
      AND index_row.indnkeyatts = 1 AND index_row.indnatts = 8
      AND pg_get_indexdef(index_row.indexrelid) LIKE
        '%(restriction_episode_id) INCLUDE (actor_admin_id, target_user_id, reason_code, occurred_at, command_id, request_id, request_digest)%'
      AND pg_get_expr(index_row.indpred,index_row.indrelid) =
        '((restriction_episode_id IS NOT NULL) AND (actor_type = ''admin''::text) AND (action_type = ''unrestrict_user''::text))'
  ) THEN
    RAISE EXCEPTION 'moderation episode-bound resolution index is missing or invalid';
  END IF;
END $$;
