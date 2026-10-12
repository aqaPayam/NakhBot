-- Original pending references must remain complete for archival and funded replay.
-- This read-only proof grants no new delivery, refund, deletion or fresh Return.
CREATE OR REPLACE FUNCTION nakh.original_funded_scope_valid(source_id uuid,flow_id uuid,sender uuid,receiver uuid,
  funding text,credit_id uuid,payment_id uuid) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.nakh_flows flow JOIN nakh.nakh_reference_anchors anchor
    ON anchor.id=source_id AND anchor.nakh_flow_id=flow.id
    WHERE flow.id=flow_id AND flow.sender_user_id=sender AND flow.receiver_user_id=receiver
      AND anchor.sender_user_id=sender AND anchor.receiver_user_id=receiver
      AND anchor.sender_product_epoch=flow.sender_product_epoch
      AND anchor.receiver_product_epoch=flow.receiver_product_epoch
      AND ((funding='credits' AND payment_id IS NULL AND EXISTS(
        SELECT 1 FROM billing.credit_transactions credit WHERE credit.id=credit_id
          AND credit.nakh_id=source_id AND credit.user_id=sender AND credit.product_epoch=flow.sender_product_epoch
          AND credit.transaction_type='spend_nakh' AND credit.amount=-2
          AND credit.payment_record_id IS NULL AND credit.feature_unlock_id IS NULL
          AND ((credit.pending_payment_id IS NULL
            AND NOT EXISTS(SELECT 1 FROM nakh.pending_nakhes pending WHERE pending.nakh_flow_id=flow.id)
            AND NOT EXISTS(SELECT 1 FROM nakh.pending_nakh_reference_anchors reference WHERE reference.nakh_flow_id=flow.id))
            OR EXISTS(SELECT 1 FROM nakh.pending_nakhes pending
            WHERE pending.pending_payment_id=credit.pending_payment_id AND pending.nakh_flow_id=flow.id
              AND pending.status='paid_and_sent' AND nakh.original_pending_reference_valid(pending.id)
              AND EXISTS(SELECT 1 FROM billing.pending_payments intent WHERE intent.id=pending.pending_payment_id
                AND intent.status='paid')))))
        OR (funding='telegram_stars' AND credit_id IS NULL AND EXISTS(
          SELECT 1 FROM billing.payment_records payment JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id
          WHERE payment.id=payment_id AND payment.user_id=sender AND payment.payment_type='pay_pending_action'
            AND payment.paid_action_reason='send_nakh' AND payment.status='paid' AND payment.stars_amount=2
            AND intent.user_id=sender AND intent.product_epoch=flow.sender_product_epoch
            AND intent.reason='send_nakh' AND intent.target_type='pending_nakh' AND intent.status='paid' AND intent.required_stars=2
            AND EXISTS(SELECT 1 FROM nakh.pending_nakhes pending WHERE pending.id=intent.target_id
              AND pending.pending_payment_id=intent.id AND pending.nakh_flow_id=flow.id AND pending.status='paid_and_sent' AND nakh.original_pending_reference_valid(pending.id))))))
$$;
