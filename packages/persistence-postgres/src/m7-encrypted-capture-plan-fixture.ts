import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql, type Insertable } from 'kysely';
import {
  AesGcmProfileReportSnapshotProtector,
  AesGcmProfileReportSnapshotReader,
  AesGcmPhotoReportSnapshotProtector,
  AesGcmPhotoReportSnapshotReader,
  AesGcmChatReportSnapshotProtector,
  AesGcmChatReportSnapshotReader,
  AesGcmUnmatchedReportSnapshotProtector,
  AesGcmUnmatchedReportSnapshotReader,
  type StoredProfileReportSnapshot,
  type ReportSnapshotSubject,
} from '@nakh/application';
import type { DatabaseSchema, NakhDatabase } from './database.js';
import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';

export type M7EncryptedCaptureFixture = Readonly<{
  authenticated: number;
  metadataIntact: number;
  byType: Readonly<Record<'profile' | 'photo' | 'chat' | 'unmatched_user', number>>;
  tagRejected: number;
  reportBindingRejected: number;
  evidenceBindingRejected: number;
  keyVersionRejected: number;
  hashRejected: number;
}>;

function reject(read: () => unknown): void {
  try {
    read();
  } catch {
    return;
  }
  throw new Error('M7 encrypted capture rejection missing.');
}

/** Actual local AEAD over persisted synthetic subjects. Caller owns metadata FK/trigger
 * bypass and rollback. This is neither native admission nor an authorized evidence reveal.
 * Only numeric observations escape; the ephemeral key never enters SQL or artifacts. */
