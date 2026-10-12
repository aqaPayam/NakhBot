-- Return is still disabled. Original epoch zero is the only provable legacy
-- life; never backfill a historical Match from a subsequently returned Account.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM matching.match_reference_anchors anchor
    JOIN identity.accounts account ON account.user_id IN(anchor.user_low_id,anchor.user_high_id)
    WHERE account.product_epoch<>0) THEN
    RAISE EXCEPTION 'legacy Match life is unprovable' USING ERRCODE='23514'; END IF;
END $$;
ALTER TABLE matching.match_reference_anchors
  ADD COLUMN low_product_epoch integer NOT NULL DEFAULT 0 CHECK(low_product_epoch>=0),
  ADD COLUMN high_product_epoch integer NOT NULL DEFAULT 0 CHECK(high_product_epoch>=0);
ALTER TABLE matching.match_reference_anchors DROP CONSTRAINT match_reference_anchors_user_low_id_user_high_id_key;
CREATE UNIQUE INDEX match_reference_original_pair_lives_uq ON matching.match_reference_anchors
  (user_low_id,user_high_id,low_product_epoch,high_product_epoch);

CREATE OR REPLACE FUNCTION matching.guard_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE low_epoch integer; high_epoch integer;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'match reference requires controlled release' USING ERRCODE='55000'; END IF;
  -- Match writers already own the pair. No late counter acquisition.
  PERFORM interaction.lock_user_pair(NEW.user_low_id,NEW.user_high_id);
  PERFORM id FROM identity.users WHERE id IN(NEW.user_low_id,NEW.user_high_id) ORDER BY id FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id IN(NEW.user_low_id,NEW.user_high_id) ORDER BY user_id FOR UPDATE;
  SELECT product_epoch INTO low_epoch FROM identity.accounts WHERE user_id=NEW.user_low_id AND state<>'deleted';
  SELECT product_epoch INTO high_epoch FROM identity.accounts WHERE user_id=NEW.user_high_id AND state<>'deleted';
  IF low_epoch IS NULL OR high_epoch IS NULL
    OR (NEW.low_product_epoch<>0 AND NEW.low_product_epoch<>low_epoch)
    OR (NEW.high_product_epoch<>0 AND NEW.high_product_epoch<>high_epoch)
    OR NOT EXISTS(SELECT 1 FROM matching.current_match_lives source WHERE source.id=NEW.id
      AND source.user_low_id=NEW.user_low_id AND source.user_high_id=NEW.user_high_id) THEN
    RAISE EXCEPTION 'Match reference lacks exact live participant lives' USING ERRCODE='23514'; END IF;
  NEW.low_product_epoch:=low_epoch; NEW.high_product_epoch:=high_epoch;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION matching.require_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM matching.match_reference_anchors anchor
    JOIN identity.accounts low_account ON low_account.user_id=anchor.user_low_id
    JOIN identity.accounts high_account ON high_account.user_id=anchor.user_high_id
    WHERE anchor.id=NEW.id AND anchor.user_low_id=NEW.user_low_id AND anchor.user_high_id=NEW.user_high_id
      AND anchor.low_product_epoch=low_account.product_epoch AND anchor.high_product_epoch=high_account.product_epoch) THEN
    RAISE EXCEPTION 'Match original life reference incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION matching.guard_retired_match_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM matching.match_reference_anchors WHERE id=NEW.id) THEN
    RAISE EXCEPTION 'retired Match identity cannot be reused' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER match_retired_identity_guard BEFORE INSERT ON matching.matches
  FOR EACH ROW EXECUTE FUNCTION matching.guard_retired_match_identity();

-- Historical closure never consults a current lease or grants current access.
CREATE FUNCTION matching.original_match_closure_valid(subject uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM matching.matches WHERE id=subject) AND EXISTS(
    SELECT 1 FROM matching.match_reference_anchors anchor
    JOIN identity.account_deletion_match_receipts receipt ON receipt.match_id=anchor.id
    JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
    JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
    WHERE anchor.id=subject AND receipt.status IN('closed','unmatched') AND receipt.closed_at IS NOT NULL
      AND ((root.user_id=anchor.user_low_id AND root.product_epoch=anchor.low_product_epoch)
        OR (root.user_id=anchor.user_high_id AND root.product_epoch=anchor.high_product_epoch))
      AND receipt.checklist_version=1 AND receipt.archived_at>=root.requested_at AND receipt.archived_at<receipt.lease_expires_at
      AND audit.category='account' AND audit.event_type='account.deletion-match-archived.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id AND audit.result_code='match_archived'
      AND audit.metadata_schema_version=1 AND audit.metadata='{"kind":"match_source"}'::jsonb
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=receipt.archived_at)
$$;
COMMENT ON TABLE matching.match_reference_anchors IS
  'Original Match identity, normalized participants and their exact original lives; no product status, access, return or release authority.';
