-- The canonical pair target uses only its UUID inputs and pure built-in byte/hash
-- operations. It reads no tables or backend-local state and changes no state.
-- Keep its body, volatility, strictness and invoker authority unchanged while
-- allowing read-only integrity queries to consider parallel plans.
ALTER FUNCTION moderation.admin_pair_target_id(uuid, uuid) PARALLEL SAFE;
