CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS billing;
CREATE SCHEMA IF NOT EXISTS notification;

CREATE TABLE catalog.locales (
  code text PRIMARY KEY CHECK (code ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  english_name text NOT NULL CHECK (char_length(english_name) BETWEEN 1 AND 80),
  native_name text NOT NULL CHECK (char_length(native_name) BETWEEN 1 AND 80),
  is_active boolean NOT NULL,
  is_default boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX locales_one_default_idx ON catalog.locales (is_default) WHERE is_default;

CREATE FUNCTION catalog.require_default_locale() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalog.locales WHERE is_default AND is_active) THEN
    RAISE EXCEPTION 'one active default locale is required' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER locales_require_default
AFTER INSERT OR UPDATE OR DELETE ON catalog.locales
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION catalog.require_default_locale();

CREATE TABLE catalog.ui_texts (
  id uuid PRIMARY KEY,
  locale_code text NOT NULL REFERENCES catalog.locales(code) ON DELETE RESTRICT,
  text_key text NOT NULL CHECK (text_key ~ '^[a-z][a-z0-9_.]*$' AND char_length(text_key) <= 160),
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 4000),
  category text NOT NULL CHECK (
    category IN ('button', 'message', 'error', 'admin', 'payment', 'notification', 'safety')
  ),
  variables jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(variables) = 'array'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (locale_code, text_key)
);

CREATE INDEX ui_texts_active_locale_idx
  ON catalog.ui_texts (locale_code, text_key)
  WHERE is_active;

CREATE TABLE identity.users (
  id uuid PRIMARY KEY,
  last_activity_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE identity.telegram_identities (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE RESTRICT,
  telegram_user_id bigint NOT NULL UNIQUE CHECK (telegram_user_id > 0),
  username text CHECK (username IS NULL OR char_length(username) BETWEEN 1 AND 32),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  CONSTRAINT telegram_seen_order_ck CHECK (last_seen_at >= first_seen_at)
);

CREATE TABLE identity.accounts (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE RESTRICT,
  state text NOT NULL,
  state_reason text,
  state_changed_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT account_state_ck CHECK (
    state IN ('guest', 'incomplete', 'active', 'restricted', 'banned', 'deleted')
  ),
  CONSTRAINT account_state_reason_ck CHECK (
    state_reason IS NULL OR char_length(state_reason) BETWEEN 1 AND 160
  )
);

CREATE INDEX accounts_state_changed_idx ON identity.accounts (state, state_changed_at, user_id);

CREATE TABLE identity.account_state_history (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  previous_state text,
  next_state text NOT NULL,
  reason_code text NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 160),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'admin', 'system')),
  actor_user_id uuid REFERENCES identity.users(id) ON DELETE RESTRICT,
  actor_admin_id uuid,
  changed_at timestamptz NOT NULL,
  CONSTRAINT account_history_previous_state_ck CHECK (
    previous_state IS NULL OR previous_state IN ('guest', 'incomplete', 'active', 'restricted', 'banned', 'deleted')
  ),
  CONSTRAINT account_history_next_state_ck CHECK (
    next_state IN ('guest', 'incomplete', 'active', 'restricted', 'banned', 'deleted')
  ),
  CONSTRAINT account_history_state_change_ck CHECK (
    previous_state IS NULL OR previous_state <> next_state
  ),
  CONSTRAINT account_history_actor_ck CHECK (
    (actor_type = 'user' AND actor_user_id IS NOT NULL AND actor_admin_id IS NULL)
    OR (actor_type = 'admin' AND actor_user_id IS NULL AND actor_admin_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_user_id IS NULL AND actor_admin_id IS NULL)
  )
);

CREATE INDEX account_history_user_changed_idx
  ON identity.account_state_history (user_id, changed_at DESC, id DESC);
CREATE INDEX account_history_ban_idx
  ON identity.account_state_history (user_id, changed_at DESC, id DESC)
  WHERE next_state = 'banned';

