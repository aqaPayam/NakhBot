import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type {
  AuthorizedNakhReadPage,
  AuthorizedNakhRow,
  DeliveredNakhReadStore,
  NakhKeyset,
  NakhPageDirection,
  NakhReceiverActionStore,
  RejectNakhWrite,
  ViewNakhProfileWrite,
} from '@nakh/application';
import type { NakhActionResult, RejectNakhCommand, ViewNakhProfileCommand } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { lockUserPair } from './pair-lock.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function commandHash(command: ViewNakhProfileCommand | RejectNakhCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        commandType: command.commandType,
        schemaVersion: command.schemaVersion,
        actor: command.actor,
        data: command.data,
      }),
    )
    .digest('hex');
}

function replayResult(value: Readonly<Record<string, unknown>>): NakhActionResult {
  return {
    nakhId: String(value.nakhId),
    status: String(value.status) as NakhActionResult['status'],
    ...(typeof value.matchId === 'string' ? { matchId: value.matchId } : {}),
    changedAt: String(value.changedAt),
    replayed: true,
  };
}

function denied(): never {
  throw new ApplicationError('capability_denied', 'error.capability.denied', 403);
}

export class PostgresDeliveredNakhStore implements DeliveredNakhReadStore, NakhReceiverActionStore {
  public constructor(private readonly database: NakhDatabase) {}

  public readPage(
    viewerUserId: string,
    direction: NakhPageDirection,
    limit: number,
    after?: NakhKeyset,
  ): Promise<AuthorizedNakhReadPage> {
    if (
      !UUID.test(viewerUserId) ||
      (direction !== 'sent' && direction !== 'received') ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      return Promise.reject(
        new ApplicationError('invalid_request', 'error.nakh.page_invalid', 400),
      );
    return this.database
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (transaction) => {
        const account = await transaction
          .selectFrom('identity.accounts')
          .select('state')
          .where('user_id', '=', viewerUserId)
          .executeTakeFirst();
        if (account?.state !== 'active') denied();
        const ownerColumn = direction === 'sent' ? 'sender_user_id' : 'receiver_user_id';
        const count = await transaction
          .selectFrom('nakh.nakhes')
          .select((expression) => expression.fn.countAll<string>().as('count'))
          .where(ownerColumn, '=', viewerUserId)
          .executeTakeFirstOrThrow();
        const totalCount = Number(count.count);
        if (!Number.isSafeInteger(totalCount))
          throw new ApplicationError('internal_error', 'error.internal', 500);

        let query = transaction
          .selectFrom('nakh.nakhes as nakh')
          .innerJoin('profile.profiles as counterparty', (join) =>
            join.onRef(
              'counterparty.user_id',
              '=',
              direction === 'sent' ? 'nakh.receiver_user_id' : 'nakh.sender_user_id',
            ),
          )
          .select([
            'nakh.id',
            'counterparty.name as counterparty_name',
            'nakh.text',
            'nakh.status',
            'nakh.sent_at',
            'nakh.expires_at',
            'nakh.version',
          ])
          .where(`nakh.${ownerColumn}`, '=', viewerUserId);
        if (after !== undefined)
          query = query.where((expression) =>
            expression.or([
              expression('nakh.sent_at', '<', after.sentAt),
              expression.and([
                expression('nakh.sent_at', '=', after.sentAt),
                expression('nakh.id', '<', after.nakhId),
              ]),
            ]),
          );
        const rows = await query
          .orderBy('nakh.sent_at', 'desc')
          .orderBy('nakh.id', 'desc')
          .limit(limit + 1)
          .execute();
        return {
          totalCount,
          rows: rows.slice(0, limit).map((row) => ({
            nakhId: row.id,
            direction,
            counterpartyName: row.counterparty_name,
            text: row.text,
            status: row.status,
            sentAt: row.sent_at,
            expiresAt: row.expires_at,
            version: row.version,
          })),
          hasMore: rows.length > limit,
        };
      });
  }

  public async readDetail(viewerUserId: string, nakhId: string): Promise<AuthorizedNakhRow> {
    if (!UUID.test(viewerUserId) || !UUID.test(nakhId))
      throw new ApplicationError('invalid_request', 'error.nakh.detail_invalid', 400);
    const account = await this.database
      .selectFrom('identity.accounts')
      .select('state')
      .where('user_id', '=', viewerUserId)
      .executeTakeFirst();
    if (account?.state !== 'active') denied();
    const row = await this.database
      .selectFrom('nakh.nakhes as nakh')
      .innerJoin('profile.profiles as sender', 'sender.user_id', 'nakh.sender_user_id')
      .innerJoin('profile.profiles as receiver', 'receiver.user_id', 'nakh.receiver_user_id')
      .select([
        'nakh.id',
        'nakh.sender_user_id',
        'nakh.receiver_user_id',
        'sender.name as sender_name',
        'receiver.name as receiver_name',
        'nakh.text',
        'nakh.status',
        'nakh.sent_at',
        'nakh.expires_at',
        'nakh.version',
      ])
      .where('nakh.id', '=', nakhId)
      .where((expression) =>
        expression.or([
          expression('nakh.sender_user_id', '=', viewerUserId),
          expression('nakh.receiver_user_id', '=', viewerUserId),
        ]),
      )
      .executeTakeFirst();
    if (row === undefined) throw new ApplicationError('not_found', 'error.nakh.not_found', 404);
    const direction = row.sender_user_id === viewerUserId ? 'sent' : 'received';
    return {
      nakhId: row.id,
      direction,
      counterpartyName: direction === 'sent' ? row.receiver_name : row.sender_name,
      text: row.text,
      status: row.status,
      sentAt: row.sent_at,
      expiresAt: row.expires_at,
      version: row.version,
    };
  }

