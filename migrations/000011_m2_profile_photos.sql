CREATE TABLE media.photo_variants (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES media.media_assets(id),
  variant_type text NOT NULL CHECK (variant_type IN ('thumbnail', 'blurred_preview')),
  transformation_version integer NOT NULL CHECK (transformation_version > 0),
  storage_provider text NOT NULL CHECK (storage_provider = 'r2'),
  storage_key text NOT NULL UNIQUE,
  delivery_path text NOT NULL UNIQUE,
  width integer NOT NULL CHECK (width BETWEEN 1 AND 12000),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 12000),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  verified_at timestamptz NOT NULL,
  generated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  storage_deleted_at timestamptz,
  UNIQUE (asset_id, variant_type, transformation_version),
  CHECK (storage_deleted_at IS NULL OR deleted_at IS NOT NULL)
);

CREATE TABLE media.profile_photos (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profile.profiles(id),
  asset_id uuid NOT NULL UNIQUE REFERENCES media.media_assets(id),
  status text NOT NULL CHECK (status IN ('visible', 'hidden', 'deleted')),
  is_primary boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL CHECK (display_order >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  hidden_at timestamptz,
  deleted_at timestamptz,
  CHECK (NOT is_primary OR status = 'visible'),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK ((status = 'hidden') = (hidden_at IS NOT NULL))
);
CREATE UNIQUE INDEX profile_photos_primary_unique ON media.profile_photos(profile_id)
  WHERE is_primary AND status = 'visible';
CREATE UNIQUE INDEX profile_photos_order_unique ON media.profile_photos(profile_id, display_order)
  WHERE status <> 'deleted';
CREATE INDEX profile_photos_status_order_idx ON media.profile_photos(profile_id, status, display_order);

-- Writers lock User -> Profile -> assets/photos in stable ID order. The Profile lock
-- also protects slot counts when assignments are inserted directly by a worker.
CREATE FUNCTION media.guard_photo_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile_owner uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.profile_id <> OLD.profile_id OR NEW.asset_id <> OLD.asset_id THEN
      RAISE EXCEPTION 'photo assignment is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
      RAISE EXCEPTION 'photo deletion is terminal' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT user_id INTO profile_owner FROM profile.profiles WHERE id = NEW.profile_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM media.media_assets WHERE id = NEW.asset_id AND owner_user_id = profile_owner) THEN
    RAISE EXCEPTION 'photo owner mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'deleted' THEN
    IF (SELECT count(*) FROM media.profile_photos
      WHERE profile_id = NEW.profile_id AND status <> 'deleted' AND id <> NEW.id) >= 6 THEN
      RAISE EXCEPTION 'photo saved limit exceeded' USING ERRCODE = '23514';
    END IF;
    PERFORM id FROM media.media_assets WHERE id = NEW.asset_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM media.media_assets a JOIN media.photo_variants v ON v.asset_id = a.id
      WHERE a.id = NEW.asset_id AND a.validation_state = 'valid' AND a.deleted_at IS NULL
        AND a.storage_deleted_at IS NULL AND v.variant_type = 'thumbnail' AND v.transformation_version = 1
        AND v.deleted_at IS NULL AND v.storage_deleted_at IS NULL) THEN
      RAISE EXCEPTION 'photo requires validated asset and verified thumbnail' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profile_photo_assignment BEFORE INSERT OR UPDATE ON media.profile_photos
  FOR EACH ROW EXECUTE FUNCTION media.guard_photo_assignment();

CREATE TABLE media.photo_moderation_records (
  id uuid PRIMARY KEY,
  photo_id uuid NOT NULL REFERENCES media.profile_photos(id),
  admin_user_id uuid NOT NULL REFERENCES administration.admin_users(id),
  action text NOT NULL CHECK (action IN ('hide', 'restore', 'delete')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  report_id uuid,
  occurred_at timestamptz NOT NULL
);
COMMENT ON COLUMN media.photo_moderation_records.report_id IS 'Reserved for M7 report FK; must remain NULL until that migration.';
ALTER TABLE media.photo_moderation_records ADD CONSTRAINT media_report_not_yet_available CHECK (report_id IS NULL);
CREATE INDEX photo_moderation_photo_time_idx ON media.photo_moderation_records(photo_id, occurred_at);
CREATE FUNCTION media.deny_moderation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'media moderation history is append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER photo_moderation_append_only BEFORE UPDATE OR DELETE ON media.photo_moderation_records
  FOR EACH ROW EXECUTE FUNCTION media.deny_moderation_mutation();
