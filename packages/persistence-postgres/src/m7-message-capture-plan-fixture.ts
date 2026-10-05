import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql, type Insertable } from 'kysely';
import {
  IntegrityMessageReportSnapshotReader,
  type StoredMessageReportSnapshot,
  type ReportMessageContent,
} from '@nakh/application';
import type { DatabaseSchema, NakhDatabase } from './database.js';
import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';

export type M7MessageCaptureFixture = Readonly<{
  integrityVerified: number;
  metadataIntact: number;
  byType: Readonly<Record<StoredMessageReportSnapshot['messageType'], number>>;
  reportBindingRejected: number;
  sessionBindingRejected: number;
  messageBindingRejected: number;
  contentRejected: number;
  shapeRejected: number;
  senderRejected: number;
  timestampRejected: number;
  hashRejected: number;
  outsideAdmissionWindow: number;
  admissionEligibleBefore: number;
  admissionEligibleAfter: number;
}>;

function reject(read: () => unknown): void {
  try {
    read();
  } catch {
    return;
  }
  throw new Error('M7 message capture rejection missing.');
}

/** Persisted synthetic M6 SHA-256 readback, not AEAD or authenticated provenance.
 * Caller owns isolated FK/trigger bypass and rollback. No native admission,
 * content authorization, audited release or provider acceptance is implied.
 * Only numeric observations escape; synthetic message bodies stay local. */
