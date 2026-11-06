-- An interactive Like grant names its original unlock and native sign-in.
-- Ordinary source identifiers deliberately have no FK: deleting the source revokes access.
ALTER TABLE media.delivery_grants ADD COLUMN feature_unlock_id uuid;
ALTER TABLE media.delivery_grants DROP CONSTRAINT media_delivery_grant_scope_ck;
ALTER TABLE media.delivery_grants ADD CONSTRAINT media_delivery_grant_scope_ck CHECK (
 (purpose='owner_preview' AND actor_user_id=owner_user_id AND like_id IS NULL
   AND variant_type='thumbnail' AND candidate_delivery_id IS NULL AND session_grant_id IS NULL AND feature_unlock_id IS NULL)
 OR (purpose='liked_by_blur' AND actor_user_id<>owner_user_id AND like_id IS NOT NULL
   AND variant_type='blurred_preview' AND candidate_delivery_id IS NULL AND feature_unlock_id IS NULL)
 OR (purpose IN ('profile_card','profile_detail') AND actor_user_id<>owner_user_id
   AND like_id IS NULL AND variant_type='thumbnail' AND candidate_delivery_id IS NOT NULL
   AND session_grant_id IS NOT NULL AND feature_unlock_id IS NULL)
 OR (purpose='profile_detail' AND actor_user_id<>owner_user_id AND like_id IS NOT NULL
   AND variant_type='thumbnail' AND candidate_delivery_id IS NULL
   AND session_grant_id IS NOT NULL AND feature_unlock_id IS NOT NULL)
);

ALTER FUNCTION media.delivery_grant_source_is_current(media.delivery_grants)
 RENAME TO delivery_grant_pre_like_source_is_current;
