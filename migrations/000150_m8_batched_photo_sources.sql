-- Equivalent live custody membership: validate every asset property once per
-- statement, and exclude every verified private-copy witness without null poisoning.
-- A corrupt verified private copy still cannot fall back to ordinary storage.
-- The private branch and all rows, keys, captures, policies and fingerprints stay intact.
CREATE OR REPLACE VIEW media.report_photo_source_facts AS
 SELECT hold.report_evidence_id,hold.asset_id,hold.variant_id,variant.storage_key,variant.sha256,
   variant.variant_type,variant.transformation_version
 FROM media.report_photo_evidence_holds hold
 JOIN media.photo_variants variant ON variant.id=hold.variant_id AND variant.asset_id=hold.asset_id
 WHERE COALESCE(hold.asset_id IN (SELECT asset.id FROM media.media_assets asset
     WHERE asset.validation_state='valid' AND asset.storage_provider='r2'
       AND asset.storage_deleted_at IS NULL AND asset.cleanup_lease_owner IS NULL),false)
   AND variant.storage_provider='r2' AND variant.storage_deleted_at IS NULL
   AND variant.variant_type='thumbnail' AND variant.transformation_version=1
   AND encode(variant.sha256,'hex')=hold.content_sha256
   AND hold.report_evidence_id NOT IN (
     SELECT operation.evidence_id FROM identity.account_deletion_media_operations operation
     WHERE operation.kind='retain_photo' AND operation.verified_at IS NOT NULL AND operation.evidence_id IS NOT NULL)
 UNION ALL
 SELECT hold.report_evidence_id,hold.asset_id,hold.variant_id,
   'evidence/'||operation.environment||'/'||hold.report_evidence_id::text||'/thumbnail-v1.webp',variant.sha256,
   variant.variant_type,variant.transformation_version
 FROM media.report_photo_evidence_holds hold
 JOIN media.variant_reference_anchors variant ON variant.id=hold.variant_id AND variant.asset_id=hold.asset_id
 JOIN identity.account_deletion_media_operations operation ON operation.evidence_id=hold.report_evidence_id AND operation.kind='retain_photo'
 WHERE identity.deletion_private_photo_valid(hold.report_evidence_id);
