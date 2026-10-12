-- Repair the failed M8 write fence without changing deletion authority or deadlines.
CREATE OR REPLACE FUNCTION identity.guard_verified_product_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document jsonb:=to_jsonb(NEW); subject uuid;
BEGIN
  -- This derived checkpoint references the live Chat body. Its nondeferrable
  -- FK takes the parent lock and prevents an insert from outliving body removal.
  -- Retention already owns the Chat; taking Account locks here reverses report admission.
  IF TG_TABLE_SCHEMA='chat' AND TG_TABLE_NAME='chat_cleanup_checkpoints' THEN RETURN NEW; END IF;
  -- Match reference insertion subsequently takes pair -> User -> Account.
  -- Acquire that same order before taking any Account lock at Match birth.
  IF TG_TABLE_SCHEMA='matching' AND TG_TABLE_NAME='matches' AND TG_OP='INSERT' THEN
    PERFORM interaction.lock_user_pair((document->>'user_low_id')::uuid,(document->>'user_high_id')::uuid);
  END IF;
  -- A blocked pair is retained safety state, not reopened ordinary interaction.
  IF TG_TABLE_SCHEMA='interaction' AND TG_TABLE_NAME='user_pair_states' AND document->>'state'='blocked' THEN RETURN NEW; END IF;
  FOR subject IN SELECT DISTINCT account.user_id FROM identity.accounts account JOIN (
    SELECT (document->>field.key)::uuid AS user_id FROM (VALUES('user_id'),('viewer_user_id'),('target_user_id'),('sender_user_id'),('receiver_user_id'),
      ('payer_user_id'),('actor_user_id'),('user_low_id'),('user_high_id')) field(key) WHERE document->>field.key IS NOT NULL
    UNION SELECT original.user_id FROM platform.deletion_original_subjects original
      JOIN LATERAL(VALUES('profile',(document->>'profile_id')::uuid),('chat_session',(document->>'chat_session_id')::uuid),
        ('match',(document->>'match_id')::uuid),('nakh',(document->>'nakh_id')::uuid),('nakh_flow',(document->>'nakh_flow_id')::uuid))
        parent(resource,id) ON original.resource=parent.resource AND original.source_id=parent.id
    ) owner ON owner.user_id=account.user_id ORDER BY account.user_id
  LOOP
    -- UPDATE already owns this ordinary source row. A purge cannot remove it
    -- or verify absence until that update commits. Avoid taking identity locks
    -- after existing closures have already locked Account/Match/Chat rows.
    -- The post-product rejection below still applies to damaged/recreated rows.
    IF TG_OP='INSERT' THEN
      PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
      PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
    END IF;
    IF EXISTS(SELECT 1 FROM identity.accounts account JOIN identity.account_deletion_records root
      ON root.user_id=account.user_id AND root.product_epoch=account.product_epoch
      WHERE account.user_id=subject AND account.state='deleted' AND root.checkpoint_version>=4) THEN
      RAISE EXCEPTION 'ordinary write cannot reopen verified product data' USING ERRCODE='40001'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
