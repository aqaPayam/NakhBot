import type { Actor, Clock, IdGenerator, PhotoModerationAction, PhotoStatus } from '@nakh/domain';
import { ApplicationError } from '@nakh/domain';

export type ManagedPhoto = Readonly<{
  id: string;
  status: PhotoStatus;
  isPrimary: boolean;
  displayOrder: number;
  version: number;
}>;

export type OwnPhotoCollection = Readonly<{
  profileVersion: number;
  photos: readonly ManagedPhoto[];
}>;

export type OwnPhotoAction =
  | Readonly<{ type: 'reorder'; orderedPhotoIds: readonly string[] }>
  | Readonly<{ type: 'select_primary'; photoId: string }>
  | Readonly<{ type: 'delete'; photoId: string }>;

export interface PhotoManagementStore {
  listOwn(userId: string): Promise<OwnPhotoCollection>;
  mutateOwn(
    input: Readonly<{
      userId: string;
      expectedProfileVersion: number;
      action: OwnPhotoAction;
      commandId: string;
      requestId: string;
      idempotencyKey: string;
      auditId: string;
      eventId: string;
      profileEventId: string;
      occurredAt: Date;
    }>,
  ): Promise<OwnPhotoCollection>;
  moderate(
    input: Readonly<{
      adminUserId: string;
      photoId: string;
      action: PhotoModerationAction;
      reasonCode: string;
      moderationId: string;
      auditId: string;
      eventId: string;
      profileEventId: string;
      occurredAt: Date;
    }>,
  ): Promise<void>;
}

function userId(actor: Actor): string {
  if (actor.kind !== 'user')
    throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
  return actor.userId;
}

export class ListOwnPhotosHandler {
  public constructor(private readonly store: PhotoManagementStore) {}

  public execute(actor: Actor): Promise<OwnPhotoCollection> {
    return this.store.listOwn(userId(actor));
  }
}

export class MutateOwnPhotosHandler {
  public constructor(
    private readonly store: PhotoManagementStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public execute(
    input: Readonly<{
      actor: Actor;
      expectedProfileVersion: number;
      action: OwnPhotoAction;
      commandId: string;
      requestId: string;
      idempotencyKey: string;
    }>,
  ): Promise<OwnPhotoCollection> {
    return this.store.mutateOwn({
      userId: userId(input.actor),
      expectedProfileVersion: input.expectedProfileVersion,
      action: input.action,
      commandId: input.commandId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      profileEventId: this.ids.uuid(),
      occurredAt: this.clock.now(),
    });
  }
}

export class ModeratePhotoHandler {
  public constructor(
    private readonly store: PhotoManagementStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public execute(
    input: Readonly<{
      actor: Actor;
      photoId: string;
      action: PhotoModerationAction;
      reasonCode: string;
    }>,
  ): Promise<void> {
    if (input.actor.kind !== 'admin')
      throw new ApplicationError('reviewer_unauthorized', 'error.admin.reviewer_unauthorized', 403);
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(input.reasonCode))
      throw new ApplicationError('invalid_request', 'error.media.moderation_reason', 400);
    return this.store.moderate({
      adminUserId: input.actor.userId,
      photoId: input.photoId,
      action: input.action,
      reasonCode: input.reasonCode,
      moderationId: this.ids.uuid(),
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      profileEventId: this.ids.uuid(),
      occurredAt: this.clock.now(),
    });
  }
}
