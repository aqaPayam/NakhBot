import { createHash } from 'node:crypto';

import type {
  ChangeSettingsWrite,
  IdentityContextSnapshot,
  IdentityStore,
  LocalizationCatalog,
  LocalizationStore,
  RegisterTelegramIdentityWrite,
} from '@nakh/application';
import type { ChangeSettingsResult, RegisterTelegramIdentityResult } from '@nakh/contracts';
import { ApplicationError, entryRouteFor, evaluateCapability } from '@nakh/domain';
import { sql } from 'kysely';

import type { NakhDatabase } from './database.js';

function registrationHash(write: RegisterTelegramIdentityWrite): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        commandType: write.command.commandType,
        schemaVersion: write.command.schemaVersion,
        actor: write.command.actor,
        data: write.command.data,
        channelContext: write.command.channelContext,
      }),
    )
    .digest('hex');
}

function settingsHash(write: ChangeSettingsWrite): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        commandType: write.command.commandType,
        schemaVersion: write.command.schemaVersion,
        actor: write.command.actor,
        data: write.command.data,
      }),
    )
    .digest('hex');
}

function parseStoredRegistration(
  value: Readonly<Record<string, unknown>>,
): RegisterTelegramIdentityResult {
  const context = value.context;
  if (typeof context !== 'object' || context === null)
    throw new Error('Stored identity registration result is invalid.');
  const stored = context as Readonly<Record<string, unknown>>;
  return {
    context: {
      userId: String(stored.userId),
      accountState: stored.accountState as IdentityContextSnapshot['accountState'],
      profileCompletion:
        stored.profileCompletion === null
          ? null
          : (stored.profileCompletion as IdentityContextSnapshot['profileCompletion']),
      visibilityEnabled: Boolean(stored.visibilityEnabled),
      uiLocale: String(stored.uiLocale),
      guestPreviewCount: Number(stored.guestPreviewCount),
      guestPreviewLimit: Number(stored.guestPreviewLimit),
      entryRoute: stored.entryRoute as IdentityContextSnapshot['entryRoute'],
      accountVersion: Number(stored.accountVersion),
      settingsVersion: Number(stored.settingsVersion),
    },
    created: Boolean(value.created),
    replayed: true,
  };
}

function parseStoredSettings(value: Readonly<Record<string, unknown>>): ChangeSettingsResult {
  return {
    userId: String(value.userId),
    uiLocale: String(value.uiLocale),
    visibilityEnabled: Boolean(value.visibilityEnabled),
    settingsVersion: Number(value.settingsVersion),
    changed: Boolean(value.changed),
    replayed: true,
  };
}

export class PostgresIdentityStore implements IdentityStore {
  public constructor(private readonly database: NakhDatabase) {}

  private async getContext(
    database: NakhDatabase,
    telegramUserId: string,
  ): Promise<IdentityContextSnapshot | undefined> {
    const row = await database
      .selectFrom('identity.telegram_identities as telegram')
      .innerJoin('identity.accounts as account', 'account.user_id', 'telegram.user_id')
      .innerJoin('identity.user_settings as settings', 'settings.user_id', 'telegram.user_id')
      .innerJoin(
        'identity.guest_preview_counters as preview',
        'preview.user_id',
        'telegram.user_id',
      )
      .select([
        'telegram.user_id',
        'account.state',
        'account.version as account_version',
        'settings.visibility_enabled',
        'settings.ui_locale_code',
        'settings.version as settings_version',
        'preview.preview_count',
        'preview.limit_count',
      ])
      .where('telegram.telegram_user_id', '=', telegramUserId)
      .executeTakeFirst();
    if (row === undefined) return undefined;

    const profileCompletion = null;
    return {
      userId: row.user_id,
      accountState: row.state,
      profileCompletion,
      visibilityEnabled: row.visibility_enabled,
      uiLocale: row.ui_locale_code,
      guestPreviewCount: row.preview_count,
      guestPreviewLimit: row.limit_count,
      entryRoute: entryRouteFor({
        accountState: row.state,
        profileCompletion,
        visibilityEnabled: row.visibility_enabled,
      }),
      accountVersion: row.account_version,
      settingsVersion: row.settings_version,
    };
  }

  public getByTelegramUserId(telegramUserId: string): Promise<IdentityContextSnapshot | undefined> {
    return this.getContext(this.database, telegramUserId);
  }

