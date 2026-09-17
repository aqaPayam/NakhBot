-- Candidate-query support added after the initial M3 tables. Applied migrations remain immutable.
CREATE INDEX profiles_complete_global_shuffle_idx
  ON profile.profiles (random_shuffle_key, id)
  WHERE completion_status = 'complete';

CREATE FUNCTION interaction.lock_user_pair(left_user_id uuid, right_user_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  low_id uuid;
  high_id uuid;
  pair_bytes bytea;
BEGIN
  IF left_user_id = right_user_id THEN
    RAISE EXCEPTION 'user pair must contain two users' USING ERRCODE = '22023';
  END IF;
  low_id := LEAST(left_user_id, right_user_id);
  high_id := GREATEST(left_user_id, right_user_id);
  pair_bytes := uuid_send(low_id) || uuid_send(high_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(encode(pair_bytes, 'hex'), 0));
END
$$;

COMMENT ON FUNCTION interaction.lock_user_pair(uuid, uuid) IS
  'Canonical transaction-scoped pair lock shared by interaction and discovery writers.';
