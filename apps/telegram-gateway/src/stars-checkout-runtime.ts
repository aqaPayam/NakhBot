import { createHash, randomBytes } from 'node:crypto';
import type { StarsPurchaseOffer, UserSessionActor } from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import {
  ApplicationError,
  CREDIT_PACKAGE_DEFINITIONS,
  NAKH_STARS_COST,
  type CreditPackageCode,
} from '@nakh/domain';
import { CatalogRenderer, M9_PURCHASE_TEXTS } from '@nakh/localization';
import {
  PostgresFundingStore,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresStarsPurchaseConsentStore,
  PostgresTelegramUserResolver,
  PostgresUserSessionStore,
  referenceDigest,
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
import type { TelegramStarsRuntimePort } from './stars-runtime.js';

const TERMS_VERSION = 'v1';
type Invoice = Parameters<TelegramStarsRuntimePort['invoice']>[0];
type PurchaseTexts = Record<keyof typeof M9_PURCHASE_TEXTS, string>;
export type StarsPurchasePolicy = Readonly<{
  version: string;
  support: string;
  defaultLocale: string;
  locales: Readonly<Record<string, PurchaseTexts>>;
  packages: readonly Readonly<{ code: CreditPackageCode; credits: string; stars: string }>[];
  nakhStars: string;
  digest: string;
}>;
function unavailable(): never {
  throw new ApplicationError('capability_denied', 'error.billing.payment_unavailable', 403);
}
function operation(parts: readonly unknown[]): string {
  const b = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16);
  b[6] = (b[6]! & 15) | 0x50;
  b[8] = (b[8]! & 63) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Public review artifact only. Capturing it is not owner approval. */
export async function captureStarsPurchasePolicy(
  db: NakhDatabase,
  support: string,
): Promise<StarsPurchasePolicy> {
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(support)) unavailable();
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (tx) => {
      const active = await tx
        .selectFrom('catalog.locales')
        .select(['code', 'is_default'])
        .where('is_active', '=', true)
        .orderBy('code')
        .execute();
      const fallback = active.find((r) => r.is_default)?.code;
      if (!fallback || active.length === 0) unavailable();
      const locales: Record<string, PurchaseTexts> = {};
      for (const row of active) {
        const catalog = await new PostgresLocalizationStore(tx).loadActiveCatalog(row.code);
        const texts: Partial<PurchaseTexts> = {};
        for (const [key, english] of Object.entries(M9_PURCHASE_TEXTS)) {
          const text = catalog.messages[key];
          const vars = (value: string): string =>
            [...new Set([...value.matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((m) => m[1]))]
              .sort()
              .join(',');
          if (
            typeof text !== 'string' ||
            text.trim() === '' ||
            text.length > 1500 ||
            vars(text) !== vars(english)
          )
            unavailable();
          texts[key as keyof PurchaseTexts] = text;
        }
        locales[row.code] = texts as PurchaseTexts;
      }
      const rows = await tx
        .selectFrom('billing.credit_packages')
        .select(['code', 'credit_amount', 'stars_price'])
        .where('is_active', '=', true)
        .orderBy('credit_amount')
        .orderBy('code')
        .execute();
      if (rows.length === 0) unavailable();
      const packages = rows.map((r) => {
        if (
          !CREDIT_PACKAGE_DEFINITIONS.some((d) => d.code === r.code) ||
          BigInt(r.credit_amount) <= 0n ||
          BigInt(r.stars_price) <= 0n ||
          BigInt(r.stars_price) > BigInt(Number.MAX_SAFE_INTEGER)
        )
          unavailable();
        return {
          code: r.code,
          credits: BigInt(r.credit_amount).toString(),
          stars: BigInt(r.stars_price).toString(),
        };
      });
      const policy = {
        version: TERMS_VERSION,
        support,
        defaultLocale: fallback,
        locales,
        packages,
        nakhStars: NAKH_STARS_COST.toString(),
      };
      return { ...policy, digest: referenceDigest(policy) };
    });
}
export interface TelegramStarsCheckoutPort extends TelegramStarsRuntimePort {
  openPackages(recipient: string, actor: UserSessionActor): Promise<void>;
  handleNavigation(update: unknown): Promise<'unhandled' | 'notice'>;
}
/** Product navigation remains behind cohort admission; only financial callbacks
 * and public terms use handle() before that gate. No navigation issues a grant. */