  public async viewProfile(write: ViewNakhProfileWrite): Promise<NakhActionResult> {
    const { command } = write;
    const receiverUserId = command.actor.userId;
    const requestHash = commandHash(command);
    const locator = await this.database
      .selectFrom('nakh.nakhes')
      .select(['nakh_flow_id', 'sender_user_id', 'receiver_user_id'])
      .where('id', '=', command.data.nakhId)
      .executeTakeFirst();
    if (locator === undefined || locator.receiver_user_id !== receiverUserId)
      throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);

    return this.database.transaction().execute(async (transaction) => {
      const claimed = await transaction
        .insertInto('platform.idempotency_records')
        .values({
          id: command.commandId,
          actor_user_id: receiverUserId,
          scope: command.commandType,
          idempotency_key: command.idempotencyKey,
          request_hash: requestHash,
          status: 'processing',
          response_json: null,
          expires_at: new Date(Date.parse(command.occurredAt) + 86_400_000),
          created_at: new Date(command.occurredAt),
          updated_at: new Date(command.occurredAt),
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (claimed === undefined) {
        const existing = await transaction
          .selectFrom('platform.idempotency_records')
          .select(['request_hash', 'status', 'response_json'])
          .where('actor_user_id', '=', receiverUserId)
          .where('scope', '=', command.commandType)
          .where('idempotency_key', '=', command.idempotencyKey)
          .executeTakeFirst();
        if (existing === undefined || existing.request_hash !== requestHash)
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        if (existing.status !== 'completed' || existing.response_json === null)
          throw new ApplicationError('conflict', 'error.command.in_progress', 409);
        return replayResult(existing.response_json);
      }

      const pair = await lockUserPair(transaction, locator.sender_user_id, receiverUserId);
      const participants = await transaction
        .selectFrom('identity.accounts as account')
        .innerJoin('profile.profiles as profile', 'profile.user_id', 'account.user_id')
        .select(['account.user_id', 'account.state', 'profile.completion_status'])
        .where('account.user_id', 'in', [pair.userLowId, pair.userHighId])
        .orderBy('account.user_id')
        .forUpdate()
        .execute();
      const receiver = participants.find((participant) => participant.user_id === receiverUserId);
      const sender = participants.find(
        (participant) => participant.user_id === locator.sender_user_id,
      );
      if (
        receiver?.state !== 'active' ||
        sender?.state !== 'active' ||
        sender.completion_status !== 'complete'
      )
        denied();
      await transaction
        .selectFrom('nakh.nakh_flows')
        .select('id')
        .where('id', '=', locator.nakh_flow_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const nakh = await transaction
        .selectFrom('nakh.nakhes')
        .select(['id', 'receiver_user_id', 'status', 'version'])
        .where('id', '=', command.data.nakhId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (nakh.receiver_user_id !== receiverUserId || nakh.status !== 'sent')
        throw new ApplicationError('nakh_terminal', 'error.nakh.terminal', 409);
      if (nakh.version !== command.data.expectedVersion)
        throw new ApplicationError('version_conflict', 'error.command.stale_version', 409);

      const time = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(transaction);
      const now = time.rows[0]!.now;
      await transaction
        .insertInto('nakh.nakh_receiver_actions')
        .values({
          id: write.actionId,
          nakh_id: nakh.id,
          receiver_user_id: receiverUserId,
          action_type: 'view_profile',
          idempotency_key: command.idempotencyKey,
          request_id: command.requestId,
          created_at: now,
        })
        .execute();
      await transaction
        .updateTable('nakh.nakhes')
        .set({ status: 'seen', seen_at: now, version: nakh.version + 1 })
        .where('id', '=', nakh.id)
        .where('status', '=', 'sent')
        .where('version', '=', nakh.version)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('nakh.nakh_status_history')
        .values({
          id: write.historyId,
          nakh_id: nakh.id,
          nakh_version: nakh.version + 1,
          from_status: 'sent',
          to_status: 'seen',
          reason_code: 'receiver_viewed_profile',
          changed_by_user_id: receiverUserId,
          request_id: command.requestId,
          changed_at: now,
        })
        .execute();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'nakh',
          aggregate_id: nakh.id,
          event_type: 'nakh.status-changed.v1',
          schema_version: 1,
          payload: { nakhId: nakh.id, status: 'seen' },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: command.requestId,
          causation_id: command.commandId,
        })
        .execute();
      const result: NakhActionResult = {
        nakhId: nakh.id,
        status: 'seen',
        changedAt: now.toISOString(),
        replayed: false,
      };
      await transaction
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: now })
        .where('id', '=', command.commandId)
        .executeTakeFirstOrThrow();
      return result;
    });
  }

  public async reject(write: RejectNakhWrite): Promise<NakhActionResult> {
    const { command } = write;
    const receiverUserId = command.actor.userId;
    const requestHash = commandHash(command);
    const locator = await this.database
      .selectFrom('nakh.nakhes')
      .select(['nakh_flow_id', 'sender_user_id', 'receiver_user_id'])
      .where('id', '=', command.data.nakhId)
      .executeTakeFirst();
    if (locator === undefined || locator.receiver_user_id !== receiverUserId)
      throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);

    return this.database.transaction().execute(async (transaction) => {
      const claimed = await transaction
        .insertInto('platform.idempotency_records')
        .values({
          id: command.commandId,
          actor_user_id: receiverUserId,
          scope: command.commandType,
          idempotency_key: command.idempotencyKey,
          request_hash: requestHash,
          status: 'processing',
          response_json: null,
          expires_at: new Date(Date.parse(command.occurredAt) + 86_400_000),
          created_at: new Date(command.occurredAt),
          updated_at: new Date(command.occurredAt),
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (claimed === undefined) {
        const existing = await transaction
          .selectFrom('platform.idempotency_records')
          .select(['request_hash', 'status', 'response_json'])
          .where('actor_user_id', '=', receiverUserId)
          .where('scope', '=', command.commandType)
          .where('idempotency_key', '=', command.idempotencyKey)
          .executeTakeFirst();
        if (existing === undefined || existing.request_hash !== requestHash)
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        if (existing.status !== 'completed' || existing.response_json === null)
          throw new ApplicationError('conflict', 'error.command.in_progress', 409);
        return replayResult(existing.response_json);
      }

      const pair = await lockUserPair(transaction, locator.sender_user_id, receiverUserId);
      const participants = await transaction
        .selectFrom('identity.accounts')
        .select(['user_id', 'state'])
        .where('user_id', 'in', [pair.userLowId, pair.userHighId])
        .orderBy('user_id')
        .forUpdate()
        .execute();
      const receiver = participants.find((participant) => participant.user_id === receiverUserId);
      if (receiver?.state !== 'active') denied();
      await transaction
        .selectFrom('nakh.nakh_flows')
        .select('id')
        .where('id', '=', locator.nakh_flow_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const nakh = await transaction
        .selectFrom('nakh.nakhes')
        .select(['id', 'receiver_user_id', 'status', 'version'])
        .where('id', '=', command.data.nakhId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        nakh.receiver_user_id !== receiverUserId ||
        (nakh.status !== 'sent' && nakh.status !== 'seen')
      )
        throw new ApplicationError('nakh_terminal', 'error.nakh.terminal', 409);
      if (nakh.version !== command.data.expectedVersion)
        throw new ApplicationError('version_conflict', 'error.command.stale_version', 409);

      const time = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(transaction);
      const now = time.rows[0]!.now;
      await transaction
        .insertInto('nakh.nakh_receiver_actions')
        .values({
          id: write.actionId,
          nakh_id: nakh.id,
          receiver_user_id: receiverUserId,
          action_type: 'reject',
          idempotency_key: command.idempotencyKey,
          request_id: command.requestId,
          created_at: now,
        })
        .execute();
      await transaction
        .updateTable('nakh.nakhes')
        .set({ status: 'rejected', rejected_at: now, version: nakh.version + 1 })
        .where('id', '=', nakh.id)
        .where('status', '=', nakh.status)
        .where('version', '=', nakh.version)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('nakh.nakh_status_history')
        .values({
          id: write.historyId,
          nakh_id: nakh.id,
          nakh_version: nakh.version + 1,
          from_status: nakh.status,
          to_status: 'rejected',
          reason_code: 'receiver_rejected',
          changed_by_user_id: receiverUserId,
          request_id: command.requestId,
          changed_at: now,
        })
        .execute();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'nakh',
          aggregate_id: nakh.id,
          event_type: 'nakh.status-changed.v1',
          schema_version: 1,
          payload: { nakhId: nakh.id, status: 'rejected' },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: command.requestId,
          causation_id: command.commandId,
        })
        .execute();
      const result: NakhActionResult = {
        nakhId: nakh.id,
        status: 'rejected',
        changedAt: now.toISOString(),
        replayed: false,
      };
      await transaction
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: now })
        .where('id', '=', command.commandId)
        .executeTakeFirstOrThrow();
      return result;
    });
  }
}
