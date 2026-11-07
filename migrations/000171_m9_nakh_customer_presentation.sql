-- A received, viewed Nakh is an explicit ordinary profile source. Its source
-- identifier has no FK so ordinary lifecycle deletion can revoke it immediately.
ALTER TABLE media.delivery_grants ADD COLUMN nakh_id uuid;
ALTER TABLE media.delivery_grants DROP CONSTRAINT media_delivery_grant_scope_ck;
ALTER TABLE media.delivery_grants ADD CONSTRAINT media_delivery_grant_scope_ck CHECK (
 (nakh_id IS NULL AND (
 (purpose='owner_preview' AND actor_user_id=owner_user_id AND like_id IS NULL
   AND variant_type='thumbnail' AND candidate_delivery_id IS NULL AND session_grant_id IS NULL AND feature_unlock_id IS NULL)
 OR (purpose='liked_by_blur' AND actor_user_id<>owner_user_id AND like_id IS NOT NULL
   AND variant_type='blurred_preview' AND candidate_delivery_id IS NULL AND feature_unlock_id IS NULL)
 OR (purpose IN ('profile_card','profile_detail') AND actor_user_id<>owner_user_id
   AND like_id IS NULL AND variant_type='thumbnail' AND candidate_delivery_id IS NOT NULL
   AND session_grant_id IS NOT NULL AND feature_unlock_id IS NULL)
 OR (purpose='profile_detail' AND actor_user_id<>owner_user_id AND like_id IS NOT NULL
   AND variant_type='thumbnail' AND candidate_delivery_id IS NULL
   AND session_grant_id IS NOT NULL AND feature_unlock_id IS NOT NULL)))
 OR (nakh_id IS NOT NULL AND purpose='profile_detail' AND actor_user_id<>owner_user_id
  AND variant_type='thumbnail' AND like_id IS NULL AND candidate_delivery_id IS NULL
  AND feature_unlock_id IS NULL AND session_grant_id IS NOT NULL)
);
ALTER FUNCTION media.delivery_grant_source_is_current(media.delivery_grants)
 RENAME TO delivery_grant_pre_nakh_source_is_current;
CREATE FUNCTION media.delivery_grant_source_is_current(grant_row media.delivery_grants)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT CASE WHEN grant_row.nakh_id IS NOT NULL THEN EXISTS (
  SELECT 1 FROM nakh.nakhes n
  JOIN nakh.current_flow_lives flow ON flow.id=n.nakh_flow_id
   AND flow.sender_user_id=n.sender_user_id AND flow.receiver_user_id=n.receiver_user_id
  JOIN nakh.nakh_reference_anchors anchor ON anchor.id=n.id AND anchor.nakh_flow_id=flow.id
  JOIN identity.accounts actor ON actor.user_id=n.receiver_user_id
  JOIN identity.accounts owner ON owner.user_id=n.sender_user_id
  JOIN profile.profiles p ON p.user_id=owner.user_id
  JOIN platform.audit_logs session ON session.id=grant_row.session_grant_id
  JOIN media.profile_photos photo ON photo.profile_id=p.id AND photo.id=grant_row.photo_id
  JOIN media.media_assets asset ON asset.id=photo.asset_id AND asset.id=grant_row.asset_id
  JOIN media.photo_variants variant ON variant.asset_id=asset.id AND variant.id=grant_row.variant_id
  WHERE n.id=grant_row.nakh_id AND grant_row.purpose='profile_detail'
   AND n.receiver_user_id=grant_row.actor_user_id AND n.sender_user_id=grant_row.owner_user_id
   AND actor.product_epoch=grant_row.actor_product_epoch AND owner.product_epoch=grant_row.owner_product_epoch
   AND anchor.receiver_user_id=actor.user_id AND anchor.sender_user_id=owner.user_id
   AND anchor.receiver_product_epoch=actor.product_epoch AND anchor.sender_product_epoch=owner.product_epoch
   AND n.status='seen' AND n.seen_at<grant_row.issued_at+interval '1 second' AND n.expires_at>clock_timestamp()
   AND EXISTS(SELECT 1 FROM nakh.nakh_receiver_actions action WHERE action.nakh_id=n.id
     AND action.receiver_user_id=actor.user_id AND action.action_type='view_profile' AND action.created_at=n.seen_at)
   AND actor.state='active' AND owner.state='active' AND p.completion_status='complete'
   AND session.actor_user_id=actor.user_id AND identity.user_session_epoch(session.id)=actor.product_epoch
   AND session.occurred_at<grant_row.issued_at+interval '1 second'
   AND session.occurred_at+interval '15 minutes'>clock_timestamp()
   AND NOT identity.user_session_authority_revoked(session.id)
   -- Original delivered-Nakh rights survive visibility withdrawal and receiver
   -- profile invalidity. They never authorize a new discovery or Nakh flow.
   AND NOT EXISTS(SELECT 1 FROM interaction.user_pair_states pair
     WHERE pair.user_low_id=LEAST(actor.user_id,owner.user_id) AND pair.user_high_id=GREATEST(actor.user_id,owner.user_id))
   AND photo.status='visible' AND photo.deleted_at IS NULL
   AND asset.owner_user_id=owner.user_id AND asset.validation_state='valid'
   AND asset.deleted_at IS NULL AND asset.storage_deleted_at IS NULL
   AND variant.variant_type='thumbnail' AND variant.transformation_version=1
   AND variant.delivery_path=grant_row.delivery_path AND grant_row.variant_type='thumbnail'
   AND variant.storage_key='variants/'||grant_row.environment||'/'||asset.id::text||'/thumbnail-v1.webp'
   AND variant.deleted_at IS NULL AND variant.storage_deleted_at IS NULL
 ) ELSE media.delivery_grant_pre_nakh_source_is_current(grant_row) END
