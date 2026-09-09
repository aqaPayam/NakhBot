ALTER TABLE media.media_assets
  ADD COLUMN ingestion_lease_owner text,
  ADD COLUMN ingestion_lease_expires_at timestamptz,
  ADD COLUMN malware_scan_result text CHECK (malware_scan_result IN ('clean')),
  ADD COLUMN malware_scanner_version text,
  ADD COLUMN malware_signature_version text,
  ADD COLUMN malware_scanned_at timestamptz,
  ADD CONSTRAINT media_asset_ingestion_lease_shape CHECK (
    (ingestion_lease_owner IS NULL AND ingestion_lease_expires_at IS NULL)
    OR (ingestion_lease_owner IS NOT NULL AND length(ingestion_lease_owner) BETWEEN 1 AND 128
      AND ingestion_lease_expires_at IS NOT NULL)
  );

ALTER TABLE media.media_assets ADD CONSTRAINT media_asset_clean_scan_before_completion CHECK (
  quarantine_uploaded_at IS NULL OR (
    malware_scan_result = 'clean'
    AND length(malware_scanner_version) BETWEEN 1 AND 128
    AND length(malware_signature_version) BETWEEN 1 AND 128
    AND malware_scanned_at IS NOT NULL
  )
);

CREATE INDEX media_asset_ingestion_claim_idx
  ON media.media_assets (ingestion_lease_expires_at, attempted_at, id)
  WHERE validation_state = 'pending' AND quarantine_uploaded_at IS NULL AND deleted_at IS NULL;

CREATE FUNCTION media.guard_ingestion_lease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quarantine_uploaded_at IS NOT NULL AND
    (NEW.ingestion_lease_owner IS NOT NULL OR NEW.ingestion_lease_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'completed quarantine cannot retain ingestion lease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_asset_ingestion_lease_guard BEFORE INSERT OR UPDATE ON media.media_assets
  FOR EACH ROW EXECUTE FUNCTION media.guard_ingestion_lease();
