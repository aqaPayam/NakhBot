import type { GetOwnAdminCommandReceiptQuery } from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { AdminQueueIdentityStore } from '../moderation/queue-actions.js';
import type { AdminCommandExecutionResult } from './admin-command.js';
export interface OwnAdminCommandReceiptStore {
  get(
    adminUserId: string,
    commandId: string,
  ): Promise<Omit<AdminCommandExecutionResult<never>, 'replayed' | 'value'> | undefined>;
}
/** Outcome recovery grants no action authority and never reads or reloads an effect value. */
export class GetOwnAdminCommandReceiptHandler {
  public constructor(
    private readonly identities: AdminQueueIdentityStore,
    private readonly receipts: OwnAdminCommandReceiptStore,
  ) {}
  public async execute(
    query: GetOwnAdminCommandReceiptQuery,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<never>> {
    if (
      actor.kind !== 'admin' ||
      query.actor.kind !== 'admin' ||
      query.actor.userId !== actor.userId
    )
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    const identity = await this.identities.get(actor.userId);
    if (identity === undefined)
      throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
    const receipt = await this.receipts.get(identity.adminUserId, query.commandId);
    if (receipt === undefined) throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
    return { ...receipt, replayed: true, value: undefined };
  }
}