export class TelegramStarsCheckoutRuntime implements TelegramStarsCheckoutPort {
  public get enabled(): boolean {
    return this.stars.enabled;
  }
  public get invoiceCreationEnabled(): boolean {
    return this.stars.invoiceCreationEnabled;
  }
  private policy: StarsPurchasePolicy | undefined;
  private readonly users: PostgresTelegramUserResolver;
  private readonly sessions: PostgresUserSessionStore;
  private readonly identities: PostgresIdentityStore;
  private readonly limiter: RedisRateLimiter;
  public constructor(
    private readonly config: AppConfig,
    userDatabase: NakhDatabase,
    private readonly financialDatabase: NakhDatabase,
    private readonly redis: ReturnType<typeof createRedisConnection>,
    private readonly botId: string,
    private readonly key: Uint8Array,
    private readonly client: TelegramBotApiMenuClient,
    private readonly stars: TelegramStarsRuntimePort,
    private readonly home: (recipient: string, actor: UserSessionActor) => Promise<void>,
  ) {
    this.users = new PostgresTelegramUserResolver(userDatabase);
    this.sessions = new PostgresUserSessionStore(userDatabase);
    this.identities = new PostgresIdentityStore(userDatabase);
    this.limiter = new RedisRateLimiter(redis, config.redis.queuePrefix);
    stars.assertSeparateNavigationKey?.(key);
  }
  public async onModuleInit(): Promise<void> {
    this.policy = undefined;
    try {
      const policy = await captureStarsPurchasePolicy(
        this.financialDatabase,
        this.config.telegram.publicSupportUsername,
      );
      if (policy.digest !== this.config.telegram.starsPurchaseApprovalDigest)
        throw new Error('Unapproved purchase policy');
      this.policy = policy;
    } catch {
      // Pausing the shop must not prevent existing financial callbacks starting.
      if (this.invoiceCreationEnabled)
        throw new Error('Reviewed Stars purchase policy approval unavailable.');
    }
  }
  public assertSeparateNavigationKey(key: Uint8Array): void {
    this.stars.assertSeparateNavigationKey?.(key);
  }
  private approved(): StarsPurchasePolicy {
    if (!this.policy) unavailable();
    return this.policy;
  }
  private locale(code: string): string {
    const p = this.approved();
    return p.locales[code] ? code : p.defaultLocale;
  }
  private text(
    locale: string,
    key: keyof PurchaseTexts,
    variables: Record<string, string> = {},
  ): string {
    const p = this.approved();
    return new CatalogRenderer(p.locales, p.defaultLocale).render(this.locale(locale), {
      key,
      variables,
    });
  }
  private tokens(
    recipient: string,
    actor: Readonly<{ userId: string; productEpoch: number }>,
  ): SignupNavigationTokens {
    return new SignupNavigationTokens(
      new RedisOwnedOpaqueTokenStore(this.redis, this.config.redis.queuePrefix, actor),
      this.key,
      this.botId,
      recipient,
      actor,
      Date.now,
      'purchase',
    );
  }
  private async current(recipient: string, actor: UserSessionActor): Promise<string> {
    const life = await this.users.resolveProductLife(recipient);
    if (
      life?.userId !== actor.userId ||
      life.productEpoch !== actor.productEpoch ||
      !(await this.sessions.current(actor, actor.sessionGrantId))
    )
      unavailable();
    const identity = await this.identities.getByUserId(actor.userId);
    if (identity?.accountState !== 'active') unavailable();
    return this.locale(identity.uiLocale);
  }
  private terms(locale: string): string {
    const p = this.approved();
    return [
      this.text(locale, 'purchase.terms_title', { version: p.version }),
      ...(
        [
          'purchase.units',
          'purchase.delivery',
          'purchase.pending',
          'purchase.correction',
          'purchase.contact',
          'purchase.rights',
        ] as const
      ).map((key) => this.text(locale, key, { support: p.support })),
    ].join('\n\n');
  }
  private document(offer: StarsPurchaseOffer, locale: string): { text: string; digest: string } {
    const p = this.approved();
    if (
      offer.reason === 'buy_credit_package' &&
      !p.packages.some(
        (r) =>
          r.code === offer.packageCode && r.credits === offer.credits && r.stars === offer.stars,
      )
    )
      unavailable();
    if (offer.reason === 'send_nakh' && offer.stars !== p.nakhStars) unavailable();
    const description =
      offer.reason === 'buy_credit_package'
        ? this.text(locale, 'purchase.package', { credits: offer.credits!, stars: offer.stars })
        : this.text(locale, 'purchase.nakh', { stars: offer.stars });
    const text = [
      this.text(locale, 'purchase.title'),
      description,
      this.terms(locale),
      this.text(locale, 'purchase.consent'),
    ].join('\n\n');
    if (text.length > 3900) unavailable();
    return {
      text,
      digest: referenceDigest([p.digest, locale, text, this.text(locale, 'purchase.confirm')]),
    };
  }
  public async openPackages(recipient: string, input: UserSessionActor): Promise<void> {
    if (!this.invoiceCreationEnabled) unavailable();
    const actor = Object.freeze({ ...input }),
      locale = await this.current(recipient, actor),
      p = this.approved();
    const tokens = this.tokens(recipient, actor),
      nav: Nav = {
        actor,
        version: 1,
        screen: 'purchase_packages',
        action: 'pick',
        group: randomBytes(12).toString('base64url'),
        reference: p.digest,
      };
    const keyboard = await Promise.all(
      p.packages.map(async (r) => [
        {
          text: this.text(locale, 'purchase.package', { credits: r.credits, stars: r.stars }),
          callback_data: await tokens.button({ ...nav, code: r.code }),
        },
      ]),
    );
    keyboard.push([
      {
        text: this.text(locale, 'purchase.back'),
        callback_data: await tokens.button({ ...nav, action: 'home' }),
      },
    ]);
    await this.current(recipient, actor);
    await this.client.sendMenu(recipient, {
      text: this.text(locale, 'purchase.packages'),
      replyMarkup: { inline_keyboard: keyboard },
    });
  }
  public async invoice(input: Invoice): Promise<void> {
    if (!this.invoiceCreationEnabled) unavailable();
    const request = structuredClone(input),
      locale = await this.current(request.telegramUserId, request.actor);
    const offer = await new PostgresStarsPurchaseConsentStore(
      this.financialDatabase,
      request.actor,
    ).review(request.fundingIntentId, request.expectedVersion);
    const document = this.document(offer, locale),
      tokens = this.tokens(request.telegramUserId, request.actor);
    const nav: Nav = {
      actor: request.actor,
      version: offer.version,
      screen: 'purchase_review',
      action: 'save',
      code: offer.fundingIntentId,
      reference: document.digest,
      reason: offer.digest,
      field: this.approved().version,
      country: locale,
      selection: [this.approved().digest],
      group: randomBytes(12).toString('base64url'),
    };
    const agree = await tokens.button(nav),
      cancel = await tokens.button({ ...nav, action: 'home' });
    await this.current(request.telegramUserId, request.actor);
    await this.client.sendMenu(request.telegramUserId, {
      text: document.text,
      replyMarkup: {
        inline_keyboard: [
          [{ text: this.text(locale, 'purchase.confirm'), callback_data: agree }],
          [{ text: this.text(locale, 'purchase.cancel'), callback_data: cancel }],
        ],
      },
    });
  }
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const result = await this.stars.handle(update);
    if (result !== 'unhandled') return result;
    const root = record(structuredClone(update)),
      message = record(root?.message);
    if (message?.text !== '/terms') return 'unhandled';
    const from = record(message.from),
      chat = record(message.chat),
      sender = from?.id;
    if (
      root?.callback_query !== undefined ||
      !Number.isSafeInteger(root?.update_id) ||
      Number(root?.update_id) < 0 ||
      typeof sender !== 'number' ||
      !Number.isSafeInteger(sender) ||
      sender <= 0 ||
      from?.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== sender
    )
      throw new ApplicationError('invalid_request', 'error.identity.user_context_invalid', 400);
    const rate = await this.limiter.consume({
      scope: 'telegram_purchase_terms',
      subject: createHash('sha256')
        .update(this.botId + '\0' + String(sender))
        .digest('hex'),
      limit: 10,
      windowSeconds: 60,
    });
    if (!rate.allowed) throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429);
    await this.client.sendMenu(String(sender), {
      text: this.policy
        ? this.terms(this.policy.defaultLocale)
        : [
            M9_PURCHASE_TEXTS['purchase.unavailable'],
            this.config.telegram.publicSupportUsername
              ? '@' + this.config.telegram.publicSupportUsername
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
      replyMarkup: { inline_keyboard: [] },
    });
    return 'notice';
  }
  public async handleNavigation(update: unknown): Promise<'unhandled' | 'notice'> {
    const root = record(structuredClone(update)),
      callback = record(root?.callback_query);
    if (typeof callback?.data !== 'string' || !callback.data.startsWith('m9b:')) return 'unhandled';
    const from = record(callback.from),
      message = record(callback.message),
      chat = record(message?.chat),
      bot = record(message?.from),
      sender = from?.id,
      updateId = root?.update_id;
    if (
      root?.message !== undefined ||
      typeof sender !== 'number' ||
      !Number.isSafeInteger(sender) ||
      sender <= 0 ||
      from?.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== sender ||
      bot?.is_bot !== true ||
      String(bot.id) !== this.botId ||
      typeof updateId !== 'number' ||
      !Number.isSafeInteger(updateId) ||
      updateId < 0 ||
      typeof callback.id !== 'string' ||
      callback.id.length < 1 ||
      callback.id.length > 128
    )
      throw new ApplicationError('invalid_request', 'error.identity.user_context_invalid', 400);
    const recipient = String(sender),
      life = await this.users.resolveProductLife(recipient);
    if (!life) unavailable();
    const tokens = this.tokens(recipient, life);
    // Token ownership uses only the life; the captured grant comes from the MAC.
    const nav = await tokens.callback(callback.data);
    if (!nav) unavailable();
    const locale = await this.current(recipient, nav.actor);
    const rate = await this.limiter.consume({
      scope: 'telegram_purchase_checkout',
      subject: nav.actor.userId,
      limit: 30,
      windowSeconds: 60,
    });
    if (!rate.allowed) throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429);
    if (!this.invoiceCreationEnabled) unavailable();
    if (nav.action === 'home') {
      const claim = await tokens.claim(nav, updateId, callback.data, nav);
      await this.client.answerCallback(callback.id);
      if (claim.accepted) await this.home(recipient, nav.actor);
      return 'notice';
    }
    if (nav.screen === 'purchase_packages' && nav.action === 'pick') {
      const p = this.approved(),
        selected = p.packages.find((r) => r.code === nav.code);
      if (!selected || nav.reference !== p.digest) unavailable();
      const claim = await tokens.claim(nav, updateId, callback.data, nav);
      await this.client.answerCallback(callback.id);
      if (!claim.accepted) return 'notice';
      const id = operation([
        'stars-package',
        this.botId,
        recipient,
        nav.actor,
        nav.group,
        selected.code,
      ]);
      const intent = await new PostgresFundingStore(
        this.financialDatabase,
        nav.actor,
      ).createFundingIntent({
        intentId: id,
        userId: nav.actor.userId,
        funding: 'stars',
        target: { type: 'credit_package', packageCode: selected.code },
        idempotencyKey: id,
      });
      await this.invoice({
        actor: nav.actor,
        telegramUserId: recipient,
        fundingIntentId: intent.id,
        expectedVersion: 1,
        commandId: id,
        requestId: id,
        idempotencyKey: id,
        occurredAt: new Date().toISOString(),
        locale,
      });
      return 'notice';
    }
    if (
      nav.screen !== 'purchase_review' ||
      nav.action !== 'save' ||
      !nav.code ||
      nav.country !== locale ||
      nav.field !== this.approved().version ||
      nav.selection?.[0] !== this.approved().digest
    )
      unavailable();
    const store = new PostgresStarsPurchaseConsentStore(this.financialDatabase, nav.actor),
      offer = await store.review(nav.code, nav.version),
      document = this.document(offer, locale);
    if (nav.reason !== offer.digest || nav.reference !== document.digest) unavailable();
    const claim = await tokens.claim(nav, updateId, callback.data, nav);
    await this.client.answerCallback(callback.id);
    if (!claim.accepted) return 'notice';
    const id = operation(['stars-consent', this.botId, nav.actor, nav.group, nav.code]);
    const consent = await store.accept({
      fundingIntentId: nav.code,
      expectedVersion: nav.version,
      offerDigest: offer.digest,
      termsVersion: this.approved().version,
      documentDigest: document.digest,
      locale,
      commandId: id,
      requestId: id,
    });
    await this.current(recipient, nav.actor);
    await this.stars.invoice({
      actor: nav.actor,
      telegramUserId: recipient,
      fundingIntentId: nav.code,
      expectedVersion: nav.version,
      purchaseConsentId: consent.id,
      commandId: id,
      requestId: id,
      idempotencyKey: `purchase:${consent.id}`,
      occurredAt: new Date().toISOString(),
      locale,
    });
    return 'notice';
  }
}
export function createTelegramStarsCheckoutRuntime(
  input: Readonly<{
    config: AppConfig;
    userDatabase: NakhDatabase;
    financialDatabase: NakhDatabase;
    redis: ReturnType<typeof createRedisConnection>;
    stars: TelegramStarsRuntimePort;
    home: (recipient: string, actor: UserSessionActor) => Promise<void>;
    resolveSecret?: (reference: string) => string;
  }>,
): TelegramStarsCheckoutPort {
  const { stars, config } = input;
  if (!stars.invoiceCreationEnabled && !config.telegram.starsPurchaseApprovalDigest)
    return {
      enabled: stars.enabled,
      invoiceCreationEnabled: false,
      invoice: (r) => stars.invoice(r),
      handle: (u) => stars.handle(u),
      assertSeparateNavigationKey: (k) => stars.assertSeparateNavigationKey?.(k),
      openPackages: () =>
        Promise.reject(
          new ApplicationError('capability_denied', 'error.billing.payment_unavailable', 403),
        ),
      handleNavigation: () => Promise.resolve('unhandled'),
    };
  if (
    !stars.enabled ||
    (stars.invoiceCreationEnabled &&
      (!config.telegram.signupEnabled ||
        !config.telegram.accountMenuEnabled ||
        config.telegram.freeTestTopupsEnabled))
  )
    unavailable();
  const resolve = input.resolveSecret ?? resolveSecretReference,
    token = resolve(config.telegram.botTokenRef),
    botId = token.split(':')[0]!,
    encoded = resolve(config.telegram.actionTokenKeyRef),
    key = Buffer.from(encoded, 'base64url');
  if (
    !/^[1-9][0-9]{0,19}$/u.test(botId) ||
    !Number.isSafeInteger(Number(botId)) ||
    key.byteLength !== 32 ||
    key.toString('base64url') !== encoded
  )
    unavailable();
  return new TelegramStarsCheckoutRuntime(
    config,
    input.userDatabase,
    input.financialDatabase,
    input.redis,
    botId,
    key,
    new TelegramBotApiMenuClient(token),
    stars,
    input.home,
  );
}
