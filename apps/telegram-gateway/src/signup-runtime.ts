import { createHash, randomBytes } from 'node:crypto';
import {
  ConfirmSignupHandler,
  SaveSignupStepHandler,
  SaveSignupOptionalDetailsHandler,
  StartSignupHandler,
  SendLikeHandler,
  MarkNotInterestedHandler,
  CreateDirectNakhHandler,
  CreatePendingNakhHandler,
  routeStart,
  type SaveSignupStepWrite,
  type SaveSignupOptionalDetailsWrite,
  type OpaqueTokenStore,
  type UserSessionActor,
} from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import type { AdministratorTelegramPort } from './admin-runtime.js';
import { ApplicationError, SystemClock, validateNakhText } from '@nakh/domain';
import {
  CatalogRenderer,
  M9_SIGNUP_TEXTS,
  M9_PREVIEW_TEXTS,
  M9_PROFILE_TEXTS,
  englishCatalogFromManifest,
  M5_LOCALIZATION_ENTRIES,
} from '@nakh/localization';
import { M1Metrics, M1_REASON_CODES, type M1HandlerOperation } from '@nakh/observability';
import {
  PostgresAccountControlSessionStore,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresSignupStore,
  PostgresProfileStore,
  PostgresSignupChoices,
  PostgresProfileMediaEligibility,
  PostgresTelegramUserResolver,
  PostgresUserSessionStore,
  PostgresInteractionStore,
  PostgresDirectNakhStore,
  PostgresPendingNakhStore,
  SystemIdGenerator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  RedisOwnedOpaqueTokenStore,
  RedisRateLimiter,
  type createRedisConnection,
} from '@nakh/queue-redis';
import { TelegramBotApiMenuClient, type TelegramFreshEntryNotice } from '@nakh/telegram';
import {
  SignupNavigationTokens,
  signupRecord as record,
  type SignupNavigation as Nav,
} from './signup-navigation.js';
import type { TelegramStartDeliveryNotice } from './start-delivery.js';
import type { TelegramStarsRuntimePort } from './stars-runtime.js';
import type { TelegramReportRuntimePort } from './report-runtime.js';
import {
  createGuestPreviewRuntime,
  createExploreDeliveryRuntime,
  type GuestPreviewRuntimePort,
} from './guest-preview-runtime.js';

type Value = SaveSignupStepWrite['command']['data']['value'];
type Edit = SaveSignupOptionalDetailsWrite['command']['data']['edit'];
const FIELDS = [
  'heightCm',
  'job',
  'educationLevelCode',
  'smokingPreferenceCode',
  'petsPreferenceCode',
  'exerciseFrequencyCode',
  'religionCode',
  'childrenPreferenceCode',
  'languageCodes',
  'personalityTagCodes',
  'bio',
] as const;
const CATEGORY: Readonly<Record<string, string>> = {
  educationLevelCode: 'education_level',
  smokingPreferenceCode: 'smoking_preference',
  petsPreferenceCode: 'pets_preference',
  exerciseFrequencyCode: 'exercise_frequency',
  religionCode: 'religion_importance',
  childrenPreferenceCode: 'children_preference',
};
function fieldKey(field: string): string {
  return 'signup.ui.' + field.replace(/[A-Z]/gu, (c) => '_' + c.toLowerCase());
}
function denied(): ApplicationError {
  return new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
}
function uuid(parts: readonly (string | number)[]): string {
  const b = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16);
  b[6] = (b[6]! & 15) | 0x50;
  b[8] = (b[8]! & 63) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export interface TelegramSignupRuntimePort {
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
  openStart?: (notice: TelegramStartDeliveryNotice) => Promise<void>;
  afterActivation?: (notice: TelegramFreshEntryNotice) => Promise<void>;
}

/** Thin transport composition. PostgreSQL owns answers, validation, versions,
 * capabilities and effects; Redis owns only signed short-lived navigation. */
