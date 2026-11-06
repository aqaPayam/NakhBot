-- Compact original-authority selectors only. Private profiles and media grants
-- remain transient worker projections. Mutable source IDs deliberately have no FK.
ALTER TABLE channel_telegram.liked_by_delivery_requests
 ADD COLUMN session_grant_id uuid,
 ADD COLUMN source_like_id uuid,
 ADD COLUMN feature_unlock_id uuid,
 ADD COLUMN profile_version integer,
 DROP CONSTRAINT liked_by_delivery_callback_pair_ck;
ALTER TABLE channel_telegram.liked_by_delivery_requests
 ADD CONSTRAINT liked_by_delivery_callback_pair_ck CHECK (
   (session_grant_id IS NULL AND ((cursor IS NULL AND callback_query_id IS NULL)
     OR (cursor IS NOT NULL AND callback_query_id IS NOT NULL)))
   OR (session_grant_id IS NOT NULL AND (cursor IS NULL OR callback_query_id IS NOT NULL))),
 ADD CONSTRAINT liked_by_delivery_original_scope_ck CHECK (
   (source_like_id IS NULL AND feature_unlock_id IS NULL AND profile_version IS NULL)
   OR (session_grant_id IS NOT NULL AND source_like_id IS NOT NULL AND feature_unlock_id IS NOT NULL
     AND cursor IS NULL AND (profile_version IS NULL OR profile_version>0)));
ALTER TABLE channel_telegram.liked_by_delivery_receipts DROP CONSTRAINT liked_by_delivery_receipt_key_ck;
ALTER TABLE channel_telegram.liked_by_delivery_receipts ADD CONSTRAINT liked_by_delivery_receipt_key_ck CHECK (
 message_key ~ '^card:v1\.lb\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$'
 OR message_key ~ '^(screen|detail):[A-Za-z0-9_-]{43}$');