$$;

-- Extend the ordinary inventory; retained erasure remains disabled.
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
 FROM jsonb_array_elements(snapshot) WITH ORDINALITY WHERE value->>'table'='media.delivery_grants';
 IF item IS NULL THEN RAISE EXCEPTION 'Nakh media schema inventory missing'; END IF;
 item:=jsonb_set(item,'{columns}',(item->'columns')||
  '[{"name":"nakh_id","type":"uuid","nullable":true}]'::jsonb);
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
 (E'home.fix_profile',E'Fix profile',E'[]'::jsonb),
 (E'home.matches',E'Matches',E'[]'::jsonb),
 (E'nakh.ui.accept',E'Accept',E'[]'::jsonb),
 (E'nakh.ui.accepted',E'You have a new Match. Open Matches to chat.',E'[]'::jsonb),
 (E'nakh.ui.back',E'Back to Nakhes',E'[]'::jsonb),
 (E'nakh.ui.cancel',E'Cancel pending Nakh',E'[]'::jsonb),
 (E'nakh.ui.cancel_info',E'Choose how to close this pending Nakh. Its place in Explore will not return.',E'[]'::jsonb),
 (E'nakh.ui.cancel_like',E'Cancel and Like',E'[]'::jsonb),
 (E'nakh.ui.cancel_reject',E'Cancel and Not interested',E'[]'::jsonb),
 (E'nakh.ui.cancelled',E'Your pending Nakh has been cancelled.',E'[]'::jsonb),
 (E'nakh.ui.close',E'Close Nakh',E'[]'::jsonb),
 (E'nakh.ui.closed',E'This Nakh is now closed.',E'[]'::jsonb),
 (E'nakh.ui.detail',E'{name}\n{status}\n{when}\n\n{text}',E'["name", "status", "text", "when"]'::jsonb),
 (E'nakh.ui.edit',E'Edit text',E'[]'::jsonb),
 (E'nakh.ui.edit_prompt',E'Reply to this message with your new Nakh text (up to 240 characters). To leave this form, send /nakhes.',E'[]'::jsonb),
 (E'nakh.ui.empty',E'Nothing here yet.',E'[]'::jsonb),
 (E'nakh.ui.expires',E'Expires {when} (UTC)',E'["when"]'::jsonb),
 (E'nakh.ui.history',E'Past pending Nakhes',E'[]'::jsonb),
 (E'nakh.ui.item',E'{name} · {status}',E'["name", "status"]'::jsonb),
 (E'nakh.ui.menu',E'Nakhes',E'[]'::jsonb),
 (E'nakh.ui.next',E'Next page',E'[]'::jsonb),
 (E'nakh.ui.pending',E'Pending',E'[]'::jsonb),
 (E'nakh.ui.profile_unavailable',E'This profile is unavailable right now. You can still check the Nakh status.',E'[]'::jsonb),
 (E'nakh.ui.received',E'Received',E'[]'::jsonb),
 (E'nakh.ui.saved',E'Your pending Nakh has been updated.',E'[]'::jsonb),
 (E'nakh.ui.sent',E'Sent',E'[]'::jsonb),
 (E'nakh.ui.status.accepted',E'Accepted',E'[]'::jsonb),
 (E'nakh.ui.status.cancelled',E'Cancelled',E'[]'::jsonb),
 (E'nakh.ui.status.closed',E'Closed',E'[]'::jsonb),
 (E'nakh.ui.status.closed_by_system',E'Closed',E'[]'::jsonb),
 (E'nakh.ui.status.expired',E'Expired',E'[]'::jsonb),
 (E'nakh.ui.status.paid_and_sent',E'Sent',E'[]'::jsonb),
 (E'nakh.ui.status.pending_payment',E'Pending',E'[]'::jsonb),
 (E'nakh.ui.status.rejected',E'Closed',E'[]'::jsonb),
 (E'nakh.ui.status.seen',E'Seen',E'[]'::jsonb),
 (E'nakh.ui.status.sent',E'Sent',E'[]'::jsonb),
 (E'nakh.ui.unavailable',E'This Nakh or action is no longer available. Open Nakhes again.',E'[]'::jsonb),
 (E'nakh.ui.view',E'View profile',E'[]'::jsonb)
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,'message',variables,true,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM seed;
