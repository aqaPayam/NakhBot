import { sql } from 'kysely';
import {
  isUserProductLife,
  type AccountControlActor,
  type AccountReturnActivationAuthority,
  type AccountReturnActivationProof,
  type UserProductLife,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { requireCurrentAccountControl } from './account-control-session-store.js';

function unavailable(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.unavailable', 409);
}
export class PostgresAccountReturnActivationAuthority implements AccountReturnActivationAuthority {
  public constructor(private readonly database: NakhDatabase) {}
  public async withCurrentReturn(
    life: UserProductLife,
    namespaceHash: string,
    effect: (proof: AccountReturnActivationProof) => Promise<void>,
  ): Promise<void> {
    if (!isUserProductLife(life) || life.productEpoch < 1 || !/^[0-9a-f]{64}$/u.test(namespaceHash))
      throw unavailable();
    const captured = Object.freeze({ userId: life.userId, productEpoch: life.productEpoch });
    const activate = async (tx: NakhDatabase): Promise<void> => {
      await sql`SELECT id FROM identity.users WHERE id=${captured.userId}::uuid FOR NO KEY UPDATE`.execute(
        tx,
      );
      const account = await tx
        .selectFrom('identity.accounts')
        .select(['state', 'product_epoch', 'version'])
        .where('user_id', '=', captured.userId)
        .forUpdate()
        .executeTakeFirst();
      if (
        account === undefined ||
        account.state === 'deleted' ||
        account.product_epoch !== captured.productEpoch
      )
        throw unavailable();
      const row = (
        await sql<{ id: string; previous_epoch: number; next_version: number }>`SELECT a.id,
        root.product_epoch AS previous_epoch,(a.metadata->>'toVersion')::integer AS next_version
        FROM platform.audit_logs a JOIN identity.account_deletion_records root ON root.id=a.subject_id
        JOIN identity.account_deletion_phase_receipts phase ON phase.deletion_record_id=root.id AND phase.completed_phase='verification'
        WHERE a.event_type='account.returned.v1' AND a.actor_user_id=${captured.userId}::uuid
          AND a.metadata->'toEpoch'=to_jsonb(${captured.productEpoch}::integer)
          AND identity.account_return_proof_valid(a,true)
          AND identity.ephemeral_reconciliation_valid(root.id,phase.verified_at)
          AND EXISTS(SELECT 1 FROM platform.audit_logs observed WHERE observed.event_type='account.deletion-ephemeral-reverified.v1'
            AND observed.subject_id=root.id AND observed.occurred_at=phase.verified_at AND observed.metadata->>'namespaceHash'=${namespaceHash})`.execute(
          tx,
        )
      ).rows;
      if (
        row.length !== 1 ||
        row[0]!.previous_epoch !== captured.productEpoch - 1 ||
        account.version < row[0]!.next_version
      )
        throw unavailable();
      await effect(
        Object.freeze({
          ...captured,
          previousProductEpoch: row[0]!.previous_epoch,
          returnAuditId: row[0]!.id,
        }),
      );
      // The owning locks fence lifecycle changes throughout the provider call.
      // Recheck actual state too, including unexpected mutations in this transaction.
      const current = await tx
        .selectFrom('identity.accounts')
        .select(['state', 'product_epoch'])
        .where('user_id', '=', captured.userId)
        .executeTakeFirst();
      if (
        current === undefined ||
        current.state === 'deleted' ||
        current.product_epoch !== captured.productEpoch
      )
        throw unavailable();
    };
    // Composition must use the same owning transaction. Opening another one
    // while a primary-entry guard holds User/Account locks would deadlock.
    if (this.database.isTransaction) await activate(this.database);
    else await this.database.transaction().execute(activate);
  }
}

/** Fresh primary confirmation uses a current-life limited control, independently
 * of the old grant that authorized Return. It activates only the verified opaque
 * namespace; neither Return nor this adapter issues/restores product credentials.
 * The caller must authenticate the primary event before constructing this port. */
export class PostgresFreshEntryActivationAuthority implements AccountReturnActivationAuthority {
  private readonly session: AccountControlActor;
  public constructor(
    private readonly database: NakhDatabase,
    session: AccountControlActor,
  ) {
    this.session = Object.freeze({ ...session });
  }
  public async withCurrentReturn(
    life: UserProductLife,
    namespaceHash: string,
    effect: (proof: AccountReturnActivationProof) => Promise<void>,
  ): Promise<void> {
    if (
      !isUserProductLife(life) ||
      life.productEpoch < 1 ||
      this.session.scope !== 'account_control' ||
      this.session.userId !== life.userId ||
      this.session.productEpoch !== life.productEpoch
    )
      throw unavailable();
    const captured = Object.freeze({ userId: life.userId, productEpoch: life.productEpoch });
    const activate = async (tx: NakhDatabase): Promise<void> => {
      await requireCurrentAccountControl(tx, captured.userId, this.session);
      await new PostgresAccountReturnActivationAuthority(tx).withCurrentReturn(
        captured,
        namespaceHash,
        effect,
      );
      // A provider wait may consume the grant lifetime or revoke it in this
      // transaction. Never acknowledge successful entry with retired authority.
      await requireCurrentAccountControl(tx, captured.userId, this.session);
    };
    if (this.database.isTransaction) await activate(this.database);
    else await this.database.transaction().execute(activate);
  }
}
