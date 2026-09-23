CREATE STATISTICS nakh.nakh_flows_direction_stats (ndistinct, dependencies)
  ON sender_user_id, receiver_user_id
  FROM nakh.nakh_flows;

COMMENT ON STATISTICS nakh.nakh_flows_direction_stats IS
  'Teaches PostgreSQL that an exact directional NakhFlow pair is selective even for high-volume senders and receivers.';
