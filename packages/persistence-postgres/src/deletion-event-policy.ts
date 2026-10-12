/** Code-owned transport classification. This is not event admission, retention
 * approval, purge authority, or permission to restore a product projection. */
export type DeletionEventDisposition =
  | 'product_transport'
  | 'financial_proof'
  | 'safety_proof'
  | 'lifecycle_proof'
  | 'ordinary_content'
  | 'unclassified';

type Shape = Readonly<{ required: string; optional?: string }>;
const shapes: Readonly<Record<string, Shape | readonly Shape[]>> = Object.freeze({
  'identity.telegram-identity-registered.v1': { required: 'userId accountState' },
  'telegram.start-route-requested.v1': { required: 'userId entryRoute uiLocale' },
  'identity.signup-started.v1': { required: 'userId currentStep draftVersion' },
  'identity.signup-step-saved.v1': { required: 'userId completedStep currentStep draftVersion' },
  'identity.locale-changed.v1': { required: 'userId uiLocale visibilityEnabled settingsVersion' },
  'identity.visibility-changed.v1': {
    required: 'userId uiLocale visibilityEnabled settingsVersion',
  },
  'identity.guest-preview-consumed.v1': { required: 'userId count limit remaining' },
  'identity.account-state-changed.v1': [
    { required: 'userId previousState nextState reasonCode accountVersion' },
    { required: 'userId profileId accountState' },
  ],
  'profile.confirmed.v1': { required: 'userId profileId accountState' },
  'profile.updated.v1': { required: 'userId profileId version' },
  'profile.profile-completed.v1': { required: 'profileId' },
  'profile.profile-invalidated.v1': { required: 'profileId' },
  'profile.protected-change-requested.v1': {
    required: 'profileChangeRequestId userId field status',
  },
  'profile.protected-change-reviewed.v1': {
    required: 'profileChangeRequestId userId field decision profileVersion',
  },
  'discovery.filter-saved.v1': { required: 'userId version' },
  'discovery.candidate-reserved.v1': {
    required: 'deliveryId viewerUserId targetUserId mode filterVersion',
  },
  'discovery.candidate-delivered.v1': { required: 'deliveryId viewerUserId targetUserId mode' },
  'discovery.candidate-delivery-failed.v1': {
    required: 'deliveryId viewerUserId targetUserId mode reasonCode',
  },
  'discovery.consumption-created.v1': { required: 'viewerUserId targetUserId reason' },
  'interaction.like-created.v1': {
    required: 'likeId senderUserId receiverUserId notificationEligible',
    optional: 'source',
  },
  'interaction.like-closed.v1': { required: 'reason', optional: 'likeId likeIds matchId' },
  'interaction.not-interested-created.v1': {
    required: 'rejectionId senderUserId receiverUserId source',
  },
  'matching.match-created.v1': {
    required: 'matchId userLowId userHighId source',
    optional: 'nakhId',
  },
  'matching.unmatched.v1': { required: 'matchId chatSessionId' },
  'telegram.liked-by-delivery-requested.v1': { required: 'deliveryId' },
  'notification.delivery-requested.v1': { required: 'notificationId deliveryId channel' },
  'chat.message-created.v1': { required: 'chatSessionId messageId messageType' },
  'chat.read-advanced.v1': { required: 'chatSessionId throughSequenceNumber' },
  'chat.mute-changed.v1': { required: 'chatSessionId muted version' },
  'nakh.flow-created.v1': { required: 'flowId senderUserId receiverUserId' },
  'nakh.pending-created.v1': { required: 'pendingNakhId senderUserId' },
  'nakh.pending-updated.v1': { required: 'pendingNakhId senderUserId' },
  'nakh.pending-reminder-requested.v1': { required: 'pendingNakhId reminderNumber' },
  'nakh.delivered.v1': { required: 'nakhId receiverUserId' },
  'nakh.cancelled.v1': { required: 'pendingNakhId senderUserId resolution' },
  'nakh.status-changed.v1': { required: 'status', optional: 'nakhId pendingNakhId matchId' },
  'billing.payment-receipt-recorded.v1': { required: 'paymentRecordId' },
  'billing.payment-correction-required.v1': { required: 'paymentRecordId' },
  'billing.payment-fulfilled.v1': { required: 'paymentRecordId' },
  'billing.payment-corrected.v1': { required: 'paymentRecordId refundRecordId' },
  'billing.credit-increased.v1': { required: 'creditTransactionId amount balanceAfter' },
  'entitlement.feature-unlocked.v1': { required: 'featureUnlockId featureType' },
  'moderation.report-submitted.v1': { required: 'reportId evidenceTypes status' },
  'moderation.threshold-reached.v1': {
    required: 'restrictionEpisodeId targetUserId distinctReporterCount',
  },
  'moderation.review-decided.v1': { required: 'reviewId status version' },
  'moderation.appeal-changed.v1': { required: 'appealId status version' },
  'support.thread-changed.v1': {
    required: 'supportThreadId userId status version unansweredUserMessages',
  },
  'moderation.action-recorded.v1': {
    required: 'actionId actionType',
    optional:
      'targetUserId accountVersion restrictionEpisodeId photoId photoVersion profileVersion pairTargetId',
  },
  'moderation.internal-block-changed.v1': {
    required: 'actionId action pairTargetId pairVersion closedLikeCount revokedUnlockCount',
    optional: 'closedMatchId closedChatSessionId',
  },
  'account.deletion-requested.v1': { required: 'deletionRecordId step' },
  'account.shared-scope-closed.v1': {
    required: 'deletionRecordId recipientUserId',
    optional: 'matchId',
  },
  'account.deletion-phase-completed.v1': {
    required: 'deletionRecordId completedPhase nextPhase checkpointVersion',
  },
  'account.deletion-credit-epoch-prepared.v1': { required: 'deletionRecordId kind' },
  'account.deletion-product-batch.v1': { required: 'deletionRecordId resource rows auditId' },
  'account.deletion-operational-batch.v1': { required: 'deletionRecordId kind rows auditId' },
  'account.deletion-evidence-verified.v1': { required: 'deletionRecordId kind' },
  'account.deletion-profile-archived.v1': { required: 'deletionRecordId kind' },
  'account.deletion-photo-archived.v1': { required: 'deletionRecordId kind' },
  'account.deletion-match-archived.v1': { required: 'deletionRecordId kind' },
  'account.deletion-chat-archived.v1': { required: 'deletionRecordId kind final deletedCount' },
  'account.deletion-support-closed.v1': { required: 'deletionRecordId kind count' },
  'account.deletion-nakh-batch.v1': { required: 'deletionRecordId kind rows auditId' },
  'account.deletion-paid-pending-batch.v1': { required: 'deletionRecordId kind rows auditId' },
  'account.deletion-terminal-pending-batch.v1': { required: 'deletionRecordId kind rows auditId' },
  'account.deletion-flow-batch.v1': { required: 'deletionRecordId kind rows auditId' },
  'account.deletion-like-batch.v1': { required: 'deletionRecordId kind rows auditId' },
  'account.deletion-unlock-batch.v1': { required: 'deletionRecordId kind rows auditId' },
  'account.deletion-pair-batch.v1': { required: 'deletionRecordId kind rows auditId' },
  'account.deletion-notice-batch.v1': { required: 'deletionRecordId kind rows auditId' },
  'media.quarantine-uploaded.v1': { required: 'assetId bytes' },
  'media.ingestion-requested.v1': { required: 'assetId validationState' },
  'media.ingestion-rejected.v1': { required: 'assetId', optional: 'errorCode validationState' },
  'media.asset-cleanup-completed.v1': { required: 'assetId deletionGeneration' },
  'media.photo-hidden.v1': { required: 'profileId photoId' },
  'media.photo-visible.v1': { required: 'profileId photoId' },
  'media.photo-deleted.v1': { required: 'profileId photoId' },
  'media.photo-primary-selected.v1': { required: 'profileId photoId' },
  'media.photos-reordered.v1': { required: 'profileId' },
  'media.photo-validated.v1': { required: 'assetId resultCode' },
  'media.validation-rejected.v1': { required: 'assetId resultCode' },
});

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const unsigned = /^(?:0|[1-9][0-9]{0,18})$/u;
const code = /^[a-z][a-z0-9_]{0,79}$/u;
const machineValues = new Set([
  'guest',
  'incomplete',
  'active',
  'restricted',
  'banned',
  'deleted',
  'continue_signup',
  'main',
  'main_discovery_paused',
  'fix_profile',
  'ban_appeal',
  'return_decision',
  'age_confirmation',
  'name',
  'birth_year',
  'gender',
  'relationship_gender_preference',
  'interests',
  'location',
  'relationship_goal',
  'primary_photo',
  'additional_photos',
  'highlight',
  'optional_details',
  'confirm_profile',
  'completed',
  'pending',
  'pending_payment',
  'paid_and_sent',
  'cancelled',
  'expired',
  'closed_by_system',
  'sent',
  'seen',
  'accepted',
  'rejected',
  'closed',
  'submitted',
  'pending_review',
  'dismissed',
  'actioned',
  'open',
  'in_review',
  'approved',
  'explore',
  'guest_preview',
  'liked_by',
  'like',
  'not_interested',
  'matched',
  'reciprocal_likes',
  'nakh',
  'direct',
  'pending_nakh',
  'mutual_like',
  'cancelled_pending_nakh',
  'send_nakh',
  'nakh_flow',
  'converted_to_like',
  'converted_to_not_interested',
  'text',
  'predefined_question',
  'predefined_answer',
  'system',
  'chat',
  'photo',
  'profile',
  'chat_unlock',
  'liked_by_profile_unlock',
  'telegram',
  'birth_year',
  'gender',
  'restrict_user',
  'ban_user',
  'unrestrict_user',
  'unban_user',
  'hide_photo',
  'restore_photo',
  'delete_photo',
  'create_internal_block',
  'remove_internal_block',
  'create',
  'remove',
  'shared_closure',
  'evidence_capture',
  'product_data',
  'media_objects',
  'ephemeral_access',
  'retention_manifest',
  'verification',
  'credit_epoch',
  'quarantined',
  'validating',
  'valid',
  'invalid',
  'rejected',
  'uploaded',
  'capture_integrity',
  'profile_source',
  'photo_source',
  'chat_source',
  'match_source',
  'support_scope',
  'nakh_source',
  'paid_pending_source',
  'terminal_pending_source',
  'flow_source',
  'like_source',
  'unlock_source',
  'pair_source',
  'notice_source',
  'outbox_cancel',
]);

