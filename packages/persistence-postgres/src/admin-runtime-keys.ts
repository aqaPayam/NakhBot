import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import { sql } from 'kysely';
import {
  ReportSnapshotKeyRing,
  AesGcmReviewNoteProtector,
  AesGcmProfileReportSnapshotProtector,
  AesGcmPhotoReportSnapshotProtector,
  AesGcmProfileReportSnapshotReader,
  AesGcmPhotoReportSnapshotReader,
  AesGcmChatReportSnapshotReader,
  AesGcmUnmatchedReportSnapshotReader,
  verifyAdminTotpSecretCustody,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import type { ReportEvidenceCapabilities } from './report-services.js';

function key(encoded: string): Buffer {
  const result = Buffer.from(encoded, 'base64url');
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(encoded) ||
    result.length !== 32 ||
    result.toString('base64url') !== encoded
  )
    throw new Error('Administrator key custody unavailable.');
  return result;
}
type Version = { keyId: string; keyVersion: number };

/** Trusted host keys; public routes receive only the native services they need.
 * Retained rings preserve historical versions; no array order selects a writer. */
export class AdminRuntimeKeys {
  public readonly totp: ReportSnapshotKeyRing;
  private readonly notes: ReportSnapshotKeyRing;
  private readonly snapshots: ReportSnapshotKeyRing;
  public readonly actionKey: Uint8Array;
  public readonly userSessionKey: Uint8Array;
  public readonly uiEncryptionKey: Uint8Array;
  public readonly uiReferenceKey: Uint8Array;
  public readonly reviewNotes: AesGcmReviewNoteProtector;
  public readonly capabilities: ReportEvidenceCapabilities;
  public constructor(
    input: Readonly<{
      totp: string;
      notes: string;
      snapshots: string;
      action: string;
      navigation: string;
      noteKeyId: string;
      noteKeyVersion: number;
      snapshotKeyId: string;
      snapshotKeyVersion: number;
    }>,
  ) {
    try {
      this.totp = new ReportSnapshotKeyRing(input.totp);
      this.notes = new ReportSnapshotKeyRing(input.notes);
      this.snapshots = new ReportSnapshotKeyRing(input.snapshots);
      this.actionKey = key(input.action);
      const navigation = key(input.navigation);
      this.userSessionKey = Uint8Array.from(navigation);
      if (Buffer.from(this.actionKey).equals(navigation)) throw new Error();
      this.uiEncryptionKey = createHmac('sha256', this.actionKey)
        .update('nakh-admin-ui-encryption-v1')
        .digest();
      this.uiReferenceKey = createHmac('sha256', this.actionKey)
        .update('nakh-admin-ui-reference-v1')
        .digest();
      const rings = [this.totp, this.notes, this.snapshots];
      for (const ring of rings) {
        for (const secret of [
          navigation,
          this.actionKey,
          this.uiEncryptionKey,
          this.uiReferenceKey,
        ])
          ring.assertSeparateNavigationKey(secret);
      }
      for (let i = 0; i < rings.length; i++)
        for (let j = i + 1; j < rings.length; j++) rings[i]!.assertSeparateKeyRing(rings[j]!);
      const note = this.notes.writeKey(input.noteKeyId, input.noteKeyVersion);
      this.reviewNotes = new AesGcmReviewNoteProtector(note.keyId, note.keyVersion, note.key);
      note.key.fill(0);
      const snapshot = this.snapshots.writeKey(input.snapshotKeyId, input.snapshotKeyVersion);
      this.capabilities = Object.freeze({
        profile: Object.freeze({
          protector: new AesGcmProfileReportSnapshotProtector(
            snapshot.keyId,
            snapshot.keyVersion,
            snapshot.key,
          ),
          reader: new AesGcmProfileReportSnapshotReader(this.snapshots),
        }),
        photo: Object.freeze({
          protector: new AesGcmPhotoReportSnapshotProtector(
            snapshot.keyId,
            snapshot.keyVersion,
            snapshot.key,
          ),
          reader: new AesGcmPhotoReportSnapshotReader(this.snapshots),
        }),
      });
      snapshot.key.fill(0);
      navigation.fill(0);
    } catch {
      throw new Error('Administrator key custody unavailable.');
    }
  }
  /** All referenced versions must exist; decrypt a bounded sample per version.
   * This is not a full corruption scan or an authorization to reveal content. */
  public async verifyCustody(database: NakhDatabase): Promise<void> {
    try {
      const versions = (
        await sql<Version>`SELECT key_id AS "keyId",key_version AS "keyVersion"
        FROM administration.admin_totp_credentials UNION SELECT key_id,key_version
        FROM administration.admin_totp_enrollments`.execute(database)
      ).rows;
      for (const version of versions) {
        if (this.totp.resolve(version.keyId, version.keyVersion) === undefined) throw new Error();
        const row = (
          await sql<{
            id: string;
            userId: string;
            ciphertext: Buffer;
            nonce: Buffer;
          }>`SELECT secret.id,admin.user_id AS "userId",secret.ciphertext,secret.nonce
          FROM (SELECT id,admin_user_id,key_id,key_version,ciphertext,nonce
            FROM administration.admin_totp_credentials UNION ALL
            SELECT id,admin_user_id,key_id,key_version,ciphertext,nonce
            FROM administration.admin_totp_enrollments) secret
          JOIN administration.admin_users admin ON admin.id=secret.admin_user_id
          WHERE secret.key_id=${version.keyId} AND secret.key_version=${version.keyVersion}
          ORDER BY secret.id LIMIT 1`.execute(database)
        ).rows[0];
        if (row === undefined) throw new Error();
        verifyAdminTotpSecretCustody(
          { actorUserId: row.userId, credentialId: row.id },
          {
            keyId: version.keyId,
            keyVersion: version.keyVersion,
            ciphertext: row.ciphertext,
            nonce: row.nonce,
          },
          this.totp,
        );
      }
      const notes = await database
        .selectFrom('moderation.moderation_reviews')
        .select(['decision_note_key_id', 'decision_note_key_version'])
        .where('decision_note_ciphertext', 'is not', null)
        .distinct()
        .execute();
      for (const version of notes) {
        if (version.decision_note_key_id === null || version.decision_note_key_version === null)
          throw new Error();
        const secret = this.notes.resolve(
          version.decision_note_key_id,
          version.decision_note_key_version,
        );
        if (secret === undefined) throw new Error();
        try {
          const row = await database
            .selectFrom('moderation.moderation_reviews')
            .selectAll()
            .where('decision_note_key_id', '=', version.decision_note_key_id)
            .where('decision_note_key_version', '=', version.decision_note_key_version)
            .orderBy('id')
            .limit(1)
            .executeTakeFirstOrThrow();
          if (row.decision_note_ciphertext === null || row.decision_note_nonce === null)
            throw new Error();
          const encrypted = Buffer.from(row.decision_note_ciphertext);
          const decipher = createDecipheriv('aes-256-gcm', secret, row.decision_note_nonce);
          decipher.setAAD(
            Buffer.from(
              JSON.stringify([
                'moderation-review-note',
                1,
                row.id,
                version.decision_note_key_id,
                version.decision_note_key_version,
              ]),
            ),
          );
          decipher.setAuthTag(encrypted.subarray(-16));
          const plaintext = Buffer.concat([
            decipher.update(encrypted.subarray(0, -16)),
            decipher.final(),
          ]);
          try {
            if (createHash('sha256').update(plaintext).digest('hex') !== row.decision_note_sha256)
              throw new Error();
          } finally {
            plaintext.fill(0);
          }
        } finally {
          secret.fill(0);
        }
      }
      const readers = {
        profile: new AesGcmProfileReportSnapshotReader(this.snapshots),
        photo: new AesGcmPhotoReportSnapshotReader(this.snapshots),
        chat: new AesGcmChatReportSnapshotReader(this.snapshots),
        unmatched_user: new AesGcmUnmatchedReportSnapshotReader(this.snapshots),
      };
      const snapshots = await database
        .selectFrom('moderation.report_snapshots')
        .select(['encryption_key_id', 'encryption_key_version'])
        .distinct()
        .execute();
      for (const version of snapshots) {
        if (
          this.snapshots.resolve(version.encryption_key_id, version.encryption_key_version) ===
          undefined
        )
          throw new Error();
        const row = await database
          .selectFrom('moderation.report_snapshots')
          .selectAll()
          .where('encryption_key_id', '=', version.encryption_key_id)
          .where('encryption_key_version', '=', version.encryption_key_version)
          .orderBy('id')
          .limit(1)
          .executeTakeFirstOrThrow();
        readers[row.snapshot_type].decrypt(
          { reportId: row.report_id, evidenceId: row.report_evidence_id },
          {
            schemaVersion: row.schema_version,
            snapshotType: row.snapshot_type,
            keyId: row.encryption_key_id,
            keyVersion: row.encryption_key_version,
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            sha256: row.content_sha256,
          },
        );
      }
    } catch {
      throw new Error('Administrator key custody unavailable.');
    }
  }
}
