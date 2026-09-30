import { createHash } from 'node:crypto';
import {
  ApplicationError,
  requiredPermissionForModerationAction,
  type IdGenerator,
  type PhotoStatus,
} from '@nakh/domain';

import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const PHOTO_ADMIN_ACTIONS = ['hide_photo', 'restore_photo', 'delete_photo'] as const;
export type PhotoAdminAction = (typeof PHOTO_ADMIN_ACTIONS)[number];

export type PhotoModerationResult = Readonly<{
  actionId: string;
  photoId: string;
  profileId: string;
  targetUserId: string;
  previousStatus: PhotoStatus;
  nextStatus: PhotoStatus;
  wasPrimary: boolean;
  primaryPhotoId: string | null;
  photoVersion: number;
  profileVersion: number;
  profileCompletion: 'incomplete' | 'complete' | 'invalid';
}>;

export type PhotoModerationWrite = Readonly<{
  sourceReportId?: string;
  action: PhotoAdminAction;
  adminUserId: string;
  photoId: string;
  expectedPhotoVersion: number;
  requestId: string;
  commandId: string;
  requestDigest: string;
  reasonCode: string;
  moderationId: string;
  auditId: string;
  eventId: string;
  profileEventId: string;
  actionId: string;
  actionEventId: string;
}>;

export interface PhotoModerationWorkflowStore<TContext> {
  apply(context: TContext, write: PhotoModerationWrite): Promise<PhotoModerationResult>;
}

export interface PhotoDeliveryRevocation {
  execute(photoId: string): Promise<void>;
}

function invalidRequest(): ApplicationError {
  return new ApplicationError('invalid_request', 'error.moderation.photo_action_invalid', 400);
}

function reasonCode(action: PhotoAdminAction): string {
  return `admin_${action}`;
}

function isPhotoAction(action: string): action is PhotoAdminAction {
  return (PHOTO_ADMIN_ACTIONS as readonly string[]).includes(action);
}

/**
 * Purges externally cached delivery before a hide/delete can commit, then delegates the state
 * change to the owning M2 lifecycle inside the audited admin-command transaction.
 */
export class PhotoModerationWorkflow<TContext> {
  public constructor(
    private readonly commands: AdminCommandExecutionStore<TContext>,
    private readonly photos: PhotoModerationWorkflowStore<TContext>,
    private readonly delivery: PhotoDeliveryRevocation,
    private readonly ids: IdGenerator,
  ) {}

  public async apply(
    attempt: AdminCommandAttempt,
    action: PhotoAdminAction,
  ): Promise<AdminCommandExecutionResult<PhotoModerationResult>> {
    const expectedVersion = attempt.expectedTargetVersion;
    if (
      attempt.commandCode !== 'moderation.apply-photo-action' ||
      attempt.targetType !== 'photo' ||
      !UUID.test(attempt.targetId) ||
      expectedVersion === null ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 ||
      !isPhotoAction(action) ||
      attempt.requiredPermission !== requiredPermissionForModerationAction(action)
    )
      throw invalidRequest();

    // Purging is idempotent. A later permission/version rejection remains fail-closed for delivery.
    let purgeFailed = false;
    if (attempt.preconditionRejection === undefined && action !== 'restore_photo') {
      try {
        await this.delivery.execute(attempt.targetId);
      } catch {
        purgeFailed = true;
      }
    }
    const boundAttempt =
      attempt.sourceReportId === undefined
        ? attempt
        : {
            ...attempt,
            requestDigest: createHash('sha256')
              .update(JSON.stringify([attempt.requestDigest, attempt.sourceReportId]))
              .digest('hex'),
          };
    const write: PhotoModerationWrite = {
      ...(attempt.sourceReportId === undefined ? {} : { sourceReportId: attempt.sourceReportId }),
      action,
      adminUserId: attempt.adminUserId,
      photoId: attempt.targetId,
      expectedPhotoVersion: expectedVersion,
      requestId: attempt.requestId,
      commandId: attempt.commandId,
      requestDigest: boundAttempt.requestDigest,
      reasonCode: reasonCode(action),
      moderationId: this.ids.uuid(),
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      profileEventId: this.ids.uuid(),
      actionId: this.ids.uuid(),
      actionEventId: this.ids.uuid(),
    };
    return this.commands.execute(boundAttempt, async (context) => {
      if (purgeFailed) throw new Error('Photo delivery revocation unavailable.');
      return { value: await this.photos.apply(context, write), safeCode: `photo_${action}` };
    });
  }
}
