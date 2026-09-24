ALTER TABLE notification.notification_deliveries
  ADD COLUMN provider_progress text NOT NULL DEFAULT 'not_started'
    CHECK (provider_progress IN ('not_started','call_started','settled','ambiguous')),
  ADD COLUMN lease_owner text
    CHECK (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 128),
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN fence_token bigint NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  ADD COLUMN quarantined_at timestamptz;

ALTER TABLE notification.notification_deliveries
  DROP CONSTRAINT notification_delivery_state_ck,
  ADD CONSTRAINT notification_delivery_state_ck CHECK (
    (status = 'pending' AND next_attempt_at IS NOT NULL AND sent_at IS NULL
      AND failed_at IS NULL AND failure_code IS NULL)
    OR (status = 'sent' AND next_attempt_at IS NULL AND sent_at IS NOT NULL
      AND failed_at IS NULL AND failure_code IS NULL)
    OR (status = 'failed_retryable' AND next_attempt_at IS NOT NULL AND sent_at IS NULL
      AND failed_at IS NOT NULL AND failure_code IS NOT NULL)
    OR (status = 'failed_terminal' AND next_attempt_at IS NULL AND sent_at IS NULL
      AND failed_at IS NOT NULL AND failure_code IS NOT NULL)
  ),
  ADD CONSTRAINT notification_delivery_lease_ck CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
      AND status IN ('pending','failed_retryable') AND fence_token > 0)
  ),
  ADD CONSTRAINT notification_delivery_provider_progress_ck CHECK (
    (status IN ('pending','failed_retryable') AND provider_progress IN ('not_started','call_started')
      AND provider_delivery_key IS NULL AND quarantined_at IS NULL)
    OR (status = 'sent' AND provider_progress = 'settled'
      AND provider_delivery_key IS NOT NULL AND quarantined_at IS NULL)
    OR (status = 'failed_terminal' AND failure_code = 'ambiguous_result'
      AND provider_progress = 'ambiguous' AND provider_delivery_key IS NULL
      AND quarantined_at IS NOT NULL)
    OR (status = 'failed_terminal' AND failure_code <> 'ambiguous_result'
      AND provider_progress = 'settled' AND provider_delivery_key IS NULL
      AND quarantined_at IS NULL)
  ),
  ADD CONSTRAINT notification_delivery_call_lease_ck CHECK (
    provider_progress <> 'call_started' OR lease_owner IS NOT NULL
  );

CREATE OR REPLACE FUNCTION notification.guard_notification_delivery()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.notification_id <> OLD.notification_id OR NEW.channel <> OLD.channel
    OR NEW.created_at <> OLD.created_at OR NEW.attempt_number < OLD.attempt_number
    OR NEW.fence_token < OLD.fence_token OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid notification delivery mutation' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt_number > OLD.attempt_number AND (
      NEW.attempt_number <> OLD.attempt_number + 1
      OR NEW.fence_token <> OLD.fence_token + 1
      OR NEW.lease_owner IS NULL
      OR OLD.provider_progress = 'call_started'
    ) THEN
    RAISE EXCEPTION 'invalid notification delivery claim' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt_number = OLD.attempt_number AND NEW.fence_token <> OLD.fence_token THEN
    RAISE EXCEPTION 'notification delivery fence changed without a claim'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP INDEX notification.notification_deliveries_due_idx;
CREATE INDEX notification_deliveries_due_claim_idx
  ON notification.notification_deliveries (next_attempt_at, id)
  WHERE status IN ('pending','failed_retryable') AND provider_progress = 'not_started';
CREATE INDEX notification_deliveries_expired_call_idx
  ON notification.notification_deliveries (lease_expires_at, id)
  WHERE status IN ('pending','failed_retryable') AND provider_progress = 'call_started';

COMMENT ON COLUMN notification.notification_deliveries.fence_token IS
  'Monotonic claim fence; settlement must match the current lease owner and exact fence.';
COMMENT ON COLUMN notification.notification_deliveries.provider_progress IS
  'Separates no-call, possibly-called, known-settled, and quarantined ambiguous provider outcomes.';
