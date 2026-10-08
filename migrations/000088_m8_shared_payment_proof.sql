-- Closing product content does not cancel received money. Every captured attempt
-- needs its exact, durable refund obligation before ordinary deletion can advance.
CREATE FUNCTION billing.pending_nakh_has_bound_closure(subject uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT EXISTS (
  SELECT 1 FROM nakh.pending_nakhes pending
  JOIN billing.pending_payments intent ON intent.id=pending.pending_payment_id
  WHERE pending.id=subject AND pending.status='closed_by_system'
    AND intent.user_id=pending.sender_user_id AND intent.reason='send_nakh'
    AND intent.target_type='pending_nakh' AND intent.target_id=pending.id
    AND intent.expires_at=pending.expires_at
    AND intent.status IN ('cancelled','expired','failed','paid')
    AND NOT EXISTS (SELECT 1 FROM nakh.nakhes WHERE nakh_flow_id=pending.nakh_flow_id)
    AND (intent.status<>'paid' OR EXISTS (
      SELECT 1 FROM billing.payment_records payment
      JOIN billing.telegram_stars_receipts receipt ON receipt.payment_record_id=payment.id
      WHERE payment.pending_payment_id=intent.id))
    AND NOT EXISTS (
      SELECT 1 FROM billing.payment_records payment
      LEFT JOIN billing.telegram_stars_receipts receipt ON receipt.payment_record_id=payment.id
      WHERE payment.pending_payment_id=intent.id
        AND (receipt.payment_record_id IS NOT NULL OR payment.status IN ('paid','refunded'))
        AND NOT EXISTS (
          SELECT 1 FROM billing.payment_fulfillments fulfillment
          JOIN billing.refund_records refund ON refund.payment_record_id=fulfillment.payment_record_id
          WHERE fulfillment.payment_record_id=payment.id
            AND fulfillment.state IN ('correction_required','corrected')
            AND fulfillment.correction_required_at IS NOT NULL
            AND payment.user_id=pending.sender_user_id
            AND payment.payment_type='pay_pending_action' AND payment.paid_action_reason='send_nakh'
            AND intent.funding_type='telegram_stars'
            AND payment.stars_amount=intent.required_stars
            AND receipt.payer_user_id=payment.user_id AND receipt.stars_amount=payment.stars_amount
            AND refund.user_id=payment.user_id AND refund.funding_type='telegram_stars'
            AND refund.telegram_charge_id=receipt.telegram_charge_id
            AND refund.stars_amount=receipt.stars_amount AND refund.reason_code='target_unavailable'
            AND refund.idempotency_key='stars-refund:'||payment.id::text
            AND ((fulfillment.state='correction_required' AND refund.status<>'processed'
                  AND payment.status<>'refunded')
              OR (fulfillment.state='corrected' AND refund.status='processed'
                  AND refund.provider_progress='refund_confirmed' AND payment.status='refunded'))
        )
    )
) $$;

CREATE FUNCTION identity.deletion_has_unresolved_shared_payments(subject uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT EXISTS (
  SELECT 1 FROM nakh.pending_nakhes pending JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
  WHERE pending.status='closed_by_system' AND (flow.sender_user_id=subject OR flow.receiver_user_id=subject)
    AND NOT billing.pending_nakh_has_bound_closure(pending.id)
) $$;

CREATE OR REPLACE FUNCTION identity.deletion_has_open_shared_scopes(subject uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT
  EXISTS (SELECT 1 FROM interaction.likes WHERE status='active' AND (sender_user_id=subject OR receiver_user_id=subject))
  OR EXISTS (SELECT 1 FROM matching.matches WHERE status='active' AND (user_low_id=subject OR user_high_id=subject))
  OR EXISTS (SELECT 1 FROM chat.chat_sessions session JOIN matching.matches match ON match.id=session.match_id
    WHERE session.status='active' AND (match.user_low_id=subject OR match.user_high_id=subject))
  OR EXISTS (SELECT 1 FROM interaction.user_pair_states WHERE state='matched' AND (user_low_id=subject OR user_high_id=subject))
  OR EXISTS (SELECT 1 FROM interaction.feature_unlocks grant_scope JOIN interaction.likes like_scope ON like_scope.id=grant_scope.like_id
    WHERE grant_scope.status='active' AND (like_scope.sender_user_id=subject OR like_scope.receiver_user_id=subject))
  OR EXISTS (SELECT 1 FROM interaction.feature_unlocks grant_scope JOIN matching.matches match ON match.id=grant_scope.match_id
    WHERE grant_scope.status='active' AND (match.user_low_id=subject OR match.user_high_id=subject))
  OR EXISTS (SELECT 1 FROM nakh.pending_nakhes pending JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
    WHERE pending.status='pending_payment' AND (flow.sender_user_id=subject OR flow.receiver_user_id=subject))
  OR EXISTS (SELECT 1 FROM nakh.nakhes WHERE status IN ('sent','seen') AND (sender_user_id=subject OR receiver_user_id=subject))
  OR identity.deletion_has_unresolved_shared_payments(subject)
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM identity.account_deletion_records record
    WHERE record.phase<>'shared_closure' AND identity.deletion_has_unresolved_shared_payments(record.user_id)) THEN
    RAISE EXCEPTION 'legacy deletion progress lacks financial closure proof' USING ERRCODE='23514';
  END IF;
END $$;