CREATE FUNCTION media.delivery_grant_source_is_current(grant_row media.delivery_grants)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT CASE
 WHEN grant_row.purpose='profile_detail' AND grant_row.like_id IS NOT NULL THEN EXISTS (
  SELECT 1 FROM interaction.feature_unlocks unlock
  JOIN interaction.feature_unlock_reference_anchors anchor ON anchor.id=unlock.id
  JOIN interaction.current_like_lives incoming ON incoming.id=unlock.like_id
  JOIN identity.accounts actor ON actor.user_id=incoming.receiver_user_id
  JOIN identity.accounts owner ON owner.user_id=incoming.sender_user_id
  JOIN profile.profiles actor_profile ON actor_profile.user_id=actor.user_id
  JOIN identity.user_settings settings ON settings.user_id=actor.user_id
  JOIN profile.profiles profile ON profile.user_id=owner.user_id
  JOIN platform.audit_logs session ON session.id=grant_row.session_grant_id
  JOIN media.profile_photos photo ON photo.profile_id=profile.id AND photo.id=grant_row.photo_id
  JOIN media.media_assets asset ON asset.id=photo.asset_id AND asset.id=grant_row.asset_id
  JOIN media.photo_variants variant ON variant.asset_id=asset.id AND variant.id=grant_row.variant_id
  WHERE unlock.id=grant_row.feature_unlock_id AND unlock.like_id=grant_row.like_id
   AND unlock.feature_type='liked_by_profile_unlock' AND unlock.payer_user_id=actor.user_id
   AND unlock.status='active' AND unlock.revoked_at IS NULL AND unlock.expired_at IS NULL
   AND (unlock.expires_at IS NULL OR unlock.expires_at>clock_timestamp())
   AND unlock.unlocked_at<grant_row.issued_at+interval '1 second'
   AND anchor.payer_user_id=actor.user_id AND anchor.payer_product_epoch=actor.product_epoch
   AND anchor.feature_type=unlock.feature_type AND anchor.like_id=incoming.id
   AND incoming.status='active' AND actor.user_id=grant_row.actor_user_id AND owner.user_id=grant_row.owner_user_id
   AND actor.product_epoch=grant_row.actor_product_epoch AND owner.product_epoch=grant_row.owner_product_epoch
   AND actor.state='active' AND owner.state='active' AND settings.visibility_enabled
   AND actor_profile.completion_status='complete' AND profile.completion_status='complete'
   AND session.actor_user_id=actor.user_id AND identity.user_session_epoch(session.id)=actor.product_epoch
   AND session.occurred_at<grant_row.issued_at+interval '1 second'
   AND session.occurred_at+interval '15 minutes'>clock_timestamp()
   AND NOT identity.user_session_authority_revoked(session.id)
   -- Visibility or changed preferences never retract a sent Like.
   AND NOT EXISTS (SELECT 1 FROM interaction.user_pair_states pair
     WHERE pair.user_low_id=LEAST(actor.user_id,owner.user_id) AND pair.user_high_id=GREATEST(actor.user_id,owner.user_id))
   AND NOT EXISTS (SELECT 1 FROM interaction.not_interested rejection
     WHERE rejection.sender_user_id=actor.user_id AND rejection.receiver_user_id=owner.user_id)
   AND EXISTS (SELECT 1 FROM media.profile_photos primary_photo
     JOIN media.media_assets primary_asset ON primary_asset.id=primary_photo.asset_id
     JOIN media.photo_variants thumbnail ON thumbnail.asset_id=primary_asset.id
     WHERE primary_photo.profile_id=profile.id AND primary_photo.status='visible' AND primary_photo.is_primary
      AND primary_photo.deleted_at IS NULL AND primary_asset.owner_user_id=owner.user_id
      AND primary_asset.validation_state='valid' AND primary_asset.deleted_at IS NULL AND primary_asset.storage_deleted_at IS NULL
      AND thumbnail.variant_type='thumbnail' AND thumbnail.transformation_version=1
      AND thumbnail.deleted_at IS NULL AND thumbnail.storage_deleted_at IS NULL)
   AND photo.status='visible' AND photo.deleted_at IS NULL
   AND asset.owner_user_id=owner.user_id AND asset.validation_state='valid'
   AND asset.deleted_at IS NULL AND asset.storage_deleted_at IS NULL
   AND variant.variant_type='thumbnail' AND variant.transformation_version=1
   AND variant.delivery_path=grant_row.delivery_path AND grant_row.variant_type='thumbnail'
   AND variant.storage_key='variants/'||grant_row.environment||'/'||asset.id::text||'/thumbnail-v1.webp'
   AND variant.deleted_at IS NULL AND variant.storage_deleted_at IS NULL
 )
 WHEN grant_row.purpose='liked_by_blur' AND grant_row.session_grant_id IS NOT NULL THEN
  media.delivery_grant_pre_like_source_is_current(grant_row) AND EXISTS (
   SELECT 1 FROM platform.audit_logs session JOIN interaction.current_like_lives incoming ON incoming.id=grant_row.like_id
   WHERE session.id=grant_row.session_grant_id AND session.actor_user_id=grant_row.actor_user_id
    AND identity.user_session_epoch(session.id)=grant_row.actor_product_epoch
    AND session.occurred_at<grant_row.issued_at+interval '1 second'
    AND session.occurred_at+interval '15 minutes'>clock_timestamp()
    AND NOT identity.user_session_authority_revoked(session.id)
    AND incoming.sender_user_id=grant_row.owner_user_id AND incoming.receiver_user_id=grant_row.actor_user_id
    AND incoming.status='active')
 ELSE media.delivery_grant_pre_like_source_is_current(grant_row) END
$$;

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
 FROM jsonb_array_elements(snapshot) WITH ORDINALITY WHERE value->>'table'='media.delivery_grants';
 IF item IS NULL THEN RAISE EXCEPTION 'media grant schema inventory missing'; END IF;
 item:=jsonb_set(item,'{columns}',(item->'columns')||
  '[{"name":"feature_unlock_id","type":"uuid","nullable":true}]'::jsonb);
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
