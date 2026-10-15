import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { AccountControlActor, AccountReturnStore } from '@nakh/application';
import type { ReturnAccountCommand, ReturnAccountResult } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

export class PostgresAccountReturnStore implements AccountReturnStore {
  private readonly control: AccountControlActor;
  public constructor(
    private readonly database: NakhDatabase,
    control: AccountControlActor,
  ) {
    this.control = Object.freeze({ ...control });
  }
  public async return(command: ReturnAccountCommand): Promise<ReturnAccountResult> {
    if (
      command.commandType !== 'account.return' ||
      command.schemaVersion !== 1 ||
      !Number.isSafeInteger(command.data.expectedAccountVersion) ||
      command.data.expectedAccountVersion < 1 ||
      typeof command.idempotencyKey !== 'string' ||
      command.idempotencyKey.length < 8 ||
      command.idempotencyKey.length > 128
    )
      throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
    if (
      this.control.kind !== 'user' ||
      this.control.scope !== 'account_control' ||
      command.actor.kind !== 'user' ||
      command.actor.userId !== this.control.userId
    )
      throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
    const requestDigest = createHash('sha256')
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
    const idempotencyHash = createHash('sha256').update(command.idempotencyKey).digest('hex');
    // Values are bound before the first await; callers cannot retag a delayed command.
    const query = sql<{
      account_version: number;
      replayed: boolean;
    }>`SELECT * FROM identity.return_account(
      ${this.control.userId}::uuid,${this.control.productEpoch}::integer,${this.control.controlGrantId}::uuid,
      ${command.commandId}::uuid,${command.requestId}::uuid,${requestDigest},${idempotencyHash},${command.data.expectedAccountVersion}::integer)`;
    try {
      const row = (await query.execute(this.database)).rows[0];
      if (row === undefined) throw new Error('Account return receipt missing.');
      return { returned: true, accountVersion: row.account_version, replayed: row.replayed };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === '22023')
        throw new ApplicationError(
          'idempotency_conflict',
          'error.command.idempotency_conflict',
          409,
        );
      if (code === '42501')
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      if (code === '55000')
        throw new ApplicationError('conflict', 'error.deletion.unavailable', 409);
      throw error;
    }
  }
}
