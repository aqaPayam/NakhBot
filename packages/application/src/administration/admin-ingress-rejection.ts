import { ApplicationError, M7_PERMISSIONS, type Actor, type M7Permission } from '@nakh/domain';
import type { AdminCommandExecutionResult } from './admin-command.js';

export interface AdminIngressRejection {
  readonly actor: Actor;
  readonly commandId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  /** Fixed by the trusted route, never read from client permission or command claims. */
  readonly commandCode: string;
  readonly requiredPermission: M7Permission;
  readonly outcome?: 'rejected' | 'failed';
}
export interface AdminIngressRejectionStore {
  record(input: AdminIngressRejection): Promise<AdminCommandExecutionResult<never>>;
  recover?(input: AdminIngressRejection): Promise<AdminCommandExecutionResult<never> | undefined>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** Failure-only capability. It cannot execute or authorize any business mutation. */
export class RecordAdminIngressRejectionHandler {
  public constructor(private readonly store: AdminIngressRejectionStore) {}
  public record(input: AdminIngressRejection): Promise<AdminCommandExecutionResult<never>> {
    this.validate(input);
    return this.store.record(input);
  }
  public recover(
    input: AdminIngressRejection,
  ): Promise<AdminCommandExecutionResult<never> | undefined> {
    this.validate(input);
    return this.store.recover?.(input) ?? Promise.resolve(undefined);
  }
  private validate(input: AdminIngressRejection): void {
    if (input.actor.kind !== 'admin' || !UUID.test(input.actor.userId))
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    if (
      ![input.commandId, input.requestId].every((id) => UUID.test(id)) ||
      !/^[a-f0-9]{64}$/u.test(input.requestDigest) ||
      !/^[a-z][a-z0-9_.-]{0,119}$/u.test(input.commandCode) ||
      !M7_PERMISSIONS.includes(input.requiredPermission) ||
      (input.outcome !== undefined && !['rejected', 'failed'].includes(input.outcome))
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
  }
}
