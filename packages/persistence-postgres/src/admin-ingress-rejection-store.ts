import { createHash } from 'node:crypto';
import {
  RecordAdminIngressRejectionHandler,
  type AdminIngressRejection,
  type AdminIngressRejectionStore,
  type AdminCommandExecutionResult,
} from '@nakh/application';
import { ApplicationError, type IdGenerator } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
import { SystemIdGenerator } from './foundation-store.js';

/** Logs the authenticated admin's request context when no trusted business target is recoverable. */
export class PostgresAdminIngressRejectionStore implements AdminIngressRejectionStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly ids: IdGenerator = new SystemIdGenerator(),
  ) {}
  public async record(input: AdminIngressRejection): Promise<AdminCommandExecutionResult<never>> {
    if (input.actor.kind !== 'admin')
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    const admin = await this.database
      .selectFrom('administration.admin_users')
      .select('id')
      .where('user_id', '=', input.actor.userId)
      .executeTakeFirst();
    if (admin === undefined)
      throw new ApplicationError('forbidden', 'error.admin.unauthorized', 403);
    return new PostgresAdminCommandStore(this.database).execute<never>(
      {
        logId: this.ids.uuid(),
        adminUserId: admin.id,
        commandId: input.commandId,
        requestId: input.requestId,
        requestDigest: input.requestDigest,
        commandCode: input.commandCode,
        requiredPermission: input.requiredPermission,
        targetType: 'admin_request',
        targetId: admin.id,
        expectedTargetVersion: null,
        reasonDigest: createHash('sha256').update('admin-ingress-rejection').digest('hex'),
        metadata: {},
        correlationId: input.requestId,
        preconditionRejection: 'invalid_request',
      },
      () => {
        throw new Error('An ingress rejection cannot execute an effect.');
      },
    );
  }
}
export class PostgresRecordAdminIngressRejectionHandler extends RecordAdminIngressRejectionHandler {
  public constructor(database: NakhDatabase, ids?: IdGenerator) {
    super(new PostgresAdminIngressRejectionStore(database, ids));
  }
}
