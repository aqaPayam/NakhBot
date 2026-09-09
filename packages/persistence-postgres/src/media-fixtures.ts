import { createHash, randomUUID } from 'node:crypto';
import type { NakhDatabase } from './database.js';

/** Synthetic database fixtures only. No real image or storage verification is performed.
 * Production valid-state writes belong to the verified PR4 worker, never this helper. */
export async function seedValidMedia(
  database: NakhDatabase,
  userId: string,
  assetId = randomUUID(),
  thumbnail = true,
  attemptedAt = new Date(),
): Promise<string> {
  const now = new Date();
  const checksum = createHash('sha256').update(assetId).digest();
  await database
    .insertInto('media.media_assets')
    .values({
      id: assetId,
      owner_user_id: userId,
      source_type: 'telegram',
      transport_metadata_ciphertext: null,
      validation_state: 'valid',
      error_code: null,
      detected_media_type: 'image/jpeg',
      size_bytes: 1024,
      width: 600,
      height: 600,
      frame_count: 1,
      original_sha256: checksum,
      normalized_sha256: checksum,
      storage_provider: 'r2',
      quarantine_key: `quarantine/test/${assetId}/original`,
      validated_key: `validated/test/${assetId}/original`,
      quarantine_size_bytes: 1024,
      quarantine_sha256: checksum,
      quarantine_uploaded_at: now,
      ingestion_lease_owner: null,
      ingestion_lease_expires_at: null,
      malware_scan_result: 'clean',
      malware_scanner_version: 'synthetic-test-scanner',
      malware_signature_version: 'synthetic-test-signatures',
      malware_scanned_at: now,
      validation_lease_owner: null,
      validation_lease_expires_at: null,
      attempted_at: attemptedAt,
      uploaded_at: now,
      validated_at: now,
      terminal_at: now,
      deleted_at: null,
      storage_deleted_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  if (thumbnail)
    await database
      .insertInto('media.photo_variants')
      .values({
        id: randomUUID(),
        asset_id: assetId,
        variant_type: 'thumbnail',
        transformation_version: 1,
        storage_provider: 'r2',
        storage_key: `variants/test/${assetId}/thumbnail-v1.webp`,
        delivery_path: `/test/${assetId}/thumbnail-v1.webp`,
        width: 300,
        height: 300,
        sha256: checksum,
        generated_at: now,
        verified_at: now,
        deleted_at: null,
        storage_deleted_at: null,
      })
      .execute();
  return assetId;
}
