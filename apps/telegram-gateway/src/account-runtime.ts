import type { TelegramStarsCheckoutPort } from './stars-checkout-runtime.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  GrantFreeTestCreditsHandler,
  ChangeSettingsHandler,
  ChangeNotificationPreferenceHandler,
  type UserSessionActor,
} from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { ApplicationError, SystemClock } from '@nakh/domain';
import { CatalogRenderer, M9_ACCOUNT_TEXTS, M9_SETTINGS_TEXTS } from '@nakh/localization';
import {
  PostgresFreeTestCreditStore,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresTelegramUserResolver,
  PostgresUserSessionStore,
  PostgresNotificationPreferenceStore,
  SystemIdGenerator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  RedisOwnedOpaqueTokenStore,
  RedisRateLimiter,
  type createRedisConnection,
} from '@nakh/queue-redis';
import {
  TelegramBotApiMenuClient,
  SignupNavigationTokens,
  signupRecord as record,
  type SignupNavigation as Nav,
} from '@nakh/telegram';

function denied(): never {
  throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
}
function uuid(value: string): string {
  const b = createHash('sha256').update(value).digest().subarray(0, 16);
  b[6] = (b[6]! & 15) | 0x50;
  b[8] = (b[8]! & 63) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export interface TelegramAccountRuntimePort {
  readonly enabled: boolean;
  readonly supportEnabled?: boolean;
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
  open(recipient: string, actor: UserSessionActor): Promise<void>;
  openSupport?(recipient: string, actor: UserSessionActor): Promise<void>;
  openCredits?(recipient: string, actor: UserSessionActor): Promise<void>;
}
/** Only public menu choices are cached; the ledger owns each repeatable grant. */
export class TelegramAccountRuntime implements TelegramAccountRuntimePort {
  public readonly enabled = true;
  public get supportEnabled(): boolean {
    return this.config.telegram.supportAppealEnabled;
  }
  private readonly key: Buffer;
  private readonly users: PostgresTelegramUserResolver;
  private readonly sessions: PostgresUserSessionStore;
  private readonly identities: PostgresIdentityStore;
  private readonly localization: PostgresLocalizationStore;
  private readonly limiter: RedisRateLimiter;
  private readonly ids = new SystemIdGenerator();
  private readonly clock = new SystemClock();
  public constructor(
    private readonly config: AppConfig,
    private readonly database: NakhDatabase,
    private readonly financialDatabase: NakhDatabase,
    private readonly redis: ReturnType<typeof createRedisConnection>,
    private readonly botId: string,
    key: Uint8Array,
    private readonly client: TelegramBotApiMenuClient,
    private readonly home?: (recipient: string, actor: UserSessionActor) => Promise<void>,
    private readonly editProfile?: (recipient: string, actor: UserSessionActor) => Promise<void>,
    private readonly purchases?: TelegramStarsCheckoutPort,
  ) {
    this.key = Buffer.from(key);
    this.users = new PostgresTelegramUserResolver(database);
    this.sessions = new PostgresUserSessionStore(database);
    this.identities = new PostgresIdentityStore(database);
    this.localization = new PostgresLocalizationStore(database);
    this.limiter = new RedisRateLimiter(redis, config.redis.queuePrefix);
  }
  public async onModuleInit(): Promise<void> {
    if (
      !(await this.database
        .selectFrom('platform.schema_migrations')
        .select('name')
        .where('name', '=', '000166_m9_profile_settings_menus.sql')
        .executeTakeFirst())
    )
      throw new Error('Account menu schema unavailable.');
    const locales = await this.database
      .selectFrom('catalog.locales')
      .select('code')
      .where('is_active', '=', true)
      .execute();
    for (const locale of locales) {
      const catalog = await this.localization.loadActiveCatalog(locale.code);
      for (const [key, english] of Object.entries({ ...M9_ACCOUNT_TEXTS, ...M9_SETTINGS_TEXTS })) {
        const value = catalog.messages[key];
        const variables = (text: string): string =>
          [...new Set([...text.matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((m) => m[1]))]
            .sort()
            .join(',');
        if (
          typeof value !== 'string' ||
          value.trim() === '' ||
          variables(value) !== variables(english)
        )
          throw new Error('Account menu localization unavailable.');
      }
    }
  }
  private tokens(
    recipient: string,
    life: Readonly<{ userId: string; productEpoch: number }>,
  ): SignupNavigationTokens {
    return new SignupNavigationTokens(
      new RedisOwnedOpaqueTokenStore(this.redis, this.config.redis.queuePrefix, life),
      this.key,
      this.botId,
      recipient,
      life,
      Date.now,
      'account',
    );
  }
  private store(actor: UserSessionActor): PostgresFreeTestCreditStore {
    return new PostgresFreeTestCreditStore(
      this.financialDatabase,
      actor,
      this.config.telegram.freeTestTopupsEnabled
        ? { sourceSha: this.config.release, environment: 'staging', telegramBotId: this.botId }
        : undefined,
    );
  }
  private async current(recipient: string, actor: UserSessionActor): Promise<string> {
    const life = await this.users.resolveProductLife(recipient);
    if (
      life?.userId !== actor.userId ||
      life.productEpoch !== actor.productEpoch ||
      !(await this.sessions.current(actor, actor.sessionGrantId))
    )
      denied();
    const identity = await this.identities.getByUserId(actor.userId);
    if (!identity || !['active', 'restricted'].includes(identity.accountState)) denied();
    return identity.uiLocale;
  }
  private async render(
    recipient: string,
    actor: UserSessionActor,
    screen: 'settings' | 'credits' | 'locales' | 'notifications',
    notice?: string,
  ): Promise<void> {
    const locale = await this.current(recipient, actor),
      state = screen === 'credits' ? await this.store(actor).state() : undefined;
    const catalog = await this.localization.loadActiveCatalog(locale),
      renderer = new CatalogRenderer(
        { [catalog.resolvedLocale]: catalog.messages },
        catalog.resolvedLocale,
      );
    const t = (key: string, variables: Record<string, string | number> = {}): string =>
      renderer.render(catalog.resolvedLocale, { key, variables });
    const identity = await this.identities.getByUserId(actor.userId);
    if (!identity) denied();
    const preferences =
      screen === 'notifications'
        ? await new PostgresNotificationPreferenceStore(this.database, actor).read()
        : undefined;
    const version = preferences?.version ?? state?.version ?? identity.settingsVersion;
    const nav: Nav = {
      actor: Object.freeze({ ...actor }),
      version,
      screen,
      action: 'resume',
      group: randomBytes(12).toString('base64url'),
    };
    const tokens = this.tokens(recipient, actor);
    const button = async (
      key: string,
      action: Nav['action'],
      code?: string,
    ): Promise<{ text: string; callback_data: string }> => ({
      text: t(key),
      callback_data: await tokens.button({
        ...nav,
        version,
        action,
        ...(code === undefined ? {} : { code }),
      }),
    });
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    const text = [
      t(
        screen === 'settings'
          ? 'account.menu.title'
          : screen === 'credits'
            ? 'account.credits.title'
            : screen === 'locales'
              ? 'account.settings.language'
              : 'account.settings.notifications',
      ),
    ];
    if (state) text.push(t('account.credits.balance', { credits: state.balance }));
    if (notice !== undefined) text.push(t(notice));
    if (screen === 'settings') {
      text.push(t('account.settings.visibility_info'));
      keyboard.push([await button('account.credits.title', 'pick', 'credits')]);
      if (
        (
          await this.database
            .selectFrom('catalog.locales')
            .select('code')
            .where('is_active', '=', true)
            .limit(2)
            .execute()
        ).length > 1
      )
        keyboard.push([await button('account.settings.language', 'pick', 'locales')]);
      if (this.editProfile) keyboard.push([await button('profile.edit.title', 'edit_profile')]);
      keyboard.push([
        await button(
          identity.visibilityEnabled
            ? 'account.settings.visibility_on'
            : 'account.settings.visibility_off',
          'save',
          identity.visibilityEnabled ? 'visibility_off' : 'visibility_on',
        ),
      ]);
      keyboard.push([await button('account.settings.notifications', 'pick', 'notifications')]);
      if (this.config.telegram.supportAppealEnabled)
        keyboard.push([await button('account.menu.support', 'pick', 'support')]);
      if (this.config.deletion.telegramEnabled)
        keyboard.push([await button('account.menu.delete', 'pick', 'delete')]);
      keyboard.push([await button('account.menu.home', 'home')]);
    } else if (screen === 'locales') {
      text.push(t('account.settings.language'));
      for (const locale of await this.database
        .selectFrom('catalog.locales')
        .select(['code', 'native_name'])
        .where('is_active', '=', true)
        .orderBy('code')
        .execute())
        keyboard.push([
          {
            text: (locale.code === identity.uiLocale ? '✓ ' : '') + locale.native_name,
            callback_data: await tokens.button({
              ...nav,
              version,
              action: 'save',
              code: 'locale_' + locale.code,
            }),
          },
        ]);
      keyboard.push([await button('account.menu.back', 'resume')]);
    } else if (screen === 'notifications') {
      if (!preferences) denied();
      text.push(t('account.settings.notification_info'));
      for (const [kind, enabled] of [
        ['chat', preferences.chatEnabled],
        ['like', preferences.likeEnabled],
        ['nakh', preferences.nakhEnabled],
        ['match', preferences.matchEnabled],
      ] as const)
        keyboard.push([
          {
            text: t('account.settings.toggle', {
              label: t('account.settings.' + kind),
              state: t(enabled ? 'account.settings.on' : 'account.settings.off'),
            }),
            callback_data: await tokens.button({
              ...nav,
              version,
              action: 'save',
              code: `notify_${kind}_${enabled ? '0' : '1'}`,
            }),
          },
        ]);
      keyboard.push([await button('account.menu.back', 'resume')]);
    } else {
      if (!state) denied();
      if (this.config.telegram.freeTestTopupsEnabled && state.enabled) {
        text.push(t('account.credits.free_info'));
        keyboard.push([await button('account.credits.free_add', 'save', 'topup')]);
      } else if (this.purchases?.invoiceCreationEnabled) {
        keyboard.push([await button('purchase.packages', 'pick', 'stars_packages')]);
      } else text.push(t('account.credits.unavailable'));
      keyboard.push([await button('account.menu.back', 'resume')]);
    }
    await this.current(recipient, actor);
    await this.client.sendMenu(recipient, {
      text: text.join('\n\n'),
      replyMarkup: { inline_keyboard: keyboard },
    });
  }
  public async open(recipient: string, input: UserSessionActor): Promise<void> {
    const actor = Object.freeze({ ...input });
    await this.current(recipient, actor);
    await this.render(recipient, actor, 'settings');
  }
  public async openCredits(recipient: string, input: UserSessionActor): Promise<void> {
    const actor = Object.freeze({ ...input });
    await this.current(recipient, actor);
    await this.render(recipient, actor, 'credits');
  }
  public async openSupport(recipient: string, actor: UserSessionActor): Promise<void> {
    if (!this.config.telegram.supportAppealEnabled) denied();
    const locale = await this.current(recipient, actor);
    const catalog = await this.localization.loadActiveCatalog(locale);
    const renderer = new CatalogRenderer(
      { [catalog.resolvedLocale]: catalog.messages },
      catalog.resolvedLocale,
    );
    await this.current(recipient, actor);
    await this.client.sendMenu(recipient, {
      text: renderer.render(catalog.resolvedLocale, {
        key: 'account.menu.support_help',
        variables: {},
      }),
      replyMarkup: { inline_keyboard: [] },
    });
  }
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    if ((await this.purchases?.handleNavigation(update)) === 'notice') return 'notice';
    const root = record(structuredClone(update)),
      message = record(root?.message),
      callback = record(root?.callback_query);
    const command =
      typeof message?.text === 'string' && /^\/(settings|credits)$/u.test(message.text)
        ? message.text
        : undefined;
    const data =
      typeof callback?.data === 'string' && callback.data.startsWith('m9a:')
        ? callback.data
        : undefined;
    if (command === undefined && data === undefined) return 'unhandled';
    const from = record(callback?.from ?? message?.from),
      chat = record(callback === undefined ? message?.chat : record(callback.message)?.chat);
    const sender = from?.id,
      updateId = root?.update_id,
      bot = record(record(callback?.message)?.from);
    if (
      typeof sender !== 'number' ||
      !Number.isSafeInteger(sender) ||
      sender <= 0 ||
      from?.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== sender ||
      typeof updateId !== 'number' ||
      !Number.isSafeInteger(updateId) ||
      updateId < 0 ||
      (callback !== undefined && message !== undefined) ||
      (callback !== undefined &&
        (bot?.is_bot !== true ||
          String(bot.id) !== this.botId ||
          typeof callback.id !== 'string' ||
          callback.id.length < 1 ||
          callback.id.length > 128))
    )
      throw new ApplicationError('invalid_request', 'error.identity.user_context_invalid', 400);
    const recipient = String(sender),
      callbackId = callback === undefined ? undefined : String(callback.id);
    const resolved = await this.users.resolveProductLife(recipient);
    if (!resolved) denied();
    const life = Object.freeze({ userId: resolved.userId, productEpoch: resolved.productEpoch });
    let actor: UserSessionActor, nav: Nav | undefined;
    if (command !== undefined) {
      const grant = await this.sessions.issue(
        life,
        uuid(JSON.stringify(['account-entry', this.botId, recipient, life, updateId])),
      );
      if (!grant) denied();
      actor = Object.freeze({ kind: 'user', ...life, sessionGrantId: grant.id });
    } else {
      nav = await this.tokens(recipient, life).callback(data!);
      if (!nav) denied();
      actor = Object.freeze({ ...nav.actor });
    }
    await this.current(recipient, actor);
    const rate = await this.limiter.consume({
      scope: 'telegram_account_menu',
      subject: actor.userId,
      limit: 30,
      windowSeconds: 60,
    });
    if (!rate.allowed) throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429);
    try {
      if (nav?.action === 'pick' && nav.code === 'stars_packages' && nav.screen === 'credits') {
        if (!this.purchases?.invoiceCreationEnabled) denied();
        if (callbackId !== undefined) await this.client.answerCallback(callbackId);
        await this.purchases.openPackages(recipient, actor);
        return 'notice';
      }
      if (nav?.action === 'edit_profile') {
        if (!this.editProfile) denied();
        if (callbackId !== undefined) await this.client.answerCallback(callbackId);
        await this.editProfile(recipient, actor);
        return 'notice';
      }
      if (nav?.action === 'home') {
        if (callbackId !== undefined) await this.client.answerCallback(callbackId);
        if (this.home) await this.home(recipient, actor);
        else await this.render(recipient, actor, 'settings');
        return 'notice';
      }
      if (nav?.action === 'save' && nav.code !== undefined && nav.code !== 'topup') {
        if (nav.group === undefined) denied();
        const key = JSON.stringify([
          'account-setting',
          this.botId,
          actor.userId,
          actor.productEpoch,
          actor.sessionGrantId,
          nav.group,
          nav.code,
        ]);
        const base = {
          commandId: uuid(key),
          requestId: uuid(key + ':request'),
          schemaVersion: 1 as const,
          actor: { kind: 'user' as const, userId: actor.userId },
          idempotencyKey: createHash('sha256').update(key).digest('hex'),
          occurredAt: this.clock.now().toISOString(),
          locale: await this.current(recipient, actor),
        };
        let next: 'settings' | 'notifications' | 'locales' = 'settings';
        if (nav.code === 'visibility_on' || nav.code === 'visibility_off')
          await new ChangeSettingsHandler(
            new PostgresIdentityStore(this.database, actor),
            this.ids,
            this.clock,
          ).execute({
            ...base,
            commandType: 'identity.change-visibility',
            data: {
              expectedSettingsVersion: nav.version,
              visibilityEnabled: nav.code === 'visibility_on',
            },
          });
        else if (nav.code.startsWith('locale_')) {
          await new ChangeSettingsHandler(
            new PostgresIdentityStore(this.database, actor),
            this.ids,
            this.clock,
          ).execute({
            ...base,
            commandType: 'identity.change-locale',
            data: { expectedSettingsVersion: nav.version, locale: nav.code.slice(7) },
          });
          next = 'locales';
        } else {
          const match = /^notify_(chat|like|nakh|match)_([01])$/u.exec(nav.code);
          if (!match) denied();
          const kind = match[1];
          if (kind !== 'chat' && kind !== 'like' && kind !== 'nakh' && kind !== 'match') denied();
          await new ChangeNotificationPreferenceHandler(
            new PostgresNotificationPreferenceStore(this.database, actor),
            this.ids,
            this.clock,
          ).execute({
            ...base,
            commandType: 'notification.change-preference',
            data: { kind, enabled: match[2] === '1', expectedVersion: nav.version },
          });
          next = 'notifications';
        }
        if (callbackId !== undefined) await this.client.answerCallback(callbackId);
        await this.render(recipient, actor, next, 'account.settings.saved');
        return 'notice';
      }
      if (nav?.action === 'save' && nav.code === 'topup' && nav.screen === 'credits') {
        if (!this.config.telegram.freeTestTopupsEnabled || nav.group === undefined) denied();
        const key = JSON.stringify([
          'free-test-topup',
          this.botId,
          actor.userId,
          actor.productEpoch,
          nav.group,
        ]);
        await new GrantFreeTestCreditsHandler(this.store(actor), this.ids).execute({
          commandId: uuid(key),
          requestId: uuid(key + ':request'),
          commandType: 'billing.grant-free-test-credits',
          schemaVersion: 1,
          actor: { kind: 'user', userId: actor.userId },
          idempotencyKey: createHash('sha256').update(key).digest('hex'),
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: {},
        });
        if (callbackId !== undefined) await this.client.answerCallback(callbackId);
        await this.render(recipient, actor, 'credits', 'account.credits.added');
        return 'notice';
      }
      if (callbackId !== undefined) await this.client.answerCallback(callbackId);
      if (nav?.action === 'pick' && (nav.code === 'support' || nav.code === 'delete')) {
        const locale = await this.current(recipient, actor),
          catalog = await this.localization.loadActiveCatalog(locale);
        const renderer = new CatalogRenderer(
          { [catalog.resolvedLocale]: catalog.messages },
          catalog.resolvedLocale,
        );
        await this.current(recipient, actor);
        await this.client.sendMenu(recipient, {
          text: renderer.render(catalog.resolvedLocale, {
            key: nav.code === 'support' ? 'account.menu.support_help' : 'account.menu.delete_help',
            variables: {},
          }),
          replyMarkup: { inline_keyboard: [] },
        });
      } else
        await this.render(
          recipient,
          actor,
          command === '/credits' || (nav?.action === 'pick' && nav.code === 'credits')
            ? 'credits'
            : nav?.action === 'pick' && nav.code === 'locales'
              ? 'locales'
              : nav?.action === 'pick' && nav.code === 'notifications'
                ? 'notifications'
                : 'settings',
        );
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && (error.status === 400 || error.status === 409)) {
        await this.render(
          recipient,
          actor,
          'settings',
          error.status === 409 ? 'account.settings.changed' : 'account.settings.invalid',
        );
        return 'notice';
      }
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.billing.payment_unavailable', 500);
    }
  }
}
export function createTelegramAccountRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    financialDatabase: NakhDatabase;
    redis: ReturnType<typeof createRedisConnection>;
    resolveSecret?: (reference: string) => string;
    home?: (recipient: string, actor: UserSessionActor) => Promise<void>;
    editProfile?: (recipient: string, actor: UserSessionActor) => Promise<void>;
    purchases?: TelegramStarsCheckoutPort;
  }>,
): TelegramAccountRuntimePort {
  if (!input.config.telegram.accountMenuEnabled)
    return {
      enabled: false,
      handle: () => Promise.resolve('unhandled'),
      open: () =>
        Promise.reject(new ApplicationError('capability_denied', 'error.capability.denied', 403)),
    };
  const resolve = input.resolveSecret ?? resolveSecretReference,
    token = resolve(input.config.telegram.botTokenRef),
    match = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(token);
  const encoded = resolve(input.config.telegram.actionTokenKeyRef),
    key = Buffer.from(encoded, 'base64url');
  if (
    match === null ||
    !Number.isSafeInteger(Number(match[1])) ||
    key.byteLength !== 32 ||
    key.toString('base64url') !== encoded
  )
    throw new Error('Account menu credentials unavailable.');
  return new TelegramAccountRuntime(
    input.config,
    input.database,
    input.financialDatabase,
    input.redis,
    match[1]!,
    key,
    new TelegramBotApiMenuClient(token),
    input.home,
    input.editProfile,
    input.purchases,
  );
}
