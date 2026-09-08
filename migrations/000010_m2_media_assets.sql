CREATE SCHEMA media;

-- An asset is also the durable upload-attempt record, including coarse rejections.
CREATE TABLE media.media_assets (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  source_type text NOT NULL CHECK (source_type IN ('telegram', 'web', 'mobile')),
  transport_metadata_ciphertext bytea,
  validation_state text NOT NULL DEFAULT 'pending'
    CHECK (validation_state IN ('pending', 'valid', 'rejected', 'failed')),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  detected_media_type text CHECK (detected_media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer CHECK (size_bytes BETWEEN 1 AND 10485760),
  width integer CHECK (width BETWEEN 600 AND 12000),
  height integer CHECK (height BETWEEN 600 AND 12000),
  frame_count integer CHECK (frame_count = 1),
  original_sha256 bytea CHECK (octet_length(original_sha256) = 32),
  normalized_sha256 bytea CHECK (octet_length(normalized_sha256) = 32),
  storage_provider text NOT NULL CHECK (storage_provider = 'r2'),
  quarantine_key text NOT NULL UNIQUE,
  validated_key text UNIQUE,
  attempted_at timestamptz NOT NULL,
  uploaded_at timestamptz,
  validated_at timestamptz,
  terminal_at timestamptz,
  deleted_at timestamptz,
  storage_deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (width::bigint * height <= 40000000),
  CHECK ((validation_state IN ('pending', 'valid') AND error_code IS NULL)
    OR (validation_state IN ('rejected', 'failed') AND error_code IS NOT NULL)),
  CHECK ((validation_state = 'pending') = (terminal_at IS NULL)),
  CHECK (storage_deleted_at IS NULL OR deleted_at IS NOT NULL),
  CONSTRAINT media_asset_valid_facts CHECK (validation_state <> 'valid' OR (
    detected_media_type IS NOT NULL AND size_bytes IS NOT NULL
    AND width IS NOT NULL AND height IS NOT NULL AND frame_count = 1
    AND frame_count IS NOT NULL AND original_sha256 IS NOT NULL
    AND normalized_sha256 IS NOT NULL AND validated_key IS NOT NULL
    AND uploaded_at IS NOT NULL AND validated_at IS NOT NULL
    AND transport_metadata_ciphertext IS NULL
  )),
  CHECK (transport_metadata_ciphertext IS NULL OR octet_length(transport_metadata_ciphertext) BETWEEN 1 AND 8192)
);
CREATE INDEX media_assets_owner_attempt_idx ON media.media_assets(owner_user_id, attempted_at DESC);
CREATE INDEX media_assets_owner_upload_idx ON media.media_assets(owner_user_id, uploaded_at DESC);
CREATE UNIQUE INDEX media_assets_active_hash_unique
  ON media.media_assets(owner_user_id, normalized_sha256)
  WHERE validation_state = 'valid' AND deleted_at IS NULL;

CREATE FUNCTION media.guard_asset_identity_and_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.owner_user_id <> OLD.owner_user_id
    OR NEW.attempted_at <> OLD.attempted_at OR NEW.source_type <> OLD.source_type
    OR NEW.quarantine_key <> OLD.quarantine_key OR NEW.storage_provider <> OLD.storage_provider THEN
    RAISE EXCEPTION 'media asset identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.validation_state <> 'pending' AND NEW.validation_state <> OLD.validation_state THEN
    RAISE EXCEPTION 'media validation is terminal' USING ERRCODE = '23514';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'media deletion is terminal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_asset_identity_and_state BEFORE UPDATE ON media.media_assets
  FOR EACH ROW EXECUTE FUNCTION media.guard_asset_identity_and_state();
