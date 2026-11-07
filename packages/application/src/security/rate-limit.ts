export const RATE_LIMIT_SCOPES = [
  'telegram_start',
  'telegram_admin_signin',
  'telegram_admin_profile_review',
  'telegram_photo_ingestion',
  'telegram_photo_management',
  'telegram_liked_by',
  'telegram_nakhes',
  'telegram_support_appeal',
  'telegram_payment_support_contact',
  'telegram_account_menu',
  'telegram_account_control',
  'telegram_account_return',
  'telegram_fresh_entry',
  'telegram_report',
  'telegram_report_entry',
  'chat_write',
  'chat_session_write',
  'signup_write',
  'profile_write',
  'protected_change_request',
] as const;
export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

export type RateLimitRequest = Readonly<{
  scope: RateLimitScope;
  subject: string;
  limit: number;
  windowSeconds: number;
}>;

export type RateLimitDecision = Readonly<{
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}>;

export interface RateLimiterPort {
  consume(request: RateLimitRequest): Promise<RateLimitDecision>;
}
