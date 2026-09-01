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
