import type {
  OpaqueTokenStore,
  ReviewNoteProtector,
  PhotoDeliveryRevocation,
} from '@nakh/application';
import {
  PostgresConfirmedAppealReveals,
  PostgresConfirmedSupportReveals,
  PostgresConfirmedSupportCommands,
  PostgresConfirmedAppealCommands,
  PostgresPrepareAppealUnbanAccessHandler,
  PostgresPrepareSupportActionHandler,
  PostgresPrepareAppealReviewAccessHandler,
  PostgresGetSafetyQueueActionsHandler,
  PostgresGetSupportMetadataHandler,
  PostgresGetAppealMetadataHandler,
  PostgresGetAdminReportQueueActionsHandler,
  PostgresGetReportMetadataPageHandler,
  PostgresPrepareSelectedReportReviewHandler,
  PostgresConfirmedReviewAssignments,
  PostgresConfirmedReviewDecisions,
  PostgresPrepareSelectedReportAccountActionHandler,
  PostgresConfirmedAccountActions,
  PostgresGetSelectedReportEvidenceMetadataHandler,
  PostgresPrepareSelectedReportPhotoActionHandler,
  PostgresConfirmedPhotoActions,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  TelegramAdminSafetyContentAdapter,
  TelegramAdminSafetyReadVault,
  TelegramAdminSafetyReadPreparation,
  TelegramAdminSafetyTargetSelection,
  TelegramAdminSafetyQueueState,
  TelegramAdminSafetyQueueAdapter,
  TelegramAdminSafetyFeedback,
  TelegramAdminSupportMutationVault,
  TelegramAdminSupportMutations,
  TelegramAdminAppealReviews,
  TelegramAdminAppealUnbans,
  TelegramAdminSafetyMutationVault,
  TelegramAdminReadConfirmationMenus,
  TelegramAdminReportAssignments,
  TelegramAdminReportDecisions,
  TelegramAdminReportAccountActions,
  TelegramAdminReportQueue,
  TelegramAdminReportQueueState,
  TelegramAdminReportEvidence,
  TelegramAdminReportPhotoActions,
  TelegramAdminReportPhotoPicker,
  type TelegramSelectedReportEvidence,
  type TelegramAdminTextDelivery,
  type TelegramAdminSessionVerifier,
  type M7TextRenderer,
} from '@nakh/telegram';

/** Explicit composition only. A trusted selected-target UI calls prepare; authenticated private
 * webhook callbacks call handle. Ordinary startup enables neither session nor admin delivery. */
