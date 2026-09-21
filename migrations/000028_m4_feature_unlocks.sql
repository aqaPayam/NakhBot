CREATE TABLE interaction.feature_unlocks (
  id uuid PRIMARY KEY,
  payer_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  feature_type text NOT NULL CHECK (feature_type IN ('liked_by_profile_unlock','chat_unlock')),
  like_id uuid REFERENCES interaction.likes(id) ON DELETE RESTRICT,
  match_id uuid REFERENCES matching.matches(id) ON DELETE RESTRICT,
  payment_record_id uuid REFERENCES billing.payment_records(id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  credit_transaction_id uuid REFERENCES billing.credit_transactions(id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  unlocked_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IS NULL OR revoked_reason ~ '^[a-z][a-z0-9_]{0,79}$'),
  revoked_by_admin_id uuid REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  expired_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT feature_unlock_scope_ck CHECK (
    (feature_type = 'liked_by_profile_unlock' AND like_id IS NOT NULL AND match_id IS NULL)
    OR (feature_type = 'chat_unlock' AND match_id IS NOT NULL AND like_id IS NULL)
  ),
  CONSTRAINT feature_unlock_funding_ck CHECK (
    (payment_record_id IS NOT NULL AND credit_transaction_id IS NULL)
    OR (payment_record_id IS NULL AND credit_transaction_id IS NOT NULL)
  ),
  CONSTRAINT feature_unlock_mvp_expiry_ck CHECK (expires_at IS NULL),
  CONSTRAINT feature_unlock_lifecycle_ck CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_reason IS NULL
      AND revoked_by_admin_id IS NULL AND expired_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_reason IS NOT NULL
      AND expired_at IS NULL)
    OR (status = 'expired' AND expired_at IS NOT NULL AND revoked_at IS NULL
      AND revoked_reason IS NULL AND revoked_by_admin_id IS NULL)
  )
);

CREATE UNIQUE INDEX feature_unlocks_like_once_idx
  ON interaction.feature_unlocks (like_id)
  WHERE feature_type = 'liked_by_profile_unlock';
CREATE UNIQUE INDEX feature_unlocks_match_once_idx
  ON interaction.feature_unlocks (match_id)
  WHERE feature_type = 'chat_unlock';
CREATE UNIQUE INDEX feature_unlocks_payment_once_idx
  ON interaction.feature_unlocks (payment_record_id)
  WHERE payment_record_id IS NOT NULL;
CREATE UNIQUE INDEX feature_unlocks_credit_once_idx
  ON interaction.feature_unlocks (credit_transaction_id)
  WHERE credit_transaction_id IS NOT NULL;
CREATE INDEX feature_unlocks_payer_status_idx
  ON interaction.feature_unlocks (payer_user_id, status, unlocked_at DESC, id DESC);

ALTER TABLE billing.credit_transactions
  ADD CONSTRAINT credit_transactions_feature_unlock_fk
  FOREIGN KEY (feature_unlock_id) REFERENCES interaction.feature_unlocks(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION interaction.guard_feature_unlock_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.payer_user_id <> OLD.payer_user_id
    OR NEW.feature_type <> OLD.feature_type OR NEW.like_id IS DISTINCT FROM OLD.like_id
    OR NEW.match_id IS DISTINCT FROM OLD.match_id
    OR NEW.payment_record_id IS DISTINCT FROM OLD.payment_record_id
    OR NEW.credit_transaction_id IS DISTINCT FROM OLD.credit_transaction_id
    OR NEW.unlocked_at <> OLD.unlocked_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'feature unlock proof is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'active' OR NEW.status NOT IN ('revoked','expired')
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid feature unlock transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER feature_unlock_lifecycle_guard
BEFORE UPDATE ON interaction.feature_unlocks
FOR EACH ROW EXECUTE FUNCTION interaction.guard_feature_unlock_lifecycle();

COMMENT ON TABLE interaction.feature_unlocks IS
  'Sole durable authority for paid Like and Match access; effective access also requires a live scope.';
