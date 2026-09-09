import type { Generated } from 'kysely';
import type { MediaValidationState, PhotoStatus, PhotoVariantType } from '@nakh/domain';

export interface MediaAssetTable {
  id: string;
  owner_user_id: string;
  source_type: 'telegram' | 'web' | 'mobile';
  transport_metadata_ciphertext: Buffer | null;
  validation_state: Generated<MediaValidationState>;
  error_code: string | null;
  version: Generated<number>;
  detected_media_type: 'image/jpeg' | 'image/png' | 'image/webp' | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  frame_count: number | null;
  original_sha256: Buffer | null;
  normalized_sha256: Buffer | null;
  storage_provider: 'r2';
  quarantine_key: string;
  validated_key: string | null;
  quarantine_size_bytes: number | null;
  quarantine_sha256: Buffer | null;
  quarantine_uploaded_at: Date | null;
  ingestion_lease_owner: string | null;
  ingestion_lease_expires_at: Date | null;
  malware_scan_result: 'clean' | null;
  malware_scanner_version: string | null;
  malware_signature_version: string | null;
  malware_scanned_at: Date | null;
  attempted_at: Date;
  uploaded_at: Date | null;
  validated_at: Date | null;
  terminal_at: Date | null;
  deleted_at: Date | null;
  storage_deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PhotoVariantTable {
  id: string;
  asset_id: string;
  variant_type: PhotoVariantType;
  transformation_version: number;
  storage_provider: 'r2';
  storage_key: string;
  delivery_path: string;
  width: number;
  height: number;
  sha256: Buffer;
  verified_at: Date;
  generated_at: Date;
  deleted_at: Date | null;
  storage_deleted_at: Date | null;
}

export interface ProfilePhotoTable {
  id: string;
  profile_id: string;
  asset_id: string;
  status: PhotoStatus;
  is_primary: Generated<boolean>;
  display_order: number;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
  hidden_at: Date | null;
  deleted_at: Date | null;
}

export interface PhotoModerationTable {
  id: string;
  photo_id: string;
  admin_user_id: string;
  action: 'hide' | 'restore' | 'delete';
  reason_code: string;
  report_id: null;
  occurred_at: Date;
}
