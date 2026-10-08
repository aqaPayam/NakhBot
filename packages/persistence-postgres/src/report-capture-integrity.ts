import type {
  ProfileReportSnapshotReader,
  ChatReportSnapshotReader,
  UnmatchedReportSnapshotReader,
  PhotoReportSnapshotReader,
  MessageReportSnapshotReader,
} from '@nakh/application';
import type { RevealedReportEvidence } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

export type ReportEvidenceReaders = Readonly<{
  profile?: ProfileReportSnapshotReader;
  chat?: ChatReportSnapshotReader;
  unmatched_user?: UnmatchedReportSnapshotReader;
  photo?: PhotoReportSnapshotReader;
  message?: MessageReportSnapshotReader;
}>;
/** Internal cryptographic capability. Its caller supplies audited administrator
 * authority or a fenced deletion-work lease. Deletion discards the returned content.
 * All keys are preloaded; no provider or external key request runs in this transaction. */
export async function authenticateReportEvidenceInTransaction(
  transaction: NakhDatabase,
  readers: ReportEvidenceReaders,
  evidenceId: string,
): Promise<RevealedReportEvidence['content']> {
  const selected = await transaction
    .selectFrom('moderation.report_evidence')
    .select(['report_id', 'evidence_type', 'chat_message_id'])
    .where('id', '=', evidenceId)
    .executeTakeFirst();
  if (selected?.evidence_type === 'message') {
    const reader = readers.message;
    const snapshot =
      selected.chat_message_id === null
        ? undefined
        : await transaction
            .selectFrom('chat.chat_message_snapshots')
            .selectAll()
            .where('report_id', '=', selected.report_id)
            .where('original_message_id', '=', selected.chat_message_id)
            .executeTakeFirst();
    if (reader === undefined || snapshot === undefined || selected.chat_message_id === null)
      throw new ApplicationError('report_unavailable', 'error.moderation.report_unavailable', 409);
    const content = reader.read(
      {
        reportId: selected.report_id,
        chatSessionId: snapshot.chat_session_id,
        messageId: selected.chat_message_id,
      },
      {
        reportId: snapshot.report_id,
        chatSessionId: snapshot.chat_session_id,
        originalMessageId: snapshot.original_message_id,
        senderUserId: snapshot.sender_user_id,
        messageType: snapshot.message_type,
        content: snapshot.content,
        originalCreatedAt: snapshot.original_created_at,
        integritySha256: snapshot.integrity_sha256,
      },
    );
    if (
      content.evidenceType !== 'message' ||
      content.messageId !== selected.chat_message_id ||
      content.messageType !== snapshot.message_type ||
      content.createdAt !== snapshot.original_created_at.toISOString()
    )
      throw new Error('Report snapshot reference is invalid.');
    return content;
  }
  const row = await transaction
    .selectFrom('moderation.report_evidence as evidence')
    .innerJoin(
      'moderation.report_snapshots as snapshot',
      'snapshot.report_evidence_id',
      'evidence.id',
    )
    .select([
      'evidence.report_id',
      'evidence.evidence_type',
      'evidence.chat_session_id',
      'evidence.unmatch_record_id',
      'evidence.profile_photo_id',
      'snapshot.snapshot_type',
      'snapshot.schema_version',
      'snapshot.encryption_key_id',
      'snapshot.encryption_key_version',
      'snapshot.nonce',
      'snapshot.ciphertext',
      'snapshot.content_sha256',
    ])
    .where('evidence.id', '=', evidenceId)
    .executeTakeFirst();
  const reader =
    row?.evidence_type === 'profile'
      ? readers.profile
      : row?.evidence_type === 'chat'
        ? readers.chat
        : row?.evidence_type === 'unmatched_user'
          ? readers.unmatched_user
          : row?.evidence_type === 'photo'
            ? readers.photo
            : undefined;
  if (row === undefined || reader === undefined)
    throw new ApplicationError('report_unavailable', 'error.moderation.report_unavailable', 409);
  const content = reader.decrypt(
    { reportId: row.report_id, evidenceId: evidenceId },
    {
      snapshotType: row.snapshot_type,
      schemaVersion: row.schema_version,
      keyId: row.encryption_key_id,
      keyVersion: row.encryption_key_version,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      sha256: row.content_sha256,
    },
  );
  if (
    content.evidenceType !== row.evidence_type ||
    (content.evidenceType === 'chat' && content.chatSessionId !== row.chat_session_id)
  )
    throw new Error('Report snapshot reference is invalid.');
  if (content.evidenceType === 'unmatched_user') {
    const source =
      row.unmatch_record_id === null
        ? undefined
        : await transaction
            .selectFrom('matching.unmatch_records')
            .select(['unmatched_at', 'report_window_expires_at'])
            .where('match_id', '=', row.unmatch_record_id)
            .executeTakeFirst();
    // Retained evidence remains reviewable after expiry; only its immutable binding matters.
    if (
      source === undefined ||
      content.unmatchedAt !== source.unmatched_at.toISOString() ||
      content.reportWindowExpiresAt !== source.report_window_expires_at.toISOString()
    )
      throw new Error('Report snapshot reference is invalid.');
  }
  if (content.evidenceType === 'photo') {
    const held = await transaction
      .selectFrom('media.report_photo_evidence_holds as hold')
      .innerJoin('media.photo_variants as variant', 'variant.id', 'hold.variant_id')
      .select([
        'hold.photo_id',
        'hold.content_sha256',
        'hold.captured_primary',
        'variant.storage_deleted_at',
      ])
      .where('hold.report_evidence_id', '=', evidenceId)
      .executeTakeFirst();
    if (
      held === undefined ||
      held.photo_id !== row.profile_photo_id ||
      held.storage_deleted_at !== null ||
      content.evidenceObjectRef !== `v1.pe.${evidenceId}` ||
      content.contentSha256 !== held.content_sha256 ||
      content.primary !== held.captured_primary
    )
      throw new Error('Report snapshot reference is invalid.');
  }
  return content;
}
