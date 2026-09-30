import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import {
  isReportProfileContent,
  profileReportSnapshotAad,
  type ProtectedProfileReportSnapshot,
  type ReportProfileContent,
  type ReportSnapshotSubject,
} from './profile-report-snapshot.js';

export type StoredProfileReportSnapshot = Omit<
  ProtectedProfileReportSnapshot,
  'schemaVersion' | 'snapshotType'
> &
  Readonly<{
    schemaVersion: number;
    snapshotType: string;
  }>;
export interface ReportSnapshotKeyResolver {
  /** Preloaded local keys only; fetch or rotate external keys outside the business transaction. */
  resolve(keyId: string, keyVersion: number): Uint8Array | undefined;
}
export interface ProfileReportSnapshotReader {
  decrypt(
    subject: ReportSnapshotSubject,
    snapshot: StoredProfileReportSnapshot,
  ): ReportProfileContent;
}

/** Internal cryptographic capability. Only an audited, authorized store may release its result. */
export class AesGcmProfileReportSnapshotReader implements ProfileReportSnapshotReader {
  public constructor(private readonly keys: ReportSnapshotKeyResolver) {}
  public decrypt(
    subject: ReportSnapshotSubject,
    snapshot: StoredProfileReportSnapshot,
  ): ReportProfileContent {
    let key: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      if (
        snapshot.schemaVersion !== 1 ||
        snapshot.snapshotType !== 'profile' ||
        !(snapshot.nonce instanceof Uint8Array) ||
        snapshot.nonce.byteLength !== 12 ||
        !(snapshot.ciphertext instanceof Uint8Array) ||
        snapshot.ciphertext.byteLength < 17 ||
        snapshot.ciphertext.byteLength > 65536
      )
        throw new Error();
      const aad = profileReportSnapshotAad(subject, {
        ...snapshot,
        schemaVersion: 1,
        snapshotType: 'profile',
      });
      const resolved = this.keys.resolve(snapshot.keyId, snapshot.keyVersion);
      if (resolved === undefined || resolved.byteLength !== 32) throw new Error();
      key = Buffer.from(resolved);
      const ciphertext = Buffer.from(snapshot.ciphertext);
      const cipher = createDecipheriv('aes-256-gcm', key, snapshot.nonce);
      cipher.setAAD(aad);
      cipher.setAuthTag(ciphertext.subarray(-16));
      plaintext = Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]);
      if (
        !timingSafeEqual(
          createHash('sha256').update(plaintext).digest(),
          Buffer.from(snapshot.sha256, 'hex'),
        )
      )
        throw new Error();
      const content: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
      ) as unknown;
      if (!isReportProfileContent(content)) throw new Error();
      return content;
    } catch {
      // Never attach provider errors, JSON excerpts, key details or plaintext as an error cause.
      throw new Error('Report snapshot could not be read.');
    } finally {
      key?.fill(0);
      plaintext?.fill(0);
    }
  }
}