CREATE FUNCTION channel_telegram.guard_liked_by_original_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.session_grant_id,NEW.source_like_id,NEW.feature_unlock_id)
    IS DISTINCT FROM (OLD.session_grant_id,OLD.source_like_id,OLD.feature_unlock_id)
   OR (OLD.session_grant_id IS NOT NULL AND
     (NEW.bot_id,NEW.update_id,NEW.viewer_user_id,NEW.product_epoch,NEW.telegram_user_id,
      NEW.request_id,NEW.cursor,NEW.callback_query_id,NEW.created_at)
     IS DISTINCT FROM
     (OLD.bot_id,OLD.update_id,OLD.viewer_user_id,OLD.product_epoch,OLD.telegram_user_id,
      OLD.request_id,OLD.cursor,OLD.callback_query_id,OLD.created_at)) THEN
   RAISE EXCEPTION 'original interactive Like authority is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.profile_version IS DISTINCT FROM OLD.profile_version THEN
   IF OLD.profile_version IS NOT NULL OR OLD.state<>'pending' OR NEW.feature_unlock_id IS NULL
     OR NEW.profile_version IS NULL OR NOT EXISTS (
       SELECT 1 FROM interaction.current_like_lives incoming
       JOIN interaction.feature_unlocks u ON u.like_id=incoming.id AND u.id=NEW.feature_unlock_id
       JOIN profile.profiles p ON p.user_id=incoming.sender_user_id
       WHERE incoming.id=NEW.source_like_id AND incoming.receiver_user_id=NEW.viewer_user_id
         AND u.payer_user_id=NEW.viewer_user_id AND p.version=NEW.profile_version) THEN
    RAISE EXCEPTION 'original Like profile version cannot be replaced' USING ERRCODE='55000'; END IF;
  END IF;
  -- Operational lease/failure settlement remains possible after source revocation.
  RETURN NEW;
 END IF;
 IF NEW.session_grant_id IS NULL THEN RETURN NEW; END IF;
 IF NEW.profile_version IS NOT NULL THEN
  RAISE EXCEPTION 'interactive profile version is frozen by the claimed worker' USING ERRCODE='55000'; END IF;
 IF NEW.source_like_id IS NOT NULL THEN
  SELECT sender_user_id INTO target FROM interaction.current_like_lives
   WHERE id=NEW.source_like_id AND receiver_user_id=NEW.viewer_user_id;
  IF target IS NULL THEN RAISE EXCEPTION 'original Like unavailable' USING ERRCODE='40001'; END IF;
  PERFORM interaction.lock_user_pair(LEAST(NEW.viewer_user_id,target),GREATEST(NEW.viewer_user_id,target));
 END IF;
 PERFORM id FROM identity.users WHERE id=NEW.viewer_user_id OR id=target ORDER BY id FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=NEW.viewer_user_id OR user_id=target ORDER BY user_id FOR UPDATE;
 IF NOT EXISTS (
  SELECT 1 FROM platform.audit_logs session
  JOIN identity.accounts account ON account.user_id=session.actor_user_id
  JOIN profile.profiles p ON p.user_id=account.user_id
  JOIN identity.user_settings settings ON settings.user_id=account.user_id
  JOIN identity.telegram_identities telegram ON telegram.user_id=account.user_id
  WHERE session.id=NEW.session_grant_id AND session.actor_user_id=NEW.viewer_user_id
   AND identity.user_session_epoch(session.id)=NEW.product_epoch AND account.product_epoch=NEW.product_epoch
   AND session.occurred_at<=clock_timestamp() AND session.occurred_at+interval '15 minutes'>clock_timestamp()
   AND NOT identity.user_session_authority_revoked(session.id)
   AND telegram.telegram_user_id::text=NEW.telegram_user_id AND account.state='active'
   AND p.completion_status='complete' AND settings.visibility_enabled
 ) THEN RAISE EXCEPTION 'original Like session unavailable' USING ERRCODE='40001'; END IF;
 IF NEW.feature_unlock_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM interaction.current_like_lives incoming
  JOIN identity.accounts owner ON owner.user_id=incoming.sender_user_id
  JOIN profile.profiles p ON p.user_id=owner.user_id
  JOIN interaction.feature_unlocks u ON u.like_id=incoming.id
  JOIN interaction.feature_unlock_reference_anchors a ON a.id=u.id
  WHERE incoming.id=NEW.source_like_id AND incoming.receiver_user_id=NEW.viewer_user_id AND incoming.status='active'
   AND owner.state='active' AND p.completion_status='complete'
   AND u.id=NEW.feature_unlock_id AND u.payer_user_id=NEW.viewer_user_id AND u.feature_type='liked_by_profile_unlock'
   AND u.status='active' AND u.revoked_at IS NULL AND u.expired_at IS NULL AND u.unlocked_at<=clock_timestamp()
   AND (u.expires_at IS NULL OR u.expires_at>clock_timestamp())
   AND a.payer_user_id=u.payer_user_id AND a.payer_product_epoch=NEW.product_epoch AND a.like_id=incoming.id
   AND NOT EXISTS (SELECT 1 FROM interaction.user_pair_states pair
     WHERE pair.user_low_id=LEAST(NEW.viewer_user_id,owner.user_id) AND pair.user_high_id=GREATEST(NEW.viewer_user_id,owner.user_id))
   AND NOT EXISTS (SELECT 1 FROM interaction.not_interested rejection
     WHERE rejection.sender_user_id=NEW.viewer_user_id AND rejection.receiver_user_id=owner.user_id)
   AND EXISTS (SELECT 1 FROM media.profile_photos photo
     JOIN media.media_assets asset ON asset.id=photo.asset_id
     JOIN media.photo_variants thumbnail ON thumbnail.asset_id=asset.id
     WHERE photo.profile_id=p.id AND photo.status='visible' AND photo.is_primary AND photo.deleted_at IS NULL
      AND asset.owner_user_id=owner.user_id AND asset.validation_state='valid'
      AND asset.deleted_at IS NULL AND asset.storage_deleted_at IS NULL
      AND thumbnail.variant_type='thumbnail' AND thumbnail.transformation_version=1
      AND thumbnail.deleted_at IS NULL AND thumbnail.storage_deleted_at IS NULL)
 ) THEN RAISE EXCEPTION 'original Like unlock unavailable' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $$;