const booleanFields = ['notificationEligible', 'muted', 'visibilityEnabled', 'final'];
const quantityFields = ['amount', 'balanceAfter', 'throughSequenceNumber', 'bytes'];
const codeFields = ['reasonCode', 'errorCode', 'resultCode'];
const counterFields = [
  'version',
  'draftVersion',
  'settingsVersion',
  'accountVersion',
  'filterVersion',
  'photoVersion',
  'profileVersion',
  'pairVersion',
  'checkpointVersion',
  'count',
  'limit',
  'remaining',
  'reminderNumber',
  'distinctReporterCount',
  'unansweredUserMessages',
  'closedLikeCount',
  'revokedUnlockCount',
  'deletionGeneration',
  'resource',
  'rows',
  'deletedCount',
];
/** Reviewed migration snapshot; native parity tests must match these same rules. */
export const DELETION_EVENT_POLICY = Object.freeze({
  shapes,
  machineValues: Object.freeze([...machineValues]),
  booleanFields: Object.freeze(booleanFields),
  quantityFields: Object.freeze(quantityFields),
  codeFields: Object.freeze(codeFields),
  counterFields: Object.freeze(counterFields),
});

function fieldValid(key: string, value: unknown): boolean {
  if (key.endsWith('Id')) return typeof value === 'string' && uuid.test(value);
  if (key === 'likeIds')
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 100 &&
      value.every((v) => typeof v === 'string' && uuid.test(v))
    );
  if (key === 'evidenceTypes')
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 4 &&
      value.every(
        (v) => typeof v === 'string' && ['profile', 'photo', 'chat', 'unmatch'].includes(v),
      )
    );
  if (booleanFields.includes(key)) return typeof value === 'boolean';
  if (quantityFields.includes(key))
    return (
      (typeof value === 'string' && unsigned.test(value)) ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    );
  if (key === 'uiLocale')
    return typeof value === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/u.test(value);
  if (codeFields.includes(key)) return typeof value === 'string' && code.test(value);
  if (counterFields.includes(key))
    return (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647
    );
  return typeof value === 'string' && machineValues.has(value);
}

