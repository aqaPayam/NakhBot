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
  type OpaqueTokenStore,
} from '@nakh/application';
import type { ReportEvidenceType } from '@nakh/contracts';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';
import { resolveProfileReportSource } from './profile-report-source-store.js';
import { resolveChatReportSource } from './chat-report-source-store.js';
import { resolveUnmatchedReportSource } from './unmatched-report-source-store.js';
import { resolvePhotoReportSource } from './photo-report-source-store.js';
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
  reportTokens: ReportTokens,
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
  const sources: Partial<Record<ReportEvidenceType, ProfileReportSourceStore['resolve']>> = {};
  const captures: Partial<Record<ReportEvidenceType, SingleReportEvidenceCapture['capture']>> = {};
  const readers: { -readonly [K in keyof ReportEvidenceReaders]: ReportEvidenceReaders[K] } = {};
  const types: (keyof ReportEvidenceReaders)[] = [];
  if (capabilities.photo !== undefined) {
    const { protector, reader } = capabilities.photo;
    sources.photo = (actor, source) => resolvePhotoReportSource(database, actor, source);
    captures.photo = (transaction, write) =>
      capturePhotoReportEvidence(transaction, write, protector);
    readers.photo = reader;
    types.push('photo');
  }
  if (capabilities.profile !== undefined) {
    const { protector, reader } = capabilities.profile;
    sources.profile = (actor, source) => resolveProfileReportSource(database, actor, source);
    captures.profile = (transaction, write) =>
      captureProfileReportEvidence(transaction, write, protector);
    readers.profile = reader;
    types.push('profile');
  }
  if (capabilities.chat !== undefined) {
    const { protector, reader } = capabilities.chat;
    sources.chat = (actor, source) => resolveChatReportSource(database, actor, source);
    captures.chat = (transaction, write) =>
      captureChatReportEvidence(transaction, write, protector);
    readers.chat = reader;
    types.push('chat');
  }
  if (capabilities.unmatched_user !== undefined) {
    const { protector, reader } = capabilities.unmatched_user;
    sources.unmatched_user = (actor, source) =>
      resolveUnmatchedReportSource(database, actor, source);
    captures.unmatched_user = (transaction, write) =>
      captureUnmatchedReportEvidence(transaction, write, protector);
    readers.unmatched_user = reader;
    types.push('unmatched_user');
  }
  return {
    prepare: new PrepareSingleReportEvidenceHandler(
      reportTokens,
      {
        resolve: (actor, source, type) =>
          type === undefined
            ? Promise.resolve(undefined)
            : (sources[type]?.(actor, source, type) ?? Promise.resolve(undefined)),
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
