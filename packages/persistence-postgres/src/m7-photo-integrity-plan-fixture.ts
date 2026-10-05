import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';
import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';

export type M7RetainedPhotoFixture = Readonly<{
  evidence: number;
  intact: number;
  hashDrift: number;
  storageDrift: number;
}>;

/** Isolated metadata fixtures, with caller-owned trigger/FK bypass and rollback.
 * No object upload, native capture or cryptographic authentication is claimed. */
export async function seedM7PhotoIntegrityPlans(
  database: NakhDatabase,
  prefix: string,
  volume: number,
  at: Date,
): Promise<M7RetainedPhotoFixture> {
  await sql`INSERT INTO media.media_assets
    (id,owner_user_id,source_type,validation_state,detected_media_type,size_bytes,width,height,frame_count,
      original_sha256,normalized_sha256,storage_provider,quarantine_key,validated_key,
      attempted_at,uploaded_at,validated_at,terminal_at,deleted_at,storage_deleted_at,created_at,updated_at)
    SELECT asset,md5(${prefix} || 'target' || (n % 64))::uuid,'web','valid','image/webp',1024,600,600,1,
      decode(repeat('a',64),'hex'),decode(md5(asset::text) || md5(asset::text),'hex'),'r2',
      'quarantine/test/' || asset::text || '/original','validated/test/' || asset::text || '/original',
      ${at}::timestamptz,${at}::timestamptz,${at}::timestamptz,${at}::timestamptz,
      CASE WHEN n % 2 <> 0 THEN ${at}::timestamptz ELSE NULL END,
      CASE WHEN n % 8 = 7 THEN ${at}::timestamptz ELSE NULL END,${at}::timestamptz,${at}::timestamptz
    FROM (SELECT n,md5(${prefix} || 'photo-asset' || n)::uuid AS asset FROM generate_series(1,${volume}) n) fixture`.execute(
    database,
  );
  await sql`INSERT INTO media.photo_variants
    (id,asset_id,variant_type,transformation_version,storage_provider,storage_key,delivery_path,
      width,height,sha256,verified_at,generated_at,deleted_at,storage_deleted_at)
    SELECT md5(${prefix} || 'photo-variant' || n)::uuid,asset,'thumbnail',1,'r2',
      'variants/test/' || asset::text || '/thumbnail-v1.webp','/media/' || asset::text || '/thumbnail-v1.webp',
      600,600,decode(repeat('a',64),'hex'),${at}::timestamptz,${at}::timestamptz,
      CASE WHEN n % 2 <> 0 THEN ${at}::timestamptz ELSE NULL END,
      CASE WHEN n % 8 = 3 THEN ${at}::timestamptz ELSE NULL END
    FROM (SELECT n,md5(${prefix} || 'photo-asset' || n)::uuid AS asset FROM generate_series(1,${volume}) n) fixture`.execute(
    database,
  );
  await sql`INSERT INTO media.profile_photos
    (id,profile_id,asset_id,status,is_primary,display_order,created_at,updated_at,hidden_at,deleted_at)
    SELECT md5(${prefix} || 'retained-photo' || n)::uuid,md5(${prefix} || 'profile' || n)::uuid,
      md5(${prefix} || 'photo-asset' || n)::uuid,
      CASE WHEN n % 2 = 0 THEN 'hidden' ELSE 'deleted' END,false,0,${at}::timestamptz,${at}::timestamptz,
      CASE WHEN n % 2 = 0 THEN ${at}::timestamptz ELSE NULL END,
      CASE WHEN n % 2 <> 0 THEN ${at}::timestamptz ELSE NULL END
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO moderation.report_evidence (id,report_id,evidence_type,profile_photo_id)
    SELECT md5(${prefix} || 'photo-evidence' || n)::uuid,md5(${prefix} || 'report' || n)::uuid,'photo',
      md5(${prefix} || 'retained-photo' || n)::uuid FROM generate_series(1,${volume}) n`.execute(
    database,
  );
  // Shape-valid opaque bytes deliberately do not stand in for authenticated encrypted content.
  await sql`INSERT INTO moderation.report_snapshots
    (id,report_id,report_evidence_id,snapshot_type,schema_version,encryption_key_id,encryption_key_version,nonce,ciphertext,content_sha256)
    SELECT md5(${prefix} || 'photo-snapshot' || n)::uuid,md5(${prefix} || 'report' || n)::uuid,
      md5(${prefix} || 'photo-evidence' || n)::uuid,'photo',1,'synthetic-plan-key',1,
      decode(repeat('00',12),'hex'),decode(repeat('00',17),'hex'),repeat('a',64)
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO media.report_photo_evidence_holds
    (report_evidence_id,photo_id,asset_id,variant_id,content_sha256,captured_primary)
    SELECT md5(${prefix} || 'photo-evidence' || n)::uuid,md5(${prefix} || 'retained-photo' || n)::uuid,
      md5(${prefix} || 'photo-asset' || n)::uuid,md5(${prefix} || 'photo-variant' || n)::uuid,
      CASE WHEN n % 4 = 2 THEN repeat('b',64) ELSE repeat('a',64) END,false
    FROM generate_series(1,${volume}) n`.execute(database);
  const row = (
    await sql<{ evidence: string; intact: string; hashDrift: string; storageDrift: string }>`
    SELECT count(*)::text AS evidence,
      count(*) FILTER(WHERE probe."hasCapture" AND probe."hasRetainedPhoto")::text AS intact,
      count(*) FILTER(WHERE probe."hasCapture" AND NOT probe."hasRetainedPhoto" AND fixture.n % 4 = 2)::text AS "hashDrift",
      count(*) FILTER(WHERE probe."hasCapture" AND NOT probe."hasRetainedPhoto" AND fixture.n % 4 = 3)::text AS "storageDrift"
    FROM (${MODERATION_INTEGRITY_SOURCES.evidence}) probe
    JOIN (SELECT n,md5(${prefix} || 'photo-evidence' || n)::uuid AS id FROM generate_series(1,${volume}) n) fixture
      ON fixture.id = probe.id`.execute(database)
  ).rows[0]!;
  const result = {
    evidence: Number(row.evidence),
    intact: Number(row.intact),
    hashDrift: Number(row.hashDrift),
    storageDrift: Number(row.storageDrift),
  };
  const hashDrift = Math.floor((volume + 2) / 4),
    storageDrift = Math.floor((volume + 1) / 4);
  if (
    result.evidence !== volume ||
    result.hashDrift !== hashDrift ||
    result.storageDrift !== storageDrift ||
    result.intact !== volume - hashDrift - storageDrift
  )
    throw new Error('M7 retained photo fixture incomplete.');
  return result;
}