  public async getByUserId(userId: string): Promise<IdentityContextSnapshot | undefined> {
    const row = await this.database
      .selectFrom('identity.users as user')
      .innerJoin('identity.accounts as account', 'account.user_id', 'user.id')
      .innerJoin('identity.user_settings as settings', 'settings.user_id', 'user.id')
      .innerJoin('identity.guest_preview_counters as preview', 'preview.user_id', 'user.id')
      .select([
        'user.id as user_id',
        'account.state',
        'account.version as account_version',
        'settings.visibility_enabled',
        'settings.ui_locale_code',
        'settings.version as settings_version',
        'preview.preview_count',
        'preview.limit_count',
      ])
      .where('user.id', '=', userId)
      .executeTakeFirst();
    if (row === undefined) return undefined;

    const profileCompletion = null;
    return {
      userId: row.user_id,
      accountState: row.state,
      profileCompletion,
      visibilityEnabled: row.visibility_enabled,
      uiLocale: row.ui_locale_code,
      guestPreviewCount: row.preview_count,
      guestPreviewLimit: row.limit_count,
      entryRoute: entryRouteFor({
        accountState: row.state,
        profileCompletion,
        visibilityEnabled: row.visibility_enabled,
      }),
      accountVersion: row.account_version,
      settingsVersion: row.settings_version,
    };
  }

