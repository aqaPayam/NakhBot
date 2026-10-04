import type { GetAppealMetadataQuery, AppealMetadataPage, AppealStatus } from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminActionAuthorizationService } from '../administration/admin-authorization.js';
import type {
  SafetyMetadataCursors,
  SafetyMetadataPosition,
  SafetyMetadataViewer,
} from './safety-metadata-cursor.js';
export interface AppealMetadataReadStore {
  page(
    viewer: SafetyMetadataViewer,
    status: AppealStatus,
    limit: number,
    after?: SafetyMetadataPosition,
  ): Promise<
    Readonly<{ items: AppealMetadataPage['items']; next: SafetyMetadataPosition | undefined }>
  >;
}
export class GetAppealMetadataHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize'>,
    private readonly store: AppealMetadataReadStore,
    private readonly cursors: Pick<SafetyMetadataCursors, 'issue' | 'resolve'>,
  ) {}
  public async execute(query: GetAppealMetadataQuery, actor: Actor): Promise<AppealMetadataPage> {
    if (
      actor.kind !== 'admin' ||
      query.actor.kind !== 'admin' ||
      actor.userId !== query.actor.userId
    )
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    const status = query.status ?? 'submitted';
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 50 ||
      !['submitted', 'in_review', 'accepted', 'rejected'].includes(status)
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const root = await this.authorization.authorize({
      actor,
      token: query.adminActionToken,
      commandCode: 'moderation.appeal-metadata',
      requiredPermission: 'review_appeals',
      targetType: 'appeal_queue',
    });
    if (root.targetId !== null || root.expectedTargetVersion !== null)
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const viewer = { adminUserId: root.adminUserId, actorUserId: root.actorUserId };
    const after =
      query.cursor === undefined
        ? undefined
        : await this.cursors.resolve(query.cursor, viewer, 'appeals', status);
    if (query.cursor !== undefined && after === undefined)
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const page = await this.store.page(viewer, status, query.limit, after);
    return {
      items: page.items,
      ...(page.next === undefined
        ? {}
        : { nextCursor: await this.cursors.issue(viewer, 'appeals', status, page.next) }),
    };
  }
}