CREATE FUNCTION identity.reject_account_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'account state history is append-only' USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER account_history_append_only
BEFORE UPDATE OR DELETE ON identity.account_state_history
FOR EACH ROW EXECUTE FUNCTION identity.reject_account_history_mutation();

CREATE TABLE identity.guest_preview_counters (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE RESTRICT,
  preview_count integer NOT NULL DEFAULT 0 CHECK (preview_count >= 0),
  limit_count integer NOT NULL CHECK (limit_count > 0),
  first_preview_at timestamptz,
  last_preview_at timestamptz,
  CONSTRAINT guest_preview_limit_ck CHECK (preview_count <= limit_count),
  CONSTRAINT guest_preview_times_ck CHECK (
    (preview_count = 0 AND first_preview_at IS NULL AND last_preview_at IS NULL)
    OR (
      preview_count > 0
      AND first_preview_at IS NOT NULL
      AND last_preview_at IS NOT NULL
      AND last_preview_at >= first_preview_at
    )
  )
);

CREATE FUNCTION identity.preserve_guest_preview_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.limit_count <> OLD.limit_count THEN
    RAISE EXCEPTION 'guest preview limit snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER guest_preview_limit_immutable
BEFORE UPDATE ON identity.guest_preview_counters
FOR EACH ROW EXECUTE FUNCTION identity.preserve_guest_preview_limit();

CREATE TABLE identity.user_settings (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE RESTRICT,
  visibility_enabled boolean NOT NULL DEFAULT true,
  ui_locale_code text NOT NULL DEFAULT 'en' REFERENCES catalog.locales(code) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE billing.credit_accounts (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE RESTRICT,
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE notification.notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE RESTRICT,
  chat_enabled boolean NOT NULL DEFAULT true,
  like_enabled boolean NOT NULL DEFAULT true,
  nakh_enabled boolean NOT NULL DEFAULT true,
  match_enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

INSERT INTO catalog.locales (
  code, english_name, native_name, is_active, is_default, created_at, updated_at
) VALUES
  ('en', 'English', 'English', true, true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('fa', 'Persian', 'فارسی', false, false, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

INSERT INTO catalog.ui_texts (
  id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'en', 'start.guest.title', 'Welcome to Nakh', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000002', 'en', 'start.incomplete.title', 'Continue your profile', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000003', 'en', 'start.main.title', 'What would you like to do?', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000004', 'en', 'start.discovery_paused.title', 'Discovery is paused while your visibility is off.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000005', 'en', 'start.fix_profile.title', 'Fix your profile to continue discovering people.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000006', 'en', 'start.restricted.title', 'Your account currently has limited access.', 'safety', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000007', 'en', 'start.banned.title', 'Your account is banned. You may review your appeal options.', 'safety', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000008', 'en', 'start.deleted.title', 'This account was deleted. Return availability must be reviewed.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000009', 'en', 'common.button.guest_preview', 'Browse as guest', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000010', 'en', 'common.button.sign_up', 'Sign up', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000011', 'en', 'common.button.continue_signup', 'Continue signup', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000012', 'en', 'common.button.settings', 'Settings', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000013', 'en', 'common.button.support', 'Support', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000014', 'en', 'error.account.invalid_transition', 'That account change is not allowed.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000015', 'en', 'error.signup.birth_year.invalid', 'Enter a four-digit Gregorian birth year.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000016', 'en', 'error.signup.birth_year.underage', 'You must be at least 18 to use Nakh.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000017', 'en', 'error.validation.control_character', 'Remove unsupported control characters.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000018', 'en', 'error.validation.length', 'This value has an invalid length.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

COMMENT ON TABLE identity.guest_preview_counters IS
  'Permanent anti-reset product counter retained through deletion and return.';
COMMENT ON TABLE billing.credit_accounts IS
  'M1 creates only the required zero-balance account; M4 owns ledger and balance behavior.';
COMMENT ON TABLE notification.notification_preferences IS
  'M1 creates first-start defaults; M6 owns preference editing and notification delivery.';
