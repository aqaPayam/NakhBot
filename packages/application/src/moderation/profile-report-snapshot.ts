import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import type { RevealedReportEvidence } from '@nakh/contracts';

export type ReportProfileContent = Extract<
  RevealedReportEvidence['content'],
  { evidenceType: 'profile' }
>;
export type ReportSnapshotSubject = Readonly<{ reportId: string; evidenceId: string }>;
export type ProtectedProfileReportSnapshot = Readonly<{
  schemaVersion: 1;
  snapshotType: 'profile';
  keyId: string;
  keyVersion: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  sha256: string;
}>;
export interface ProfileReportSnapshotProtector {
  protect(
    subject: ReportSnapshotSubject,
    content: ReportProfileContent,
  ): ProtectedProfileReportSnapshot;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function text(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === 'string' &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    [...value].length >= min &&
    [...value].length <= max
  );
}
export function isReportProfileContent(value: unknown): value is ReportProfileContent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).every((key) =>
      ['evidenceType', 'displayName', 'birthYear', 'bio'].includes(key),
    ) &&
    row.evidenceType === 'profile' &&
    text(row.displayName, 1, 80) &&
    typeof row.birthYear === 'number' &&
    Number.isInteger(row.birthYear) &&
    row.birthYear >= 1900 &&
    row.birthYear <= 9999 &&
    (row.bio === undefined || text(row.bio, 0, 1000))
  );
}
/** Shared envelope binding for the write capability and the separately authorized reader. */
export function profileReportSnapshotAad(
  subject: ReportSnapshotSubject,
  envelope: Pick<
    ProtectedProfileReportSnapshot,
    'schemaVersion' | 'snapshotType' | 'keyId' | 'keyVersion' | 'sha256'
  >,
): Buffer {
  if (
    !UUID.test(subject.reportId) ||
    !UUID.test(subject.evidenceId) ||
    envelope.schemaVersion !== 1 ||
    envelope.snapshotType !== 'profile' ||
    !/^[A-Za-z0-9_-]{8,160}$/u.test(envelope.keyId) ||
    !Number.isSafeInteger(envelope.keyVersion) ||
    envelope.keyVersion < 1 ||
    !/^[a-f0-9]{64}$/u.test(envelope.sha256)
  )
    throw new Error('Report snapshot binding is invalid.');
  return Buffer.from(
    JSON.stringify([
      'report-snapshot',
      envelope.schemaVersion,
      envelope.snapshotType,
      subject.reportId,
      subject.evidenceId,
      envelope.keyId,
      envelope.keyVersion,
      envelope.sha256,
    ]),
  );
}

/** Submission receives only this encryption capability, never a decryption key provider. */
export class AesGcmProfileReportSnapshotProtector implements ProfileReportSnapshotProtector {
  private readonly key: Buffer;
  public constructor(
    private readonly keyId: string,
    private readonly keyVersion: number,
    key: Uint8Array,
  ) {
    if (
      !/^[A-Za-z0-9_-]{8,160}$/u.test(keyId) ||
      !Number.isSafeInteger(keyVersion) ||
      keyVersion < 1 ||
      key.byteLength !== 32
    )
      throw new Error('Report snapshot encryption configuration is invalid.');
    this.key = Buffer.from(key);
  }
  public protect(
    subject: ReportSnapshotSubject,
    content: ReportProfileContent,
  ): ProtectedProfileReportSnapshot {
    if (!isReportProfileContent(content))
      throw new Error('Report profile snapshot content is invalid.');
    const plaintext = JSON.stringify({
      evidenceType: 'profile',
      displayName: content.displayName,
      birthYear: content.birthYear,
      ...(content.bio === undefined ? {} : { bio: content.bio }),
    });
    const metadata = {
      schemaVersion: 1 as const,
      snapshotType: 'profile' as const,
      keyId: this.keyId,
      keyVersion: this.keyVersion,
      sha256: createHash('sha256').update(plaintext).digest('hex'),
    };
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(profileReportSnapshotAad(subject, metadata));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return { ...metadata, nonce, ciphertext };
  }
}