export function classifyDeletionEvent(
  eventType: string,
  schemaVersion: number,
  payload: unknown,
): DeletionEventDisposition {
  if (
    schemaVersion !== 1 ||
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  )
    return 'unclassified';
  if (eventType === 'platform.sample-effect-created.v1') return 'ordinary_content';
  const alternatives = Object.hasOwn(shapes, eventType) ? shapes[eventType] : undefined;
  if (alternatives === undefined) return 'unclassified';
  const data = payload as Record<string, unknown>;
  const candidates: readonly Shape[] = Array.isArray(alternatives)
    ? alternatives
    : [alternatives as Shape];
  if (
    !candidates.some((shape) => {
      const required = shape.required.split(' ');
      const allowed = new Set([...required, ...(shape.optional?.split(' ') ?? [])]);
      return (
        required.every((key) => Object.hasOwn(data, key)) &&
        Object.entries(data).every(([key, value]) => allowed.has(key) && fieldValid(key, value))
      );
    })
  )
    return 'unclassified';
  if (
    eventType === 'nakh.status-changed.v1' &&
    Number(Object.hasOwn(data, 'nakhId')) + Number(Object.hasOwn(data, 'pendingNakhId')) !== 1
  )
    return 'unclassified';
  if (
    eventType === 'interaction.like-closed.v1' &&
    Number(Object.hasOwn(data, 'likeId')) + Number(Object.hasOwn(data, 'likeIds')) !== 1
  )
    return 'unclassified';
  if (
    eventType.startsWith('account.') ||
    eventType === 'media.asset-cleanup-completed.v1' ||
    (eventType === 'telegram.start-route-requested.v1' && data.entryRoute === 'return_decision')
  )
    return 'lifecycle_proof';
  if (eventType.startsWith('billing.') || eventType.startsWith('entitlement.'))
    return 'financial_proof';
  if (eventType.startsWith('moderation.') || eventType.startsWith('support.'))
    return 'safety_proof';
  return 'product_transport';
}
