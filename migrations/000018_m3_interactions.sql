CREATE SCHEMA IF NOT EXISTS interaction;

CREATE TABLE interaction.likes (
  id uuid PRIMARY KEY,
  sender_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  receiver_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('active','closed_by_match','closed_by_not_interested','closed_by_unmatch','cancelled_by_system')),
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (sender_user_id, receiver_user_id),
  CONSTRAINT like_not_self_ck CHECK (sender_user_id <> receiver_user_id),
  CONSTRAINT like_status_time_ck CHECK ((status = 'active') = (closed_at IS NULL))
);

CREATE INDEX likes_receiver_status_time_idx
  ON interaction.likes (receiver_user_id, status, created_at DESC, id);
CREATE INDEX likes_sender_status_idx
  ON interaction.likes (sender_user_id, status, id);

CREATE FUNCTION interaction.guard_like_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.sender_user_id <> OLD.sender_user_id
    OR NEW.receiver_user_id <> OLD.receiver_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'like identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = NEW.status THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'like state update requires a transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'active' AND NEW.status IN ('closed_by_match','closed_by_not_interested','closed_by_unmatch','cancelled_by_system'))
    OR (OLD.status = 'closed_by_match' AND NEW.status = 'closed_by_unmatch')
  ) THEN
    RAISE EXCEPTION 'invalid like transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'like transition must increment version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER likes_lifecycle_guard BEFORE UPDATE ON interaction.likes
FOR EACH ROW EXECUTE FUNCTION interaction.guard_like_lifecycle();

CREATE TABLE interaction.not_interested (
  id uuid PRIMARY KEY,
  sender_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  receiver_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('explore','liked_by','cancelled_pending_nakh')),
  created_at timestamptz NOT NULL,
  UNIQUE (sender_user_id, receiver_user_id),
  CONSTRAINT not_interested_not_self_ck CHECK (sender_user_id <> receiver_user_id)
);

CREATE INDEX not_interested_receiver_idx
  ON interaction.not_interested (receiver_user_id, created_at DESC, id);

CREATE FUNCTION interaction.reject_not_interested_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'not interested is immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER not_interested_immutable BEFORE UPDATE ON interaction.not_interested
FOR EACH ROW EXECUTE FUNCTION interaction.reject_not_interested_update();

CREATE TABLE interaction.user_pair_states (
  user_low_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  user_high_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('matched','unmatched','blocked')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  changed_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (user_low_id, user_high_id),
  CONSTRAINT user_pair_order_ck CHECK (user_low_id < user_high_id)
);

CREATE INDEX user_pair_states_high_idx
  ON interaction.user_pair_states (user_high_id, state, user_low_id);

CREATE FUNCTION interaction.guard_pair_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.state = 'unmatched' THEN
    RAISE EXCEPTION 'pair cannot begin unmatched' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_low_id <> OLD.user_low_id OR NEW.user_high_id <> OLD.user_high_id THEN
      RAISE EXCEPTION 'pair identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = NEW.state OR OLD.state = 'blocked'
      OR (NEW.state <> 'blocked' AND NOT (OLD.state = 'matched' AND NEW.state = 'unmatched')) THEN
      RAISE EXCEPTION 'invalid pair transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'pair transition must increment version' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER user_pair_state_guard BEFORE INSERT OR UPDATE ON interaction.user_pair_states
FOR EACH ROW EXECUTE FUNCTION interaction.guard_pair_state();
