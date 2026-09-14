ALTER TABLE media.media_assets
  ADD COLUMN cleanup_lease_owner text,
  ADD COLUMN cleanup_lease_expires_at timestamptz,
  ADD CONSTRAINT media_asset_cleanup_lease_shape CHECK (
    (cleanup_lease_owner IS NULL AND cleanup_lease_expires_at IS NULL)
    OR (cleanup_lease_owner IS NOT NULL AND length(cleanup_lease_owner) BETWEEN 1 AND 128
      AND cleanup_lease_expires_at IS NOT NULL AND deleted_at IS NOT NULL
      AND storage_deleted_at IS NULL)
  ),
  ADD CONSTRAINT media_asset_quarantine_key_shape CHECK (
    quarantine_key ~ '^quarantine/(development|test|staging|production)/[0-9a-f-]{36}/original$'
    AND split_part(quarantine_key, '/', 3) = id::text
  ),
  ADD CONSTRAINT media_asset_validated_key_shape CHECK (
    validated_key IS NULL OR (
      validated_key ~ '^validated/(development|test|staging|production)/[0-9a-f-]{36}/original$'
      AND split_part(validated_key, '/', 3) = id::text
    )
  );

ALTER TABLE media.photo_variants
  ADD CONSTRAINT media_variant_storage_key_shape CHECK (
    storage_key ~ '^variants/(development|test|staging|production)/[0-9a-f-]{36}/(thumbnail|blurred-preview)-v[1-9][0-9]*\.webp$'
    AND split_part(storage_key, '/', 3) = asset_id::text
  ),
  ADD CONSTRAINT media_variant_delivery_path_shape CHECK (
    delivery_path = '/media/' || asset_id::text || '/'
      || CASE variant_type
        WHEN 'thumbnail' THEN 'thumbnail-v'
        ELSE 'blurred-preview-v'
      END || transformation_version::text || '.webp'
  );

CREATE INDEX media_asset_cleanup_claim_idx
  ON media.media_assets (cleanup_lease_expires_at, deleted_at, id)
  WHERE deleted_at IS NOT NULL AND storage_deleted_at IS NULL;

CREATE FUNCTION media.guard_cleanup_lease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_deleted_at IS NOT NULL AND
    (NEW.cleanup_lease_owner IS NOT NULL OR NEW.cleanup_lease_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'purged media cannot retain cleanup lease' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.storage_deleted_at IS NOT NULL
      AND NEW.storage_deleted_at IS DISTINCT FROM OLD.storage_deleted_at THEN
      RAISE EXCEPTION 'media storage deletion is terminal' USING ERRCODE = '23514';
    END IF;
    IF OLD.validation_state = 'valid' AND NEW.validated_key IS DISTINCT FROM OLD.validated_key THEN
      RAISE EXCEPTION 'validated media key is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_asset_cleanup_guard BEFORE INSERT OR UPDATE ON media.media_assets
  FOR EACH ROW EXECUTE FUNCTION media.guard_cleanup_lease();

CREATE FUNCTION media.guard_variant_storage_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.asset_id <> OLD.asset_id OR NEW.variant_type <> OLD.variant_type
    OR NEW.transformation_version <> OLD.transformation_version
    OR NEW.storage_provider <> OLD.storage_provider OR NEW.storage_key <> OLD.storage_key
    OR NEW.delivery_path <> OLD.delivery_path OR NEW.sha256 <> OLD.sha256 THEN
    RAISE EXCEPTION 'media variant storage identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'media variant deletion is terminal' USING ERRCODE = '23514';
  END IF;
  IF OLD.storage_deleted_at IS NOT NULL
    AND NEW.storage_deleted_at IS DISTINCT FROM OLD.storage_deleted_at THEN
    RAISE EXCEPTION 'media variant storage deletion is terminal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_variant_storage_identity_guard BEFORE UPDATE ON media.photo_variants
  FOR EACH ROW EXECUTE FUNCTION media.guard_variant_storage_identity();
