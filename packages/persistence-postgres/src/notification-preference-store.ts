import { createHash } from 'node:crypto';
import type { Selectable } from 'kysely';
import type {
  NotificationPreferenceStore,
  NotificationPreferenceWrite,
  NotificationPreferenceResult,
  NotificationPreferences,
  UserSessionActor,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase, NotificationPreferenceTable } from './database.js';
import { requireCurrentUserSession } from './user-session-store.js';

const COLUMNS = {
  chat: 'chat_enabled',
  like: 'like_enabled',
  nakh: 'nakh_enabled',
  match: 'match_enabled',
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function denied(): never {
  throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
}
function conflict(): never {
  throw new ApplicationError('version_conflict', 'error.settings.version_conflict', 409);
}
function view(row: Selectable<NotificationPreferenceTable>): NotificationPreferences {
  return {
    version: row.version,
    chatEnabled: row.chat_enabled,
    likeEnabled: row.like_enabled,
    nakhEnabled: row.nakh_enabled,
    matchEnabled: row.match_enabled,
  };
}
/** Ordinary notification switches only. Safety/payment/administration delivery has no switch here. */
export class PostgresNotificationPreferenceStore implements NotificationPreferenceStore {
  private readonly owner: UserSessionActor;
  public constructor(
    private readonly database: NakhDatabase,
    owner: UserSessionActor,
  ) {
    this.owner = Object.freeze({ ...owner });
  }
  private async authorize(tx: NakhDatabase): Promise<void> {
    await requireCurrentUserSession(tx, this.owner.userId, this.owner);
    const account = await tx
      .selectFrom('identity.accounts')
      .select('state')
      .where('user_id', '=', this.owner.userId)
      .executeTakeFirst();
    if (!account || !['active', 'restricted'].includes(account.state))
      throw new ApplicationError('capability_denied', 'error.capability.denied', 403);
  }
  public read(): Promise<NotificationPreferences> {
    return this.database.transaction().execute(async (tx) => {
      await this.authorize(tx);
      const row = await tx
        .selectFrom('notification.notification_preferences')
        .selectAll()
        .where('user_id', '=', this.owner.userId)
        .executeTakeFirst();
      if (!row)
        throw new ApplicationError('not_found', 'error.notification.preferences_not_found', 404);
      return view(row);
    });
  }
  public change(input: NotificationPreferenceWrite): Promise<NotificationPreferenceResult> {
    const write = structuredClone(input),
      command = write.command;
    if (
      command.actor.kind !== 'user' ||
      command.actor.userId !== this.owner.userId ||
      command.commandType !== 'notification.change-preference' ||
      command.schemaVersion !== 1 ||
      !UUID.test(command.commandId) ||
      !UUID.test(command.requestId) ||
      !UUID.test(write.auditId) ||
      typeof command.idempotencyKey !== 'string' ||
      command.idempotencyKey.length < 8 ||
      command.idempotencyKey.length > 128 ||
      !command.data ||
      Object.keys(command.data).sort().join(',') !== 'enabled,expectedVersion,kind' ||
      !Object.hasOwn(COLUMNS, command.data.kind) ||
      typeof command.data.enabled !== 'boolean' ||
      !Number.isSafeInteger(command.data.expectedVersion) ||
      command.data.expectedVersion < 1 ||
      !(write.processedAt instanceof Date) ||
      !Number.isFinite(write.processedAt.getTime())
    )
      denied();
    const column = COLUMNS[command.data.kind];
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          userId: this.owner.userId,
          productEpoch: this.owner.productEpoch,
          sessionGrantId: this.owner.sessionGrantId,
          kind: command.data.kind,
          enabled: command.data.enabled,
          expectedVersion: command.data.expectedVersion,
        }),
      )
      .digest('hex');
    return this.database.transaction().execute(async (tx) => {
      await this.authorize(tx);
      const row = await tx
        .selectFrom('notification.notification_preferences')
        .selectAll()
        .where('user_id', '=', this.owner.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!row)
        throw new ApplicationError('not_found', 'error.notification.preferences_not_found', 404);
      const claim = await tx
        .insertInto('platform.idempotency_records')
        .values({
          id: command.commandId,
          actor_user_id: this.owner.userId,
          scope: command.commandType,
          idempotency_key: command.idempotencyKey,
          request_hash: digest,
          status: 'processing',
          response_json: null,
          expires_at: new Date(write.processedAt.getTime() + 86400000),
          created_at: write.processedAt,
          updated_at: write.processedAt,
        })
        .onConflict((c) => c.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!claim) {
        const prior = await tx
          .selectFrom('platform.idempotency_records')
          .selectAll()
          .where('actor_user_id', '=', this.owner.userId)
          .where('scope', '=', command.commandType)
          .where('idempotency_key', '=', command.idempotencyKey)
          .executeTakeFirst();
        if (!prior || prior.request_hash !== digest)
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        const result = prior.response_json;
        if (
          prior.status !== 'completed' ||
          result === null ||
          Object.keys(result).sort().join(',') !==
            'changed,chatEnabled,likeEnabled,matchEnabled,nakhEnabled,replayed,version' ||
          !Number.isSafeInteger(result.version) ||
          Number(result.version) < 1 ||
          typeof result.changed !== 'boolean' ||
          result.replayed !== false ||
          ['chatEnabled', 'likeEnabled', 'nakhEnabled', 'matchEnabled'].some(
            (k) => typeof result[k] !== 'boolean',
          )
        )
          conflict();
        return {
          version: Number(result.version),
          chatEnabled: result.chatEnabled as boolean,
          likeEnabled: result.likeEnabled as boolean,
          nakhEnabled: result.nakhEnabled as boolean,
          matchEnabled: result.matchEnabled as boolean,
          changed: result.changed,
          replayed: true,
        };
      }
      if (row.version !== command.data.expectedVersion) conflict();
      const changed = row[column] !== command.data.enabled;
      let updated = row;
      if (changed) {
        updated = await tx
          .updateTable('notification.notification_preferences')
          .set({
            [column]: command.data.enabled,
            version: row.version + 1,
            updated_at: write.processedAt,
          })
          .where('user_id', '=', this.owner.userId)
          .returningAll()
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('platform.audit_logs')
          .values({
            id: write.auditId,
            category: 'account',
            event_type: 'notification.preference-changed.v1',
            actor_type: 'user',
            actor_user_id: this.owner.userId,
            actor_admin_id: null,
            subject_type: 'user',
            subject_id: this.owner.userId,
            result_code: 'changed',
            metadata_schema_version: 1,
            metadata: {
              actionType: command.data.kind,
              decision: command.data.enabled ? 'enabled' : 'disabled',
              version: updated.version,
            },
            command_id: command.commandId,
            request_id: command.requestId,
            occurred_at: write.processedAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
      }
      const result = { ...view(updated), changed, replayed: false };
      await tx
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: write.processedAt })
        .where('id', '=', command.commandId)
        .returning('id')
        .executeTakeFirstOrThrow();
      return result;
    });
  }
}
