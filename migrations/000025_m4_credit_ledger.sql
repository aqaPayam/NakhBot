CREATE TABLE billing.credit_packages (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  title_key text NOT NULL UNIQUE CHECK (title_key ~ '^[a-z][a-z0-9_.]{0,159}$'),
  credit_amount bigint NOT NULL CHECK (credit_amount > 0),
  stars_price bigint NOT NULL CHECK (stars_price > 0),
  badge_key text CHECK (badge_key IS NULL OR badge_key ~ '^[a-z][a-z0-9_.]{0,159}$'),
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL UNIQUE CHECK (display_order > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

INSERT INTO billing.credit_packages (
  id, code, title_key, credit_amount, stars_price, badge_key, is_active, display_order
) VALUES
  ('40000000-0000-4000-8000-000000000001', 'starter', 'billing.package.starter.title', 10, 10, NULL, true, 1),
  ('40000000-0000-4000-8000-000000000002', 'plus', 'billing.package.plus.title', 25, 20, 'billing.package.badge.popular', true, 2),
  ('40000000-0000-4000-8000-000000000003', 'best_value', 'billing.package.best_value.title', 50, 35, 'billing.package.badge.best_value', true, 3),
  ('40000000-0000-4000-8000-000000000004', 'ultimate', 'billing.package.ultimate.title', 100, 60, 'billing.package.badge.best_value', true, 4);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM billing.credit_accounts WHERE balance <> 0 OR version <> 1) THEN
    RAISE EXCEPTION 'M4 ledger cannot start from an unexplained credit balance';
  END IF;
END $$;

CREATE TABLE billing.credit_transactions (
  id uuid PRIMARY KEY,
  credit_account_id uuid NOT NULL REFERENCES billing.credit_accounts(user_id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  account_version integer NOT NULL CHECK (account_version >= 2),
  transaction_type text NOT NULL CHECK (transaction_type IN (
    'purchase','spend_nakh','spend_chat_unlock','spend_liked_by_unlock','refund','admin_adjustment'
  )),
  amount bigint NOT NULL CHECK (amount <> 0),
  balance_before bigint NOT NULL CHECK (balance_before >= 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  payment_record_id uuid,
  pending_payment_id uuid,
  feature_unlock_id uuid,
  nakh_id uuid,
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 160),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT credit_transaction_account_user_ck CHECK (credit_account_id = user_id),
  CONSTRAINT credit_transaction_balance_ck CHECK (balance_after = balance_before + amount),
  CONSTRAINT credit_transaction_sign_ck CHECK (
    (transaction_type IN ('purchase','refund') AND amount > 0)
    OR (transaction_type IN ('spend_nakh','spend_chat_unlock','spend_liked_by_unlock') AND amount < 0)
    OR (transaction_type = 'admin_adjustment')
  ),
  CONSTRAINT credit_transaction_reference_ck CHECK (
    (transaction_type = 'purchase' AND payment_record_id IS NOT NULL AND feature_unlock_id IS NULL AND nakh_id IS NULL)
    OR (transaction_type = 'spend_nakh' AND nakh_id IS NOT NULL AND payment_record_id IS NULL AND feature_unlock_id IS NULL)
    OR (transaction_type IN ('spend_chat_unlock','spend_liked_by_unlock') AND feature_unlock_id IS NOT NULL AND payment_record_id IS NULL AND nakh_id IS NULL)
    OR (transaction_type = 'refund' AND nakh_id IS NULL)
    OR (transaction_type = 'admin_adjustment' AND payment_record_id IS NULL AND pending_payment_id IS NULL AND feature_unlock_id IS NULL AND nakh_id IS NULL)
  ),
  UNIQUE (credit_account_id, account_version)
);

CREATE INDEX credit_transactions_user_time_idx
  ON billing.credit_transactions (user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX credit_transactions_payment_idx
  ON billing.credit_transactions (payment_record_id)
  WHERE transaction_type = 'purchase' AND payment_record_id IS NOT NULL;
CREATE UNIQUE INDEX credit_transactions_feature_unlock_idx
  ON billing.credit_transactions (feature_unlock_id)
  WHERE transaction_type IN ('spend_chat_unlock','spend_liked_by_unlock') AND feature_unlock_id IS NOT NULL;
CREATE UNIQUE INDEX credit_transactions_nakh_idx
  ON billing.credit_transactions (nakh_id)
  WHERE transaction_type = 'spend_nakh' AND nakh_id IS NOT NULL;
CREATE INDEX credit_transactions_pending_payment_idx
  ON billing.credit_transactions (pending_payment_id) WHERE pending_payment_id IS NOT NULL;

CREATE FUNCTION billing.reject_credit_transaction_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit transaction is immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER credit_transactions_immutable
BEFORE UPDATE OR DELETE ON billing.credit_transactions
FOR EACH ROW EXECUTE FUNCTION billing.reject_credit_transaction_mutation();

CREATE FUNCTION billing.verify_credit_account_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_user_id uuid;
  account_balance bigint;
  account_version integer;
  latest_balance bigint;
  latest_version integer;
BEGIN
  checked_user_id := COALESCE(
    (to_jsonb(NEW) ->> 'credit_account_id')::uuid,
    (to_jsonb(NEW) ->> 'user_id')::uuid
  );
  SELECT balance, version INTO account_balance, account_version
    FROM billing.credit_accounts WHERE user_id = checked_user_id;
  SELECT balance_after, ct.account_version INTO latest_balance, latest_version
    FROM billing.credit_transactions ct
    WHERE ct.credit_account_id = checked_user_id
    ORDER BY ct.account_version DESC LIMIT 1;
  IF latest_version IS NULL THEN
    IF account_balance <> 0 OR account_version <> 1 THEN
      RAISE EXCEPTION 'credit account without ledger must remain at its initial state' USING ERRCODE = '23514';
    END IF;
  ELSIF account_balance <> latest_balance OR account_version <> latest_version THEN
    RAISE EXCEPTION 'credit account and ledger chain diverged' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER credit_account_chain_guard
AFTER INSERT OR UPDATE ON billing.credit_accounts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION billing.verify_credit_account_chain();

CREATE CONSTRAINT TRIGGER credit_transaction_chain_guard
AFTER INSERT ON billing.credit_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION billing.verify_credit_account_chain();

COMMENT ON TABLE billing.credit_transactions IS
  'Immutable ordered source of truth for every internal credit balance change.';
COMMENT ON COLUMN billing.credit_transactions.account_version IS
  'CreditAccount version after this transaction; uniquely orders the per-account ledger chain.';
