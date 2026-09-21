CREATE SCHEMA IF NOT EXISTS nakh;

CREATE TABLE platform.user_counters (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE RESTRICT,
  pending_nakh_count integer NOT NULL DEFAULT 0 CHECK (pending_nakh_count BETWEEN 0 AND 5),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

INSERT INTO platform.user_counters (user_id)
SELECT id FROM identity.users
ON CONFLICT (user_id) DO NOTHING;

CREATE FUNCTION platform.create_user_counter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform.user_counters (user_id, updated_at)
  VALUES (NEW.id, transaction_timestamp());
  RETURN NEW;
END $$;

CREATE TRIGGER users_create_counter
AFTER INSERT ON identity.users
FOR EACH ROW EXECUTE FUNCTION platform.create_user_counter();

CREATE FUNCTION platform.guard_user_counter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'user counter identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'user counter update must advance version and time' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER user_counters_guard
BEFORE UPDATE ON platform.user_counters
FOR EACH ROW EXECUTE FUNCTION platform.guard_user_counter();

CREATE TABLE nakh.nakh_flows (
  id uuid PRIMARY KEY,
  sender_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  receiver_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (sender_user_id, receiver_user_id),
  UNIQUE (id, sender_user_id),
  CONSTRAINT nakh_flow_not_self_ck CHECK (sender_user_id <> receiver_user_id)
);

CREATE INDEX nakh_flows_receiver_time_idx
  ON nakh.nakh_flows (receiver_user_id, created_at DESC, id DESC);

CREATE FUNCTION nakh.reject_nakh_flow_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Nakh flow is permanent and immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER nakh_flows_immutable
BEFORE UPDATE OR DELETE ON nakh.nakh_flows
FOR EACH ROW EXECUTE FUNCTION nakh.reject_nakh_flow_mutation();

COMMENT ON TABLE nakh.nakh_flows IS
  'Permanent account-lifetime directional uniqueness for Nakh; ordinary lifecycle completion never deletes this row.';
COMMENT ON TABLE platform.user_counters IS
  'Transactionally locked per-user counters; pending_nakh_count is reconciled against live pending Nakh rows.';
