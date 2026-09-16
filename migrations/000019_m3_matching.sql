CREATE SCHEMA IF NOT EXISTS matching;
CREATE SCHEMA IF NOT EXISTS chat;

CREATE TABLE matching.matches (
  id uuid PRIMARY KEY,
  user_low_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  user_high_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('mutual_like','nakh_accept')),
  source_like_a_id uuid REFERENCES interaction.likes(id) ON DELETE RESTRICT,
  source_like_b_id uuid REFERENCES interaction.likes(id) ON DELETE RESTRICT,
  source_nakh_id uuid,
  status text NOT NULL CHECK (status IN ('active','unmatched','closed')),
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (user_low_id, user_high_id),
  CONSTRAINT match_user_order_ck CHECK (user_low_id < user_high_id),
  CONSTRAINT match_source_shape_ck CHECK (
    (source = 'mutual_like' AND source_like_a_id IS NOT NULL AND source_like_b_id IS NOT NULL
      AND source_like_a_id <> source_like_b_id AND source_nakh_id IS NULL)
    OR (source = 'nakh_accept' AND source_like_a_id IS NULL AND source_like_b_id IS NULL
      AND source_nakh_id IS NOT NULL)
  ),
  CONSTRAINT match_status_time_ck CHECK ((status = 'active') = (closed_at IS NULL))
);

CREATE INDEX matches_low_status_idx ON matching.matches (user_low_id, status, id);
CREATE INDEX matches_high_status_idx ON matching.matches (user_high_id, status, id);

CREATE TABLE matching.match_participants (
  match_id uuid NOT NULL REFERENCES matching.matches(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  joined_at timestamptz NOT NULL,
  PRIMARY KEY (match_id, user_id)
);

CREATE FUNCTION matching.require_exact_participants() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checked_match_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'matches' THEN
    checked_match_id := NEW.id;
  ELSE
    checked_match_id := COALESCE(NEW.match_id, OLD.match_id);
  END IF;
  IF EXISTS (SELECT 1 FROM matching.matches WHERE id = checked_match_id)
    AND NOT EXISTS (
      SELECT 1 FROM matching.matches match
      WHERE match.id = checked_match_id
        AND (SELECT count(*) FROM matching.match_participants participant WHERE participant.match_id = match.id) = 2
        AND EXISTS (SELECT 1 FROM matching.match_participants WHERE match_id = match.id AND user_id = match.user_low_id)
        AND EXISTS (SELECT 1 FROM matching.match_participants WHERE match_id = match.id AND user_id = match.user_high_id)
    ) THEN
    RAISE EXCEPTION 'match requires exactly its normalized participants' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER match_requires_participants
AFTER INSERT OR UPDATE ON matching.matches DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION matching.require_exact_participants();
CREATE CONSTRAINT TRIGGER match_participants_exact
AFTER INSERT OR UPDATE OR DELETE ON matching.match_participants DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION matching.require_exact_participants();

CREATE TABLE chat.chat_sessions (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL UNIQUE REFERENCES matching.matches(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('active','closed')),
  next_sequence_number bigint NOT NULL DEFAULT 1 CHECK (next_sequence_number >= 1),
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_reason text CHECK (closed_reason IS NULL OR closed_reason IN ('unmatch','account_deleted','user_banned','admin_action','internal_block')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT chat_session_state_ck CHECK (
    (status = 'active' AND closed_at IS NULL AND closed_reason IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL AND closed_reason IS NOT NULL)
  )
);

CREATE TABLE chat.chat_participants (
  chat_session_id uuid NOT NULL REFERENCES chat.chat_sessions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  last_read_at timestamptz,
  muted_at timestamptz,
  unlock_safety_warning_shown_at timestamptz,
  PRIMARY KEY (chat_session_id, user_id)
);

CREATE FUNCTION chat.require_exact_participants() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checked_session_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'chat_sessions' THEN
    checked_session_id := NEW.id;
  ELSE
    checked_session_id := COALESCE(NEW.chat_session_id, OLD.chat_session_id);
  END IF;
  IF EXISTS (SELECT 1 FROM chat.chat_sessions WHERE id = checked_session_id)
    AND NOT EXISTS (
      SELECT 1 FROM chat.chat_sessions session
      JOIN matching.matches match ON match.id = session.match_id
      WHERE session.id = checked_session_id
        AND (SELECT count(*) FROM chat.chat_participants participant WHERE participant.chat_session_id = session.id) = 2
        AND EXISTS (SELECT 1 FROM chat.chat_participants WHERE chat_session_id = session.id AND user_id = match.user_low_id)
        AND EXISTS (SELECT 1 FROM chat.chat_participants WHERE chat_session_id = session.id AND user_id = match.user_high_id)
    ) THEN
    RAISE EXCEPTION 'chat requires exactly the match participants' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER chat_requires_participants
AFTER INSERT OR UPDATE ON chat.chat_sessions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION chat.require_exact_participants();
CREATE CONSTRAINT TRIGGER chat_participants_exact
AFTER INSERT OR UPDATE OR DELETE ON chat.chat_participants DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION chat.require_exact_participants();

CREATE FUNCTION matching.guard_match_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_low_id <> OLD.user_low_id OR NEW.user_high_id <> OLD.user_high_id
    OR NEW.source <> OLD.source OR NEW.source_like_a_id IS DISTINCT FROM OLD.source_like_a_id
    OR NEW.source_like_b_id IS DISTINCT FROM OLD.source_like_b_id
    OR NEW.source_nakh_id IS DISTINCT FROM OLD.source_nakh_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'match identity and source are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'active' OR NEW.status NOT IN ('unmatched','closed')
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid match transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER matches_lifecycle_guard BEFORE UPDATE ON matching.matches
FOR EACH ROW EXECUTE FUNCTION matching.guard_match_lifecycle();

CREATE FUNCTION chat.guard_session_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.match_id <> OLD.match_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'chat session identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'closed' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'closed chat session is terminal' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'active' THEN
    IF NEW.next_sequence_number <= OLD.next_sequence_number OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'active chat update must advance sequence and version' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'active' AND NEW.status = 'closed' THEN
    IF NEW.next_sequence_number <> OLD.next_sequence_number OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'chat closure must increment version' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'invalid chat transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER chat_session_lifecycle_guard BEFORE UPDATE ON chat.chat_sessions
FOR EACH ROW EXECUTE FUNCTION chat.guard_session_lifecycle();

COMMENT ON COLUMN matching.matches.source_nakh_id IS
  'M5 adds the deferred foreign key when the canonical Nakh table is introduced.';