export class TelegramSignupRuntime implements TelegramSignupRuntimePort {
  public async onModuleInit(): Promise<void> {
    const migration = await this.database
      .selectFrom('platform.schema_migrations')
      .select('name')
      .where('name', '=', '000152_m9_signup_presentation.sql')
      .executeTakeFirst();
    if (migration === undefined) throw new Error('Signup schema unavailable.');
    if (
      (this.previewDelivery !== undefined || this.exploreDelivery !== undefined) &&
      (await this.database
        .selectFrom('platform.schema_migrations')
        .select('name')
        .where('name', '=', '000156_m9_profile_detail_presentation.sql')
        .executeTakeFirst()) === undefined
    )
      throw new Error('Guest Preview schema unavailable.');
    const locales = await this.database
      .selectFrom('catalog.locales')
      .select('code')
      .where('is_active', '=', true)
      .execute();
    const variables = (text: string): string =>
      [...new Set([...text.matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((m) => m[1]))].sort().join(',');
    for (const locale of locales) {
      const catalog = await this.localization.loadActiveCatalog(locale.code);
      for (const [key, expected] of Object.entries({
        ...M9_SIGNUP_TEXTS,
        ...(this.previewDelivery === undefined && this.exploreDelivery === undefined
          ? {}
          : { ...M9_PREVIEW_TEXTS, ...M9_PROFILE_TEXTS }),
        ...(this.exploreDelivery === undefined
          ? {}
          : Object.fromEntries(
              [
                'explore.title',
                'explore.empty',
                'explore.button.like',
                'explore.button.not_interested',
                'interaction.like.sent',
                'interaction.not_interested.saved',
                'matching.match.created',
              ].map((key) => [key, englishCatalogFromManifest()[key]!]),
            )),
        ...(this.exploreDelivery === undefined
          ? {}
          : {
              ...Object.fromEntries(M5_LOCALIZATION_ENTRIES.map((e) => [e.key, e.english])),
              'error.billing.insufficient_credits': '',
            }),
      })) {
        const value = catalog.messages[key];
        if (
          typeof value !== 'string' ||
          value.trim() === '' ||
          variables(value) !== variables(expected)
        )
          throw new Error('Signup localization unavailable.');
      }
    }
  }
  private readonly identities: PostgresIdentityStore;
  private readonly users: PostgresTelegramUserResolver;
  private readonly sessions: PostgresUserSessionStore;
  private readonly localization: PostgresLocalizationStore;
  private readonly ids = new SystemIdGenerator();
  private readonly clock = new SystemClock();
  private readonly metrics = new M1Metrics();
  private async measured<T>(operation: M1HandlerOperation, call: () => Promise<T>): Promise<T> {
    const at = performance.now();
    try {
      const result = await call();
      this.metrics.recordHandler(
        operation,
        record(result)?.replayed === true ? 'replay' : 'success',
        performance.now() - at,
      );
      if (operation === 'signup_confirm' && record(result)?.replayed === false)
        this.metrics.recordSignup('completed');
      return result;
    } catch (error) {
      const reason =
        error instanceof ApplicationError
          ? (M1_REASON_CODES.find((r) => r === error.code) ?? 'invalid_request')
          : 'internal_error';
      this.metrics.recordHandler(
        operation,
        error instanceof ApplicationError && error.status < 500
          ? error.status === 409
            ? 'conflict'
            : 'denied'
          : 'failure',
        performance.now() - at,
        reason,
      );
      throw error;
    }
  }
  public constructor(
    private readonly database: NakhDatabase,
    private readonly redis: ReturnType<typeof createRedisConnection>,
    private readonly prefix: string,
    private readonly botId: string,
    private readonly key: Uint8Array,
    private readonly client: TelegramBotApiMenuClient,
    private readonly limiter: Pick<RedisRateLimiter, 'consume'>,
    private readonly navigationStore?: (
      life: Readonly<{ userId: string; productEpoch: number }>,
    ) => OpaqueTokenStore,
    private readonly previewDelivery?: GuestPreviewRuntimePort,
    private readonly exploreDelivery?: GuestPreviewRuntimePort,
    private readonly stars?: TelegramStarsRuntimePort,
    private readonly reports?: TelegramReportRuntimePort,
    private readonly administration?: Pick<AdministratorTelegramPort, 'link'>,
  ) {
    this.key = Buffer.from(key);
    this.stars?.assertSeparateNavigationKey?.(this.key);
    this.identities = new PostgresIdentityStore(database);
    this.users = new PostgresTelegramUserResolver(database);
    this.sessions = new PostgresUserSessionStore(database);
    this.localization = new PostgresLocalizationStore(database);
  }
  private tokens(
    telegramId: string,
    life: Readonly<{ userId: string; productEpoch: number }>,
  ): SignupNavigationTokens {
    return new SignupNavigationTokens(
      this.navigationStore?.(life) ?? new RedisOwnedOpaqueTokenStore(this.redis, this.prefix, life),
      this.key,
      this.botId,
      telegramId,
      life,
    );
  }
  private async current(actor: UserSessionActor, telegramId: string): Promise<void> {
    const life = await this.users.resolveProductLife(telegramId);
    if (
      life?.userId !== actor.userId ||
      life.productEpoch !== actor.productEpoch ||
      (await this.sessions.current(actor, actor.sessionGrantId)) === undefined
    )
      throw denied();
  }
  private envelope(
    actor: UserSessionActor,
    telegramId: string,
    updateId: number,
    purpose: string,
  ): {
    commandId: string;
    requestId: string;
    schemaVersion: 1;
    actor: { kind: 'user'; userId: string };
    occurredAt: string;
    locale: string;
    idempotencyKey: string;
    channelContext: { channel: 'telegram'; channelIdentityId: string };
  } {
    const id = uuid([
      'telegram-signup-v1',
      this.botId,
      telegramId,
      actor.userId,
      actor.productEpoch,
      updateId,
      purpose,
    ]);
    return {
      commandId: id,
      requestId: id,
      schemaVersion: 1,
      actor: { kind: 'user', userId: actor.userId },
      occurredAt: this.clock.now().toISOString(),
      locale: 'en',
      idempotencyKey: id,
      channelContext: { channel: 'telegram', channelIdentityId: telegramId },
    };
  }
  public readonly openStart = async (notice: TelegramStartDeliveryNotice): Promise<void> => {
    if (notice.context.accountState === 'deleted') {
      await this.notice(notice.telegramUserId, routeStart(notice.context.entryRoute).title.key);
      return;
    }
    // Later lives enter only through the separately verified M8 activation hook.
    if (notice.life.productEpoch !== 0) throw denied();
    await this.open(
      notice.telegramUserId,
      notice.life,
      uuid(['signup-primary', this.botId, notice.telegramUserId, notice.updateId]),
    );
  };
  public readonly afterActivation = async (notice: TelegramFreshEntryNotice): Promise<void> => {
    if (
      notice.notice.key !== 'entry.completed' ||
      notice.control === undefined ||
      notice.control.kind !== 'user' ||
      notice.control.scope !== 'account_control' ||
      notice.control.userId !== notice.userId ||
      notice.control.productEpoch !== notice.productEpoch ||
      (await new PostgresAccountControlSessionStore(this.database).current(
        notice.control,
        notice.control.controlGrantId,
      )) === undefined
    )
      throw denied();
    await this.open(notice.telegramUserId, notice, notice.control.controlGrantId);
  };
  private async open(
    telegramId: string,
    life: Readonly<{ userId: string; productEpoch: number }>,
    requestId: string,
  ): Promise<void> {
    const current = await this.users.resolveProductLife(telegramId);
    if (current?.userId !== life.userId || current.productEpoch !== life.productEpoch)
      throw denied();
    const grant = await this.sessions.issue(
      { userId: life.userId, productEpoch: life.productEpoch },
      requestId,
    );
    if (grant === undefined) throw denied();
    const actor: UserSessionActor = {
      kind: 'user',
      userId: life.userId,
      productEpoch: life.productEpoch,
      sessionGrantId: grant.id,
    };
    await this.render(telegramId, actor);
  }
  private async save(telegramId: string, updateId: number, nav: Nav, value: Value): Promise<void> {
    const store = new PostgresSignupStore(this.database, nav.actor);
    await this.measured('signup_step', () =>
      new SaveSignupStepHandler(store, this.ids, this.clock).execute({
        ...this.envelope(nav.actor, telegramId, updateId, 'step'),
        commandType: 'identity.save-signup-step',
        data: { expectedDraftVersion: nav.version, value },
      }),
    );
  }
  private async showPreview(telegramId: string, updateId: number, nav: Nav): Promise<void> {
    if (this.previewDelivery === undefined) {
      await this.render(telegramId, nav.actor);
      return;
    }
    const context = await new PostgresSignupChoices(this.database, nav.actor).context();
    const catalog = await this.localization.loadActiveCatalog(context.uiLocale);
    const renderer = new CatalogRenderer(
      { [catalog.resolvedLocale]: catalog.messages },
      catalog.resolvedLocale,
    );
    const render = (key: string, variables: Record<string, string | number> = {}): string =>
      renderer.render(catalog.resolvedLocale, { key, variables });
    const base: Nav = {
      actor: nav.actor,
      screen: 'preview',
      version: context.accountVersion,
      group: randomBytes(12).toString('base64url'),
      action: 'preview',
    };
    const tokens = this.tokens(telegramId, nav.actor);
    const keyboard = [
      [{ text: render('preview.ui.next'), callback_data: await tokens.button(base) }],
      [
        {
          text: render(
            context.accountState === 'guest' ? 'common.button.sign_up' : 'signup.ui.continue',
          ),
          callback_data: await tokens.button({
            ...base,
            action: context.accountState === 'guest' ? 'begin' : 'resume',
          }),
        },
      ],
    ];
    const result = await this.previewDelivery.show({
      actor: nav.actor,
      telegramUserId: telegramId,
      requestId: this.envelope(nav.actor, telegramId, updateId, 'preview').requestId,
      keyboard,
      render,
      ...(this.previewDelivery.detail === undefined
        ? {}
        : {
            detailButton: async (deliveryId: string) => ({
              text: render('profile.ui.more'),
              callback_data: await tokens.button({ ...base, action: 'detail', code: deliveryId }),
            }),
          }),
    });
    if (result !== 'sent')
      await this.notice(
        telegramId,
        result === 'empty'
          ? 'explore.empty'
          : result === 'delivered'
            ? 'preview.ui.handled'
            : result === 'failed'
              ? 'preview.ui.failed'
              : 'preview.ui.pending',
      );
  }
  private async exploreKeyboard(
    telegramId: string,
    nav: Nav,
    deliveryId: string,
    render: (key: string) => string,
    photoId?: string,
  ): Promise<Array<Array<{ text: string; callback_data: string }>>> {
    const tokens = this.tokens(telegramId, nav.actor);
    const button = async (
      key: string,
      action: Nav['action'],
      code?: string,
    ): Promise<{ text: string; callback_data: string }> => ({
      text: render(key),
      callback_data: await tokens.button({ ...nav, action, code }),
    });
    return [
      [
        await button('explore.button.like', 'like', deliveryId),
        await button('nakh.compose.title', 'nakh', deliveryId),
        await button('explore.button.not_interested', 'reject', deliveryId),
      ],
      [
        await button('profile.ui.more', 'detail', deliveryId),
        ...(this.reports?.enabled
          ? [
              {
                text: render('nakh.received.button.report'),
                callback_data: await this.reports.button(
                  nav.actor,
                  telegramId,
                  deliveryId,
                  photoId,
                ),
              },
            ]
          : []),
      ],
      [await button('signup.ui.next', 'explore'), await button('signup.ui.back', 'resume')],
    ];
  }
  private async showExplore(telegramId: string, updateId: number, nav: Nav): Promise<void> {
    if (this.exploreDelivery === undefined) throw denied();
    const context = await new PostgresSignupChoices(this.database, nav.actor).context();
    if (context.accountState !== 'active' || context.profileCompletion !== 'complete')
      throw denied();
    const catalog = await this.localization.loadActiveCatalog(context.uiLocale),
      renderer = new CatalogRenderer(
        { [catalog.resolvedLocale]: catalog.messages },
        catalog.resolvedLocale,
      );
    const render = (key: string, variables: Record<string, string | number> = {}): string =>
      renderer.render(catalog.resolvedLocale, { key, variables });
    const base: Nav = {
      actor: nav.actor,
      screen: 'explore',
      version: context.accountVersion,
      action: 'explore',
      group: randomBytes(12).toString('base64url'),
    };
    const result = await this.exploreDelivery.show({
      actor: nav.actor,
      telegramUserId: telegramId,
      requestId: this.envelope(nav.actor, telegramId, updateId, 'explore').requestId,
      keyboard: [],
      render,
      cardKeyboard: (deliveryId) => this.exploreKeyboard(telegramId, base, deliveryId, render),
    });
    if (result !== 'sent')
      await this.notice(
        telegramId,
        result === 'empty'
          ? 'explore.empty'
          : result === 'delivered'
            ? 'preview.ui.handled'
            : result === 'failed'
              ? 'preview.ui.failed'
              : 'preview.ui.pending',
      );
  }
  private async exploreInteraction(telegramId: string, updateId: number, nav: Nav): Promise<void> {
    if (this.exploreDelivery === undefined || nav.screen !== 'explore' || !nav.code) throw denied();
    // The server resolves the target; transport state carries only the original receipt.
    // The writer repeats the source/life/session checks under the native pair locks.
    const source = await this.database
      .selectFrom('discovery.candidate_deliveries')
      .select('target_user_id')
      .where('id', '=', nav.code)
      .where('viewer_user_id', '=', nav.actor.userId)
      .where('mode', '=', 'explore')
      .where('state', '=', 'delivered')
      .executeTakeFirst();
    if (source === undefined) throw denied();
    const store = new PostgresInteractionStore(this.database, nav.actor, nav.code),
      envelope = this.envelope(nav.actor, telegramId, updateId, 'explore-' + nav.action);
    const result =
      nav.action === 'like'
        ? await new SendLikeHandler(store, this.ids, this.clock).execute({
            ...envelope,
            commandType: 'interaction.send-like',
            data: { targetUserId: source.target_user_id },
          })
        : await new MarkNotInterestedHandler(store, this.ids, this.clock).execute({
            ...envelope,
            commandType: 'interaction.mark-not-interested',
            data: { targetUserId: source.target_user_id, source: 'explore' },
          });
    await this.notice(
      telegramId,
      result.outcome === 'matched'
        ? 'matching.match.created'
        : result.outcome === 'liked'
          ? 'interaction.like.sent'
          : 'interaction.not_interested.saved',
    );
    await this.showExplore(telegramId, updateId, nav);
  }
  private async nakhTarget(nav: Nav): Promise<string> {
    if (this.exploreDelivery === undefined || typeof nav.code !== 'string') throw denied();
    const source = await this.database
      .selectFrom('discovery.candidate_deliveries')
      .select('target_user_id')
      .where('id', '=', nav.code)
      .where('viewer_user_id', '=', nav.actor.userId)
      .where('mode', '=', 'explore')
      .where('state', '=', 'delivered')
      .executeTakeFirst();
    if (source === undefined) throw denied();
    return source.target_user_id;
  }
  private async openNakh(telegramId: string, nav: Nav): Promise<void> {
    await this.nakhTarget(nav);
    const context = await new PostgresSignupChoices(this.database, nav.actor).context(),
      catalog = await this.localization.loadActiveCatalog(context.uiLocale),
      renderer = new CatalogRenderer(
        { [catalog.resolvedLocale]: catalog.messages },
        catalog.resolvedLocale,
      );
    const t = (key: string): string =>
      renderer.render(catalog.resolvedLocale, { key, variables: {} });
    const tokens = this.tokens(telegramId, nav.actor);
    await this.current(nav.actor, telegramId);
    if (nav.action === 'nakh') {
      const base: Nav = { ...nav, screen: 'nakh', group: randomBytes(12).toString('base64url') };
      const keyboard = await Promise.all(
        (
          [
            ['nakh.button.send_credits', 'nakh_credits'],
            ...(this.stars?.enabled ? [['nakh.button.pay_stars', 'nakh_stars'] as const] : []),
            ['nakh.button.save_pending', 'nakh_pending'],
            ['signup.ui.back', 'resume'],
          ] as const
        ).map(async ([label, action]) => [
          { text: t(label), callback_data: await tokens.button({ ...base, action }) },
        ]),
      );
      await this.current(nav.actor, telegramId);
      await this.client.sendMenu(telegramId, {
        text: [
          t('nakh.compose.title'),
          t('nakh.compose.cost.credits'),
          t('nakh.compose.cost.stars'),
          t('nakh.compose.auto_settle_consent'),
        ].join('\n'),
        replyMarkup: { inline_keyboard: keyboard },
      });
      return;
    }
    const screen = nav.action === 'reply' ? nav.screen : nav.action;
    if (screen !== 'nakh_credits' && screen !== 'nakh_pending' && screen !== 'nakh_stars')
      throw denied();
    if (screen === 'nakh_stars' && !this.stars?.enabled) throw denied();
    const prompt = await this.client.sendPrompt(
      telegramId,
      [
        t('nakh.compose.title'),
        t(screen === 'nakh_credits' ? 'nakh.compose.cost.credits' : 'nakh.compose.cost.stars'),
        ...(screen !== 'nakh_credits' ? [t('nakh.compose.auto_settle_consent')] : []),
        t('nakh.compose.prompt'),
        t('signup.ui.reply'),
      ].join('\n'),
    );
    await this.current(nav.actor, telegramId);
    await tokens.prompt(prompt, {
      ...nav,
      screen,
      action: 'reply',
      group: nav.action === 'reply' ? nav.group : randomBytes(12).toString('base64url'),
    });
  }
  private async sendNakh(
    telegramId: string,
    updateId: number,
    nav: Nav,
    text: string,
  ): Promise<void> {
    const targetUserId = await this.nakhTarget(nav),
      envelope = this.envelope(nav.actor, telegramId, updateId, nav.screen);
    if (nav.screen === 'nakh_credits') {
      await new CreateDirectNakhHandler(
        new PostgresDirectNakhStore(this.database, nav.actor, nav.code),
        this.ids,
      ).execute({ ...envelope, commandType: 'nakh.create-direct', data: { targetUserId, text } });
      await this.notice(telegramId, 'nakh.delivery.sent');
    } else if (nav.screen === 'nakh_pending' || nav.screen === 'nakh_stars') {
      const pending = await new CreatePendingNakhHandler(
        new PostgresPendingNakhStore(this.database, nav.actor, nav.code),
        this.ids,
      ).execute({
        ...envelope,
        commandType: 'nakh.create-pending',
        data: { targetUserId, text, autoSettleAuthorized: true },
      });
      await this.notice(telegramId, 'nakh.pending.created');
      if (nav.screen === 'nakh_stars') {
        if (!this.stars?.enabled) throw denied();
        await this.stars.invoice({
          ...envelope,
          actor: nav.actor,
          telegramUserId: telegramId,
          fundingIntentId: pending.fundingIntentId,
          expectedVersion: 1,
        });
      }
    } else throw denied();
    await this.showExplore(telegramId, updateId, nav);
  }
  private async showDetail(telegramId: string, nav: Nav): Promise<void> {
    const delivery = nav.screen === 'explore' ? this.exploreDelivery : this.previewDelivery;
    if (
      !delivery?.detail ||
      !['preview', 'explore'].includes(nav.screen) ||
      typeof nav.code !== 'string'
    )
      throw denied();
    const context = await new PostgresSignupChoices(this.database, nav.actor).context();
    const catalog = await this.localization.loadActiveCatalog(context.uiLocale);
    const renderer = new CatalogRenderer(
      { [catalog.resolvedLocale]: catalog.messages },
      catalog.resolvedLocale,
    );
    const render = (key: string, variables: Record<string, string | number> = {}): string =>
      renderer.render(catalog.resolvedLocale, { key, variables });
    const tokens = this.tokens(telegramId, nav.actor),
      base: Nav = {
        actor: nav.actor,
        screen: 'preview',
        version: context.accountVersion,
        action: 'preview',
        group: randomBytes(12).toString('base64url'),
      };
    const keyboard =
      nav.screen === 'explore'
        ? await this.exploreKeyboard(telegramId, nav, nav.code, render)
        : [
            [{ text: render('preview.ui.next'), callback_data: await tokens.button(base) }],
            [
              {
                text: render(
                  context.accountState === 'guest' ? 'common.button.sign_up' : 'signup.ui.continue',
                ),
                callback_data: await tokens.button({
                  ...base,
                  action: context.accountState === 'guest' ? 'begin' : 'resume',
                }),
              },
            ],
          ];
    await delivery.detail({
      actor: nav.actor,
      telegramUserId: telegramId,
      deliveryId: nav.code,
      keyboard,
      ...(nav.screen === 'explore' && this.reports?.enabled
        ? {
            photoKeyboard: (photoId: string) =>
              this.exploreKeyboard(telegramId, nav, nav.code!, render, photoId),
          }
        : {}),
      render,
      sendText: async (text) => {
        await this.client.sendMenu(telegramId, {
          text,
          replyMarkup: { inline_keyboard: keyboard },
        });
      },
    });
  }
  private async optional(
    telegramId: string,
    updateId: number,
    nav: Nav,
    edit: Edit,
  ): Promise<void> {
    await this.measured('signup_step', () =>
      new SaveSignupOptionalDetailsHandler(
        new PostgresSignupStore(this.database, nav.actor),
        this.ids,
        this.clock,
      ).execute({
        ...this.envelope(nav.actor, telegramId, updateId, 'optional'),
        commandType: 'identity.save-signup-optional-details',
        data: { expectedDraftVersion: nav.version, edit },
      }),
    );
  }
  private multi(nav: Nav): boolean {
    return (
      nav.screen === 'interests' ||
      nav.screen === 'additional_photos' ||
      nav.field === 'languageCodes' ||
      nav.field === 'personalityTagCodes'
    );
  }
  private next(nav: Nav): Nav {
    if (nav.action === 'page') return { ...nav, action: 'resume', page: Number(nav.code) };
    if (nav.action === 'optional')
      return { ...nav, action: 'resume', field: nav.code, selection: undefined, page: 0 };
    if (nav.action !== 'pick') return nav;
    if (this.multi(nav)) {
      const values = new Set(nav.selection ?? []),
        code = nav.code!;
      if (values.has(code)) values.delete(code);
      else values.add(code);
      if (values.size > 20)
        throw new ApplicationError('invalid_request', 'error.signup.step.invalid', 400);
      return { ...nav, action: 'resume', selection: [...values] };
    }
    if (nav.screen === 'location' && (nav.field === undefined || nav.field === 'country'))
      return { ...nav, action: 'resume', field: 'province', country: nav.code, page: 0 };
    if (nav.screen === 'location' && nav.field === 'province')
      return { ...nav, action: 'resume', field: 'city', province: nav.code, page: 0 };
    return nav;
  }
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const root = record(update),
      callback = record(root?.callback_query),
      message = record(callback?.message ?? root?.message),
      text = message?.text,
      data = callback?.data;
    if (
      callback === undefined &&
      (typeof text !== 'string' ||
        text.startsWith('/') ||
        record(message?.reply_to_message) === undefined)
    )
      return 'unhandled';
    if (callback !== undefined && !(typeof data === 'string' && data.startsWith('m9s:')))
      return 'unhandled';
    const from = record(callback?.from ?? message?.from),
      chat = record(message?.chat),
      sender = from?.id,
      origin = record(message?.from),
      reply = record(message?.reply_to_message),
      replyFrom = record(reply?.from),
      replyChat = record(reply?.chat);
    const updateId = root?.update_id;
    if (
      typeof updateId !== 'number' ||
      !Number.isSafeInteger(updateId) ||
      updateId < 0 ||
      typeof sender !== 'number' ||
      !Number.isSafeInteger(sender) ||
      sender <= 0 ||
      from?.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== sender ||
      (callback !== undefined && root?.message !== undefined) ||
      (callback !== undefined &&
        (origin?.is_bot !== true ||
          String(origin.id) !== this.botId ||
          typeof callback.id !== 'string' ||
          callback.id.length < 1 ||
          callback.id.length > 128 ||
          !Number.isSafeInteger(message?.message_id) ||
          Number(message?.message_id) <= 0)) ||
      (callback === undefined &&
        (typeof text !== 'string' ||
          text.length > 4096 ||
          replyFrom?.is_bot !== true ||
          String(replyFrom.id) !== this.botId ||
          replyChat?.type !== 'private' ||
          replyChat.id !== sender ||
          typeof reply?.message_id !== 'number' ||
          !Number.isSafeInteger(reply.message_id) ||
          reply.message_id < 1))
    )
      throw new ApplicationError('invalid_request', 'error.signup.step.invalid', 400);
    if (callback !== undefined) {
      try {
        await this.client.answerCallback(String(callback.id));
      } catch {
        this.metrics.recordHandler('signup_step', 'failure', 0, 'dependency_unavailable');
      }
    }
    const telegramId = String(sender),
      life = await this.users.resolveProductLife(telegramId);
    if (life === undefined) {
      if (callback !== undefined) return 'notice';
      return 'unhandled';
    }
    const admission = await this.limiter.consume({
      scope: 'signup_write',
      subject: life.userId,
      limit: 120,
      windowSeconds: 60,
    });
    if (!admission.allowed) {
      this.metrics.recordHandler('signup_step', 'denied', 0, 'rate_limited');
      await this.notice(telegramId, 'error.rate_limit.exceeded');
      return 'notice';
    }
    const tokens = this.tokens(telegramId, life);
    const nav =
      callback === undefined
        ? await tokens.reply(Number(reply?.message_id))
        : await tokens.callback(String(data));
    if (nav === undefined) {
      if (callback === undefined) return 'unhandled';
      await new PostgresSignupStore(this.database).recordNavigationDenial(
        life.userId,
        life.productEpoch,
        uuid(['signup-invalid', this.botId, life.userId, life.productEpoch, updateId]),
      );
      await this.notice(telegramId, 'signup.ui.expired');
      return 'notice';
    }
    try {
      await this.current(nav.actor, telegramId);
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.status !== 401) throw error;
      this.metrics.recordHandler('signup_step', 'denied', 0, 'unauthorized');
      await this.notice(telegramId, 'signup.ui.expired');
      return 'notice';
    }
    try {
      if (callback !== undefined) {
        await this.current(nav.actor, telegramId);
        if (nav.action === 'detail') {
          await this.showDetail(telegramId, nav);
          return 'notice';
        }
        const next = this.next(nav),
          claim = await tokens.claim(nav, updateId, String(data), next);
        if (!claim.accepted) {
          await this.render(telegramId, nav.actor, claim.next);
          return 'notice';
        }
        if (nav.action === 'preview') {
          await this.showPreview(telegramId, updateId, nav);
          return 'notice';
        }
        if (nav.action === 'explore') {
          await this.showExplore(telegramId, updateId, nav);
          return 'notice';
        }
        if (nav.action === 'like' || nav.action === 'reject') {
          await this.exploreInteraction(telegramId, updateId, nav);
          return 'notice';
        }
        if (['nakh', 'nakh_credits', 'nakh_pending', 'nakh_stars'].includes(nav.action)) {
          await this.openNakh(telegramId, nav);
          return 'notice';
        }
        if (nav.action === 'begin')
          await this.measured('signup_start', () =>
            new StartSignupHandler(
              new PostgresSignupStore(this.database, nav.actor),
              this.ids,
              this.clock,
            ).execute({
              ...this.envelope(nav.actor, telegramId, updateId, 'begin'),
              commandType: 'identity.start-signup',
              data: { expectedAccountVersion: nav.version },
            }),
          );
        else if (nav.action === 'finish')
          await this.measured('signup_confirm', () =>
            new ConfirmSignupHandler(
              new PostgresProfileStore(this.database, nav.actor),
              new PostgresProfileMediaEligibility(this.database, this.ids),
              this.ids,
              this.clock,
            ).execute({
              ...this.envelope(nav.actor, telegramId, updateId, 'confirm'),
              commandType: 'identity.confirm-signup',
              data: { expectedDraftVersion: nav.version },
            }),
          );
        else if (nav.action === 'clear' && nav.field !== undefined)
          await this.optional(telegramId, updateId, nav, { field: nav.field, clear: true } as Edit);
        else if (
          nav.action === 'pick' &&
          !this.multi(nav) &&
          !(nav.screen === 'location' && nav.field !== 'city')
        ) {
          if (nav.screen === 'optional_details' && nav.field !== undefined)
            await this.optional(telegramId, updateId, nav, {
              field: nav.field,
              value: nav.code,
            } as Edit);
          else if (nav.screen === 'age_confirmation')
            await this.save(telegramId, updateId, nav, {
              step: 'age_confirmation',
              accepted: true,
            });
          else if (
            nav.screen === 'gender' ||
            nav.screen === 'relationship_gender_preference' ||
            nav.screen === 'relationship_goal'
          )
            await this.save(telegramId, updateId, nav, { step: nav.screen, code: nav.code! });
          else if (nav.screen === 'location')
            await this.save(telegramId, updateId, nav, {
              step: 'location',
              countryCode: nav.country!,
              provinceCode: nav.province!,
              cityCode: nav.code!,
            });
          else if (nav.screen === 'primary_photo')
            await this.save(telegramId, updateId, nav, {
              step: 'primary_photo',
              mediaAssetId: nav.code!,
            });
        } else if (nav.action === 'save') {
          if (nav.screen === 'interests')
            await this.save(telegramId, updateId, nav, {
              step: 'interests',
              codes: [...(nav.selection ?? [])],
            });
          else if (nav.screen === 'additional_photos')
            await this.save(telegramId, updateId, nav, {
              step: 'additional_photos',
              mediaAssetIds: [...(nav.selection ?? [])],
            });
          else if (nav.field === 'languageCodes' || nav.field === 'personalityTagCodes')
            await this.optional(
              telegramId,
              updateId,
              nav,
              nav.field === 'languageCodes'
                ? { field: 'languageCodes', value: [...(nav.selection ?? [])] }
                : { field: 'personalityTagCodes', value: [...(nav.selection ?? [])] },
            );
          else if (nav.screen === 'optional_details') {
            const current = await new PostgresSignupStore(this.database, nav.actor).getSignupState(
              nav.actor.userId,
            );
            if (
              current?.currentStep !== 'optional_details' ||
              current.draftVersion !== nav.version
            ) {
              await this.render(telegramId, nav.actor);
              return 'notice';
            }
            const draft = await new PostgresSignupStore(this.database, nav.actor).getUiDraft(
              nav.actor.userId,
            );
            await this.save(telegramId, updateId, nav, {
              step: 'optional_details',
              value: record(record(draft.optional_details)?.value) ?? {},
            });
          }
        }
        await this.render(telegramId, nav.actor, next);
      } else {
        const value = String(text);
        if (
          nav.screen === 'nakh_credits' ||
          nav.screen === 'nakh_pending' ||
          nav.screen === 'nakh_stars'
        ) {
          validateNakhText(value);
          const claim = await tokens.claim(
            nav,
            updateId,
            tokens.replyId(Number(reply?.message_id)),
            nav,
          );
          if (!claim.accepted) {
            await this.render(telegramId, nav.actor);
            return 'notice';
          }
          await this.sendNakh(telegramId, updateId, nav, value);
          return 'notice';
        }
        if (nav.screen === 'name' || nav.screen === 'birth_year' || nav.screen === 'highlight')
          await this.save(telegramId, updateId, nav, { step: nav.screen, value });
        else if (
          nav.screen === 'optional_details' &&
          (nav.field === 'heightCm' || nav.field === 'job' || nav.field === 'bio')
        ) {
          const digits = value
            .trim()
            .replace(/[۰-۹]/gu, (d) => String(d.charCodeAt(0) - 1776))
            .replace(/[٠-٩]/gu, (d) => String(d.charCodeAt(0) - 1632));
          const normalized = nav.field === 'heightCm' ? Number(digits) : value;
          if (
            nav.field === 'heightCm' &&
            (!/^\d{3}$/u.test(digits) || !Number.isInteger(normalized))
          )
            throw new ApplicationError(
              'invalid_request',
              'error.signup.optional_details.invalid',
              400,
            );
          await this.optional(telegramId, updateId, nav, {
            field: nav.field,
            value: normalized,
          } as Edit);
        } else throw new ApplicationError('invalid_request', 'error.signup.step.invalid', 400);
        await this.render(telegramId, nav.actor);
      }
      return 'notice';
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.status >= 500)
        throw new ApplicationError('internal_error', 'error.identity.user_context_invalid', 500);
      if (
        (nav.screen === 'nakh_credits' ||
          nav.screen === 'nakh_pending' ||
          nav.screen === 'nakh_stars') &&
        error.code === 'nakh_text_invalid'
      ) {
        await this.notice(telegramId, 'error.nakh.text_invalid');
        await this.openNakh(telegramId, nav);
        return 'notice';
      }
      if (nav.screen === 'nakh_credits' && error.code === 'insufficient_credits') {
        await this.notice(telegramId, 'error.billing.insufficient_credits');
        await this.openNakh(telegramId, { ...nav, action: 'nakh' });
        return 'notice';
      }
      if (nav.action === 'preview' && error.code === 'guest_preview_limit_reached') {
        await this.render(telegramId, nav.actor, undefined, 'explore.guest.limit_reached');
        return 'notice';
      }
      if (error.status === 401 || error.status === 403 || error.status === 429) {
        await this.notice(telegramId, 'signup.ui.expired');
        return 'notice';
      }
      await this.render(telegramId, nav.actor, undefined, 'signup.ui.invalid');
      return 'notice';
    }
  }
  private async notice(telegramId: string, key: string): Promise<void> {
    const context = await this.identities.getByTelegramUserId(telegramId);
    if (context === undefined) throw denied();
    const catalog = await this.localization.loadActiveCatalog(context.uiLocale),
      renderer = new CatalogRenderer(
        { [catalog.resolvedLocale]: catalog.messages },
        catalog.resolvedLocale,
      );
    await this.client.sendMenu(telegramId, {
      text: renderer.render(catalog.resolvedLocale, { key, variables: {} }),
      replyMarkup: { inline_keyboard: [] },
    });
  }
  private async render(
    telegramId: string,
    actor: UserSessionActor,
    prior?: Nav,
    errorKey?: string,
  ): Promise<void> {
    await this.current(actor, telegramId);
    const projection = new PostgresSignupChoices(this.database, actor);
    const context = await projection.context();
    const catalog = await this.localization.loadActiveCatalog(context.uiLocale),
      renderer = new CatalogRenderer(
        { [catalog.resolvedLocale]: catalog.messages },
        catalog.resolvedLocale,
      );
    const t = (key: string, variables: Record<string, string | number> = {}): string =>
      renderer.render(catalog.resolvedLocale, { key, variables });
    const store = new PostgresSignupStore(this.database, actor),
      state =
        context.accountState === 'incomplete'
          ? await store.getSignupState(actor.userId)
          : undefined;
    const screen = state?.currentStep ?? 'root',
      version = state?.draftVersion ?? context.accountVersion;
    let nav: Nav = {
      ...(prior?.version === version && prior.screen === screen ? prior : {}),
      actor,
      screen,
      version,
      action: 'resume',
      group: randomBytes(12).toString('base64url'),
    };
    const tokens = this.tokens(telegramId, actor),
      keyboard: Array<
        Array<{ text: string; callback_data: string } | { text: string; url: string }>
      > = [];
    const button = async (label: string, change: Partial<Nav>): Promise<void> => {
      keyboard.push([
        {
          text: Array.from(label).slice(0, 64).join(''),
          callback_data: await tokens.button({ ...nav, ...change }),
        },
      ]);
    };
    let text =
      screen === 'root'
        ? t(routeStart(context.entryRoute).title.key)
        : t(`signup.${screen}.prompt`);
    let prompt = false;
    const choices =
      screen === 'root' ? undefined : await new PostgresSignupChoices(this.database, actor).list();
    const draft = screen === 'root' ? {} : await store.getUiDraft(actor.userId);
    const savedOptional = record(record(draft.optional_details)?.value) ?? {};
    if (
      nav.screen === 'optional_details' &&
      nav.field !== undefined &&
      this.multi(nav) &&
      nav.selection === undefined
    ) {
      const selected = savedOptional[nav.field];
      if (Array.isArray(selected) && selected.every((v: unknown) => typeof v === 'string'))
        nav = { ...nav, selection: selected };
    }
    if (screen === 'root') {
      const administratorLink = await this.administration?.link(actor, context.uiLocale);
      if (administratorLink !== undefined)
        keyboard.push([{ text: t('admin.auth.open'), url: administratorLink }]);
      if (
        context.accountState === 'active' &&
        context.profileCompletion === 'complete' &&
        this.exploreDelivery !== undefined
      )
        await button(t('explore.title'), { action: 'explore' });
      if (context.accountState === 'guest')
        await button(t('common.button.sign_up'), { action: 'begin' });
      if (
        context.accountState === 'guest' &&
        this.previewDelivery !== undefined &&
        context.guestPreviewCount < context.guestPreviewLimit
      )
        await button(t('common.button.guest_preview'), { action: 'preview' });
    } else if (screen === 'name' || screen === 'birth_year' || screen === 'highlight')
      prompt = true;
    else if (screen === 'age_confirmation')
      await button(t('signup.ui.confirm_age'), { action: 'pick', code: 'yes' });
    else if (screen === 'optional_details' && nav.field === undefined) {
      const optional = record(record(draft.optional_details)?.value) ?? {};
      for (const field of FIELDS)
        await button(`${Object.hasOwn(optional, field) ? '✓ ' : ''}${t(fieldKey(field))}`, {
          action: 'optional',
          code: field,
        });
      await button(t('signup.ui.continue'), { action: 'save' });
    } else if (screen === 'confirm_profile') {
      const entry = (key: string): Record<string, unknown> => record(draft[key]) ?? {};
      const label = (kind: string, code: unknown): string => {
        const c = choices?.catalogs[kind]?.find((x) => x.code === code);
        return c === undefined ? '' : t(c.labelKey);
      };
      const optional = record(entry('optional_details').value) ?? {};
      const optionalText = FIELDS.filter((f) => Object.hasOwn(optional, f))
        .map((field) => {
          const value = optional[field];
          const kind = CATEGORY[field] ?? field;
          return `${t(fieldKey(field))}: ${Array.isArray(value) ? value.map((v: unknown) => label(kind, v)).join(', ') : CATEGORY[field] !== undefined ? label(kind, value) : String(value)}`;
        })
        .join('\n');
      text +=
        '\n' +
        t('signup.ui.review', {
          name: String(entry('name').value),
          year: String(entry('birth_year').value),
          gender: label('gender', entry('gender').code),
          preference: label(
            'relationship_gender_preference',
            entry('relationship_gender_preference').code,
          ),
          interests: (entry('interests').codes as string[])
            .map((v) => label('interests', v))
            .join(', '),
          location: [
            label('country', entry('location').countryCode),
            label('province', entry('location').provinceCode),
            label('city', entry('location').cityCode),
          ].join(' / '),
          goal: label('relationship_goal', entry('relationship_goal').code),
          highlight: String(entry('highlight').value),
          optional: optionalText,
          photos: 1 + (entry('additional_photos').mediaAssetIds as string[]).length,
        });
      await button(t('signup.ui.confirm'), { action: 'finish' });
    } else {
      const field = nav.field,
        optional = screen === 'optional_details';
      if (optional && field !== undefined) text = t(fieldKey(field));
      if (optional && (field === 'heightCm' || field === 'job' || field === 'bio')) prompt = true;
      else {
        let list =
          choices?.catalogs[optional ? (CATEGORY[field ?? ''] ?? field ?? '') : screen] ?? [];
        if (screen === 'location') {
          const kind = field ?? 'country';
          list = choices?.catalogs[kind] ?? [];
          if (kind === 'province') list = list.filter((c) => c.parent === nav.country);
          if (kind === 'city')
            list = list.filter((c) => c.parent === `${nav.country}/${nav.province}`);
        }
        if (screen === 'primary_photo' || screen === 'additional_photos') {
          const primary = record(draft.primary_photo)?.mediaAssetId;
          const photos = choices?.photos ?? [];
          list = photos
            .filter((id) => screen !== 'additional_photos' || id !== primary)
            .map((code) => ({ code, labelKey: 'signup.ui.photo' }));
          text += '\n' + t('signup.ui.photos');
        }
        const page = nav.page ?? 0,
          visible = list.slice(page * 8, page * 8 + 8);
        for (const item of visible) {
          const label =
            item.labelKey === 'signup.ui.photo'
              ? t(item.labelKey, { position: (choices?.photos.indexOf(item.code) ?? 0) + 1 })
              : t(item.labelKey);
          await button(
            `${nav.selection?.includes(item.code) || (screen === 'optional_details' && nav.field !== undefined && savedOptional[nav.field] === item.code) ? '✓ ' : ''}${label}`,
            {
              action: 'pick',
              code: item.code,
            },
          );
        }
        if (page > 0) await button(t('signup.ui.back'), { action: 'page', code: String(page - 1) });
        if (list.length > (page + 1) * 8)
          await button(t('signup.ui.next'), { action: 'page', code: String(page + 1) });
        if (this.multi(nav)) await button(t('signup.ui.continue'), { action: 'save' });
        if (screen === 'primary_photo' || screen === 'additional_photos')
          await button(t('signup.ui.refresh'), { action: 'resume' });
      }
      if (optional) {
        await button(t('signup.ui.remove'), { action: 'clear' });
        await button(t('signup.ui.back'), {
          action: 'resume',
          field: undefined,
          selection: undefined,
          page: 0,
        });
      }
    }
    if (errorKey !== undefined) text = t(errorKey) + '\n' + text;
    if (
      context.accountState === 'incomplete' &&
      this.previewDelivery !== undefined &&
      context.guestPreviewCount < context.guestPreviewLimit
    )
      await button(t('common.button.guest_preview'), { action: 'preview' });
    const checkpoint = async (): Promise<void> => {
      await this.current(actor, telegramId);
      const fresh = await projection.context(),
        latest = state === undefined ? undefined : await store.getSignupState(actor.userId);
      if (
        fresh?.accountVersion !== context.accountVersion ||
        fresh.settingsVersion !== context.settingsVersion ||
        fresh.profileVersion !== context.profileVersion ||
        latest?.draftVersion !== state?.draftVersion ||
        latest?.currentStep !== state?.currentStep
      )
        throw denied();
    };
    await checkpoint();
    if (screen === 'confirm_profile' && text.length > 4096) {
      const parts: string[] = [];
      let part = '';
      for (const character of text) {
        if (part.length + character.length > 3500) {
          parts.push(part);
          part = '';
        }
        part += character;
      }
      parts.push(part);
      for (const previous of parts.slice(0, -1)) {
        await this.client.sendMenu(telegramId, {
          text: previous,
          replyMarkup: { inline_keyboard: [] },
        });
        await checkpoint();
      }
      text = parts.at(-1)!;
    }
    if (text.length > 4096 || text.length < 1)
      throw new ApplicationError('internal_error', 'error.identity.user_context_invalid', 500);
    if (prompt) {
      if (keyboard.length > 0) {
        await this.client.sendMenu(telegramId, {
          text,
          replyMarkup: { inline_keyboard: keyboard },
        });
        await checkpoint();
      }
      const id = await this.client.sendPrompt(telegramId, text + '\n' + t('signup.ui.reply'));
      await checkpoint();
      await tokens.prompt(id, { ...nav, action: 'reply' });
    } else
      await this.client.sendMenu(telegramId, { text, replyMarkup: { inline_keyboard: keyboard } });
  }
}

