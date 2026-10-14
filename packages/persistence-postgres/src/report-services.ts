import {
  PrepareSingleReportEvidenceHandler,
  SubmitSingleEvidenceReportHandler,
  reportUnavailable,
  type ProfileReportSnapshotProtector,
  type ChatReportSnapshotProtector,
  type UnmatchedReportSnapshotProtector,
  type PhotoReportSnapshotProtector,
  type ProfileReportSourceStore,
  type ReportTokens,
  type ReportTokenReferences,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { ReportEvidenceType } from '@nakh/contracts';
import { canSubmitUserReport } from '@nakh/domain';
import { PostgresUserSessionStore } from './user-session-store.js';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';
import { resolveProfileReportSource } from './profile-report-source-store.js';
import { resolveChatReportSource } from './chat-report-source-store.js';
import { resolveUnmatchedReportSource } from './unmatched-report-source-store.js';
import { resolvePhotoReportSource } from './photo-report-source-store.js';
import { resolveMessageReportSource } from './message-report-source-store.js';
import { captureMessageReportEvidence } from './message-report-submission-store.js';
import { capturePhotoReportEvidence } from './photo-report-submission-store.js';
import {
  PostgresSingleEvidenceReportSubmissionStore,
  captureProfileReportEvidence,
  type SingleReportEvidenceCapture,
} from './profile-report-submission-store.js';
import { captureChatReportEvidence } from './chat-report-submission-store.js';
import { captureUnmatchedReportEvidence } from './unmatched-report-submission-store.js';
import { type ReportEvidenceReaders } from './profile-evidence-reveal-store.js';
import { PostgresConfirmedReportEvidenceReveals } from './confirmed-evidence-reveal-store.js';
import { PostgresGetReportEvidenceActionsHandler } from './report-evidence-actions-store.js';

export type ReportEvidenceCapabilities = Readonly<{
  message?: Readonly<{ reader: NonNullable<ReportEvidenceReaders['message']> }>;
  photo?: Readonly<{
    protector: PhotoReportSnapshotProtector;
    reader: NonNullable<ReportEvidenceReaders['photo']>;
  }>;
  profile?: Readonly<{
    protector: ProfileReportSnapshotProtector;
    reader: NonNullable<ReportEvidenceReaders['profile']>;
  }>;
  chat?: Readonly<{
    protector: ChatReportSnapshotProtector;
    reader: NonNullable<ReportEvidenceReaders['chat']>;
  }>;
  unmatched_user?: Readonly<{
    protector: UnmatchedReportSnapshotProtector;
    reader: NonNullable<ReportEvidenceReaders['unmatched_user']>;
  }>;
}>;

/** Provider-neutral composition. One trusted configuration governs every supported evidence path. */
export function createPostgresReportServices(
  database: NakhDatabase,
  reportTokens: ReportTokens | ReportTokenReferences,
  adminTokens: OpaqueTokenStore,
  adminKey: Uint8Array,
  capabilities: ReportEvidenceCapabilities,
  now: () => number = Date.now,
): Readonly<{
  prepare: PrepareSingleReportEvidenceHandler;
  submit: SubmitSingleEvidenceReportHandler;
  evidenceActions: PostgresGetReportEvidenceActionsHandler;
  reveals: PostgresConfirmedReportEvidenceReveals;
}> {
  type SourceResolver = (
    context: NakhDatabase,
    actor: string,
    source: Parameters<ProfileReportSourceStore['resolve']>[1],
  ) => ReturnType<ProfileReportSourceStore['resolve']>;
  const sources: Partial<Record<ReportEvidenceType, SourceResolver>> = {};
  const captures: Partial<Record<ReportEvidenceType, SingleReportEvidenceCapture['capture']>> = {};
  const readers: { -readonly [K in keyof ReportEvidenceReaders]: ReportEvidenceReaders[K] } = {};
  const types: (keyof ReportEvidenceReaders)[] = [];
  if (capabilities.message !== undefined) {
    sources.message = resolveMessageReportSource;
    captures.message = captureMessageReportEvidence;
    readers.message = capabilities.message.reader;
    types.push('message');
  }
  if (capabilities.photo !== undefined) {
    const { protector, reader } = capabilities.photo;
    sources.photo = resolvePhotoReportSource;
    captures.photo = (transaction, write) =>
      capturePhotoReportEvidence(transaction, write, protector);
    readers.photo = reader;
    types.push('photo');
  }
  if (capabilities.profile !== undefined) {
    const { protector, reader } = capabilities.profile;
    sources.profile = resolveProfileReportSource;
    captures.profile = (transaction, write) =>
      captureProfileReportEvidence(transaction, write, protector);
    readers.profile = reader;
    types.push('profile');
  }
  if (capabilities.chat !== undefined) {
    const { protector, reader } = capabilities.chat;
    sources.chat = resolveChatReportSource;
    captures.chat = (transaction, write) =>
      captureChatReportEvidence(transaction, write, protector);
    readers.chat = reader;
    types.push('chat');
  }
  if (capabilities.unmatched_user !== undefined) {
    const { protector, reader } = capabilities.unmatched_user;
    sources.unmatched_user = resolveUnmatchedReportSource;
    captures.unmatched_user = (transaction, write) =>
      captureUnmatchedReportEvidence(transaction, write, protector);
    readers.unmatched_user = reader;
    types.push('unmatched_user');
  }
  return {
    prepare: new PrepareSingleReportEvidenceHandler(
      reportTokens,
      {
        resolve: (actor, source, type, authority) =>
          database.transaction().execute(async (transaction) => {
            const account = await transaction
              .selectFrom('identity.accounts')
              .select(['product_epoch', 'state'])
              .where('user_id', '=', actor)
              .forShare()
              .executeTakeFirst();
            if (
              account === undefined ||
              !canSubmitUserReport(account.state) ||
              account.product_epoch !== (authority?.productEpoch ?? 0)
            )
              return undefined;
            if (
              authority?.sessionGrantId !== undefined &&
              (await new PostgresUserSessionStore(transaction).current(
                { userId: actor, productEpoch: authority.productEpoch },
                authority.sessionGrantId,
              )) === undefined
            )
              return undefined;
            return type === undefined ? undefined : sources[type]?.(transaction, actor, source);
          }),
      },
      types,
    ),
    submit: new SubmitSingleEvidenceReportHandler(
      reportTokens,
      new PostgresSingleEvidenceReportSubmissionStore(database, {
        capture: (transaction, write) => {
          const type = write.intent.evidence[0]?.evidenceType;
          const capture = type === undefined ? undefined : captures[type];
          if (capture === undefined) throw reportUnavailable();
          return capture(transaction, write);
        },
      }),
      new SystemIdGenerator(),
      types,
    ),
    evidenceActions: new PostgresGetReportEvidenceActionsHandler(
      database,
      adminTokens,
      adminKey,
      now,
      types,
    ),
    reveals: new PostgresConfirmedReportEvidenceReveals(
      database,
      adminTokens,
      adminKey,
      readers,
      now,
    ),
  };
}
