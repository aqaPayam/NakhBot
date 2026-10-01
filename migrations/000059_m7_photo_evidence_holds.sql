-- Media owns object retention. The evidence FK is deferred so capture and the
-- governing Report can be created atomically without an external storage call.
CREATE TABLE media.report_photo_evidence_holds (
  report_evidence_id uuid PRIMARY KEY REFERENCES moderation.report_evidence(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  photo_id uuid NOT NULL REFERENCES media.profile_photos(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES media.media_assets(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES media.photo_variants(id) ON DELETE RESTRICT,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  captured_primary boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE INDEX report_photo_evidence_holds_asset_idx
  ON media.report_photo_evidence_holds(asset_id);

CREATE FUNCTION media.validate_report_photo_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source media.profile_photos%ROWTYPE;
  asset media.media_assets%ROWTYPE;
  variant media.photo_variants%ROWTYPE;
BEGIN
  SELECT * INTO source FROM media.profile_photos WHERE id = NEW.photo_id FOR SHARE;
  SELECT * INTO asset FROM media.media_assets WHERE id = NEW.asset_id FOR SHARE;
  SELECT * INTO variant FROM media.photo_variants WHERE id = NEW.variant_id FOR SHARE;
  IF source.id IS NULL OR source.asset_id <> NEW.asset_id OR source.status <> 'visible'
    OR source.is_primary <> NEW.captured_primary
    OR asset.id IS NULL OR asset.validation_state <> 'valid'
    OR asset.deleted_at IS NOT NULL OR asset.storage_deleted_at IS NOT NULL
    OR asset.cleanup_lease_owner IS NOT NULL
    OR variant.id IS NULL OR variant.asset_id <> NEW.asset_id
    OR variant.variant_type <> 'thumbnail' OR variant.transformation_version <> 1
    OR variant.deleted_at IS NOT NULL OR variant.storage_deleted_at IS NOT NULL
    OR encode(variant.sha256, 'hex') <> NEW.content_sha256 THEN
    RAISE EXCEPTION 'photo evidence source is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'report_photo_hold_source_valid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_photo_hold_source_valid
BEFORE INSERT ON media.report_photo_evidence_holds
FOR EACH ROW EXECUTE FUNCTION media.validate_report_photo_hold();

CREATE FUNCTION media.validate_report_photo_hold_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM moderation.report_evidence evidence
    JOIN moderation.reports report ON report.id = evidence.report_id
    JOIN media.profile_photos photo ON photo.id = NEW.photo_id
    JOIN profile.profiles profile ON profile.id = photo.profile_id
    WHERE evidence.id = NEW.report_evidence_id AND evidence.evidence_type = 'photo'
      AND evidence.profile_photo_id = NEW.photo_id AND profile.user_id = report.target_user_id
  ) THEN
    RAISE EXCEPTION 'photo hold does not match its governing evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'report_photo_hold_binding_valid';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_photo_hold_binding_valid
AFTER INSERT ON media.report_photo_evidence_holds DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION media.validate_report_photo_hold_binding();

CREATE TRIGGER report_photo_hold_append_only
BEFORE UPDATE OR DELETE ON media.report_photo_evidence_holds
FOR EACH ROW EXECUTE FUNCTION media.deny_moderation_mutation();
COMMENT ON TABLE media.report_photo_evidence_holds IS
  'Restricted immutable exact-thumbnail retention obligations; M8 owns controlled policy release.';
