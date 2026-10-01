-- Asset locks serialize these checks with hold creation's FOR SHARE lock.
-- Hold release is a separate M8 policy operation, never ordinary media cleanup.
CREATE FUNCTION media.guard_photo_evidence_asset_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.storage_deleted_at IS DISTINCT FROM OLD.storage_deleted_at
      OR (NEW.cleanup_lease_owner IS NOT NULL
        AND NEW.cleanup_lease_owner IS DISTINCT FROM OLD.cleanup_lease_owner))
    AND EXISTS (SELECT 1 FROM media.report_photo_evidence_holds WHERE asset_id = NEW.id) THEN
    RAISE EXCEPTION 'media asset is retained as report evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'report_photo_asset_retained';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_photo_asset_retained BEFORE UPDATE ON media.media_assets
FOR EACH ROW EXECUTE FUNCTION media.guard_photo_evidence_asset_cleanup();

CREATE FUNCTION media.guard_photo_evidence_variant_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_deleted_at IS DISTINCT FROM OLD.storage_deleted_at
    AND EXISTS (SELECT 1 FROM media.report_photo_evidence_holds WHERE variant_id = NEW.id) THEN
    RAISE EXCEPTION 'media variant is retained as report evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'report_photo_variant_retained';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_photo_variant_retained BEFORE UPDATE ON media.photo_variants
FOR EACH ROW EXECUTE FUNCTION media.guard_photo_evidence_variant_cleanup();