export function createTelegramAdminSafetyReadIngress(
  input: Readonly<{
    database: NakhDatabase;
    botId: string;
    tokens: OpaqueTokenStore;
    adminKey: Uint8Array;
    uiEncryptionKey: Uint8Array;
    uiReferenceKey: Uint8Array;
    sessions: TelegramAdminSessionVerifier;
    renderer: M7TextRenderer;
    delivery: TelegramAdminTextDelivery;
    reviewNotes?: ReviewNoteProtector;
    photoDelivery?: PhotoDeliveryRevocation;
  }>,
): Readonly<{
  prepare: TelegramAdminSafetyReadPreparation['prepare'];
  select: TelegramAdminSafetyTargetSelection['select'];
  handle: TelegramAdminSafetyContentAdapter['handle'];
}> {
  const support = new PostgresConfirmedSupportReveals(input.database, input.tokens, input.adminKey);
  const appeals = new PostgresConfirmedAppealReveals(input.database, input.tokens, input.adminKey);
  const vault = new TelegramAdminSafetyReadVault(
    input.tokens,
    input.uiEncryptionKey,
    input.uiReferenceKey,
  );
  const menus = new TelegramAdminReadConfirmationMenus(
    input.sessions,
    vault,
    input.renderer,
    input.delivery,
  );
  const preparation = new TelegramAdminSafetyReadPreparation(
    input.sessions,
    support,
    appeals,
    vault,
    menus,
  );
  const reads = new TelegramAdminSafetyContentAdapter(
    input.sessions,
    vault,
    support,
    appeals,
    input.delivery,
    input.renderer,
  );
  const selections = new TelegramAdminSafetyTargetSelection(
    input.sessions,
    new PostgresPrepareSupportActionHandler(input.database, input.tokens, input.adminKey),
    new PostgresPrepareAppealReviewAccessHandler(input.database, input.tokens, input.adminKey),
    input.tokens,
    input.uiReferenceKey,
    preparation,
  );
  const mutations = new TelegramAdminSupportMutations(
    input.sessions,
    new PostgresPrepareSupportActionHandler(input.database, input.tokens, input.adminKey),
    new PostgresConfirmedSupportCommands(input.database, input.tokens, input.adminKey),
    new TelegramAdminSupportMutationVault(
      input.tokens,
      input.uiEncryptionKey,
      input.uiReferenceKey,
    ),
    input.uiReferenceKey,
    input.delivery,
    input.renderer,
  );
  const reviews = new TelegramAdminAppealReviews(
    input.sessions,
    new PostgresPrepareAppealReviewAccessHandler(input.database, input.tokens, input.adminKey),
    new PostgresConfirmedAppealCommands(input.database, input.tokens, input.adminKey),
    new TelegramAdminSafetyMutationVault(
      'appeal-review',
      input.tokens,
      input.uiEncryptionKey,
      input.uiReferenceKey,
    ),
    input.uiReferenceKey,
    input.delivery,
    input.renderer,
  );
  const unbans = new TelegramAdminAppealUnbans(
    input.sessions,
    new PostgresPrepareAppealUnbanAccessHandler(input.database, input.tokens, input.adminKey),
    new PostgresConfirmedAppealCommands(input.database, input.tokens, input.adminKey),
    new TelegramAdminSafetyMutationVault(
      'appeal-unban',
      input.tokens,
      input.uiEncryptionKey,
      input.uiReferenceKey,
    ),
    input.uiReferenceKey,
    input.delivery,
    input.renderer,
  );
  const queue = new TelegramAdminSafetyQueueAdapter(
    input.botId,
    input.sessions,
    new PostgresGetSafetyQueueActionsHandler(input.database, input.tokens, input.adminKey),
    new PostgresGetSupportMetadataHandler(input.database, input.tokens, input.adminKey),
    new PostgresGetAppealMetadataHandler(input.database, input.tokens, input.adminKey),
    new PostgresPrepareSupportActionHandler(input.database, input.tokens, input.adminKey),
    new PostgresPrepareAppealReviewAccessHandler(input.database, input.tokens, input.adminKey),
    new TelegramAdminSafetyQueueState(input.tokens, input.uiEncryptionKey, input.uiReferenceKey),
    selections,
    input.delivery,
    input.renderer,
    undefined,
    mutations,
    reviews,
    unbans,
  );
  const reportAssignments = new TelegramAdminReportAssignments(
    input.sessions,
    new PostgresPrepareSelectedReportReviewHandler(input.database, input.tokens, input.adminKey),
    new PostgresConfirmedReviewAssignments(input.database, input.tokens, input.adminKey),
    new TelegramAdminSafetyMutationVault(
      'report-assignment',
      input.tokens,
      input.uiEncryptionKey,
      input.uiReferenceKey,
    ),
    input.uiReferenceKey,
    input.delivery,
    input.renderer,
  );
  const reportDecisions =
    input.reviewNotes === undefined
      ? undefined
      : new TelegramAdminReportDecisions(
          input.sessions,
          new PostgresPrepareSelectedReportReviewHandler(
            input.database,
            input.tokens,
            input.adminKey,
          ),
          new PostgresConfirmedReviewDecisions(
            input.database,
            input.tokens,
            input.adminKey,
            input.reviewNotes,
          ),
          new TelegramAdminSafetyMutationVault(
            'report-decision',
            input.tokens,
            input.uiEncryptionKey,
            input.uiReferenceKey,
          ),
          input.uiReferenceKey,
          input.delivery,
          input.renderer,
        );
  const reportAccounts = new TelegramAdminReportAccountActions(
    input.sessions,
    new PostgresPrepareSelectedReportAccountActionHandler(
      input.database,
      input.tokens,
      input.adminKey,
    ),
    new PostgresConfirmedAccountActions(input.database, input.tokens, input.adminKey),
    new TelegramAdminSafetyMutationVault(
      'report-account',
      input.tokens,
      input.uiEncryptionKey,
      input.uiReferenceKey,
    ),
    input.uiReferenceKey,
    input.delivery,
    input.renderer,
  );
  const reportState = new TelegramAdminReportQueueState(
    input.tokens,
    input.uiEncryptionKey,
    input.uiReferenceKey,
  );
  const photoActions =
    input.photoDelivery === undefined
      ? undefined
      : new TelegramAdminReportPhotoActions(
          input.sessions,
          new PostgresPrepareSelectedReportPhotoActionHandler(
            input.database,
            input.tokens,
            input.adminKey,
          ),
          new PostgresConfirmedPhotoActions(
            input.database,
            input.tokens,
            input.adminKey,
            input.photoDelivery,
          ),
          new TelegramAdminSafetyMutationVault(
            'report-photo',
            input.tokens,
            input.uiEncryptionKey,
            input.uiReferenceKey,
          ),
          input.uiReferenceKey,
          input.delivery,
          input.renderer,
        );
  const photoPicker =
    photoActions === undefined
      ? undefined
      : new TelegramAdminReportPhotoPicker(
          input.botId,
          input.sessions,
          {
            selection: (id: string, reference: string): Promise<TelegramSelectedReportEvidence> =>
              reportEvidence.selection(id, reference),
          },
          reportState,
          photoActions,
          input.delivery,
          input.renderer,
        );
  const reportEvidence: TelegramAdminReportEvidence = new TelegramAdminReportEvidence(
    input.botId,
    input.sessions,
    new PostgresGetSelectedReportEvidenceMetadataHandler(
      input.database,
      input.tokens,
      input.adminKey,
    ),
    reportState,
    input.delivery,
    input.renderer,
    undefined,
    photoPicker,
  );
  const reportQueue = new TelegramAdminReportQueue(
    input.botId,
    input.sessions,
    new PostgresGetAdminReportQueueActionsHandler(input.database, input.tokens, input.adminKey),
    new PostgresGetReportMetadataPageHandler(input.database, input.tokens, input.adminKey),
    reportState,
    reportAssignments,
    input.delivery,
    input.renderer,
    undefined,
    reportDecisions,
    reportAccounts,
    reportEvidence,
  );
  const feedback = new TelegramAdminSafetyFeedback(
    input.botId,
    input.sessions,
    [
      queue,
      reads,
      mutations,
      reviews,
      unbans,
      reportQueue,
      reportAssignments,
      reportAccounts,
      reportEvidence,
      ...(photoActions === undefined ? [] : [photoActions]),
      ...(photoPicker === undefined ? [] : [photoPicker]),
      ...(reportDecisions === undefined ? [] : [reportDecisions]),
    ],
    input.tokens,
    input.uiReferenceKey,
    input.delivery,
    input.renderer,
  );
  return Object.freeze({
    select: selections.select.bind(selections),
    prepare: preparation.prepare.bind(preparation),
    handle: feedback.handle.bind(feedback),
  });
}
