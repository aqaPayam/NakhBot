DO $$ BEGIN
  IF position('original_pending_reference_valid' in pg_get_functiondef(
      'nakh.original_funded_scope_valid(uuid,uuid,uuid,uuid,text,uuid,uuid)'::regprocedure))=0
    OR EXISTS(SELECT 1 FROM nakh.nakh_lifecycle_facts source
      WHERE NOT nakh.original_funded_scope_valid(source.id,source.nakh_flow_id,
        source.sender_user_id,source.receiver_user_id,source.funding_type,
        source.credit_transaction_id,source.payment_record_id)) THEN
    RAISE EXCEPTION 'original pending funding binding is unproven';
  END IF;
END $$;
