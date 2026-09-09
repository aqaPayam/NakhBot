ALTER TABLE media.media_assets
  ADD COLUMN quarantine_size_bytes integer
    CHECK (quarantine_size_bytes BETWEEN 1 AND 10485760),
  ADD COLUMN quarantine_sha256 bytea
    CHECK (octet_length(quarantine_sha256) = 32),
  ADD COLUMN quarantine_uploaded_at timestamptz,
  ADD CONSTRAINT quarantine_facts_complete CHECK (
    (quarantine_uploaded_at IS NULL AND quarantine_size_bytes IS NULL AND quarantine_sha256 IS NULL)
    OR (quarantine_uploaded_at IS NOT NULL AND quarantine_size_bytes IS NOT NULL
      AND quarantine_sha256 IS NOT NULL AND uploaded_at IS NOT NULL)
  );

CREATE FUNCTION media.guard_quarantine_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quarantine_uploaded_at IS NOT NULL AND (
    NEW.quarantine_size_bytes IS NULL OR NEW.quarantine_sha256 IS NULL OR NEW.uploaded_at IS NULL
  ) THEN
    RAISE EXCEPTION 'quarantine completion facts are incomplete' USING ERRCODE = '23514';
  END IF;
  IF OLD.quarantine_uploaded_at IS NOT NULL AND (
    NEW.quarantine_uploaded_at IS DISTINCT FROM OLD.quarantine_uploaded_at
    OR NEW.quarantine_size_bytes IS DISTINCT FROM OLD.quarantine_size_bytes
    OR NEW.quarantine_sha256 IS DISTINCT FROM OLD.quarantine_sha256
    OR NEW.quarantine_key IS DISTINCT FROM OLD.quarantine_key
    OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at
  ) THEN
    RAISE EXCEPTION 'quarantine completion is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_asset_quarantine_completion BEFORE UPDATE ON media.media_assets
  FOR EACH ROW EXECUTE FUNCTION media.guard_quarantine_completion();
