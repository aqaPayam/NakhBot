import type {
  ProfileChangeRequest,
  RequestProtectedProfileChangeCommand,
  RequestProtectedProfileChangeResult,
  ResolveProtectedProfileChangeCommand,
  ResolveProtectedProfileChangeResult,
} from '@nakh/contracts';
import {
  ApplicationError,
  type Actor,
  type Clock,
  type IdGenerator,
  normalizeProfileChangeReviewNote,
  normalizeProtectedProfileChange,
  type NormalizedProtectedProfileChange,
} from '@nakh/domain';

export type ProfileChangeReviewerAuthorization = Readonly<{
  adminUserId: string;
  reviewerUserId: string;
}>;

export interface ProfileChangeReviewerAuthorizationPort {
  authorize(reviewerUserId: string): Promise<ProfileChangeReviewerAuthorization | undefined>;
}

export type RequestProtectedProfileChangeWrite = Readonly<{
  command: RequestProtectedProfileChangeCommand;
  normalized: NormalizedProtectedProfileChange;
  profileChangeRequestId: string;
  auditId: string;
  eventId: string;
  processedAt: Date;
}>;

export type ResolveProtectedProfileChangeWrite = Readonly<{
  command: ResolveProtectedProfileChangeCommand;
  authorization: ProfileChangeReviewerAuthorization;
  normalizedNote: string | undefined;
  auditId: string;
  eventId: string;
  processedAt: Date;
}>;

export interface ProfileChangeStore {
  requestProtectedChange(
    write: RequestProtectedProfileChangeWrite,
  ): Promise<RequestProtectedProfileChangeResult>;
  resolveProtectedChange(
    write: ResolveProtectedProfileChangeWrite,
  ): Promise<ResolveProtectedProfileChangeResult>;
  getProtectedChangeRequest(
    userId: string,
    profileChangeRequestId: string,
  ): Promise<ProfileChangeRequest | undefined>;
}

function requireActor(actor: Actor, kind: 'user' | 'admin'): string {
  if (actor.kind !== kind)
    throw new ApplicationError(
      kind === 'user' ? 'unauthorized' : 'reviewer_unauthorized',
      kind === 'user'
        ? 'error.identity.user_context_invalid'
        : 'error.profile.change.reviewer_unauthorized',
      kind === 'user' ? 401 : 403,
    );
  return actor.userId;
}

export class RequestProtectedProfileChangeHandler {
  public constructor(
    private readonly store: ProfileChangeStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public execute(
    command: RequestProtectedProfileChangeCommand,
  ): Promise<RequestProtectedProfileChangeResult> {
    requireActor(command.actor, 'user');
    const processedAt = this.clock.now();
    const normalized = normalizeProtectedProfileChange(command.data, {
      now: () => processedAt,
    });
    return this.store.requestProtectedChange({
      command,
      normalized,
      profileChangeRequestId: this.ids.uuid(),
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      processedAt,
    });
  }
}

export class ResolveProtectedProfileChangeHandler {
  public constructor(
    private readonly store: ProfileChangeStore,
    private readonly authorization: ProfileChangeReviewerAuthorizationPort,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    command: ResolveProtectedProfileChangeCommand,
  ): Promise<ResolveProtectedProfileChangeResult> {
    const reviewerUserId = requireActor(command.actor, 'admin');
    const authorization = await this.authorization.authorize(reviewerUserId);
    if (authorization === undefined || authorization.reviewerUserId !== reviewerUserId)
      throw new ApplicationError(
        'reviewer_unauthorized',
        'error.profile.change.reviewer_unauthorized',
        403,
      );
    return this.store.resolveProtectedChange({
      command,
      authorization,
      normalizedNote: normalizeProfileChangeReviewNote(command.data.note),
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      processedAt: this.clock.now(),
    });
  }
}

export class GetProtectedProfileChangeRequestHandler {
  public constructor(private readonly store: ProfileChangeStore) {}

  public execute(
    actor: Actor,
    profileChangeRequestId: string,
  ): Promise<ProfileChangeRequest | undefined> {
    return this.store.getProtectedChangeRequest(
      requireActor(actor, 'user'),
      profileChangeRequestId,
    );
  }
}
