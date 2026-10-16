-- Candidate and session identifiers refer to original mutable sources without
-- foreign keys: deletion may purge those sources and must revoke delivery.
ALTER TABLE media.delivery_grants
  ADD COLUMN candidate_delivery_id uuid,
  ADD COLUMN session_grant_id uuid,
  DROP CONSTRAINT delivery_grants_purpose_check,
  DROP CONSTRAINT media_delivery_grant_scope_ck;
ALTER TABLE media.delivery_grants
  ADD CONSTRAINT delivery_grants_purpose_check CHECK
    (purpose IN ('owner_preview','liked_by_blur','profile_card','profile_detail')),
  ADD CONSTRAINT media_delivery_grant_scope_ck CHECK (
    (purpose='owner_preview' AND actor_user_id=owner_user_id AND like_id IS NULL
      AND variant_type='thumbnail' AND candidate_delivery_id IS NULL AND session_grant_id IS NULL)
    OR (purpose='liked_by_blur' AND actor_user_id<>owner_user_id AND like_id IS NOT NULL
      AND variant_type='blurred_preview' AND candidate_delivery_id IS NULL AND session_grant_id IS NULL)
    OR (purpose IN ('profile_card','profile_detail') AND actor_user_id<>owner_user_id
      AND like_id IS NULL AND variant_type='thumbnail'
      AND candidate_delivery_id IS NOT NULL AND session_grant_id IS NOT NULL)
  );

ALTER FUNCTION media.delivery_grant_source_is_current(media.delivery_grants)
  RENAME TO delivery_grant_legacy_source_is_current;