  private async touchKnownIdentity(
    database: NakhDatabase,
    write: RegisterTelegramIdentityWrite,
  ): Promise<void> {
    await database
      .updateTable('identity.telegram_identities')
      .set({
        username: sql`CASE
          WHEN last_seen_at <= ${write.processedAt} THEN ${write.command.data.username ?? null}
          ELSE username
        END`,
        last_seen_at: sql`GREATEST(last_seen_at, ${write.processedAt})`,
      })
      .where('telegram_user_id', '=', write.command.data.telegramUserId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable('identity.users')
      .set({
        last_activity_at: sql`GREATEST(last_activity_at, ${write.processedAt})`,
        updated_at: sql`GREATEST(updated_at, ${write.processedAt})`,
      })
      .where(
        'id',
        '=',
        database
          .selectFrom('identity.telegram_identities')
          .select('user_id')
          .where('telegram_user_id', '=', write.command.data.telegramUserId),
      )
      .executeTakeFirstOrThrow();
  }

  private async createFirstStartAggregate(
    database: NakhDatabase,
    write: RegisterTelegramIdentityWrite,
  ): Promise<void> {
    const username = write.command.data.username ?? null;
    await database
      .insertInto('identity.users')
      .values({
        id: write.userId,
        last_activity_at: write.processedAt,
        created_at: write.processedAt,
        updated_at: write.processedAt,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto('identity.telegram_identities')
      .values({
        user_id: write.userId,
        telegram_user_id: write.command.data.telegramUserId,
        username,
        first_seen_at: write.processedAt,
        last_seen_at: write.processedAt,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto('identity.accounts')
      .values({
        user_id: write.userId,
        state: 'guest',
        state_reason: null,
        state_changed_at: write.processedAt,
        version: 1,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto('identity.account_state_history')
      .values({
        id: write.accountHistoryId,
        user_id: write.userId,
        previous_state: null,
        next_state: 'guest',
        reason_code: 'first_start',
        actor_type: 'system',
        actor_user_id: null,
        actor_admin_id: null,
        changed_at: write.processedAt,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto('identity.guest_preview_counters')
      .values({
        user_id: write.userId,
        preview_count: 0,
        limit_count: write.guestPreviewLimit,
        first_preview_at: null,
        last_preview_at: null,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto('identity.user_settings')
      .values({
        user_id: write.userId,
        visibility_enabled: true,
        ui_locale_code: write.defaultLocale,
        version: 1,
        created_at: write.processedAt,
        updated_at: write.processedAt,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto('billing.credit_accounts')
      .values({
        user_id: write.userId,
        balance: '0',
        version: 1,
        created_at: write.processedAt,
        updated_at: write.processedAt,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto('notification.notification_preferences')
      .values({
        user_id: write.userId,
        chat_enabled: true,
        like_enabled: true,
        nakh_enabled: true,
        match_enabled: true,
        version: 1,
        created_at: write.processedAt,
        updated_at: write.processedAt,
      })
      .executeTakeFirstOrThrow();
  }

  public async registerTelegramIdentity(
    write: RegisterTelegramIdentityWrite,
  ): Promise<RegisterTelegramIdentityResult> {
    const hash = registrationHash(write);
    return this.database.transaction().execute(async (transaction) => {
      const claimed = await transaction
        .insertInto('platform.idempotency_records')
        .values({
          id: write.command.commandId,
          actor_user_id: write.command.actor.userId,
          scope: write.command.commandType,
          idempotency_key: write.command.idempotencyKey,
          request_hash: hash,
          status: 'processing',
          response_json: null,
          expires_at: new Date(write.processedAt.getTime() + 24 * 60 * 60 * 1_000),
          created_at: write.processedAt,
          updated_at: write.processedAt,
        })
        .onConflict((conflict) =>
          conflict.columns(['actor_user_id', 'scope', 'idempotency_key']).doNothing(),
        )
        .returning('id')
        .executeTakeFirst();

      if (claimed === undefined) {
        const existing = await transaction
          .selectFrom('platform.idempotency_records')
          .select(['request_hash', 'status', 'response_json'])
          .where('actor_user_id', '=', write.command.actor.userId)
          .where('scope', '=', write.command.commandType)
          .where('idempotency_key', '=', write.command.idempotencyKey)
          .executeTakeFirstOrThrow();
        if (existing.request_hash !== hash) {
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        }
        if (existing.status !== 'completed' || existing.response_json === null) {
          throw new ApplicationError('conflict', 'error.command.in_progress', 409);
        }
        return parseStoredRegistration(existing.response_json);
      }

      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${write.command.data.telegramUserId}, 0))`.execute(
        transaction,
      );
      let context = await this.getContext(transaction, write.command.data.telegramUserId);
      const created = context === undefined;
      if (created) {
        await this.createFirstStartAggregate(transaction, write);
        context = await this.getContext(transaction, write.command.data.telegramUserId);
      } else {
        await this.touchKnownIdentity(transaction, write);
        context = await this.getContext(transaction, write.command.data.telegramUserId);
      }
      if (context === undefined) throw new Error('Identity aggregate was not persisted.');

      if (created) {
        await transaction
          .insertInto('platform.audit_logs')
          .values({
            id: write.auditId,
            category: 'account',
            event_type: 'identity.telegram-identity-registered.v1',
            actor_type: 'system',
            actor_user_id: null,
            actor_admin_id: null,
            subject_type: 'user',
            subject_id: context.userId,
            result_code: 'created',
            metadata_schema_version: 1,
            metadata: { channel: 'telegram' },
            request_id: write.command.requestId,
            command_id: write.command.commandId,
            occurred_at: write.processedAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: write.registrationEventId,
            aggregate_type: 'user',
            aggregate_id: context.userId,
            event_type: 'identity.telegram-identity-registered.v1',
            schema_version: 1,
            payload: { userId: context.userId, accountState: 'guest' },
            occurred_at: write.processedAt,
            available_at: write.processedAt,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: write.command.requestId,
            causation_id: write.command.commandId,
          })
          .executeTakeFirstOrThrow();
      }

      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.startRouteEventId,
          aggregate_type: 'user',
          aggregate_id: context.userId,
          event_type: 'telegram.start-route-requested.v1',
          schema_version: 1,
          payload: {
            userId: context.userId,
            entryRoute: context.entryRoute,
            uiLocale: context.uiLocale,
          },
          occurred_at: write.processedAt,
          available_at: write.processedAt,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: write.command.requestId,
          causation_id: write.command.commandId,
        })
        .executeTakeFirstOrThrow();

      const result: RegisterTelegramIdentityResult = {
        context,
        created,
        replayed: false,
      };
      await transaction
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: write.processedAt })
        .where('id', '=', write.command.commandId)
        .executeTakeFirstOrThrow();
      return result;
    });
  }

  public async changeSettings(write: ChangeSettingsWrite): Promise<ChangeSettingsResult> {
    if (write.command.actor.kind !== 'user') {
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    }
    const actorUserId = write.command.actor.userId;
    const hash = settingsHash(write);

    return this.database.transaction().execute(async (transaction) => {
      const claimed = await transaction
        .insertInto('platform.idempotency_records')
        .values({
          id: write.command.commandId,
          actor_user_id: actorUserId,
          scope: write.command.commandType,
          idempotency_key: write.command.idempotencyKey,
          request_hash: hash,
          status: 'processing',
          response_json: null,
          expires_at: new Date(write.processedAt.getTime() + 24 * 60 * 60 * 1_000),
          created_at: write.processedAt,
          updated_at: write.processedAt,
        })
        .onConflict((conflict) =>
          conflict.columns(['actor_user_id', 'scope', 'idempotency_key']).doNothing(),
        )
        .returning('id')
        .executeTakeFirst();

      if (claimed === undefined) {
        const existing = await transaction
          .selectFrom('platform.idempotency_records')
          .select(['request_hash', 'status', 'response_json'])
          .where('actor_user_id', '=', actorUserId)
          .where('scope', '=', write.command.commandType)
          .where('idempotency_key', '=', write.command.idempotencyKey)
          .executeTakeFirstOrThrow();
        if (existing.request_hash !== hash) {
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        }
        if (existing.status !== 'completed' || existing.response_json === null) {
          throw new ApplicationError('conflict', 'error.command.in_progress', 409);
        }
        return parseStoredSettings(existing.response_json);
      }

      const user = await transaction
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', actorUserId)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined) {
        throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
      }
      const account = await transaction
        .selectFrom('identity.accounts')
        .select(['state', 'version'])
        .where('user_id', '=', actorUserId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const settings = await transaction
        .selectFrom('identity.user_settings')
        .select(['ui_locale_code', 'visibility_enabled', 'version'])
        .where('user_id', '=', actorUserId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const decision = evaluateCapability(
        {
          accountState: account.state,
          profileCompletion: null,
          visibilityEnabled: settings.visibility_enabled,
        },
        'change_settings',
      );
      if (!decision.allowed) {
        throw new ApplicationError('capability_denied', 'error.capability.denied', 403, {
          reason: decision.reasonCode ?? 'account_state_denied',
          requiredRoute: decision.requiredRoute,
        });
      }

      if (settings.version !== write.command.data.expectedSettingsVersion) {
        throw new ApplicationError('version_conflict', 'error.settings.version_conflict', 409, {
          currentVersion: String(settings.version),
        });
      }

      let uiLocale = settings.ui_locale_code;
      let visibilityEnabled = settings.visibility_enabled;
      let eventType: string;
      let metadata: Readonly<Record<string, string | boolean>>;

      if (write.command.commandType === 'identity.change-locale') {
        const locale = await transaction
          .selectFrom('catalog.locales')
          .select('code')
          .where('code', '=', write.command.data.locale)
          .where('is_active', '=', true)
          .executeTakeFirst();
        if (locale === undefined) {
          throw new ApplicationError('invalid_request', 'error.settings.locale_inactive', 400);
        }
        uiLocale = locale.code;
        eventType = 'identity.locale-changed.v1';
        metadata = { fromLocale: settings.ui_locale_code, toLocale: uiLocale };
      } else {
        visibilityEnabled = write.command.data.visibilityEnabled;
        eventType = 'identity.visibility-changed.v1';
        metadata = {
          fromVisibility: settings.visibility_enabled,
          toVisibility: visibilityEnabled,
        };
      }

      const changed =
        uiLocale !== settings.ui_locale_code || visibilityEnabled !== settings.visibility_enabled;
      const settingsVersion = changed ? settings.version + 1 : settings.version;

      if (changed) {
        await transaction
          .updateTable('identity.user_settings')
          .set({
            ui_locale_code: uiLocale,
            visibility_enabled: visibilityEnabled,
            version: settingsVersion,
            updated_at: write.processedAt,
          })
          .where('user_id', '=', actorUserId)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('platform.audit_logs')
          .values({
            id: write.auditId,
            category: 'account',
            event_type: eventType,
            actor_type: 'user',
            actor_user_id: actorUserId,
            actor_admin_id: null,
            subject_type: 'user_settings',
            subject_id: actorUserId,
            result_code: 'changed',
            metadata_schema_version: 1,
            metadata,
            request_id: write.command.requestId,
            command_id: write.command.commandId,
            occurred_at: write.processedAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: write.eventId,
            aggregate_type: 'user',
            aggregate_id: actorUserId,
            event_type: eventType,
            schema_version: 1,
            payload: { userId: actorUserId, uiLocale, visibilityEnabled, settingsVersion },
            occurred_at: write.processedAt,
            available_at: write.processedAt,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: write.command.requestId,
            causation_id: write.command.commandId,
          })
          .executeTakeFirstOrThrow();
      }

      const result: ChangeSettingsResult = {
        userId: actorUserId,
        uiLocale,
        visibilityEnabled,
        settingsVersion,
        changed,
        replayed: false,
      };
      await transaction
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: write.processedAt })
        .where('id', '=', write.command.commandId)
        .executeTakeFirstOrThrow();
      return result;
    });
  }
}

export class PostgresLocalizationStore implements LocalizationStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async loadActiveCatalog(locale: string): Promise<LocalizationCatalog> {
    const selected = await this.database
      .selectFrom('catalog.locales')
      .select('code')
      .where('code', '=', locale)
      .where('is_active', '=', true)
      .executeTakeFirst();
    const fallback =
      selected ??
      (await this.database
        .selectFrom('catalog.locales')
        .select('code')
        .where('is_default', '=', true)
        .where('is_active', '=', true)
        .executeTakeFirstOrThrow());
    const rows = await this.database
      .selectFrom('catalog.ui_texts')
      .select(['text_key', 'value'])
      .where('locale_code', '=', fallback.code)
      .where('is_active', '=', true)
      .orderBy('text_key')
      .execute();

    return {
      requestedLocale: locale,
      resolvedLocale: fallback.code,
      messages: Object.fromEntries(rows.map((row) => [row.text_key, row.value])),
    };
  }
}
