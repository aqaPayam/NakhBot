CREATE TABLE media.delivery_grants (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  actor_product_epoch integer NOT NULL CHECK (actor_product_epoch >= 0),
  owner_product_epoch integer NOT NULL CHECK (owner_product_epoch >= 0),
  photo_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  like_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('owner_preview', 'liked_by_blur')),
  variant_type text NOT NULL CHECK (variant_type IN ('thumbnail', 'blurred_preview')),
  delivery_path text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','test','staging','production')),
  ttl_seconds integer NOT NULL CHECK (ttl_seconds BETWEEN 10 AND 300),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_delivery_grant_scope_ck CHECK (
    (purpose='owner_preview' AND actor_user_id=owner_user_id AND like_id IS NULL AND variant_type='thumbnail')
    OR (purpose='liked_by_blur' AND actor_user_id<>owner_user_id AND like_id IS NOT NULL AND variant_type='blurred_preview')
  ),
  CONSTRAINT media_delivery_grant_path_ck CHECK (
    delivery_path='/media/' || asset_id::text || '/' ||
      CASE variant_type WHEN 'thumbnail' THEN 'thumbnail-v1.webp' ELSE 'blurred-preview-v1.webp' END
  ),
  CONSTRAINT media_delivery_grant_expiry_ck CHECK (
    issued_at=date_trunc('second',issued_at)
    AND expires_at=issued_at + ttl_seconds * interval '1 second'
  )
);

CREATE INDEX delivery_grants_actor_expiry_idx ON media.delivery_grants(actor_user_id, expires_at, id);
CREATE INDEX delivery_grants_owner_expiry_idx ON media.delivery_grants(owner_user_id, expires_at, id);

-- Original source identifiers intentionally do not reference mutable product rows.
-- Archiving a Photo or Like must revoke this grant, never prevent product purge.
CREATE FUNCTION media.delivery_grant_source_is_current(grant_row media.delivery_grants)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM identity.accounts actor_account
    JOIN identity.accounts owner_account ON owner_account.user_id=grant_row.owner_user_id
    JOIN profile.profiles owner_profile ON owner_profile.user_id=owner_account.user_id
    JOIN media.profile_photos photo ON photo.profile_id=owner_profile.id AND photo.id=grant_row.photo_id
    JOIN media.media_assets asset ON asset.id=photo.asset_id AND asset.id=grant_row.asset_id
    JOIN media.photo_variants variant ON variant.asset_id=asset.id AND variant.id=grant_row.variant_id
    WHERE actor_account.user_id=grant_row.actor_user_id
      AND actor_account.product_epoch=grant_row.actor_product_epoch
      AND owner_account.product_epoch=grant_row.owner_product_epoch
      AND asset.owner_user_id=grant_row.owner_user_id
      AND asset.validation_state='valid' AND asset.deleted_at IS NULL AND asset.storage_deleted_at IS NULL
      AND photo.deleted_at IS NULL
      AND variant.variant_type=grant_row.variant_type AND variant.transformation_version=1
      AND variant.delivery_path=grant_row.delivery_path
      AND variant.storage_key='variants/' || grant_row.environment || '/' || grant_row.asset_id::text || '/' ||
        CASE grant_row.variant_type WHEN 'thumbnail' THEN 'thumbnail-v1.webp' ELSE 'blurred-preview-v1.webp' END
      AND variant.deleted_at IS NULL AND variant.storage_deleted_at IS NULL
      AND (
        (grant_row.purpose='owner_preview' AND grant_row.actor_user_id=grant_row.owner_user_id
          AND grant_row.like_id IS NULL AND grant_row.variant_type='thumbnail'
          AND actor_account.state IN ('active','restricted') AND photo.status<>'deleted')
        OR
        (grant_row.purpose='liked_by_blur' AND grant_row.variant_type='blurred_preview'
          AND actor_account.state='active' AND owner_account.state='active'
          AND owner_profile.completion_status='complete' AND photo.status='visible' AND photo.is_primary
          AND EXISTS (
            SELECT 1 FROM profile.profiles actor_profile JOIN identity.user_settings settings
              ON settings.user_id=actor_profile.user_id
            WHERE actor_profile.user_id=grant_row.actor_user_id
              AND actor_profile.completion_status='complete' AND settings.visibility_enabled
          )
          AND EXISTS (
            SELECT 1 FROM interaction.likes incoming
            WHERE incoming.id=grant_row.like_id AND incoming.sender_user_id=grant_row.owner_user_id
              AND incoming.receiver_user_id=grant_row.actor_user_id AND incoming.status='active'
          )
          AND EXISTS (
            SELECT 1 FROM media.photo_variants thumbnail WHERE thumbnail.asset_id=asset.id
              AND thumbnail.variant_type='thumbnail' AND thumbnail.transformation_version=1
              AND thumbnail.deleted_at IS NULL AND thumbnail.storage_deleted_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM interaction.user_pair_states pair
            WHERE pair.user_low_id=LEAST(grant_row.actor_user_id,grant_row.owner_user_id)
              AND pair.user_high_id=GREATEST(grant_row.actor_user_id,grant_row.owner_user_id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM interaction.not_interested rejection
            WHERE rejection.sender_user_id=grant_row.actor_user_id
              AND rejection.receiver_user_id=grant_row.owner_user_id
          )
        )
      )
  );
$$;

CREATE FUNCTION media.guard_delivery_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'media delivery source authority is immutable' USING ERRCODE='55000';
  ELSIF TG_OP='DELETE' THEN
    -- Expired receipts are ordinary operational data. An unexpired original grant
    -- cannot be replaced with the same identifier but a newly actionable source.
    IF OLD.expires_at>clock_timestamp() THEN
      RAISE EXCEPTION 'media delivery authority has not expired' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.purpose='liked_by_blur' THEN
    PERFORM interaction.lock_user_pair(LEAST(NEW.actor_user_id,NEW.owner_user_id),GREATEST(NEW.actor_user_id,NEW.owner_user_id));
  END IF;
  PERFORM id FROM identity.users WHERE id IN (NEW.actor_user_id,NEW.owner_user_id)
    ORDER BY id FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id IN (NEW.actor_user_id,NEW.owner_user_id)
    ORDER BY user_id FOR UPDATE;
  NEW.issued_at:=date_trunc('second',clock_timestamp());
  NEW.expires_at:=NEW.issued_at + NEW.ttl_seconds * interval '1 second';
  IF NOT media.delivery_grant_source_is_current(NEW) THEN
    RAISE EXCEPTION 'media delivery lacks current original source authority' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER delivery_grant_authority_guard BEFORE INSERT OR UPDATE OR DELETE ON media.delivery_grants
FOR EACH ROW EXECUTE FUNCTION media.guard_delivery_grant();

COMMENT ON TABLE media.delivery_grants IS
  'Short-lived opaque exact-source read authority. Current source and both product epochs must be checked for every delivery. No media bytes, provider keys or retained-evidence bypass.';