CREATE FUNCTION media.delivery_grant_source_is_current(grant_row media.delivery_grants)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT CASE WHEN grant_row.purpose IN ('owner_preview','liked_by_blur')
 THEN media.delivery_grant_legacy_source_is_current(grant_row)
 ELSE EXISTS (
  SELECT 1 FROM discovery.candidate_deliveries delivery
  JOIN identity.accounts actor ON actor.user_id=delivery.viewer_user_id
  JOIN identity.accounts owner ON owner.user_id=delivery.target_user_id
  JOIN platform.audit_logs session ON session.id=grant_row.session_grant_id
  JOIN profile.profiles profile ON profile.user_id=owner.user_id
  JOIN identity.user_settings settings ON settings.user_id=owner.user_id
  JOIN catalog.countries country ON country.id=profile.country_id
  JOIN catalog.cities city ON city.id=profile.city_id
  JOIN catalog.gender_options gender ON gender.id=profile.gender_option_id
  JOIN catalog.gender_preferences preference ON preference.id=profile.gender_preference_id
  JOIN catalog.relationship_goals goal ON goal.id=profile.relationship_goal_id
  JOIN media.profile_photos photo ON photo.profile_id=profile.id AND photo.id=grant_row.photo_id
  JOIN media.media_assets asset ON asset.id=photo.asset_id AND asset.id=grant_row.asset_id
  JOIN media.photo_variants variant ON variant.asset_id=asset.id AND variant.id=grant_row.variant_id
  WHERE grant_row.purpose IN ('profile_card','profile_detail') AND grant_row.like_id IS NULL
   AND grant_row.variant_type='thumbnail'
   AND delivery.id=grant_row.candidate_delivery_id
   AND delivery.viewer_user_id=grant_row.actor_user_id AND delivery.target_user_id=grant_row.owner_user_id
   AND delivery.state IN ('reserved','delivered') AND delivery.reserved_at<grant_row.issued_at+interval '1 second'
   AND actor.product_epoch=grant_row.actor_product_epoch AND owner.product_epoch=grant_row.owner_product_epoch
   AND owner.state='active' AND profile.completion_status='complete' AND settings.visibility_enabled
   AND country.code='iran' AND country.is_active AND city.is_active
   AND gender.is_active AND preference.is_active AND goal.is_active
   AND ((delivery.mode='guest_preview' AND actor.state IN ('guest','incomplete')) OR
    (delivery.mode='explore' AND actor.state='active' AND EXISTS (
      SELECT 1 FROM profile.profiles viewer JOIN identity.user_settings viewer_settings ON viewer_settings.user_id=viewer.user_id
      WHERE viewer.user_id=actor.user_id AND viewer.completion_status='complete' AND viewer_settings.visibility_enabled)))
   -- Immutable native grant shape and original life are independently checked.
   AND session.actor_user_id=actor.user_id AND identity.user_session_epoch(session.id)=actor.product_epoch
   AND session.occurred_at<grant_row.issued_at+interval '1 second'
   AND session.occurred_at+interval '15 minutes'>clock_timestamp()
   AND NOT identity.user_session_authority_revoked(session.id)
   -- An old reservation may never select a returned account's new product life.
   AND NOT EXISTS (SELECT 1 FROM identity.account_deletion_records root
     WHERE root.user_id IN (actor.user_id,owner.user_id) AND root.requested_at>=delivery.reserved_at)
   AND photo.status='visible' AND photo.deleted_at IS NULL
   AND (grant_row.purpose='profile_detail' OR photo.is_primary)
   AND EXISTS (SELECT 1 FROM media.profile_photos primary_photo
     JOIN media.media_assets primary_asset ON primary_asset.id=primary_photo.asset_id
     JOIN media.photo_variants primary_variant ON primary_variant.asset_id=primary_asset.id
     WHERE primary_photo.profile_id=profile.id AND primary_photo.status='visible' AND primary_photo.is_primary
      AND primary_photo.deleted_at IS NULL AND primary_asset.owner_user_id=owner.user_id
      AND primary_asset.validation_state='valid' AND primary_asset.deleted_at IS NULL AND primary_asset.storage_deleted_at IS NULL
      AND primary_variant.variant_type='thumbnail' AND primary_variant.transformation_version=1
      AND primary_variant.deleted_at IS NULL AND primary_variant.storage_deleted_at IS NULL)
   AND asset.owner_user_id=owner.user_id AND asset.validation_state='valid'
   AND asset.deleted_at IS NULL AND asset.storage_deleted_at IS NULL
   AND variant.variant_type='thumbnail' AND variant.transformation_version=1
   AND variant.delivery_path=grant_row.delivery_path
   AND variant.storage_key='variants/'||grant_row.environment||'/'||asset.id::text||'/thumbnail-v1.webp'
   AND variant.deleted_at IS NULL AND variant.storage_deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM interaction.user_pair_states pair
     WHERE pair.user_low_id=LEAST(actor.user_id,owner.user_id) AND pair.user_high_id=GREATEST(actor.user_id,owner.user_id)
      AND (delivery.mode='explore' OR pair.state='blocked'))
   AND (delivery.mode='guest_preview' OR NOT EXISTS (SELECT 1 FROM interaction.not_interested rejection
     WHERE (rejection.sender_user_id=actor.user_id AND rejection.receiver_user_id=owner.user_id)
       OR (rejection.sender_user_id=owner.user_id AND rejection.receiver_user_id=actor.user_id)))
 ) END
$$;

DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('media.guard_delivery_grant()'::regprocedure) INTO definition;
 IF position('NEW.purpose=''liked_by_blur''' IN definition)=0 THEN
  RAISE EXCEPTION 'media grant lock shape changed' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,'NEW.purpose=''liked_by_blur''',
  'NEW.purpose IN (''liked_by_blur'',''profile_card'',''profile_detail'')');
 EXECUTE definition;
END $$;

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
  '[{"name":"candidate_delivery_id","type":"uuid","nullable":true},{"name":"session_grant_id","type":"uuid","nullable":true}]'::jsonb);
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
 SELECT pg_get_functiondef('identity.guard_retention_record()'::regprocedure) INTO definition;
 IF position('IF identity.retention_record_valid(NEW) IS NOT TRUE' IN definition)=0 THEN
  RAISE EXCEPTION 'retention insertion guard changed'; END IF;
 definition:=replace(definition,'IF identity.retention_record_valid(NEW) IS NOT TRUE',
  'IF NEW.registry_hash<>identity.retention_registry_hash() OR identity.retention_record_valid(NEW) IS NOT TRUE');
 EXECUTE definition;
END $$;
