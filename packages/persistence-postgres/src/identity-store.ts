import type {
  IdentityContextSnapshot,
  IdentityStore,
  LocalizationCatalog,
  LocalizationStore,
  RegisterTelegramIdentityStoreResult,
  RegisterTelegramIdentityWrite,
} from '@nakh/application';
import { entryRouteFor } from '@nakh/domain';
import { sql } from 'kysely';

import type { NakhDatabase } from './database.js';

type PostgresError = Readonly<{ code?: unknown; constraint?: unknown }>;

function isTelegramIdentityConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const postgresError = error as PostgresError;
  return (
    postgresError.code === '23505' &&
    postgresError.constraint === 'telegram_identities_telegram_user_id_key'
  );
}

export class PostgresIdentityStore implements IdentityStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async getByTelegramUserId(
    telegramUserId: string,
  ): Promise<IdentityContextSnapshot | undefined> {
    const row = await this.database
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

  private async touchKnownIdentity(write: RegisterTelegramIdentityWrite): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('identity.telegram_identities')
        .set({
          username: sql`CASE
            WHEN last_seen_at <= ${write.occurredAt} THEN ${write.username}
            ELSE username
          END`,
          last_seen_at: sql`GREATEST(last_seen_at, ${write.occurredAt})`,
        })
        .where('telegram_user_id', '=', write.telegramUserId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('identity.users')
        .set({
          last_activity_at: sql`GREATEST(last_activity_at, ${write.occurredAt})`,
          updated_at: sql`GREATEST(updated_at, ${write.occurredAt})`,
        })
        .where(
          'id',
          '=',
          transaction
            .selectFrom('identity.telegram_identities')
            .select('user_id')
            .where('telegram_user_id', '=', write.telegramUserId),
        )
        .executeTakeFirstOrThrow();
    });
  }

  public async registerOrResolveTelegramIdentity(
    write: RegisterTelegramIdentityWrite,
  ): Promise<RegisterTelegramIdentityStoreResult> {
    const existing = await this.getByTelegramUserId(write.telegramUserId);
    if (existing !== undefined) {
      await this.touchKnownIdentity(write);
      return { context: (await this.getByTelegramUserId(write.telegramUserId))!, created: false };
    }

    try {
      await this.database.transaction().execute(async (transaction) => {
        await transaction
          .insertInto('identity.users')
          .values({
            id: write.userId,
            last_activity_at: write.occurredAt,
            created_at: write.occurredAt,
            updated_at: write.occurredAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('identity.telegram_identities')
          .values({
            user_id: write.userId,
            telegram_user_id: write.telegramUserId,
            username: write.username,
            first_seen_at: write.occurredAt,
            last_seen_at: write.occurredAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('identity.accounts')
          .values({
            user_id: write.userId,
            state: 'guest',
            state_reason: null,
            state_changed_at: write.occurredAt,
            version: 1,
          })
          .executeTakeFirstOrThrow();
        await transaction
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
            changed_at: write.occurredAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('identity.guest_preview_counters')
          .values({
            user_id: write.userId,
            preview_count: 0,
            limit_count: write.guestPreviewLimit,
            first_preview_at: null,
            last_preview_at: null,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('identity.user_settings')
          .values({
            user_id: write.userId,
            visibility_enabled: true,
            ui_locale_code: write.defaultLocale,
            version: 1,
            created_at: write.occurredAt,
            updated_at: write.occurredAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('billing.credit_accounts')
          .values({
            user_id: write.userId,
            balance: '0',
            version: 1,
            created_at: write.occurredAt,
            updated_at: write.occurredAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('notification.notification_preferences')
          .values({
            user_id: write.userId,
            chat_enabled: true,
            like_enabled: true,
            nakh_enabled: true,
            match_enabled: true,
            version: 1,
            created_at: write.occurredAt,
            updated_at: write.occurredAt,
          })
          .executeTakeFirstOrThrow();
      });
    } catch (error) {
      if (!isTelegramIdentityConflict(error)) throw error;
      await this.touchKnownIdentity(write);
      return { context: (await this.getByTelegramUserId(write.telegramUserId))!, created: false };
    }

    return {
      context: (await this.getByTelegramUserId(write.telegramUserId))!,
      created: true,
    };
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
