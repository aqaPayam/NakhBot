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
  public async recover(
    input: AdminIngressRejection,
  ): Promise<AdminCommandExecutionResult<never> | undefined> {
    if (input.actor.kind !== 'admin')
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    const row = await this.database
      .selectFrom('administration.admin_users as admin')
      .innerJoin('administration.admin_action_logs as log', 'log.admin_user_id', 'admin.id')
      .select([
        'log.id',
        'log.request_digest',
        'log.command_code',
        'log.result',
        'log.safe_code',
        'log.created_at',
      ])
      .where('admin.user_id', '=', input.actor.userId)
      .where('log.command_id', '=', input.commandId)
      .where('log.target_type', '=', 'admin_request')
      .executeTakeFirst();
    if (row === undefined) return undefined;
    if (
      row.result === 'succeeded' ||
      row.request_digest !== input.requestDigest ||
      row.command_code !== input.commandCode
    )
      throw new ApplicationError('idempotency_conflict', 'error.m7.stale_action', 409);
    return {
      logId: row.id,
      result: row.result,
      safeCode: row.safe_code,
      recordedAt: row.created_at,
      replayed: true,
      value: undefined,
    };
  }
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
    const recorded = await new PostgresAdminCommandStore(this.database).execute<never>(
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
        ...(input.outcome === 'failed'
          ? {}
          : { preconditionRejection: 'invalid_request' as const }),
      },
      () => {
        throw new Error('Admin ingress failed before any business effect.');
      },
    );
    if (recorded.result === 'succeeded')
      throw new ApplicationError('idempotency_conflict', 'error.m7.stale_action', 409);
    return recorded;
  }
}
export class PostgresRecordAdminIngressRejectionHandler extends RecordAdminIngressRejectionHandler {
  public constructor(database: NakhDatabase, ids?: IdGenerator) {
    super(new PostgresAdminIngressRejectionStore(database, ids));
  }
}
