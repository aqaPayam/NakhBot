CREATE INDEX nakh_flows_direction_ordered_idx
  ON nakh.nakh_flows (sender_user_id, receiver_user_id, id);

COMMENT ON INDEX nakh.nakh_flows_direction_ordered_idx IS
  'Bounded ordered access path for deterministic directional-flow existence and replay lookups.';
