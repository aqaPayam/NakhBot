import { createHash } from 'node:crypto';
import {
  SessionLikedByOpaqueReferences,
  SpendCreditsForPaidActionHandler,
  SendLikeHandler,
  MarkNotInterestedHandler,
  type UserSessionActor,
  type UserProductLife,
} from '@nakh/application';
import { ApplicationError, getPaidActionPrice, SystemClock } from '@nakh/domain';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { CatalogRenderer, M9_LIKED_BY_TEXTS } from '@nakh/localization';
import {
  PostgresUserSessionStore,
  PostgresTelegramUserResolver,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresLikedByStore,
  PostgresPaidActionStore,
  PostgresInteractionStore,
  PostgresTelegramLikedByDeliveryStore,
  readLikedByAccess,
  requireOriginalUnlockedLikeSource,
  SystemIdGenerator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  RedisOwnedOpaqueTokenStore,
  RedisRateLimiter,
  type createRedisConnection,
} from '@nakh/queue-redis';
import {
  SignupNavigationTokens,
  TelegramBotApiMenuClient,
  signupRecord as record,
  type SignupNavigation as Nav,
} from '@nakh/telegram';
import type { TelegramLikedByIngressOutcome } from './liked-by-ingress.js';

type Button = Readonly<{ text: string; callback_data: string }>;
type Render = (key: string, variables?: Record<string, string | number>) => string;
export interface TelegramLikedByCustomerRuntimePort {
  readonly enabled: boolean;
  handle(update: unknown): Promise<TelegramLikedByIngressOutcome>;
  entryButton(recipient: string, actor: UserSessionActor): Promise<Button>;
}
function operation(parts: readonly unknown[]): string {
  const b = createHash('sha256')
    .update(JSON.stringify(['liked-by-customer-v1', ...parts]))
    .digest()
    .subarray(0, 16);
  b[6] = (b[6]! & 15) | 0x50;
  b[8] = (b[8]! & 63) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function group(value: string): string {
  return createHash('sha256').update(value).digest().subarray(0, 12).toString('base64url');
}
function unavailable(): never {
  throw new ApplicationError('unlock_unavailable', 'error.billing.unlock_unavailable', 409);
}

/** Modern ingress captures original authority, then stores only a compact native
 * delivery request. It never sends private profile bodies or renews a callback. */
export class TelegramLikedByCustomerRuntime implements TelegramLikedByCustomerRuntimePort {
  public readonly enabled = true;
  private readonly ids = new SystemIdGenerator();
  private readonly clock = new SystemClock();
  public constructor(
    private readonly database: NakhDatabase,
    private readonly financialDatabase: NakhDatabase,
    private readonly redis: ReturnType<typeof createRedisConnection>,
    private readonly prefix: string,
    private readonly botId: string,
    private readonly key: Uint8Array,
    private readonly client: TelegramBotApiMenuClient,
    private readonly limiter: Pick<RedisRateLimiter, 'consume'>,
    private readonly home?: (recipient: string, actor: UserSessionActor) => Promise<void>,
    private readonly credits?: (recipient: string, actor: UserSessionActor) => Promise<void>,
  ) {
    this.key = Buffer.from(key);
  }
  public async onModuleInit(): Promise<void> {
    if (
      !(await this.database
        .selectFrom('platform.schema_migrations')
        .select('name')
        .where('name', '=', '000170_m9_liked_by_customer_delivery.sql')
        .executeTakeFirst())
    )
      throw new Error('Liked By customer schema unavailable.');
    const variables = (text: string): string =>
      [...new Set([...text.matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((m) => m[1]))].sort().join(',');
    for (const locale of await this.database
      .selectFrom('catalog.locales')
      .select('code')
      .where('is_active', '=', true)
      .execute()) {
      const catalog = await new PostgresLocalizationStore(this.database).loadActiveCatalog(
        locale.code,
      );
      for (const [key, expected] of Object.entries(M9_LIKED_BY_TEXTS)) {
        const value = catalog.messages[key];
        if (typeof value !== 'string' || !value.trim() || variables(value) !== variables(expected))
          throw new Error('Liked By localization unavailable.');
      }
    }
  }
  private tokens(recipient: string, life: UserProductLife): SignupNavigationTokens {
    return new SignupNavigationTokens(
      new RedisOwnedOpaqueTokenStore(this.redis, this.prefix, life),
      this.key,
      this.botId,
      recipient,
      life,
      undefined,
      'liked_by',
    );
  }
  private references(life: UserProductLife): SessionLikedByOpaqueReferences {
    return SessionLikedByOpaqueReferences.forLife(
      new RedisOwnedOpaqueTokenStore(this.redis, this.prefix, life),
      this.key,
      life,
    );
  }
  private async renderer(recipient: string): Promise<Render> {
    const identity = await new PostgresIdentityStore(this.database).getByTelegramUserId(recipient);
    const catalog = await new PostgresLocalizationStore(this.database).loadActiveCatalog(
      identity?.uiLocale ?? 'en',
    );
    const renderer = new CatalogRenderer(
      { [catalog.resolvedLocale]: catalog.messages },
      catalog.resolvedLocale,
    );
    return (key, variables = {}) => renderer.render(catalog.resolvedLocale, { key, variables });
  }
  private async current(recipient: string, actor: UserSessionActor, inbox = true): Promise<void> {
    const life = await new PostgresTelegramUserResolver(this.database).resolveProductLife(
      recipient,
    );
    if (
      life?.userId !== actor.userId ||
      life.productEpoch !== actor.productEpoch ||
      !(await new PostgresUserSessionStore(this.database).current(actor, actor.sessionGrantId))
    )
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    if (inbox)
      await new PostgresLikedByStore(this.database, actor).readActionablePage(
        { actor: { kind: 'user', userId: actor.userId }, requestId: this.ids.uuid(), limit: 1 },
        undefined,
        actor.productEpoch,
      );
  }
  public async entryButton(recipient: string, input: UserSessionActor): Promise<Button> {
    const actor = Object.freeze({ ...input });
    await this.current(recipient, actor, false);
    const t = await this.renderer(recipient);
    return {
      text: t('liked_by.menu'),
      callback_data: await this.tokens(recipient, actor).button({
        actor,
        version: 1,
        screen: 'liked_by',
        action: 'resume',
      }),
    };
  }
  private async enqueue(
    recipient: string,
    actor: UserSessionActor,
    updateId: number,
    callbackId?: string,
    selectors: { cursor?: string; likeId?: string; unlockId?: string } = {},
  ): Promise<TelegramLikedByIngressOutcome> {
    await this.current(recipient, actor);
    const result = await new PostgresTelegramLikedByDeliveryStore(
      this.database,
      this.ids,
      this.clock,
    ).enqueue({
      botId: this.botId,
      updateId: String(updateId),
      userId: actor.userId,
      productEpoch: actor.productEpoch,
      telegramUserId: recipient,
      requestId: operation(['delivery', this.botId, updateId]),
      sessionGrantId: actor.sessionGrantId,
      ...(callbackId === undefined ? {} : { callbackQueryId: callbackId }),
      ...(selectors.cursor === undefined ? {} : { cursor: selectors.cursor }),
      ...(selectors.likeId === undefined ? {} : { sourceLikeId: selectors.likeId }),
      ...(selectors.unlockId === undefined ? {} : { featureUnlockId: selectors.unlockId }),
    });
    // Persist before acknowledgment, including main-menu callbacks without cursor.
    if (callbackId !== undefined) await this.client.answerCallback(callbackId);
    return result.replayed ? 'replayed' : 'enqueued';
  }
  private async confirm(
    recipient: string,
    actor: UserSessionActor,
    token: string,
    likeId: string,
    updateId: number,
    callbackId: string,
  ): Promise<TelegramLikedByIngressOutcome> {
    const access = await readLikedByAccess(this.database, actor, likeId);
    if (access.unlockId)
      return this.enqueue(recipient, actor, updateId, callbackId, {
        likeId,
        unlockId: access.unlockId,
      });
    const t = await this.renderer(recipient),
      price = getPaidActionPrice('unlock_liked_by_profile', 'credits');
    const nav: Nav = {
      actor,
      version: 1,
      screen: 'confirm',
      action: 'pick',
      likeId,
      reference: Buffer.from(token).toString('base64url'),
      group: group(token + actor.sessionGrantId),
    };
    const tokens = this.tokens(recipient, actor),
      keyboard: Array<Array<Button>> = [];
    if (BigInt(access.balance) >= price)
      keyboard.push([
        {
          text: t('liked_by.unlock.credits', { credits: String(price) }),
          callback_data: await tokens.stableButton(nav, `confirm:${likeId}:${nav.group}`),
        },
      ]);
    if (this.credits)
      keyboard.push([
        {
          text: t('account.credits.title'),
          callback_data: await tokens.button({ ...nav, action: 'settings' }),
        },
      ]);
    keyboard.push([
      {
        text: t('liked_by.back'),
        callback_data: await tokens.button({
          actor,
          version: 1,
          screen: 'liked_by',
          action: 'resume',
        }),
      },
    ]);
    await this.current(recipient, actor);
    await this.client.answerCallback(callbackId);
    await this.client.sendMenu(recipient, {
      text: t(
        BigInt(access.balance) < price ? 'liked_by.insufficient' : 'liked_by.unlock.confirm',
        { credits: String(price), balance: access.balance },
      ),
      replyMarkup: { inline_keyboard: keyboard },
    });
    return 'notice';
  }
  private async action(
    recipient: string,
    nav: Nav,
    updateId: number,
    callbackId: string,
  ): Promise<TelegramLikedByIngressOutcome> {
    const actor = Object.freeze({ ...nav.actor });
    if (nav.action === 'home' || nav.action === 'settings') {
      await this.current(recipient, actor, false);
      await this.client.answerCallback(callbackId);
      const open = nav.action === 'home' ? this.home : this.credits;
      if (!open) unavailable();
      await open(recipient, actor);
      return 'notice';
    }
    await this.current(recipient, actor);
    if (nav.action === 'resume') return this.enqueue(recipient, actor, updateId, callbackId);
    if (!nav.likeId) unavailable();
    const t = await this.renderer(recipient),
      id = operation([actor, nav.group, nav.action, nav.likeId, nav.unlockId ?? null]);
    if (nav.screen === 'confirm' && nav.action === 'pick') {
      if (!nav.reference || !nav.group) unavailable();
      const token = Buffer.from(nav.reference, 'base64url').toString('utf8'),
        refs = this.references(actor).forSession(actor);
      if ((await refs.resolveAction(token, actor.userId)) !== nav.likeId) unavailable();
      const result = await new SpendCreditsForPaidActionHandler(
        new PostgresPaidActionStore(this.financialDatabase, actor),
        {
          resolveLikedByAction: (value, user) => refs.resolveAction(value, user),
          resolveChatUnlockAction: () => Promise.resolve(undefined),
        },
        this.ids,
      ).execute({
        commandType: 'billing.spend-credits-for-action',
        schemaVersion: 1,
        commandId: id,
        requestId: id,
        idempotencyKey: 'liked-by:' + id,
        actor: { kind: 'user', userId: actor.userId },
        occurredAt: this.clock.now().toISOString(),
        locale: 'en',
        data: { target: { type: 'liked_by_profile_unlock', actionToken: token } },
      });
      return this.enqueue(recipient, actor, updateId, callbackId, {
        likeId: nav.likeId,
        unlockId: result.featureUnlockId,
      });
    }
    if (!nav.unlockId) unavailable();
    if (nav.action === 'detail')
      return this.enqueue(recipient, actor, updateId, callbackId, {
        likeId: nav.likeId,
        unlockId: nav.unlockId,
      });
    if (nav.action !== 'like' && nav.action !== 'reject') unavailable();
    if (!nav.group) unavailable();
    const source = { likeId: nav.likeId, unlockId: nav.unlockId };
    const target = await this.database
      .transaction()
      .execute((tx) => requireOriginalUnlockedLikeSource(tx, actor, source));
    const store = new PostgresInteractionStore(this.database, actor, undefined, source),
      envelope = {
        schemaVersion: 1 as const,
        commandId: id,
        requestId: id,
        idempotencyKey: 'liked-by:' + id,
        actor: { kind: 'user' as const, userId: actor.userId },
        occurredAt: this.clock.now().toISOString(),
        locale: 'en',
      };
    if (nav.action === 'like')
      await new SendLikeHandler(store, this.ids, this.clock).execute({
        ...envelope,
        commandType: 'interaction.send-like',
        data: { targetUserId: target },
      });
    else
      await new MarkNotInterestedHandler(store, this.ids, this.clock).execute({
        ...envelope,
        commandType: 'interaction.mark-not-interested',
        data: { targetUserId: target, source: 'liked_by' },
      });
    await this.current(recipient, actor);
    await this.client.answerCallback(callbackId);
    await this.client.sendMenu(recipient, {
      text: t(nav.action === 'like' ? 'matching.match.created' : 'liked_by.rejected'),
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: t('account.menu.home'),
              callback_data: await this.tokens(recipient, actor).button({
                actor,
                version: 1,
                screen: 'liked_by',
                action: 'home',
              }),
            },
          ],
        ],
      },
    });
    return 'notice';
  }
  public async handle(input: unknown): Promise<TelegramLikedByIngressOutcome> {
    const root = record(structuredClone(input)),
      message = record(root?.message),
      callback = record(root?.callback_query);
    const command = message?.text === '/liked_by',
      data = typeof callback?.data === 'string' ? callback.data : undefined;
    if (!command && !(data?.startsWith('m9l:') || data?.startsWith('v1.lb.'))) return 'unhandled';
    const from = record(callback?.from ?? message?.from),
      chat = record(callback === undefined ? message?.chat : record(callback.message)?.chat),
      bot = record(record(callback?.message)?.from),
      sender = from?.id,
      updateId = root?.update_id;
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
          !callback.id.length ||
          callback.id.length > 128))
    )
      throw new ApplicationError('invalid_request', 'error.interaction.unavailable', 400);
    const recipient = String(sender),
      life = await new PostgresTelegramUserResolver(this.database).resolveProductLife(recipient);
    const t = await this.renderer(recipient);
    const notice = async (key: string): Promise<TelegramLikedByIngressOutcome> => {
      if (callback) await this.client.answerCallback(String(callback.id), t(key));
      else
        await this.client.sendMenu(recipient, {
          text: t(key),
          replyMarkup: { inline_keyboard: [] },
        });
      return 'notice';
    };
    if (!life) return notice('signup.ui.expired');
    if (
      !(
        await this.limiter.consume({
          scope: 'telegram_liked_by',
          subject: life.userId,
          limit: 20,
          windowSeconds: 60,
        })
      ).allowed
    )
      return notice('error.rate_limit.exceeded');
    try {
      if (command) {
        const grant = await new PostgresUserSessionStore(this.database).issue(
          life,
          operation(['entry', this.botId, recipient, updateId]),
        );
        if (!grant) unavailable();
        return await this.enqueue(
          recipient,
          { kind: 'user', ...life, sessionGrantId: grant.id },
          updateId,
        );
      }
      if (data?.startsWith('m9l:')) {
        const nav = await this.tokens(recipient, life).callback(data);
        if (!nav) return notice('signup.ui.expired');
        return await this.action(recipient, nav, updateId, String(callback!.id));
      }
      const captured = data === undefined ? undefined : await this.references(life).capture(data);
      if (!captured) return notice('signup.ui.expired');
      await this.current(recipient, captured.actor);
      if (captured.purpose === 'liked_by_cursor')
        return await this.enqueue(recipient, captured.actor, updateId, String(callback!.id), {
          cursor: data!,
        });
      return await this.confirm(
        recipient,
        captured.actor,
        data!,
        captured.likeId,
        updateId,
        String(callback!.id),
      );
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500)
        return notice(
          error.code === 'insufficient_credits'
            ? 'error.billing.insufficient_credits'
            : error.status === 401
              ? 'signup.ui.expired'
              : 'liked_by.unavailable',
        );
      throw error;
    }
  }
}
export function createTelegramLikedByCustomerRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    financialDatabase: NakhDatabase;
    redis: ReturnType<typeof createRedisConnection>;
    resolveSecret?: (ref: string) => string;
    home?: (recipient: string, actor: UserSessionActor) => Promise<void>;
    credits?: (recipient: string, actor: UserSessionActor) => Promise<void>;
  }>,
): TelegramLikedByCustomerRuntimePort {
  if (!input.config.telegram.signupEnabled || !input.config.telegram.likedByDeliveryEnabled)
    return {
      enabled: false,
      handle: () => Promise.resolve('unhandled'),
      entryButton: () =>
        Promise.reject(new ApplicationError('capability_denied', 'error.capability.denied', 403)),
    };
  const resolve = input.resolveSecret ?? resolveSecretReference,
    token = resolve(input.config.telegram.botTokenRef),
    match = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(token),
    encoded = resolve(input.config.telegram.actionTokenKeyRef),
    key = Buffer.from(encoded, 'base64url');
  if (
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    key.length !== 32 ||
    key.toString('base64url') !== encoded
  )
    throw new Error('Liked By credentials unavailable.');
  return new TelegramLikedByCustomerRuntime(
    input.database,
    input.financialDatabase,
    input.redis,
    input.config.redis.queuePrefix,
    match[1]!,
    key,
    new TelegramBotApiMenuClient(token),
    new RedisRateLimiter(input.redis, input.config.redis.queuePrefix),
    input.home,
    input.credits,
  );
}
