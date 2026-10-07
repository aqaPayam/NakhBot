import { createHash, createHmac, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AccountDeletionStore, DeletionConfirmationKeys } from '@nakh/application';
import type {
  AccountDeletionStatus,
  CancelAccountDeletionCommand,
  CancelAccountDeletionResult,
  GetAccountDeletionStatusQuery,
  PrepareAccountDeletionQuery,
  PreparedAccountDeletion,
  RequestAccountDeletionCommand,
  RequestAccountDeletionResult,
} from '@nakh/contracts';
import { ApplicationError, assertAccountTransition, type AccountState } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

type DeletionCommand = RequestAccountDeletionCommand | CancelAccountDeletionCommand;
type Confirmation = {
  id: string;
  user_id: string;
  request_id: string;
  account_version: number;
  key_id: string;
  token_hash: string;
  expires_at: Date;
  status: 'pending' | 'consumed' | 'cancelled';
};
function invalid(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.confirmation_invalid', 409);
}
function unavailable(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.unavailable', 409);
}
function digest(command: DeletionCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        commandType: command.commandType,
        schemaVersion: command.schemaVersion,
        actor: command.actor,
        requestId: command.requestId,
        data: command.data,
        channelContext: command.channelContext,
      }),
    )
    .digest('hex');
}
/** Ingress remains disabled until shared closure, media fences and the complete saga are ready. */
export class PostgresAccountDeletionStore implements AccountDeletionStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly secrets: DeletionConfirmationKeys,
  ) {
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/u.test(secrets.activeKeyId) ||
      (secrets.keys.get(secrets.activeKeyId)?.byteLength ?? 0) < 32
    )
      throw new Error('Deletion confirmation key unavailable.');
    for (const key of secrets.keys.values())
      if (key.byteLength < 32) throw new Error('Deletion confirmation key invalid.');
  }
  private token(
    proof: Pick<Confirmation, 'id' | 'user_id' | 'request_id' | 'account_version' | 'key_id'>,
  ): string {
    const key = this.secrets.keys.get(proof.key_id);
    if (key === undefined) throw invalid();
    return createHmac('sha256', key)
      .update(
        JSON.stringify([
          'account.delete.confirm.v1',
          proof.key_id,
          proof.id,
          proof.user_id,
          proof.request_id,
          proof.account_version,
        ]),
      )
      .digest('base64url');
  }
  private async lock(
    database: NakhDatabase,
    userId: string,
    kind: string,
  ): Promise<{ state: AccountState; version: number }> {
    if (kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    // Stable User keys never change. NO KEY UPDATE serializes product writers while
    // allowing the FK KEY SHARE taken by Account-first moderation transactions.
    const user = await database
      .selectFrom('identity.users')
      .select('id')
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (user === undefined) throw unavailable();
    const account = await database
      .selectFrom('identity.accounts')
      .select(['state', 'version'])
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (account === undefined) throw unavailable();
    return account;
  }
  private async now(database: NakhDatabase): Promise<Date> {
    return (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(database)).rows[0]!.at;
  }
  public async prepare(query: PrepareAccountDeletionQuery): Promise<PreparedAccountDeletion> {
    return this.database.transaction().execute(async (tx) => {
      const account = await this.lock(tx, query.actor.userId, query.actor.kind);
      if (account.state === 'deleted') throw unavailable();
      if (account.version !== query.expectedAccountVersion) throw invalid();
      const at = await this.now(tx);
      let proof = (
        await sql<Confirmation>`SELECT * FROM identity.deletion_confirmations
        WHERE user_id=${query.actor.userId}::uuid AND request_id=${query.requestId}::uuid`.execute(
          tx,
        )
      ).rows[0];
      if (proof === undefined) {
        // Refresh invalidates even expired pending authority; one pending confirmation per User.
        await sql`UPDATE identity.deletion_confirmations SET status='cancelled',resolved_at=${at}
          WHERE user_id=${query.actor.userId}::uuid AND status='pending'`.execute(tx);
        const id = randomUUID(),
          keyId = this.secrets.activeKeyId;
        const token = this.token({
          id,
          user_id: query.actor.userId,
          request_id: query.requestId,
          account_version: account.version,
          key_id: keyId,
        });
        proof = (
          await sql<Confirmation>`INSERT INTO identity.deletion_confirmations
          (id,user_id,request_id,account_version,key_id,token_hash,created_at,expires_at)
          VALUES (${id}::uuid,${query.actor.userId}::uuid,${query.requestId}::uuid,${account.version},${keyId},
            ${createHash('sha256').update(token).digest('hex')},${at},${at}::timestamptz+interval '5 minutes') RETURNING *`.execute(
            tx,
          )
        ).rows[0]!;
      }
      if (
        proof.status !== 'pending' ||
        proof.account_version !== account.version ||
        proof.expires_at <= at
      )
        throw invalid();
      return {
        confirmationToken: this.token(proof),
        expiresAt: proof.expires_at.toISOString(),
        expectedAccountVersion: account.version,
      };
    });
  }
  private async receipt(
    database: NakhDatabase,
    command: DeletionCommand,
  ): Promise<{ deletion_record_id: string | null; account_version: number } | undefined> {
    const rows = (
      await sql<{
        user_id: string;
        idempotency_key: string;
        command_id: string;
        request_digest: string;
        deletion_record_id: string | null;
        account_version: number;
      }>`SELECT user_id,idempotency_key,command_id,
        request_digest,deletion_record_id,account_version FROM identity.account_deletion_commands
      WHERE (user_id=${command.actor.userId}::uuid AND idempotency_key=${command.idempotencyKey})
         OR command_id=${command.commandId}::uuid`.execute(database)
    ).rows;
    if (rows.length === 0) return undefined;
    const receipt = rows[0]!;
    if (
      rows.length !== 1 ||
      receipt.user_id !== command.actor.userId ||
      receipt.idempotency_key !== command.idempotencyKey ||
      receipt.request_digest !== digest(command)
    )
      throw new ApplicationError('idempotency_conflict', 'error.command.idempotency_conflict', 409);
    return receipt;
  }
  private async proof(
    database: NakhDatabase,
    command: DeletionCommand,
    at: Date,
    version: number,
  ): Promise<Confirmation> {
    if (command.data.expectedAccountVersion !== version) throw invalid();
    const proof = (
      await sql<Confirmation>`SELECT * FROM identity.deletion_confirmations
      WHERE user_id=${command.actor.userId}::uuid AND token_hash=${createHash('sha256')
        .update(command.data.confirmationToken)
        .digest('hex')} FOR UPDATE`.execute(database)
    ).rows[0];
    if (
      proof === undefined ||
      proof.status !== 'pending' ||
      proof.account_version !== version ||
      proof.expires_at <= at
    )
      throw invalid();
    return proof;
  }
  private async recordReceipt(
    database: NakhDatabase,
    command: DeletionCommand,
    proof: Confirmation,
    accountVersion: number,
    recordId: string | null,
    at: Date,
  ): Promise<void> {
    await sql`INSERT INTO identity.account_deletion_commands
      (user_id,idempotency_key,command_id,request_id,request_digest,command_type,confirmation_id,
       deletion_record_id,account_version,recorded_at)
      VALUES (${command.actor.userId}::uuid,${command.idempotencyKey},${command.commandId}::uuid,
        ${command.requestId}::uuid,${digest(command)},${command.commandType},${proof.id}::uuid,
        ${recordId}::uuid,${accountVersion},${at})`.execute(database);
  }
  public async cancel(command: CancelAccountDeletionCommand): Promise<CancelAccountDeletionResult> {
    return this.database.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('deletion-command:' || ${command.commandId}::text,0))`.execute(
        tx,
      );
      const account = await this.lock(tx, command.actor.userId, command.actor.kind);
      const replay = await this.receipt(tx, command);
      if (replay !== undefined) return { cancelled: true, replayed: true };
      const at = await this.now(tx),
        proof = await this.proof(tx, command, at, account.version);
      if (account.state === 'deleted') throw unavailable();
      await sql`UPDATE identity.deletion_confirmations SET status='cancelled',resolved_at=${at}
        WHERE id=${proof.id}::uuid`.execute(tx);
      await this.recordReceipt(tx, command, proof, account.version, null, at);
      return { cancelled: true, replayed: false };
    });
  }
  private async readStatus(
    database: NakhDatabase,
    userId: string,
    recordId?: string,
  ): Promise<AccountDeletionStatus | undefined> {
    const result = (
      await sql<{
        phase: AccountDeletionStatus['phase'];
        requested_at: Date;
        completed_at: Date | null;
      }>`SELECT phase,requested_at,completed_at FROM identity.account_deletion_records
       WHERE user_id=${userId}::uuid ${recordId === undefined ? sql`` : sql`AND id=${recordId}::uuid`}
       ORDER BY requested_at DESC,id DESC LIMIT 1`.execute(database)
    ).rows[0];
    if (result === undefined) return undefined;
    if (result.phase === 'completed' && result.completed_at !== null)
      return {
        phase: 'completed',
        requestedAt: result.requested_at.toISOString(),
        completedAt: result.completed_at.toISOString(),
        returnDecision: 'reactivation_denied',
      };
    if (result.phase === 'completed') throw unavailable();
    return {
      phase: result.phase,
      requestedAt: result.requested_at.toISOString(),
      completedAt: null,
      returnDecision: 'purge_pending',
    };
  }
  public async status(
    query: GetAccountDeletionStatusQuery,
  ): Promise<AccountDeletionStatus | undefined> {
    if (query.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    return this.readStatus(this.database, query.actor.userId);
  }
  public async request(
    command: RequestAccountDeletionCommand,
  ): Promise<RequestAccountDeletionResult> {
    return this.database.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('deletion-command:' || ${command.commandId}::text,0))`.execute(
        tx,
      );
      const userId = command.actor.userId;
      const account = await this.lock(tx, userId, command.actor.kind);
      const replay = await this.receipt(tx, command);
      if (replay !== undefined && replay.deletion_record_id !== null)
        return {
          status: (await this.readStatus(tx, userId, replay.deletion_record_id))!,
          accountVersion: replay.account_version,
          replayed: true,
        };
      if (account.state === 'deleted') throw unavailable();
      const at = await this.now(tx),
        proof = await this.proof(tx, command, at, account.version);
      assertAccountTransition(account.state, 'deleted');
      const id = randomUUID(),
        historyId = randomUUID(),
        auditId = randomUUID(),
        eventId = randomUUID(),
        version = account.version + 1;
      await tx
        .updateTable('identity.accounts')
        .set({ state: 'deleted', state_reason: 'user_deletion', state_changed_at: at, version })
        .where('user_id', '=', userId)
        .execute();
      await tx
        .updateTable('identity.telegram_identities')
        .set({ username: null })
        .where('user_id', '=', userId)
        .execute();
      await tx
        .insertInto('identity.account_state_history')
        .values({
          id: historyId,
          user_id: userId,
          previous_state: account.state,
          next_state: 'deleted',
          reason_code: 'user_deletion',
          actor_type: 'user',
          actor_user_id: userId,
          actor_admin_id: null,
          changed_at: at,
        })
        .execute();
      const bar =
        account.state === 'banned'
          ? 'banned'
          : account.state === 'restricted'
            ? 'restricted'
            : 'none';
      await sql`UPDATE identity.deletion_confirmations SET status='consumed',resolved_at=${at} WHERE id=${proof.id}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO identity.account_deletion_records
        (id,user_id,confirmation_id,account_version,history_id,audit_id,event_id,command_id,request_id,requested_at,safety_bar)
        VALUES (${id}::uuid,${userId}::uuid,${proof.id}::uuid,${version},${historyId}::uuid,${auditId}::uuid,
          ${eventId}::uuid,${command.commandId}::uuid,${command.requestId}::uuid,${at},${bar})`.execute(
        tx,
      );
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id: auditId,
          category: 'account',
          event_type: 'account.deletion-requested.v1',
          actor_type: 'user',
          actor_user_id: userId,
          actor_admin_id: null,
          subject_type: 'user',
          subject_id: userId,
          result_code: 'deleted',
          metadata_schema_version: 1,
          metadata: {},
          request_id: command.requestId,
          command_id: command.commandId,
          occurred_at: at,
        })
        .execute();
      await tx
        .insertInto('platform.outbox_events')
        .values({
          id: eventId,
          aggregate_type: 'account_deletion',
          aggregate_id: id,
          event_type: 'account.deletion-requested.v1',
          schema_version: 1,
          payload: { deletionRecordId: id, step: 'shared_closure' },
          occurred_at: at,
          available_at: at,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: command.requestId,
          causation_id: command.commandId,
        })
        .execute();
      await sql`INSERT INTO identity.account_deletion_work(deletion_record_id,available_at) VALUES (${id}::uuid,${at})`.execute(
        tx,
      );
      await this.recordReceipt(tx, command, proof, version, id, at);
      return {
        status: (await this.readStatus(tx, userId, id))!,
        accountVersion: version,
        replayed: false,
      };
    });
  }
}
