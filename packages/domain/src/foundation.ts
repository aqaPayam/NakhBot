export type ActorKind = 'user' | 'admin' | 'system';

export type Actor = Readonly<{
  kind: ActorKind;
  userId: string;
}>;

export type ApplicationErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'idempotency_conflict'
  | 'already_processed'
  | 'rate_limited'
  | 'version_conflict'
  | 'dependency_unavailable'
  | 'invalid_account_transition'
  | 'capability_denied'
  | 'stale_signup_version'
  | 'invalid_signup_step'
  | 'inactive_catalog_selection'
  | 'invalid_birth_year'
  | 'underage'
  | 'invalid_location'
  | 'profile_incomplete'
  | 'media_not_eligible'
  | 'photo_upload_limit_reached'
  | 'unsupported_media_type'
  | 'media_too_large'
  | 'media_dimensions_invalid'
  | 'media_invalid'
  | 'duplicate_media'
  | 'media_invalid_state'
  | 'photo_limit_reached'
  | 'photo_not_found'
  | 'photo_primary_required'
  | 'photo_primary_delete_denied'
  | 'media_delivery_denied'
  | 'media_grant_invalid'
  | 'media_storage_mismatch'
  | 'guest_preview_limit_reached'
  | 'pending_profile_change_exists'
  | 'profile_change_invalid'
  | 'reviewer_unauthorized'
  | 'internal_error';

export class ApplicationError extends Error {
  public readonly code: ApplicationErrorCode;
  public readonly status: number;
  public readonly details: Readonly<Record<string, string>> | undefined;

  public constructor(
    code: ApplicationErrorCode,
    message: string,
    status: number,
    details?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuid(): string;
}

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}