export async function seedM7EncryptedCapturePlans(
  database: NakhDatabase,
  prefix: string,
  volume: number,
  at: Date,
): Promise<M7EncryptedCaptureFixture> {
  const key = randomBytes(32);
  const keyId = `synthetic_capture_${randomUUID().replaceAll('-', '')}`;
  const keys = {
    resolve: (id: string, version: number) => (id === keyId && version === 1 ? key : undefined),
  };
  const protectors = {
    profile: new AesGcmProfileReportSnapshotProtector(keyId, 1, key),
    photo: new AesGcmPhotoReportSnapshotProtector(keyId, 1, key),
    chat: new AesGcmChatReportSnapshotProtector(keyId, 1, key),
    unmatched_user: new AesGcmUnmatchedReportSnapshotProtector(keyId, 1, key),
  };
  const readers = {
    profile: new AesGcmProfileReportSnapshotReader(keys),
    photo: new AesGcmPhotoReportSnapshotReader(keys),
    chat: new AesGcmChatReportSnapshotReader(keys),
    unmatched_user: new AesGcmUnmatchedReportSnapshotReader(keys),
  };
  const result = {
    authenticated: 0,
    metadataIntact: 0,
    byType: { profile: 0, photo: 0, chat: 0, unmatched_user: 0 },
    tagRejected: 0,
    reportBindingRejected: 0,
    evidenceBindingRejected: 0,
    keyVersionRejected: 0,
    hashRejected: 0,
  };
  const fixtureId = (label: string): string => {
    const hex = createHash('md5')
      .update(prefix + label)
      .digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  try {
    for (let first = 1; first <= volume; first += 500) {
      const reports: Insertable<DatabaseSchema['moderation.reports']>[] = [];
      const evidence: Insertable<DatabaseSchema['moderation.report_evidence']>[] = [];
      const snapshots: Insertable<DatabaseSchema['moderation.report_snapshots']>[] = [];
      const holds: Insertable<DatabaseSchema['media.report_photo_evidence_holds']>[] = [];
      const expected = new Map<string, unknown>();
      for (let n = first; n < Math.min(first + 500, volume + 1); n++) {
        const reportId = randomUUID(),
          evidenceId = randomUUID(),
          referenceId = randomUUID();
        const subject = { reportId, evidenceId };
        const type = (['profile', 'photo', 'chat', 'unmatched_user'] as const)[n % 4]!;
        let capture: StoredProfileReportSnapshot;
        switch (type) {
          case 'profile': {
            const content = {
              evidenceType: 'profile',
              displayName: 'Synthetic capture',
              birthYear: 1990,
            } as const;
            capture = protectors.profile.protect(subject, content);
            expected.set(evidenceId, content);
            break;
          }
          case 'photo': {
            const content = {
              evidenceType: 'photo',
              evidenceObjectRef: `v1.pe.${evidenceId}`,
              contentSha256: 'a'.repeat(64),
              primary: false,
            } as const;
            capture = protectors.photo.protect(subject, content);
            expected.set(evidenceId, content);
            // n % 4 = 1 selects existing logically deleted photos whose retained bytes are intact.
            holds.push({
              report_evidence_id: evidenceId,
              photo_id: fixtureId(`retained-photo${n}`),
              asset_id: fixtureId(`photo-asset${n}`),
              variant_id: fixtureId(`photo-variant${n}`),
              content_sha256: content.contentSha256,
              captured_primary: false,
            });
            break;
          }
          case 'chat': {
            const content = {
              evidenceType: 'chat',
              chatSessionId: referenceId,
              status: 'active',
            } as const;
            capture = protectors.chat.protect(subject, content);
            expected.set(evidenceId, content);
            break;
          }
          case 'unmatched_user': {
            const content = {
              evidenceType: 'unmatched_user',
              unmatchedAt: at.toISOString(),
              reportWindowExpiresAt: new Date(at.getTime() + 86400000).toISOString(),
            } as const;
            capture = protectors.unmatched_user.protect(subject, content);
            expected.set(evidenceId, content);
            break;
          }
        }
        reports.push({
          id: reportId,
          reporter_user_id: fixtureId(`user${n % 257}`),
          target_user_id: fixtureId(`target${n % 64}`),
          reason_id: fixtureId('reason'),
          extra_text: null,
          status: 'submitted',
          command_id: randomUUID(),
          request_id: randomUUID(),
          idempotency_key: randomUUID(),
          request_digest: 'c'.repeat(64),
          submitted_at: at,
          reviewed_at: null,
          closed_at: null,
        });
        evidence.push({
          id: evidenceId,
          report_id: reportId,
          evidence_type: type,
          profile_id: type === 'profile' ? referenceId : null,
          profile_photo_id: type === 'photo' ? fixtureId(`retained-photo${n}`) : null,
          chat_session_id: type === 'chat' ? referenceId : null,
          chat_message_id: null,
          unmatch_record_id: type === 'unmatched_user' ? referenceId : null,
        });
        snapshots.push({
          id: randomUUID(),
          report_id: reportId,
          report_evidence_id: evidenceId,
          snapshot_type: type,
          schema_version: capture.schemaVersion,
          encryption_key_id: capture.keyId,
          encryption_key_version: capture.keyVersion,
          nonce: Buffer.from(capture.nonce),
          ciphertext: Buffer.from(capture.ciphertext),
          content_sha256: capture.sha256,
        });
      }
      await database.insertInto('moderation.reports').values(reports).execute();
      await database.insertInto('moderation.report_evidence').values(evidence).execute();
      await database.insertInto('moderation.report_snapshots').values(snapshots).execute();
      if (holds.length > 0)
        await database.insertInto('media.report_photo_evidence_holds').values(holds).execute();
      const persisted = await database
        .selectFrom('moderation.report_snapshots')
        .selectAll()
        .where('report_evidence_id', 'in', [...expected.keys()])
        .execute();
      if (persisted.length !== expected.size)
        throw new Error('M7 encrypted capture persistence missing.');
      for (const row of persisted) {
        const subject: ReportSnapshotSubject = {
          reportId: row.report_id,
          evidenceId: row.report_evidence_id,
        };
        const capture: StoredProfileReportSnapshot = {
          schemaVersion: row.schema_version,
          snapshotType: row.snapshot_type,
          keyId: row.encryption_key_id,
          keyVersion: row.encryption_key_version,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          sha256: row.content_sha256,
        };
        const reader = readers[row.snapshot_type];
        if (
          !isDeepStrictEqual(reader.decrypt(subject, capture), expected.get(row.report_evidence_id))
        )
          throw new Error('M7 encrypted capture roundtrip invalid.');
        result.authenticated++;
        result.byType[row.snapshot_type]++;
        const damaged = Buffer.from(row.ciphertext);
        damaged[damaged.length - 1]! ^= 1;
        reject(() => reader.decrypt(subject, { ...capture, ciphertext: damaged }));
        result.tagRejected++;
        reject(() => reader.decrypt({ ...subject, reportId: subject.evidenceId }, capture));
        result.reportBindingRejected++;
        reject(() => reader.decrypt({ ...subject, evidenceId: subject.reportId }, capture));
        result.evidenceBindingRejected++;
        reject(() => reader.decrypt(subject, { ...capture, keyVersion: 2 }));
        result.keyVersionRejected++;
        reject(() =>
          reader.decrypt(subject, {
            ...capture,
            sha256: capture.sha256 === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64),
          }),
        );
        result.hashRejected++;
      }
    }
    const observed = (
      await sql<{ count: string }>`SELECT count(*)::text AS count
      FROM (${MODERATION_INTEGRITY_SOURCES.evidence}) probe
      JOIN moderation.report_snapshots snapshot ON snapshot.report_evidence_id = probe.id
      WHERE snapshot.encryption_key_id = ${keyId} AND probe."hasCapture" AND probe."hasRetainedPhoto"`.execute(
        database,
      )
    ).rows[0]!;
    result.metadataIntact = Number(observed.count);
    if (result.metadataIntact !== volume || result.authenticated !== volume)
      throw new Error('M7 encrypted capture volume incomplete.');
    return result;
  } finally {
    key.fill(0);
  }
}