-- Canonical pair/account admission precedes the existing actor-only life guard.
CREATE TRIGGER liked_by_00_original_authority_guard BEFORE INSERT OR UPDATE
 ON channel_telegram.liked_by_delivery_requests FOR EACH ROW
 EXECUTE FUNCTION channel_telegram.guard_liked_by_original_authority();

-- Extend only this ordinary operational table in the frozen schema inventory.
-- Retained resource descriptors and approved-policy requirements are unchanged.
DO $$ DECLARE snapshot jsonb; item jsonb; position integer;
 old_hash text; cutover timestamptz; definition text;
BEGIN
 -- Drain prior inserts before choosing the historical cutoff. Waiting old
 -- writers must pass the new hash guard when this migration commits.
 LOCK TABLE identity.data_retention_records IN SHARE ROW EXCLUSIVE MODE;
 old_hash:=identity.retention_registry_hash(); cutover:=clock_timestamp();
 IF EXISTS(SELECT 1 FROM identity.data_retention_records r WHERE identity.retention_record_valid(r) IS NOT TRUE) THEN
  RAISE EXCEPTION 'existing retention proof is invalid'; END IF;
 snapshot:=identity.retention_schema();
 SELECT value,ordinality::integer-1 INTO item,position
 FROM jsonb_array_elements(snapshot) WITH ORDINALITY WHERE value->>'table'='channel_telegram.liked_by_delivery_requests';
 IF item IS NULL THEN RAISE EXCEPTION 'Liked By delivery schema inventory missing'; END IF;
 item:=jsonb_set(item,'{columns}',(item->'columns')||
  '[{"name":"session_grant_id","type":"uuid","nullable":true},{"name":"source_like_id","type":"uuid","nullable":true},{"name":"feature_unlock_id","type":"uuid","nullable":true},{"name":"profile_version","type":"integer","nullable":true}]'::jsonb);
 snapshot:=jsonb_set(snapshot,ARRAY[position::text],item);
 EXECUTE format('CREATE OR REPLACE FUNCTION identity.retention_schema() RETURNS jsonb LANGUAGE sql IMMUTABLE AS %L',
  'SELECT '||quote_literal(snapshot::text)||'::jsonb');
 -- Existing immutable manifests keep their original hash and proof. Their
 -- retained descriptors did not change. New inserts must use the new inventory.
 SELECT pg_get_functiondef('identity.retention_record_valid(identity.data_retention_records)'::regprocedure) INTO definition;
 IF position('r.registry_hash=identity.retention_registry_hash()' IN definition)=0 THEN
  RAISE EXCEPTION 'retention record hash check changed'; END IF;
 definition:=replace(definition,'r.registry_hash=identity.retention_registry_hash()',
  format('(r.registry_hash=identity.retention_registry_hash() OR (r.registry_hash=%L AND r.created_at<=%L::timestamptz))',old_hash,cutover));
 EXECUTE definition;
 -- Migration 153 already requires the current registry hash on every new insert.
END $$;

WITH seed(text_key,body,variables) AS (VALUES
 (E'liked_by.back',E'Back to Likes',E'[]'::jsonb),
 (E'liked_by.dismiss',E'Not interested',E'[]'::jsonb),
 (E'liked_by.insufficient',E'You need {credits} credits to unlock this profile. Open Your credits to check your balance.',E'["credits"]'::jsonb),
 (E'liked_by.like_back',E'Like back',E'[]'::jsonb),
 (E'liked_by.menu',E'Likes',E'[]'::jsonb),
 (E'liked_by.queued',E'Your profile view is being prepared.',E'[]'::jsonb),
 (E'liked_by.rejected',E'This Like has been dismissed.',E'[]'::jsonb),
 (E'liked_by.unavailable',E'This Like is no longer available. Open Likes again.',E'[]'::jsonb),
 (E'liked_by.unlock.confirm',E'Spend {credits} credits to view this full profile?\nYour balance: {balance} credits.',E'["balance","credits"]'::jsonb),
 (E'liked_by.unlock.credits',E'Unlock for {credits} credits',E'["credits"]'::jsonb),
 (E'liked_by.view',E'View profile',E'[]'::jsonb)
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,'message',variables,true,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM seed;