export function createTelegramSignupRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    redis: ReturnType<typeof createRedisConnection>;
    resolveSecret?: (reference: string) => string;
    stars?: TelegramStarsRuntimePort;
    reports?: TelegramReportRuntimePort;
    administration?: Pick<AdministratorTelegramPort, 'link'>;
  }>,
): TelegramSignupRuntimePort {
  if (!input.config.telegram.signupEnabled) return { handle: () => Promise.resolve('unhandled') };
  if (input.config.telegram.starsEnabled && !input.stars?.enabled)
    throw new Error('Stars composition unavailable.');
  if (input.config.telegram.reportsEnabled && !input.reports?.enabled)
    throw new Error('Report composition unavailable.');
  const resolve = input.resolveSecret ?? resolveSecretReference,
    token = resolve(input.config.telegram.botTokenRef),
    match = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(token),
    encoded = resolve(input.config.telegram.actionTokenKeyRef),
    key = Buffer.from(encoded, 'base64url');
  if (
    match === null ||
    !Number.isSafeInteger(Number(match[1])) ||
    key.length !== 32 ||
    key.toString('base64url') !== encoded
  )
    throw new Error('Signup credentials unavailable.');
  return new TelegramSignupRuntime(
    input.database,
    input.redis,
    input.config.redis.queuePrefix,
    match[1]!,
    key,
    new TelegramBotApiMenuClient(token),
    new RedisRateLimiter(input.redis, input.config.redis.queuePrefix),
    undefined,
    createGuestPreviewRuntime(input.config, input.database, resolve),
    createExploreDeliveryRuntime(input.config, input.database, resolve),
    input.stars,
    input.reports,
    input.administration,
  );
}
