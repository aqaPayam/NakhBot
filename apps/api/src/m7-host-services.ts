import type {
  OpaqueTokenStore,
  PhotoDeliveryRevocation,
  ReviewNoteProtector,
} from '@nakh/application';
import {
  PostgresConfirmedAccountActions,
  PostgresConfirmedInternalBlocks,
  PostgresConfirmedReviewAssignments,
  PostgresConfirmedReviewDecisions,
  PostgresClaimModerationReviewsHandler,
  PostgresConfirmedSupportCommands,
  PostgresConfirmedAppealCommands,
  PostgresConfirmedPhotoActions,
  PostgresRecordAdminIngressRejectionHandler,
  PostgresPrepareReviewActionHandler,
  PostgresPrepareReportAccountActionHandler,
  PostgresPrepareReportPhotoActionHandler,
  PostgresGetSafetyQueueActionsHandler,
  PostgresGetSupportMetadataHandler,
  PostgresPrepareSupportActionHandler,
  PostgresGetAppealMetadataHandler,
  PostgresPrepareAppealReviewAccessHandler,
  PostgresPrepareAppealUnbanAccessHandler,
  PostgresGetOwnAdminCommandReceiptHandler,
} from '@nakh/persistence-postgres';
import { createM7ReportHostOptions, type M7ReportHostConfiguration } from './m7-report-services.js';
import { createM7SupportApiOptions } from './m7-support-services.js';
import { createM7AppealApiOptions } from './m7-appeal-services.js';
import type { M7AdminModerationApiOptions } from './m7-admin-moderation-api.js';

export type M7HostConfiguration = M7ReportHostConfiguration &
  Readonly<{
    safetyTokens: OpaqueTokenStore;
    safetyKey: Uint8Array;
    reviewNotes: ReviewNoteProtector;
    photoDelivery?: PhotoDeliveryRevocation;
  }>;
/** One trusted host owns database, verifier and capability configuration for every M7 route. */
export function createM7HostOptions(input: M7HostConfiguration): Readonly<{
  reports: ReturnType<typeof createM7ReportHostOptions>['reports'];
  adminReports: ReturnType<typeof createM7ReportHostOptions>['adminReports'];
  adminModeration: M7AdminModerationApiOptions;
  support: ReturnType<typeof createM7SupportApiOptions>;
  appeals: ReturnType<typeof createM7AppealApiOptions>;
}> {
  const reportHost = createM7ReportHostOptions(input);
  const appealCommands = new PostgresConfirmedAppealCommands(
    input.database,
    input.adminTokens,
    input.adminKey,
  );
  const adminModeration: M7AdminModerationApiOptions = Object.freeze({
    ownCommandReceipts: new PostgresGetOwnAdminCommandReceiptHandler(input.database),
    appealUnbanActions: new PostgresPrepareAppealUnbanAccessHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    appealActions: new PostgresPrepareAppealReviewAccessHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    appealMetadata: new PostgresGetAppealMetadataHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    supportActions: new PostgresPrepareSupportActionHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    supportMetadata: new PostgresGetSupportMetadataHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    safetyQueueActions: new PostgresGetSafetyQueueActionsHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    reportAccountActions: new PostgresPrepareReportAccountActionHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    reviewActions: new PostgresPrepareReviewActionHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    authenticator: input.authenticator,
    journal: new PostgresRecordAdminIngressRejectionHandler(input.database),
    accounts: new PostgresConfirmedAccountActions(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    internalBlocks: new PostgresConfirmedInternalBlocks(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    reviewClaims: new PostgresClaimModerationReviewsHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    reviewAssignments: new PostgresConfirmedReviewAssignments(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    reviewDecisions: new PostgresConfirmedReviewDecisions(
      input.database,
      input.adminTokens,
      input.adminKey,
      input.reviewNotes,
    ),
    supportCommands: new PostgresConfirmedSupportCommands(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    appealReviews: appealCommands,
    appealUnbans: appealCommands,
    ...(input.photoDelivery === undefined
      ? {}
      : {
          reportPhotoActions: new PostgresPrepareReportPhotoActionHandler(
            input.database,
            input.adminTokens,
            input.adminKey,
          ),
          photos: new PostgresConfirmedPhotoActions(
            input.database,
            input.adminTokens,
            input.adminKey,
            input.photoDelivery,
          ),
        }),
  });
  const safety = {
    database: input.database,
    authenticator: input.authenticator,
    tokens: input.safetyTokens,
    key: input.safetyKey,
  };
  return Object.freeze({
    ...reportHost,
    adminModeration,
    support: createM7SupportApiOptions(safety),
    appeals: createM7AppealApiOptions(safety),
  });
}
export type M7HostApiOptions = ReturnType<typeof createM7HostOptions>;
