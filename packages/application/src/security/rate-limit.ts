export const RATE_LIMIT_SCOPES = [
  'telegram_start',
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
