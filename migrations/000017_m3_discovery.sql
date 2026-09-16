CREATE SCHEMA IF NOT EXISTS discovery;

CREATE TABLE discovery.explore_filters (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE RESTRICT,
  min_age integer NOT NULL CHECK (min_age BETWEEN 18 AND 120),
  max_age integer NOT NULL CHECK (max_age BETWEEN 18 AND 120),
  city_id uuid NOT NULL REFERENCES catalog.cities(id) ON DELETE RESTRICT,
  relationship_goal_id uuid REFERENCES catalog.relationship_goals(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT explore_filter_age_order_ck CHECK (min_age <= max_age)
);

CREATE INDEX explore_filters_city_age_idx
  ON discovery.explore_filters (city_id, min_age, max_age, user_id);

CREATE TABLE discovery.explore_filter_genders (
  user_id uuid NOT NULL REFERENCES discovery.explore_filters(user_id) ON DELETE CASCADE,
  gender_option_id uuid NOT NULL REFERENCES catalog.gender_options(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, gender_option_id)
);

CREATE FUNCTION discovery.require_filter_gender() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checked_user_id uuid := COALESCE(NEW.user_id, OLD.user_id);
BEGIN
  IF EXISTS (SELECT 1 FROM discovery.explore_filters WHERE user_id = checked_user_id)
    AND NOT EXISTS (
      SELECT 1 FROM discovery.explore_filter_genders WHERE user_id = checked_user_id
    ) THEN
    RAISE EXCEPTION 'explore filter requires at least one gender' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER explore_filter_gender_required
AFTER INSERT OR UPDATE OR DELETE ON discovery.explore_filter_genders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION discovery.require_filter_gender();

CREATE CONSTRAINT TRIGGER explore_filter_requires_gender
AFTER INSERT OR UPDATE ON discovery.explore_filters
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION discovery.require_filter_gender();

CREATE TABLE discovery.explore_consumptions (
  viewer_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  target_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (reason IN ('preview','like','not_interested','nakh_flow','match')),
  consumed_at timestamptz NOT NULL,
  PRIMARY KEY (viewer_user_id, target_user_id),
  CONSTRAINT explore_consumption_not_self_ck CHECK (viewer_user_id <> target_user_id)
);

CREATE INDEX explore_consumptions_viewer_time_idx
  ON discovery.explore_consumptions (viewer_user_id, consumed_at DESC, target_user_id);

CREATE FUNCTION discovery.reject_consumption_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'explore consumption is immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER explore_consumption_immutable
BEFORE UPDATE ON discovery.explore_consumptions
FOR EACH ROW EXECUTE FUNCTION discovery.reject_consumption_update();

CREATE TABLE discovery.candidate_deliveries (
  id uuid PRIMARY KEY,
  viewer_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  target_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('explore','guest_preview')),
  filter_version integer NOT NULL CHECK (filter_version >= 1),
  state text NOT NULL CHECK (state IN ('reserved','delivered','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  expires_at timestamptz NOT NULL,
  provider_message_id bigint,
  reserved_at timestamptz NOT NULL,
  delivered_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT candidate_delivery_not_self_ck CHECK (viewer_user_id <> target_user_id),
  CONSTRAINT candidate_delivery_expiry_ck CHECK (expires_at > reserved_at),
  CONSTRAINT candidate_delivery_state_ck CHECK (
    (state = 'reserved' AND delivered_at IS NULL AND failed_at IS NULL AND provider_message_id IS NULL)
    OR (state = 'delivered' AND delivered_at IS NOT NULL AND failed_at IS NULL AND provider_message_id IS NOT NULL)
    OR (state = 'failed' AND delivered_at IS NULL AND failed_at IS NOT NULL AND provider_message_id IS NULL)
  )
);

CREATE UNIQUE INDEX candidate_deliveries_one_live_viewer_idx
  ON discovery.candidate_deliveries (viewer_user_id) WHERE state = 'reserved';
CREATE INDEX candidate_deliveries_expiry_idx
  ON discovery.candidate_deliveries (expires_at, id) WHERE state = 'reserved';
CREATE INDEX candidate_deliveries_target_idx
  ON discovery.candidate_deliveries (viewer_user_id, target_user_id, state);

CREATE FUNCTION discovery.guard_candidate_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.viewer_user_id <> OLD.viewer_user_id
      OR NEW.target_user_id <> OLD.target_user_id OR NEW.mode <> OLD.mode
      OR NEW.filter_version <> OLD.filter_version OR NEW.reserved_at <> OLD.reserved_at
      OR NEW.expires_at <> OLD.expires_at THEN
      RAISE EXCEPTION 'candidate delivery identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state <> 'reserved' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'candidate delivery terminal state is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER candidate_delivery_guard
BEFORE UPDATE ON discovery.candidate_deliveries
FOR EACH ROW EXECUTE FUNCTION discovery.guard_candidate_delivery();

COMMENT ON TABLE discovery.candidate_deliveries IS
  'Durable pre-provider reservation. Profile prose, Telegram identities, media keys, and raw callback state are prohibited.';
