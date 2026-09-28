-- Preserve existing appeals; replay identities apply to newly admitted submissions only.
CREATE TABLE moderation.appeal_submissions (
  appeal_id uuid PRIMARY KEY REFERENCES moderation.user_appeals(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  UNIQUE (user_id, command_id),
  UNIQUE (user_id, idempotency_key)
);
CREATE TRIGGER appeal_submissions_immutable
BEFORE UPDATE OR DELETE ON moderation.appeal_submissions
FOR EACH ROW EXECUTE FUNCTION support.reject_message_mutation();

CREATE FUNCTION moderation.guard_appeal_ban() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_state text; account_changed_at timestamptz;
BEGIN
  SELECT state, state_changed_at INTO account_state, account_changed_at
    FROM identity.accounts WHERE user_id = NEW.user_id FOR UPDATE;
  IF account_state IS DISTINCT FROM 'banned' OR NEW.ban_state_history_id IS DISTINCT FROM (
    SELECT id FROM identity.account_state_history
    WHERE user_id = NEW.user_id AND next_state = 'banned' AND changed_at = account_changed_at
    ORDER BY id DESC LIMIT 1
  ) THEN
    RAISE EXCEPTION 'appeal requires current owned ban event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_appeals_ban_guard BEFORE INSERT ON moderation.user_appeals
FOR EACH ROW EXECUTE FUNCTION moderation.guard_appeal_ban();
CREATE TRIGGER user_appeals_delete_guard BEFORE DELETE ON moderation.user_appeals
FOR EACH ROW EXECUTE FUNCTION support.reject_message_mutation();

CREATE FUNCTION moderation.guard_appeal_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM moderation.user_appeals
    WHERE id = NEW.appeal_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'appeal submission owner mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appeal_submissions_owner_guard BEFORE INSERT ON moderation.appeal_submissions
FOR EACH ROW EXECUTE FUNCTION moderation.guard_appeal_submission();
