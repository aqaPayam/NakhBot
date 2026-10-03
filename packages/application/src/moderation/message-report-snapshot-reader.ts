import { createHash, timingSafeEqual } from 'node:crypto';
import type { RevealedReportEvidence } from '@nakh/contracts';

export type ReportMessageContent = Extract<
  RevealedReportEvidence['content'],
  { evidenceType: 'message' }
>;
export interface StoredMessageReportSnapshot {
  readonly reportId: string;
  readonly chatSessionId: string;
  readonly originalMessageId: string;
  readonly senderUserId: string | null;
  readonly messageType: ReportMessageContent['messageType'];
  readonly content: unknown;
  readonly originalCreatedAt: Date;
  readonly integritySha256: string;
}
export interface MessageReportSnapshotReader {
  read(
    subject: Readonly<{ reportId: string; chatSessionId: string; messageId: string }>,
    snapshot: StoredMessageReportSnapshot,
  ): ReportMessageContent;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}
function exact(row: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    throw new Error();
}
function contentFor(snapshot: StoredMessageReportSnapshot): Record<string, unknown> {
  const row = record(snapshot.content);
  switch (snapshot.messageType) {
    case 'text':
      exact(row, ['text']);
      if (typeof row.text !== 'string' || row.text.length < 1 || row.text.length > 1000)
        throw new Error();
      return { text: row.text };
    case 'predefined_question':
    case 'predefined_answer': {
      const key =
        snapshot.messageType === 'predefined_question'
          ? 'predefinedQuestionId'
          : 'predefinedAnswerId';
      exact(row, [key]);
      if (typeof row[key] !== 'string' || !UUID.test(row[key])) throw new Error();
      return { [key]: row[key] };
    }
    case 'system': {
      exact(row, ['localizationKey', 'arguments']);
      if (
        typeof row.localizationKey !== 'string' ||
        row.localizationKey.length < 1 ||
        row.localizationKey.length > 160
      )
        throw new Error();
      const args = record(row.arguments);
      if (Object.values(args).some((value) => typeof value !== 'string' || value.length > 160))
        throw new Error();
      // Preserve the JSONB argument order used by the M6 capture digest.
      return { localizationKey: row.localizationKey, arguments: { ...args } };
    }
    default:
      throw new Error();
  }
}
/** Internal M6 reader. Call only within the permission-checked, audited evidence release. */
export class IntegrityMessageReportSnapshotReader implements MessageReportSnapshotReader {
  public read(
    subject: Readonly<{ reportId: string; chatSessionId: string; messageId: string }>,
    snapshot: StoredMessageReportSnapshot,
  ): ReportMessageContent {
    try {
      if (
        ![subject.reportId, subject.chatSessionId, subject.messageId].every((id) =>
          UUID.test(id),
        ) ||
        snapshot.reportId !== subject.reportId ||
        snapshot.chatSessionId !== subject.chatSessionId ||
        snapshot.originalMessageId !== subject.messageId ||
        (snapshot.senderUserId !== null && !UUID.test(snapshot.senderUserId)) ||
        !(snapshot.originalCreatedAt instanceof Date) ||
        !Number.isFinite(snapshot.originalCreatedAt.getTime()) ||
        !/^[a-f0-9]{64}$/u.test(snapshot.integritySha256)
      )
        throw new Error();
      const content = contentFor(snapshot);
      const digest = createHash('sha256')
        .update(
          JSON.stringify({
            reportId: snapshot.reportId,
            chatSessionId: snapshot.chatSessionId,
            originalMessageId: snapshot.originalMessageId,
            senderUserId: snapshot.senderUserId,
            messageType: snapshot.messageType,
            content,
            originalCreatedAt: snapshot.originalCreatedAt.toISOString(),
          }),
        )
        .digest();
      if (!timingSafeEqual(digest, Buffer.from(snapshot.integritySha256, 'hex'))) throw new Error();
      const revealed =
        snapshot.messageType === 'text' ? (content.text as string) : JSON.stringify(content);
      if (revealed.length > 2000) throw new Error();
      return {
        evidenceType: 'message',
        messageId: snapshot.originalMessageId,
        messageType: snapshot.messageType,
        content: revealed,
        createdAt: snapshot.originalCreatedAt.toISOString(),
      };
    } catch {
      throw new Error('Report snapshot could not be read.');
    }
  }
}