export async function seedM7MessageCapturePlans(
  database: NakhDatabase,
  prefix: string,
  volume: number,
  at: Date,
): Promise<M7MessageCaptureFixture> {
  const reader = new IntegrityMessageReportSnapshotReader();
  const result = {
    integrityVerified: 0,
    metadataIntact: 0,
    byType: { text: 0, predefined_question: 0, predefined_answer: 0, system: 0 },
    reportBindingRejected: 0,
    sessionBindingRejected: 0,
    messageBindingRejected: 0,
    contentRejected: 0,
    shapeRejected: 0,
    senderRejected: 0,
    timestampRejected: 0,
    hashRejected: 0,
    outsideAdmissionWindow: 0,
    admissionEligibleBefore: 0,
    admissionEligibleAfter: 0,
  };
  const fixtureId = (label: string): string => {
    const hex = createHash('md5')
      .update(prefix + label)
      .digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const capturedAt = new Date(at.getTime() - 48 * 60 * 60_000);
  const admissionCount = async (): Promise<number> =>
    Number(
      (
        await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM moderation.reports
    WHERE reporter_user_id = ${fixtureId('user0')}::uuid
      AND submitted_at > ${at}::timestamptz - interval '24 hours'`.execute(database)
      ).rows[0]!.count,
    );
  result.admissionEligibleBefore = await admissionCount();
  for (let first = 1; first <= volume; first += 500) {
    const reports: Insertable<DatabaseSchema['moderation.reports']>[] = [];
    const evidence: Insertable<DatabaseSchema['moderation.report_evidence']>[] = [];
    const snapshots: Insertable<DatabaseSchema['chat.chat_message_snapshots']>[] = [];
    const expected = new Map<string, ReportMessageContent>();
    for (let n = first; n < Math.min(first + 500, volume + 1); n++) {
      const reportId = randomUUID(),
        evidenceId = randomUUID(),
        sessionId = randomUUID(),
        messageId = randomUUID();
      const messageType = (['text', 'predefined_question', 'predefined_answer', 'system'] as const)[
        n % 4
      ]!;
      const content =
        messageType === 'text'
          ? { text: `Synthetic retained message ${n}` }
          : messageType === 'predefined_question'
            ? { predefinedQuestionId: randomUUID() }
            : messageType === 'predefined_answer'
              ? { predefinedAnswerId: randomUUID() }
              : {
                  localizationKey: 'synthetic.retained.message',
                  arguments: { a: String(n), b: 'synthetic' },
                };
      const snapshot: StoredMessageReportSnapshot = {
        reportId,
        chatSessionId: sessionId,
        originalMessageId: messageId,
        senderUserId: messageType === 'system' ? null : randomUUID(),
        messageType,
        content,
        originalCreatedAt: capturedAt,
        integritySha256: '',
      };
      // Exact M6 capture protocol: ordered envelope fields and Date ISO milliseconds.
      // System argument keys are already in the JSONB order used by native capture.
      const integrity = createHash('sha256')
        .update(
          JSON.stringify({
            reportId: snapshot.reportId,
            chatSessionId: snapshot.chatSessionId,
            originalMessageId: snapshot.originalMessageId,
            senderUserId: snapshot.senderUserId,
            messageType: snapshot.messageType,
            content,
            originalCreatedAt: capturedAt.toISOString(),
          }),
        )
        .digest('hex');
      expected.set(reportId, {
        evidenceType: 'message',
        messageId,
        messageType,
        content: messageType === 'text' ? content.text! : JSON.stringify(content),
        createdAt: capturedAt.toISOString(),
      });
      reports.push({
        id: reportId,
        reporter_user_id: fixtureId(`user${n % 257}`),
        target_user_id: fixtureId(`target${n % 64}`),
        reason_id: fixtureId('reason'),
        extra_text: null,
        status: 'submitted',
        command_id: randomUUID(),
        request_id: randomUUID(),
        idempotency_key: `m7-message-${prefix}-${n}`,
        request_digest: 'd'.repeat(64),
        submitted_at: capturedAt,
        reviewed_at: null,
        closed_at: null,
      });
      evidence.push({
        id: evidenceId,
        report_id: reportId,
        evidence_type: 'message',
        profile_id: null,
        profile_photo_id: null,
        chat_session_id: sessionId,
        chat_message_id: messageId,
        unmatch_record_id: null,
        created_at: capturedAt,
      });
      snapshots.push({
        id: randomUUID(),
        report_id: reportId,
        chat_session_id: sessionId,
        original_message_id: messageId,
        sender_user_id: snapshot.senderUserId,
        message_type: messageType,
        content,
        original_created_at: capturedAt,
        snapshotted_at: capturedAt,
        integrity_sha256: integrity,
      });
    }
    await database.insertInto('moderation.reports').values(reports).execute();
    await database.insertInto('moderation.report_evidence').values(evidence).execute();
    await database.insertInto('chat.chat_message_snapshots').values(snapshots).execute();
    const persisted = await database
      .selectFrom('chat.chat_message_snapshots')
      .selectAll()
      .where('report_id', 'in', [...expected.keys()])
      .execute();
    if (persisted.length !== expected.size)
      throw new Error('M7 message capture persistence missing.');
    for (const row of persisted) {
      const subject = {
        reportId: row.report_id,
        chatSessionId: row.chat_session_id,
        messageId: row.original_message_id,
      };
      const snapshot: StoredMessageReportSnapshot = {
        reportId: row.report_id,
        chatSessionId: row.chat_session_id,
        originalMessageId: row.original_message_id,
        senderUserId: row.sender_user_id,
        messageType: row.message_type,
        content: row.content,
        originalCreatedAt: row.original_created_at,
        integritySha256: row.integrity_sha256,
      };
      if (!isDeepStrictEqual(reader.read(subject, snapshot), expected.get(row.report_id)))
        throw new Error('M7 message capture roundtrip invalid.');
      result.integrityVerified++;
      result.byType[row.message_type]++;
      reject(() => reader.read({ ...subject, reportId: subject.chatSessionId }, snapshot));
      result.reportBindingRejected++;
      reject(() => reader.read({ ...subject, chatSessionId: subject.reportId }, snapshot));
      result.sessionBindingRejected++;
      reject(() => reader.read({ ...subject, messageId: subject.reportId }, snapshot));
      result.messageBindingRejected++;
      const changedContent =
        row.message_type === 'text'
          ? { text: 'Changed synthetic message' }
          : row.message_type === 'predefined_question'
            ? { predefinedQuestionId: subject.reportId }
            : row.message_type === 'predefined_answer'
              ? { predefinedAnswerId: subject.reportId }
              : { localizationKey: 'synthetic.changed.message', arguments: row.content.arguments };
      reject(() => reader.read(subject, { ...snapshot, content: changedContent }));
      result.contentRejected++;
      reject(() =>
        reader.read(subject, { ...snapshot, content: { ...row.content, unexpected: 'synthetic' } }),
      );
      result.shapeRejected++;
      reject(() =>
        reader.read(subject, {
          ...snapshot,
          senderUserId: row.sender_user_id === null ? subject.reportId : null,
        }),
      );
      result.senderRejected++;
      reject(() =>
        reader.read(subject, {
          ...snapshot,
          originalCreatedAt: new Date(row.original_created_at.getTime() + 1),
        }),
      );
      result.timestampRejected++;
      reject(() =>
        reader.read(subject, {
          ...snapshot,
          integritySha256:
            snapshot.integritySha256 === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64),
        }),
      );
      result.hashRejected++;
    }
  }
  const observed = (
    await sql<{ count: string; outsideWindow: string }>`
      SELECT count(*)::text AS count,
        count(*) FILTER(WHERE report.submitted_at <= ${at}::timestamptz - interval '24 hours')::text AS "outsideWindow"
      FROM (${MODERATION_INTEGRITY_SOURCES.evidence}) probe
      JOIN moderation.reports report ON report.id = probe."reportId"
      WHERE report.idempotency_key LIKE ${`m7-message-${prefix}-%`}
        AND probe."evidenceType" = 'message' AND probe."hasCapture" AND probe."hasRetainedPhoto"`.execute(
      database,
    )
  ).rows[0]!;
  result.metadataIntact = Number(observed.count);
  result.outsideAdmissionWindow = Number(observed.outsideWindow);
  result.admissionEligibleAfter = await admissionCount();
  if (
    result.integrityVerified !== volume ||
    result.metadataIntact !== volume ||
    result.outsideAdmissionWindow !== volume ||
    result.admissionEligibleBefore !== result.admissionEligibleAfter
  )
    throw new Error('M7 message capture volume incomplete.');
  return result;
}
