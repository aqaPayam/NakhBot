import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { RevealedReportEvidence } from '@nakh/contracts';
import type { ReportSnapshotSubject } from './profile-report-snapshot.js';
import type {
  ReportSnapshotKeyResolver,
  StoredProfileReportSnapshot,
} from './profile-report-snapshot-reader.js';

export type ReportChatContent = Extract<
  RevealedReportEvidence['content'],
  { evidenceType: 'chat' }
>;
export type ProtectedChatReportSnapshot = Omit<
  StoredProfileReportSnapshot,
  'schemaVersion' | 'snapshotType'
> & {
  readonly schemaVersion: 1;
  readonly snapshotType: 'chat';
};
export interface ChatReportSnapshotProtector {
  protect(subject: ReportSnapshotSubject, content: ReportChatContent): ProtectedChatReportSnapshot;
}
export interface ChatReportSnapshotReader {
  decrypt(subject: ReportSnapshotSubject, snapshot: StoredProfileReportSnapshot): ReportChatContent;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function utc(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
export function isReportChatContent(value: unknown): value is ReportChatContent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).every((key) =>
      ['evidenceType', 'chatSessionId', 'status', 'closedAt'].includes(key),
    ) &&
    row.evidenceType === 'chat' &&
    typeof row.chatSessionId === 'string' &&
    UUID.test(row.chatSessionId) &&
    ((row.status === 'active' && row.closedAt === undefined) ||
      (row.status === 'closed' && utc(row.closedAt)))
  );
}
export function chatReportSnapshotAad(
  subject: ReportSnapshotSubject,
  envelope: Pick<
    StoredProfileReportSnapshot,
    'schemaVersion' | 'snapshotType' | 'keyId' | 'keyVersion' | 'sha256'
  >,
): Buffer {
  if (
    !UUID.test(subject.reportId) ||
    !UUID.test(subject.evidenceId) ||
    envelope.schemaVersion !== 1 ||
    envelope.snapshotType !== 'chat' ||
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
/** Only this write capability is passed to submission; keys are preloaded outside the transaction. */
export class AesGcmChatReportSnapshotProtector implements ChatReportSnapshotProtector {
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
    content: ReportChatContent,
  ): ProtectedChatReportSnapshot {
    if (!isReportChatContent(content)) throw new Error('Report chat snapshot content is invalid.');
    const plaintext = Buffer.from(
      JSON.stringify({
        evidenceType: 'chat',
        chatSessionId: content.chatSessionId,
        status: content.status,
        ...(content.closedAt === undefined ? {} : { closedAt: content.closedAt }),
      }),
    );
    try {
      const metadata = {
        schemaVersion: 1 as const,
        snapshotType: 'chat' as const,
        keyId: this.keyId,
        keyVersion: this.keyVersion,
        sha256: createHash('sha256').update(plaintext).digest('hex'),
      };
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', this.key, nonce);
      cipher.setAAD(chatReportSnapshotAad(subject, metadata));
      return {
        ...metadata,
        nonce,
        ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]),
      };
    } finally {
      plaintext.fill(0);
    }
  }
}
/** Internal reader; an audited permission-checked transaction must authorize every content release. */
export class AesGcmChatReportSnapshotReader implements ChatReportSnapshotReader {
  public constructor(private readonly keys: ReportSnapshotKeyResolver) {}
  public decrypt(
    subject: ReportSnapshotSubject,
    snapshot: StoredProfileReportSnapshot,
  ): ReportChatContent {
    let key: Buffer | undefined, plaintext: Buffer | undefined;
    try {
      if (
        !(snapshot.nonce instanceof Uint8Array) ||
        snapshot.nonce.byteLength !== 12 ||
        !(snapshot.ciphertext instanceof Uint8Array) ||
        snapshot.ciphertext.byteLength < 17 ||
        snapshot.ciphertext.byteLength > 65536
      )
        throw new Error();
      const aad = chatReportSnapshotAad(subject, snapshot);
      const resolved = this.keys.resolve(snapshot.keyId, snapshot.keyVersion);
      if (resolved === undefined || resolved.byteLength !== 32) throw new Error();
      key = Buffer.from(resolved);
      const ciphertext = Buffer.from(snapshot.ciphertext),
        cipher = createDecipheriv('aes-256-gcm', key, snapshot.nonce);
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
      if (!isReportChatContent(content)) throw new Error();
      return content;
    } catch {
      throw new Error('Report snapshot could not be read.');
    } finally {
      key?.fill(0);
      plaintext?.fill(0);
    }
  }
}
