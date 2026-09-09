ALTER TABLE media.media_assets
  ADD COLUMN validation_lease_owner text,
  ADD COLUMN validation_lease_expires_at timestamptz,
  ADD CONSTRAINT media_asset_validation_lease_shape CHECK (
    (validation_lease_owner IS NULL AND validation_lease_expires_at IS NULL)
    OR (validation_lease_owner IS NOT NULL AND length(validation_lease_owner) BETWEEN 1 AND 128
      AND validation_lease_expires_at IS NOT NULL)
  );

CREATE INDEX media_asset_validation_claim_idx
  ON media.media_assets (validation_lease_expires_at, quarantine_uploaded_at, id)
  WHERE validation_state = 'pending' AND quarantine_uploaded_at IS NOT NULL AND deleted_at IS NULL;

CREATE FUNCTION media.guard_validation_lease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.validation_state <> 'pending' AND
    (NEW.validation_lease_owner IS NOT NULL OR NEW.validation_lease_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'terminal media cannot retain validation lease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_asset_validation_lease_guard BEFORE INSERT OR UPDATE ON media.media_assets
  FOR EACH ROW EXECUTE FUNCTION media.guard_validation_lease();
