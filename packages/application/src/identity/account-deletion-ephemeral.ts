import { ApplicationError } from '@nakh/domain';
import type { AccountDeletionLease } from './account-deletion.js';

export const DELETION_EPHEMERAL_STAGES = [
  'owned_remove',
  'owned_verify',
  'legacy_remove',
  'legacy_verify',
  'queue_normalize',
  'queue_verify',
] as const;
export type DeletionEphemeralStage = (typeof DELETION_EPHEMERAL_STAGES)[number];
export type DeletionEphemeralCursor =
  string | Readonly<{ redisCursor: string; pendingKeys: readonly string[] }>;
export type DeletionEphemeralOperation = Readonly<{
  id: string;
  deletionRecordId: string;
  userId: string;
  productEpoch: number;
  namespaceHash: string;
  cutoverEvidenceHash: string;
  stage: DeletionEphemeralStage;
  cursor: DeletionEphemeralCursor;
}>;
export type DeletionEphemeralObservation = Readonly<{
  cursor: DeletionEphemeralCursor;
  more: boolean;
  found: number;
}>;
export interface AccountDeletionEphemeralStore {
  claimNext(
    lease: AccountDeletionLease,
  ): Promise<Readonly<{ operation?: DeletionEphemeralOperation; done: boolean }>>;
  assertCurrent(lease: AccountDeletionLease, operationId: string): Promise<void>;
  complete(
    lease: AccountDeletionLease,
    operationId: string,
    observation: DeletionEphemeralObservation,
  ): Promise<void>;
  finish(lease: AccountDeletionLease): Promise<Readonly<{ completed: boolean }>>;
}
export interface AccountDeletionEphemeralProvider {
  readonly namespaceHash: string;
  execute(
    operation: DeletionEphemeralOperation,
    assertCurrent: () => Promise<void>,
  ): Promise<DeletionEphemeralObservation>;
}
export interface AccountDeletionSessions {
  revokeNext(
    lease: AccountDeletionLease,
    limit?: number,
  ): Promise<Readonly<{ revoked: number; hasMore: boolean }>>;
  verify(lease: AccountDeletionLease): Promise<Readonly<{ verified: boolean }>>;
}
function conflict(): never {
  throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
/** One durable bounded step. Provider calls run outside native transactions.
 * A terminal cursor never substitutes for the independent verification pass or
 * the separate native checkpoint. Deployment drain evidence is an operator
 * assertion supplied by trusted composition, not inferred from a cache scan. */
export class ExecuteAccountDeletionEphemeral {
  public constructor(
    private readonly store: AccountDeletionEphemeralStore,
    private readonly sessions: AccountDeletionSessions,
    private readonly provider: AccountDeletionEphemeralProvider,
  ) {}
  public async executeNext(
    lease: AccountDeletionLease,
  ): Promise<Readonly<{ worked: boolean; completed: boolean }>> {
    const scope = Object.freeze({ ...lease, leaseExpiresAt: new Date(lease.leaseExpiresAt) });
    if (scope.phase !== 'ephemeral_access' || scope.checkpointVersion !== 5) conflict();
    const sessions = await this.sessions.revokeNext(scope);
    if (sessions.hasMore) return { worked: true, completed: false };
    if (!(await this.sessions.verify(scope)).verified) conflict();
    const claim = await this.store.claimNext(scope);
    if (claim.done) return { worked: false, completed: (await this.store.finish(scope)).completed };
    const issued = claim.operation;
    if (issued === undefined) return { worked: false, completed: false };
    const operation = Object.freeze({
      ...issued,
      cursor:
        typeof issued.cursor === 'string'
          ? issued.cursor
          : Object.freeze({
              ...issued.cursor,
              pendingKeys: Object.freeze([...issued.cursor.pendingKeys]),
            }),
    });
    if (
      operation.deletionRecordId !== scope.deletionRecordId ||
      operation.userId !== scope.userId ||
      operation.namespaceHash !== this.provider.namespaceHash ||
      !DELETION_EPHEMERAL_STAGES.includes(operation.stage)
    )
      conflict();
    await this.store.assertCurrent(scope, operation.id);
    const observation = await this.provider.execute(operation, () =>
      this.store.assertCurrent(scope, operation.id),
    );
    await this.store.assertCurrent(scope, operation.id);
    await this.store.complete(scope, operation.id, observation);
    return { worked: true, completed: false };
  }
}
