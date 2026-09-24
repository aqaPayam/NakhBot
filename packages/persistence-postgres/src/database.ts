import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import type {
  AccountState,
  ProfileChangeDecision,
  ProfileChangeStatus,
  ProtectedProfileField,
} from '@nakh/domain';
import pg from 'pg';
import type {
  MediaAssetTable,
  PhotoVariantTable,
  ProfilePhotoTable,
  PhotoModerationTable,
} from './media-tables.js';

const { Pool } = pg;

type JsonObject = Readonly<Record<string, unknown>>;
type JsonArray = readonly unknown[];

export interface IdempotencyTable {
  id: string;
  actor_user_id: string;
  scope: string;
  idempotency_key: string;
  request_hash: string;
  status: 'processing' | 'completed';
  response_json: ColumnType<JsonObject | null, object | null, object | null>;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface SampleEffectTable {
  id: string;
  actor_user_id: string;
  name: string;
  created_at: Date;
}

export interface OutboxEventTable {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  schema_version: number;
  payload: ColumnType<JsonObject, object, object>;
  occurred_at: Date;
  available_at: Date;
  attempt_count: Generated<number>;
  published_at: Date | null;
  last_error_code: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  correlation_id: string;
  causation_id: string;
}

export interface InboxMessageTable {
  id: string;
  consumer: string;
  message_id: string;
  payload_hash: string;
  received_at: Date;
  processed_at: Date | null;
  result_code: string | null;
}

export interface TelegramLikedByDeliveryRequestTable {
  id: string;
  bot_id: string;
  update_id: string;
  viewer_user_id: string;
  telegram_user_id: string;
  request_id: string;
  cursor: string | null;
  callback_query_id: string | null;
  state: Generated<'pending' | 'delivered' | 'failed'>;
  attempt_count: Generated<number>;
  available_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TelegramLikedByDeliveryReceiptTable {
  delivery_id: string;
  message_key: string;
  provider_message_id: string;
  recorded_at: Date;
}

export interface SampleProjectionTable {
  id: string;
  source_event_id: string;
  effect_id: string;
  projected_name: string;
  projected_at: Date;
}

export interface ScheduledJobTable {
  id: string;
  job_type: string;
  is_active: Generated<boolean>;
  schedule_config: ColumnType<JsonObject, object, object>;
  last_run_at: Date | null;
  next_run_at: Date;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
}

export interface JobRunLogTable {
  id: string;
  scheduled_job_id: string;
  run_key: string;
  status: 'started' | 'succeeded' | 'failed' | 'skipped';
  started_at: Date;
  finished_at: Date | null;
  error_code: string | null;
  metadata: ColumnType<JsonObject, object, object>;
}

export interface LocaleTable {
  code: string;
  english_name: string;
  native_name: string;
  is_active: boolean;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UiTextTable {
  id: string;
  locale_code: string;
  text_key: string;
  value: string;
  category: 'button' | 'message' | 'error' | 'admin' | 'payment' | 'notification' | 'safety';
  variables: ColumnType<JsonArray, readonly unknown[], readonly unknown[]>;
  is_active: Generated<boolean>;
  created_at: Date;
  updated_at: Date;
}

export interface CatalogOptionTable {
  id: string;
  code: string;
  label_key: string;
  is_active: Generated<boolean>;
  display_order: number;
}

export interface GenderPreferenceMemberTable {
  gender_preference_id: string;
  gender_option_id: string;
}

export interface ProfileOptionValueTable extends CatalogOptionTable {
  category:
    | 'education_level'
    | 'smoking_preference'
    | 'pets_preference'
    | 'exercise_frequency'
    | 'religion_importance'
    | 'children_preference';
}

export interface ProvinceTable extends CatalogOptionTable {
  country_id: string;
}

export interface CityTable extends CatalogOptionTable {
  province_id: string;
}

export interface UserTable {
  id: string;
  last_activity_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface TelegramIdentityTable {
  user_id: string;
  telegram_user_id: string;
  username: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
}

export interface AccountTable {
  user_id: string;
  state: AccountState;
  state_reason: string | null;
  state_changed_at: Date;
  version: Generated<number>;
}

export interface AccountStateHistoryTable {
  id: string;
  user_id: string;
  previous_state: AccountState | null;
  next_state: AccountState;
  reason_code: string;
  actor_type: 'user' | 'admin' | 'system';
  actor_user_id: string | null;
  actor_admin_id: string | null;
  changed_at: Date;
}

export interface GuestPreviewCounterTable {
  user_id: string;
  preview_count: Generated<number>;
  limit_count: number;
  first_preview_at: Date | null;
  last_preview_at: Date | null;
}

export interface UserSettingsTable {
  user_id: string;
  visibility_enabled: Generated<boolean>;
  ui_locale_code: Generated<string>;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
}

export interface SignupProgressTable {
  user_id: string;
  current_step:
    | 'age_confirmation'
    | 'name'
    | 'birth_year'
    | 'gender'
    | 'relationship_gender_preference'
    | 'interests'
    | 'location'
    | 'relationship_goal'
    | 'primary_photo'
    | 'additional_photos'
    | 'highlight'
    | 'optional_details'
    | 'confirm_profile'
    | 'completed';
  started_at: Date;
  completed_at: Date | null;
  version: Generated<number>;
  updated_at: Date;
}

export interface SignupDraftTable {
  user_id: string;
  draft_data: ColumnType<JsonObject, object, object>;
  schema_version: number;
  last_completed_step: SignupProgressTable['current_step'] | null;
  expires_at: Date | null;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
}

export interface ProfileTable {
  id: string;
  user_id: string;
  name: string;
  birth_year: number;
  gender_option_id: string;
  gender_preference_id: string;
  relationship_goal_id: string;
  country_id: string;
  province_id: string;
  city_id: string;
  highlight: string;
  bio: string | null;
  completion_status: 'incomplete' | 'complete' | 'invalid';
  ever_completed: Generated<boolean>;
  completed_at: Date | null;
  random_shuffle_key: Generated<number>;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
}

export interface ProfileOptionalDetailsTable {
  profile_id: string;
  height_cm: number | null;
  job_title: string | null;
  education_level_code: string | null;
  smoking_preference_code: string | null;
  pets_preference_code: string | null;
  exercise_frequency_code: string | null;
  religion_importance_code: string | null;
  children_preference_code: string | null;
}

export interface ProfileSelectionTable {
  profile_id: string;
  interest_id: string;
}

export interface ProfileLanguageTable {
  profile_id: string;
  language_id: string;
}

export interface ProfilePersonalityTagTable {
  profile_id: string;
  personality_tag_id: string;
}

export interface AdminUserTable {
  id: string;
  user_id: string;
  telegram_user_id: string;
  is_active: Generated<boolean>;
  disabled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProfileChangeRequestTable {
  id: string;
  user_id: string;
  field_name: ProtectedProfileField;
  old_value_snapshot: ColumnType<number | string, number | string, number | string>;
  requested_value: ColumnType<number | string, number | string, number | string>;
  value_schema_version: number;
  reason: string;
  status: ProfileChangeStatus;
  submitted_at: Date;
  resolved_at: Date | null;
}

export interface ProfileChangeReviewTable {
  request_id: string;
  admin_user_id: string;
  decision: ProfileChangeDecision;
  admin_note: string | null;
  reviewed_at: Date;
}

export interface CreditAccountTable {
  user_id: string;
  balance: Generated<string>;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
}

export interface UserCounterTable {
  user_id: string;
  pending_nakh_count: Generated<number>;
  version: Generated<number>;
  updated_at: Generated<Date>;
}

export interface NakhFlowTable {
  id: string;
  sender_user_id: string;
  receiver_user_id: string;
  created_at: Generated<Date>;
}

export interface PendingNakhTable {
  id: string;
  nakh_flow_id: string;
  sender_user_id: string;
  text: string;
  status: Generated<
    'pending_payment' | 'paid_and_sent' | 'cancelled' | 'expired' | 'closed_by_system'
  >;
  pending_payment_id: string;
  auto_settle_authorized_at: Date;
  authorization_source: 'explore';
  authorized_at: Date;
  created_at: Generated<Date>;
  expires_at: Date;
  paid_at: Date | null;
  cancelled_at: Date | null;
  expired_at: Date | null;
  closed_at: Date | null;
  cancel_resolution: 'converted_to_like' | 'converted_to_not_interested' | null;
  reminder_count: Generated<number>;
  last_reminder_at: Date | null;
  idempotency_key: string;
  request_hash: string;
  version: Generated<number>;
}

export type DeliveredNakhStatus = 'sent' | 'seen' | 'accepted' | 'rejected' | 'expired' | 'closed';

export interface NakhTable {
  id: string;
  nakh_flow_id: string;
  sender_user_id: string;
  receiver_user_id: string;
  text: string;
  funding_type: 'credits' | 'telegram_stars';
  credit_transaction_id: string | null;
  payment_record_id: string | null;
  status: Generated<DeliveredNakhStatus>;
  sent_at: Generated<Date>;
  expires_at: Date;
  seen_at: Date | null;
  accepted_at: Date | null;
  rejected_at: Date | null;
  expired_at: Date | null;
  closed_at: Date | null;
  version: Generated<number>;
}

export interface NakhStatusHistoryTable {
  id: string;
  nakh_id: string;
  nakh_version: number;
  from_status: DeliveredNakhStatus | null;
  to_status: DeliveredNakhStatus;
  reason_code: string;
  changed_by_user_id: string | null;
  request_id: string;
  changed_at: Generated<Date>;
}

export interface NakhReceiverActionTable {
  id: string;
  nakh_id: string;
  receiver_user_id: string;
  action_type: 'view_profile' | 'accept' | 'reject' | 'report';
  idempotency_key: string;
  request_id: string;
  created_at: Generated<Date>;
}

export interface CreditPackageTable {
  id: string;
  code: 'starter' | 'plus' | 'best_value' | 'ultimate';
  title_key: string;
  credit_amount: string;
  stars_price: string;
  badge_key: string | null;
  is_active: Generated<boolean>;
  display_order: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CreditTransactionTable {
  id: string;
  credit_account_id: string;
  user_id: string;
  account_version: number;
  transaction_type:
    | 'purchase'
    | 'spend_nakh'
    | 'spend_chat_unlock'
    | 'spend_liked_by_unlock'
    | 'refund'
    | 'admin_adjustment';
  amount: string;
  balance_before: string;
  balance_after: string;
  payment_record_id: string | null;
  pending_payment_id: string | null;
  feature_unlock_id: string | null;
  nakh_id: string | null;
  idempotency_key: string;
  correlation_id: string;
  created_at: Generated<Date>;
}

export interface PendingPaymentTable {
  id: string;
  user_id: string;
  reason: 'send_nakh' | 'unlock_chat' | 'unlock_liked_by_profile' | 'buy_credit_package';
  target_type: 'credit_package' | 'like' | 'match' | 'pending_nakh';
  target_id: string;
  funding_type: 'credits' | 'telegram_stars';
  required_credits: string | null;
  required_stars: string | null;
  package_code_snapshot: string | null;
  package_credit_amount_snapshot: string | null;
  status: Generated<'pending' | 'paid' | 'failed' | 'cancelled' | 'expired'>;
  idempotency_key: string;
  request_hash: string;
  created_at: Generated<Date>;
  expires_at: Date;
  resolved_at: Date | null;
  version: Generated<number>;
}

export interface PaymentRecordTable {
  id: string;
  user_id: string;
  pending_payment_id: string;
  payment_type: 'buy_credit_package' | 'direct_paid_action' | 'pay_pending_action';
  paid_action_reason: 'send_nakh' | 'unlock_chat' | 'unlock_liked_by_profile' | null;
  credit_package_id: string | null;
  package_code_snapshot: string | null;
  package_credit_amount_snapshot: string | null;
  status: Generated<'pending' | 'paid' | 'failed' | 'cancelled' | 'expired' | 'refunded'>;
  stars_amount: string;
  provider: 'telegram_stars';
  provider_environment: 'local' | 'test' | 'staging' | 'production';
  provider_bot_id_digest: string;
  invoice_payload_digest: string;
  invoice_payload_ciphertext: ColumnType<Uint8Array, Uint8Array, never>;
  invoice_payload_key_id: string;
  provider_payment_id: string | null;
  idempotency_key: string;
  request_hash: string;
  created_at: Generated<Date>;
  paid_at: Date | null;
  failed_at: Date | null;
  cancelled_at: Date | null;
  expired_at: Date | null;
  refunded_at: Date | null;
  version: Generated<number>;
}

export interface PaymentProviderEventTable {
  id: string;
  provider: 'telegram_stars';
  provider_event_id: string;
  event_type: 'pre_checkout' | 'successful_payment';
  payment_record_id: string | null;
  payer_user_id: string | null;
  fact_hash: string;
  raw_payload_digest: string;
  raw_payload_ciphertext: ColumnType<Uint8Array, Uint8Array, never>;
  raw_payload_key_id: string;
  raw_payload_schema_version: number;
  decision: 'allow' | 'deny' | 'receipt_recorded' | 'quarantined';
  reason_code: string | null;
  received_at: Generated<Date>;
}

export interface PaymentProviderConflictTable {
  id: string;
  provider: 'telegram_stars';
  provider_event_id: string;
  payment_record_id: string | null;
  existing_fact_hash: string | null;
  incoming_fact_hash: string;
  reason_code: 'event_fact_conflict' | 'payment_fact_mismatch' | 'charge_conflict';
  raw_payload_digest: string;
  raw_payload_ciphertext: ColumnType<Uint8Array, Uint8Array, never>;
  raw_payload_key_id: string;
  raw_payload_schema_version: number;
  detected_at: Generated<Date>;
}

export interface TelegramStarsReceiptTable {
  payment_record_id: string;
  provider_event_id: string;
  telegram_charge_id: string;
  provider_charge_id: string | null;
  payer_user_id: string;
  stars_amount: string;
  received_at: Generated<Date>;
}

export interface PaymentFulfillmentTable {
  payment_record_id: string;
  state: Generated<
    'receipt_recorded' | 'fulfillment_pending' | 'fulfilled' | 'correction_required' | 'corrected'
  >;
  attempt_count: Generated<number>;
  fence_token: Generated<string>;
  available_at: Generated<Date>;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  fulfilled_at: Date | null;
  correction_required_at: Date | null;
  corrected_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface FeatureUnlockTable {
  id: string;
  payer_user_id: string;
  feature_type: 'liked_by_profile_unlock' | 'chat_unlock';
  like_id: string | null;
  match_id: string | null;
  payment_record_id: string | null;
  credit_transaction_id: string | null;
  status: Generated<'active' | 'revoked' | 'expired'>;
  unlocked_at: Generated<Date>;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  revoked_by_admin_id: string | null;
  expired_at: Date | null;
  version: Generated<number>;
}

export interface NotificationPreferenceTable {
  user_id: string;
  chat_enabled: Generated<boolean>;
  like_enabled: Generated<boolean>;
  nakh_enabled: Generated<boolean>;
  match_enabled: Generated<boolean>;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
}

export interface NotificationTable {
  id: string;
  user_id: string;
  notification_type:
    | 'like_received'
    | 'nakh_received'
    | 'match_created'
    | 'new_chat_message'
    | 'chat_unlocked'
    | 'liked_by_profile_unlocked'
    | 'report_result'
    | 'restriction_warning'
    | 'ban_warning'
    | 'payment_success'
    | 'payment_failure'
    | 'pending_nakh_payment_reminder'
    | 'admin_notice'
    | 'safety_notice'
    | 'chat_closed';
  category:
    'chat' | 'like' | 'nakh' | 'match' | 'safety' | 'payment' | 'admin' | 'ban' | 'restriction';
  title_key: string;
  body_key: string;
  payload: ColumnType<JsonObject, object, object>;
  payload_schema_version: Generated<number>;
  status: Generated<'unread' | 'read'>;
  deduplication_key: string | null;
  created_at: Generated<Date>;
  read_at: Date | null;
  version: Generated<number>;
}

export interface NotificationDeliveryTable {
  id: string;
  notification_id: string;
  channel: 'telegram' | 'in_app';
  status: Generated<'pending' | 'sent' | 'failed_retryable' | 'failed_terminal'>;
  attempt_number: Generated<number>;
  next_attempt_at: Generated<Date | null>;
  sent_at: Date | null;
  failed_at: Date | null;
  failure_code: string | null;
  provider_delivery_key: string | null;
  provider_progress: Generated<'not_started' | 'call_started' | 'settled' | 'ambiguous'>;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  fence_token: Generated<string>;
  quarantined_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface RefundRecordTable {
  id: string;
  user_id: string;
  funding_type: 'credits' | 'telegram_stars';
  payment_record_id: string | null;
  original_credit_transaction_id: string | null;
  refund_credit_transaction_id: string | null;
  telegram_charge_id: string | null;
  reason_code: 'target_unavailable' | 'system_failure' | 'duplicate_capture';
  stars_amount: string | null;
  credits_amount: string | null;
  status: Generated<'pending' | 'processed' | 'failed_retryable' | 'failed_terminal'>;
  provider_progress: Generated<'not_started' | 'call_started' | 'refund_confirmed'>;
  attempt_count: Generated<number>;
  fence_token: Generated<string>;
  available_at: Generated<Date>;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  idempotency_key: string;
  created_at: Generated<Date>;
  processed_at: Date | null;
  failed_at: Date | null;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface ReconciliationRunTable {
  id: string;
  run_type: Generated<'billing' | 'nakh'>;
  status: 'started' | 'succeeded' | 'failed';
  cursor: ColumnType<JsonObject, object, object>;
  scanned_count: Generated<string>;
  anomaly_count: Generated<string>;
  failure_code: string | null;
  started_at: Generated<Date>;
  finished_at: Date | null;
}

export interface ReconciliationAnomalyTable {
  id: string;
  run_id: string;
  anomaly_type: string;
  entity_type:
    | 'payment_record'
    | 'payment_fulfillment'
    | 'credit_account'
    | 'credit_transaction'
    | 'feature_unlock'
    | 'refund_record'
    | 'provider_event'
    | 'nakh_flow'
    | 'pending_nakh'
    | 'nakh'
    | 'user_counter';
  entity_id: string;
  disposition: 'repair_scheduled' | 'quarantined';
  safe_detail: ColumnType<JsonObject, object, object>;
  idempotency_key: string;
  detected_at: Generated<Date>;
}

export interface AuditLogTable {
  id: string;
  category: 'product' | 'account' | 'security' | 'admin';
  event_type: string;
  actor_type: 'user' | 'admin' | 'system';
  actor_user_id: string | null;
  actor_admin_id: string | null;
  subject_type: string;
  subject_id: string;
  result_code: string;
  metadata_schema_version: number;
  metadata: ColumnType<JsonObject, object, object>;
  request_id: string;
  command_id: string;
  occurred_at: Date;
}

export interface ExploreFilterTable {
  user_id: string;
  min_age: number;
  max_age: number;
  city_id: string;
  relationship_goal_id: string | null;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
}

export interface ExploreFilterGenderTable {
  user_id: string;
  gender_option_id: string;
}

export interface ExploreConsumptionTable {
  viewer_user_id: string;
  target_user_id: string;
  reason: 'preview' | 'like' | 'not_interested' | 'nakh_flow' | 'match';
  consumed_at: Date;
}

export interface CandidateDeliveryTable {
  id: string;
  viewer_user_id: string;
  target_user_id: string;
  mode: 'explore' | 'guest_preview';
  filter_version: number;
  state: 'reserved' | 'delivered' | 'failed';
  attempt_count: Generated<number>;
  expires_at: Date;
  provider_message_id: string | null;
  reserved_at: Date;
  delivered_at: Date | null;
  failed_at: Date | null;
  updated_at: Date;
}

export interface LikeTable {
  id: string;
  sender_user_id: string;
  receiver_user_id: string;
  status:
    | 'active'
    | 'closed_by_match'
    | 'closed_by_not_interested'
    | 'closed_by_unmatch'
    | 'cancelled_by_system';
  created_at: Date;
  closed_at: Date | null;
  version: Generated<number>;
}

export interface NotInterestedTable {
  id: string;
  sender_user_id: string;
  receiver_user_id: string;
  source: 'explore' | 'liked_by' | 'cancelled_pending_nakh';
  created_at: Date;
}

export interface UserPairStateTable {
  user_low_id: string;
  user_high_id: string;
  state: 'matched' | 'unmatched' | 'blocked';
  reason_code: string;
  changed_at: Date;
  version: Generated<number>;
}

export interface MatchTable {
  id: string;
  user_low_id: string;
  user_high_id: string;
  source: 'mutual_like' | 'nakh_accept';
  source_like_a_id: string | null;
  source_like_b_id: string | null;
  source_nakh_id: string | null;
  status: 'active' | 'unmatched' | 'closed';
  created_at: Date;
  closed_at: Date | null;
  version: Generated<number>;
}

export interface MatchParticipantTable {
  match_id: string;
  user_id: string;
  joined_at: Date;
}

export interface UnmatchRecordTable {
  match_id: string;
  actor_user_id: string;
  reason_code: string | null;
  command_id: string;
  idempotency_key: string;
  unmatched_at: Date;
  report_window_expires_at: Date;
}

export interface ChatSessionTable {
  id: string;
  match_id: string;
  status: 'active' | 'closed';
  next_sequence_number: Generated<string>;
  created_at: Date;
  closed_at: Date | null;
  closed_reason:
    'unmatch' | 'account_deleted' | 'user_banned' | 'admin_action' | 'internal_block' | null;
  version: Generated<number>;
}

export interface ChatParticipantTable {
  chat_session_id: string;
  user_id: string;
  last_read_at: Date | null;
  last_read_sequence_number: string | null;
  muted_at: Date | null;
  unlock_safety_warning_shown_at: Date | null;
  version: Generated<number>;
}

export interface PredefinedQuestionSetTable {
  id: string;
  code: string;
  title_key: string;
  is_active: Generated<boolean>;
  display_order: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface PredefinedQuestionTable {
  id: string;
  question_set_id: string;
  code: string;
  text_key: string;
  is_active: Generated<boolean>;
  display_order: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface PredefinedAnswerTable {
  id: string;
  question_id: string;
  code: string;
  text_key: string;
  is_active: Generated<boolean>;
  display_order: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface ChatMessageTable {
  id: string;
  chat_session_id: string;
  sender_user_id: string | null;
  message_type: 'predefined_question' | 'predefined_answer' | 'text' | 'system';
  text: string | null;
  predefined_question_id: string | null;
  predefined_answer_id: string | null;
  system_arguments: ColumnType<JsonObject | null, object | null, never>;
  sequence_number: string;
  created_at: Generated<Date>;
}

export interface ChatMessageSnapshotRequestTable {
  report_id: string;
  chat_session_id: string;
  original_message_id: string;
  requested_at: Generated<Date>;
  captured_at: Date | null;
  version: Generated<number>;
}

export interface ChatMessageSnapshotTable {
  id: string;
  report_id: string;
  chat_session_id: string;
  original_message_id: string;
  sender_user_id: string | null;
  message_type: ChatMessageTable['message_type'];
  content: ColumnType<JsonObject, object, never>;
  original_created_at: Date;
  snapshotted_at: Generated<Date>;
  integrity_sha256: string;
}

export interface ChatCleanupCheckpointTable {
  chat_session_id: string;
  last_retained_sequence_number: string | null;
  deleted_message_count: Generated<string>;
  last_cleaned_at: Date;
  version: Generated<number>;
}

export interface DatabaseSchema {
  'channel_telegram.liked_by_delivery_requests': TelegramLikedByDeliveryRequestTable;
  'channel_telegram.liked_by_delivery_receipts': TelegramLikedByDeliveryReceiptTable;
  'media.media_assets': MediaAssetTable;
  'media.photo_variants': PhotoVariantTable;
  'media.profile_photos': ProfilePhotoTable;
  'media.photo_moderation_records': PhotoModerationTable;
  'platform.idempotency_records': IdempotencyTable;
  'platform.sample_effects': SampleEffectTable;
  'platform.outbox_events': OutboxEventTable;
  'platform.inbox_messages': InboxMessageTable;
  'platform.sample_projections': SampleProjectionTable;
  'platform.scheduled_jobs': ScheduledJobTable;
  'platform.job_run_logs': JobRunLogTable;
  'catalog.locales': LocaleTable;
  'catalog.ui_texts': UiTextTable;
  'catalog.gender_options': CatalogOptionTable;
  'catalog.gender_preferences': CatalogOptionTable;
  'catalog.gender_preference_members': GenderPreferenceMemberTable;
  'catalog.relationship_goals': CatalogOptionTable;
  'catalog.interests': CatalogOptionTable;
  'catalog.languages': CatalogOptionTable;
  'catalog.personality_tags': CatalogOptionTable;
  'catalog.profile_option_values': ProfileOptionValueTable;
  'catalog.countries': CatalogOptionTable;
  'catalog.provinces': ProvinceTable;
  'catalog.cities': CityTable;
  'identity.users': UserTable;
  'identity.telegram_identities': TelegramIdentityTable;
  'identity.accounts': AccountTable;
  'identity.account_state_history': AccountStateHistoryTable;
  'identity.guest_preview_counters': GuestPreviewCounterTable;
  'identity.user_settings': UserSettingsTable;
  'identity.signup_progress': SignupProgressTable;
  'identity.signup_drafts': SignupDraftTable;
  'billing.credit_accounts': CreditAccountTable;
  'platform.user_counters': UserCounterTable;
  'nakh.nakh_flows': NakhFlowTable;
  'nakh.pending_nakhes': PendingNakhTable;
  'nakh.nakhes': NakhTable;
  'nakh.nakh_status_history': NakhStatusHistoryTable;
  'nakh.nakh_receiver_actions': NakhReceiverActionTable;
  'billing.credit_packages': CreditPackageTable;
  'billing.credit_transactions': CreditTransactionTable;
  'billing.pending_payments': PendingPaymentTable;
  'billing.payment_records': PaymentRecordTable;
  'billing.payment_provider_events': PaymentProviderEventTable;
  'billing.payment_provider_conflicts': PaymentProviderConflictTable;
  'billing.telegram_stars_receipts': TelegramStarsReceiptTable;
  'billing.payment_fulfillments': PaymentFulfillmentTable;
  'billing.refund_records': RefundRecordTable;
  'billing.reconciliation_runs': ReconciliationRunTable;
  'billing.reconciliation_anomalies': ReconciliationAnomalyTable;
  'notification.notification_preferences': NotificationPreferenceTable;
  'notification.notifications': NotificationTable;
  'notification.notification_deliveries': NotificationDeliveryTable;
  'platform.audit_logs': AuditLogTable;
  'profile.profiles': ProfileTable;
  'profile.profile_optional_details': ProfileOptionalDetailsTable;
  'profile.profile_interests': ProfileSelectionTable;
  'profile.profile_languages': ProfileLanguageTable;
  'profile.profile_personality_tags': ProfilePersonalityTagTable;
  'profile.profile_change_requests': ProfileChangeRequestTable;
  'profile.profile_change_reviews': ProfileChangeReviewTable;
  'administration.admin_users': AdminUserTable;
  'discovery.explore_filters': ExploreFilterTable;
  'discovery.explore_filter_genders': ExploreFilterGenderTable;
  'discovery.explore_consumptions': ExploreConsumptionTable;
  'discovery.candidate_deliveries': CandidateDeliveryTable;
  'interaction.likes': LikeTable;
  'interaction.not_interested': NotInterestedTable;
  'interaction.feature_unlocks': FeatureUnlockTable;
  'interaction.user_pair_states': UserPairStateTable;
  'matching.matches': MatchTable;
  'matching.match_participants': MatchParticipantTable;
  'matching.unmatch_records': UnmatchRecordTable;
  'chat.chat_sessions': ChatSessionTable;
  'chat.chat_participants': ChatParticipantTable;
  'chat.predefined_question_sets': PredefinedQuestionSetTable;
  'chat.predefined_questions': PredefinedQuestionTable;
  'chat.predefined_answers': PredefinedAnswerTable;
  'chat.chat_messages': ChatMessageTable;
  'chat.chat_message_snapshot_requests': ChatMessageSnapshotRequestTable;
  'chat.chat_message_snapshots': ChatMessageSnapshotTable;
  'chat.chat_cleanup_checkpoints': ChatCleanupCheckpointTable;
}

export type NakhDatabase = Kysely<DatabaseSchema>;

export type DatabaseConfig = Readonly<{
  url: string;
  poolMax: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}>;

export function createDatabase(config: DatabaseConfig): NakhDatabase {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    statement_timeout: config.statementTimeoutMs,
    options: `-c lock_timeout=${config.lockTimeoutMs}ms -c timezone=UTC`,
    application_name: 'nakh',
  });
  return new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
}

export class PostgresUnitOfWork {
  public constructor(private readonly database: NakhDatabase) {}

  public async execute<T>(operation: (transaction: NakhDatabase) => Promise<T>): Promise<T> {
    return this.database.transaction().execute(operation);
  }
}
