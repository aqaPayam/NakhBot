CREATE INDEX nakh_flows_direction_lookup_idx
  ON nakh.nakh_flows (sender_user_id, receiver_user_id)
  INCLUDE (id);

COMMENT ON INDEX nakh.nakh_flows_direction_lookup_idx IS
  'Covering index for permanent directional-flow existence and replay lookups.';
