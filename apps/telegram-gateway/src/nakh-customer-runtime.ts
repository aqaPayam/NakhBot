import type { ViewNakhProfileCommand } from '@nakh/contracts';
import { createHash } from 'node:crypto';
import {
  AcceptNakhHandler,
  RejectNakhHandler,
  ViewNakhProfileHandler,
  EditPendingNakhHandler,
  CancelPendingNakhHandler,
  type UserSessionActor,
  type UserProductLife,
  type MediaDeliverySignerPort,
} from '@nakh/application';
import { ApplicationError, SystemClock } from '@nakh/domain';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { CatalogRenderer, M9_NAKH_TEXTS } from '@nakh/localization';
import {
  PostgresUserSessionStore,
  PostgresTelegramUserResolver,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresDeliveredNakhStore,
  PostgresPendingNakhStore,
  PostgresNakhCustomerReadStore,
  PostgresNakhProfileStore,
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
  TelegramLockedLikedByScreenRelay,
  TelegramCandidateMediaRelay,
  fullProfileTextParts,
  signupRecord as record,
  type SignupNavigation as Nav,
} from '@nakh/telegram';
import {
  HmacMediaAudienceCredentials,
  HmacMediaDeliveryTokens,
  MediaDeliveryUrlSigner,
} from '@nakh/media-delivery';

type Button = Readonly<{ text: string; callback_data: string }>;
type Render = (key: string, variables?: Record<string, string | number>) => string;
type Outcome = 'unhandled' | 'notice';
type Tab = 'received' | 'sent' | 'pending' | 'history';
export interface TelegramNakhCustomerRuntimePort {
  readonly enabled: boolean;
  handle(update: unknown): Promise<Outcome>;
  entryButton(recipient: string, actor: UserSessionActor): Promise<Button>;
}
function operation(parts: readonly unknown[]): string {
  const b = createHash('sha256')
    .update(JSON.stringify(['nakh-customer-v1', ...parts]))
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
function denied(): never {
  throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 403);
}
function tab(value: unknown): Tab {
  if (value === 'received' || value === 'sent' || value === 'pending' || value === 'history')
    return value;
  return denied();
}
function label(value: string, maximum = 64): string {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > maximum) break;
    result += character;
  }
  return result;
}
function position(nav: Nav): { id: string; at: Date } | undefined {
  if (nav.selection === undefined) return undefined;
  const [id, encoded] = nav.selection;
  if (nav.selection.length !== 2 || !id || !encoded || !/^[0-9a-f-]{36}$/u.test(id)) denied();
  const raw = Buffer.from(encoded, 'base64url').toString('utf8'),
    at = new Date(raw);
  if (
    !Number.isFinite(at.getTime()) ||
    at.toISOString() !== raw ||
    Buffer.from(raw).toString('base64url') !== encoded
  )
    denied();
  return { id, at };
}
/** Only selectors and the original session enter Redis. Private Nakh/profile
 * bodies are read afresh from PostgreSQL and delivered to the admitted account.
 * Native commands are idempotent; ambiguous provider sends remain at least once. */
export class TelegramNakhCustomerRuntime implements TelegramNakhCustomerRuntimePort {
  public readonly enabled = true;
  private readonly ids = new SystemIdGenerator();
  private readonly clock = new SystemClock();
  public constructor(
    private readonly database: NakhDatabase,
    private readonly redis: ReturnType<typeof createRedisConnection>,
    private readonly prefix: string,
    private readonly botId: string,
    private readonly key: Uint8Array,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
    private readonly client: Pick<TelegramBotApiMenuClient, 'answerCallback' | 'sendPrompt'>,
    private readonly screens: Pick<TelegramLockedLikedByScreenRelay, 'sendPrivateText'>,
    private readonly photos: Pick<TelegramCandidateMediaRelay, 'send'>,
    private readonly signer: MediaDeliverySignerPort,
    private readonly limiter: Pick<RedisRateLimiter, 'consume'>,
    private readonly reportsEnabled: boolean,
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
        .where('name', '=', '000171_m9_nakh_customer_presentation.sql')
        .executeTakeFirst())
    )
      throw new Error('Nakh customer schema unavailable.');
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
      for (const [key, expected] of Object.entries(M9_NAKH_TEXTS)) {
        const value = catalog.messages[key];
        if (typeof value !== 'string' || !value.trim() || variables(value) !== variables(expected))
          throw new Error('Nakh customer localization unavailable.');
      }
    }
  }
  private tokens(
    recipient: string,
    life: UserProductLife,
    purpose: 'nakh' | 'report' = 'nakh',
  ): SignupNavigationTokens {
    return new SignupNavigationTokens(
      new RedisOwnedOpaqueTokenStore(this.redis, this.prefix, life),
      this.key,
      this.botId,
      recipient,
      life,
      undefined,
      purpose,
    );
  }
  private async renderer(recipient: string): Promise<Render> {
    const identity = await new PostgresIdentityStore(this.database).getByTelegramUserId(recipient);
    const catalog = await new PostgresLocalizationStore(this.database).loadActiveCatalog(
      identity?.uiLocale ?? 'en',
    );
    const render = new CatalogRenderer(
      { [catalog.resolvedLocale]: catalog.messages },
      catalog.resolvedLocale,
    );
    return (key, variables = {}) => render.render(catalog.resolvedLocale, { key, variables });
  }
  private async current(recipient: string, actor: UserSessionActor, active = true): Promise<void> {
    const life = await new PostgresTelegramUserResolver(this.database).resolveProductLife(
      recipient,
    );
    if (
      life?.userId !== actor.userId ||
      life.productEpoch !== actor.productEpoch ||
      !(await new PostgresUserSessionStore(this.database).current(actor, actor.sessionGrantId))
    )
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    if (active) {
      const account = await this.database
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', actor.userId)
        .executeTakeFirst();
      if (account?.state !== 'active') denied();
    }
  }
  private async button(
    recipient: string,
    nav: Nav,
    text: string,
    extra: Partial<Nav>,
  ): Promise<Button> {
    return {
      text: label(text),
      callback_data: await this.tokens(recipient, nav.actor).button({
        ...nav,
        selection: undefined,
        reference: undefined,
        field: undefined,
        reason: undefined,
        action: 'resume',
        ...extra,
      }),
    };
  }
  private async send(
    recipient: string,
    nav: Nav,
    text: string,
    keyboard: readonly (readonly Button[])[],
  ): Promise<void> {
    await this.current(recipient, nav.actor);
    await this.screens.sendPrivateText({
      botId: this.botId,
      telegramUserId: recipient,
      text,
      keyboard,
    });
  }
  public async entryButton(recipient: string, actor: UserSessionActor): Promise<Button> {
    const original = Object.freeze({ ...actor });
    await this.current(recipient, original, false);
    return this.button(
      recipient,
      { actor: original, version: 1, screen: 'nakhes', action: 'resume' },
      (await this.renderer(recipient))('nakh.ui.menu'),
      {},
    );
  }
  private async footer(recipient: string, nav: Nav, t: Render): Promise<Button[]> {
    return [
      await this.button(recipient, nav, t('nakh.ui.back'), { screen: 'nakhes' }),
      await this.button(recipient, nav, t('account.menu.home'), { action: 'home' }),
    ];
  }
  private async root(recipient: string, nav: Nav, t: Render): Promise<void> {
    const rows: Button[][] = [];
    for (const field of ['received', 'sent', 'pending', 'history'] as const)
      rows.push([
        await this.button(recipient, nav, t('nakh.ui.' + field), {
          screen: 'page',
          action: 'page',
          field,
        }),
      ]);
    rows.push([await this.button(recipient, nav, t('account.menu.home'), { action: 'home' })]);
    await this.send(recipient, nav, t('nakh.ui.menu'), rows);
  }
  private async page(recipient: string, nav: Nav, t: Render): Promise<void> {
    const field = tab(nav.field),
      after = position(nav),
      rows: Button[][] = [];
    let more: boolean, last: { id: string; at: Date } | undefined;
    if (field === 'received' || field === 'sent') {
      const store = new PostgresDeliveredNakhStore(this.database, nav.actor);
      const result = await store.readPage(
        nav.actor.userId,
        field,
        3,
        after ? { nakhId: after.id, sentAt: after.at } : undefined,
      );
      for (const item of result.rows)
        rows.push([
          await this.button(
            recipient,
            nav,
            t('nakh.ui.item', {
              name: label(item.counterpartyName, 24),
              status: t('nakh.ui.status.' + item.status),
            }),
            {
              screen: 'detail',
              action: 'detail',
              field,
              reference: item.nakhId,
              version: item.version,
            },
          ),
        ]);
      more = result.hasMore;
      const end = result.rows.at(-1);
      if (end) last = { id: end.nakhId, at: end.sentAt };
      // Repeat the read immediately before sending; a returned account must not
      // inherit a projection captured from its earlier product life.
      const fresh = await store.readPage(
        nav.actor.userId,
        field,
        3,
        after ? { nakhId: after.id, sentAt: after.at } : undefined,
      );
      if (JSON.stringify(fresh) !== JSON.stringify(result)) denied();
    } else {
      const store = new PostgresNakhCustomerReadStore(this.database, nav.actor);
      const query = {
        limit: 3,
        history: field === 'history',
        ...(after ? { after: { pendingNakhId: after.id, createdAt: after.at } } : {}),
      };
      const result = await store.page(query);
      for (const item of result.rows)
        rows.push([
          await this.button(
            recipient,
            nav,
            t('nakh.ui.item', {
              name: label(item.targetName, 24),
              status: t('nakh.ui.status.' + item.status),
            }),
            {
              screen: 'detail',
              action: 'detail',
              field,
              reference: item.pendingNakhId,
              version: item.version,
            },
          ),
        ]);
      more = result.hasMore;
      const end = result.rows.at(-1);
      if (end) last = { id: end.pendingNakhId, at: end.createdAt };
      if (JSON.stringify(await store.page(query)) !== JSON.stringify(result)) denied();
    }
    const empty = rows.length === 0;
    const footer = await this.footer(recipient, nav, t);
    if (more && last)
      footer.unshift(
        await this.button(recipient, nav, t('nakh.ui.next'), {
          screen: 'page',
          action: 'page',
          field,
          selection: [last.id, Buffer.from(last.at.toISOString()).toString('base64url')],
        }),
      );
    rows.push(footer);
    await this.send(
      recipient,
      nav,
      t('nakh.ui.' + field) + (empty ? '\n' + t('nakh.ui.empty') : ''),
      rows,
    );
  }
  private async detail(recipient: string, nav: Nav, t: Render): Promise<void> {
    if (!nav.reference) denied();
    const field = tab(nav.field),
      rows: Button[][] = [];
    let name: string, text: string, status: string, expires: Date;
    if (field === 'received' || field === 'sent') {
      const store = new PostgresDeliveredNakhStore(this.database, nav.actor);
      const item = await store.readDetail(nav.actor.userId, nav.reference);
      if (item.direction !== field) denied();
      ({ text, status } = item);
      name = item.counterpartyName;
      expires = item.expiresAt;
      if (
        field === 'received' &&
        (status === 'sent' || status === 'seen') &&
        expires.getTime() > this.clock.now().getTime()
      ) {
        const original = {
          ...nav,
          version: item.version,
          group: group(operation([nav.actor, nav.reference, item.version])),
        };
        rows.push([
          await this.button(recipient, original, t('nakh.ui.view'), {
            screen: 'profile',
            action: 'preview',
            field,
            reference: item.nakhId,
          }),
        ]);
        rows.push([
          await this.button(recipient, original, t('nakh.ui.accept'), {
            screen: 'detail',
            action: 'finish',
            field,
            reference: item.nakhId,
          }),
          await this.button(recipient, original, t('nakh.ui.close'), {
            screen: 'detail',
            action: 'reject',
            field,
            reference: item.nakhId,
          }),
        ]);
      }
      if (
        JSON.stringify(await store.readDetail(nav.actor.userId, nav.reference)) !==
        JSON.stringify(item)
      )
        denied();
    } else {
      const store = new PostgresNakhCustomerReadStore(this.database, nav.actor),
        item = await store.detail(nav.reference);
      name = item.targetName;
      ({ text, status } = item);
      expires = item.expiresAt;
      if (status === 'pending_payment') {
        const original = {
          ...nav,
          version: item.version,
          group: group(operation([nav.actor, nav.reference, item.version])),
        };
        rows.push([
          await this.button(recipient, original, t('nakh.ui.edit'), {
            action: 'pick',
            field: 'edit',
            reference: item.pendingNakhId,
          }),
          await this.button(recipient, original, t('nakh.ui.cancel'), {
            action: 'pick',
            field: 'cancel',
            reference: item.pendingNakhId,
          }),
        ]);
        if (this.credits)
          rows.push([
            await this.button(recipient, original, t('account.credits.title'), {
              action: 'nakh_credits',
            }),
          ]);
      }
      if (JSON.stringify(await store.detail(nav.reference)) !== JSON.stringify(item)) denied();
    }
    rows.push(await this.footer(recipient, nav, t));
    await this.send(
      recipient,
      nav,
      t('nakh.ui.detail', {
        name,
        text,
        status: t('nakh.ui.status.' + status),
        when: t('nakh.ui.expires', { when: expires.toISOString().replace('T', ' ').slice(0, 16) }),
      }),
      rows,
    );
  }
  private envelope(
    nav: Nav,
    updateId: number,
  ): Omit<ViewNakhProfileCommand, 'commandType' | 'data'> {
    const id = operation([
      this.botId,
      nav.actor,
      nav.reference,
      nav.version,
      nav.action,
      nav.field,
      nav.reason,
      nav.group,
      nav.action === 'reply' ? updateId : null,
    ]);
    return {
      schemaVersion: 1 as const,
      commandId: id,
      requestId: id,
      idempotencyKey: 'nakh-ui:' + id,
      actor: { kind: 'user' as const, userId: nav.actor.userId },
      occurredAt: this.clock.now().toISOString(),
      locale: 'en',
    };
  }
  private async profile(recipient: string, nav: Nav, t: Render, updateId: number): Promise<void> {
    if (!nav.reference || nav.field !== 'received') denied();
    const native = new PostgresDeliveredNakhStore(this.database, nav.actor),
      item = await native.readDetail(nav.actor.userId, nav.reference);
    if (item.direction !== 'received') denied();
    if (item.status === 'sent')
      await new ViewNakhProfileHandler(native, this.ids).execute({
        ...this.envelope(nav, updateId),
        commandType: 'nakh.view-profile',
        data: { nakhId: item.nakhId, expectedVersion: nav.version },
      });
    const store = new PostgresNakhProfileStore(this.database, this.environment, nav.actor, 300),
      detail = await store.detail(nav.reference);
    const current = async (): Promise<boolean> => {
      await this.current(recipient, nav.actor);
      return store.detailIsCurrent(nav.reference!, detail);
    };
    if (detail.telegramUserId !== recipient) denied();
    const base = {
      ...nav,
      version: (await native.readDetail(nav.actor.userId, nav.reference)).version,
    };
    const actions = [
      await this.button(recipient, base, t('nakh.ui.accept'), {
        action: 'finish',
        field: 'received',
        reference: nav.reference,
      }),
      await this.button(recipient, base, t('nakh.ui.close'), {
        action: 'reject',
        field: 'received',
        reference: nav.reference,
      }),
    ];
    const report = async (photoId?: string): Promise<Button> => ({
      text: t('report.title'),
      callback_data: await this.tokens(recipient, nav.actor, 'report').button({
        actor: nav.actor,
        version: 1,
        screen: 'report',
        action: 'begin',
        field: 'received_nakh',
        code: nav.reference,
        group: group(operation([nav.actor, nav.reference, 'report', photoId])),
        ...(photoId ? { photoId } : {}),
      }),
    });
    const footer = await this.footer(recipient, nav, t);
    for (const [index, photo] of detail.photos.entries()) {
      if (!(await current())) denied();
      await this.photos.send(
        {
          viewerUserId: nav.actor.userId,
          telegramUserId: recipient,
          caption: t('profile.ui.photo', {
            name: detail.name,
            position: index + 1,
            total: detail.photos.length,
          }),
          keyboard: [
            actions,
            ...(this.reportsEnabled ? [[await report(photo.photoId)]] : []),
            footer,
          ],
          protectContent: true,
          photo: {
            variantType: 'thumbnail',
            cachePolicy: 'no-store',
            expiresAt: new Date(photo.authority.expiresAt * 1000).toISOString(),
            deliveryUrl: this.signer.sign({
              ...photo.source,
              purpose: 'profile_detail',
              variant: 'thumbnail',
            }),
          },
        },
        current,
      );
    }
    for (const text of fullProfileTextParts(detail, t)) {
      if (!(await current())) denied();
      await this.send(recipient, nav, text, [
        actions,
        ...(this.reportsEnabled ? [[await report()]] : []),
        footer,
      ]);
    }
  }
  private async action(
    recipient: string,
    nav: Nav,
    t: Render,
    updateId: number,
    text?: string,
  ): Promise<void> {
    await this.current(recipient, nav.actor, nav.action !== 'home');
    if (nav.action === 'home') {
      if (!this.home) denied();
      await this.home(recipient, nav.actor);
      return;
    }
    if (nav.action === 'nakh_credits') {
      if (!this.credits) denied();
      await this.credits(recipient, nav.actor);
      return;
    }
    if (nav.action === 'resume') return this.root(recipient, nav, t);
    if (nav.action === 'page') return this.page(recipient, nav, t);
    if (nav.action === 'detail') return this.detail(recipient, nav, t);
    if (nav.action === 'preview') return this.profile(recipient, nav, t, updateId);
    if (!nav.reference || !nav.group) denied();
    const envelope = this.envelope(nav, updateId);
    if (nav.action === 'finish' || nav.action === 'reject') {
      if (nav.field !== 'received') denied();
      const data = { nakhId: nav.reference, expectedVersion: nav.version },
        store = new PostgresDeliveredNakhStore(this.database, nav.actor);
      if (nav.action === 'finish')
        await new AcceptNakhHandler(store, this.ids).execute({
          ...envelope,
          commandType: 'nakh.accept',
          data,
        });
      else
        await new RejectNakhHandler(store, this.ids).execute({
          ...envelope,
          commandType: 'nakh.reject',
          data,
        });
      await this.send(
        recipient,
        nav,
        t(nav.action === 'finish' ? 'nakh.ui.accepted' : 'nakh.ui.closed'),
        [await this.footer(recipient, nav, t)],
      );
      return;
    }
    const drafts = new PostgresNakhCustomerReadStore(this.database, nav.actor);
    if (nav.action === 'pick' && (nav.field === 'edit' || nav.field === 'cancel')) {
      const item = await drafts.detail(nav.reference);
      if (item.status !== 'pending_payment' || item.version !== nav.version) denied();
      if (nav.field === 'edit') {
        await this.current(recipient, nav.actor);
        const id = await this.client.sendPrompt(recipient, t('nakh.ui.edit_prompt'));
        await this.tokens(recipient, nav.actor).prompt(id, { ...nav, action: 'reply' });
        return;
      }
      await this.send(recipient, nav, t('nakh.ui.cancel_info'), [
        [
          await this.button(recipient, nav, t('nakh.ui.cancel_like'), {
            action: 'clear',
            field: 'cancel',
            reference: nav.reference,
            reason: 'converted_to_like',
          }),
          await this.button(recipient, nav, t('nakh.ui.cancel_reject'), {
            action: 'clear',
            field: 'cancel',
            reference: nav.reference,
            reason: 'converted_to_not_interested',
          }),
        ],
        await this.footer(recipient, nav, t),
      ]);
      return;
    }
    const store = new PostgresPendingNakhStore(this.database, nav.actor);
    if (nav.action === 'reply' && nav.field === 'edit' && typeof text === 'string') {
      await new EditPendingNakhHandler(store, this.ids).execute({
        ...envelope,
        commandType: 'nakh.edit-pending',
        data: { pendingNakhId: nav.reference, expectedVersion: nav.version, text },
      });
      await this.send(recipient, nav, t('nakh.ui.saved'), [await this.footer(recipient, nav, t)]);
      return;
    }
    if (
      nav.action === 'clear' &&
      nav.field === 'cancel' &&
      (nav.reason === 'converted_to_like' || nav.reason === 'converted_to_not_interested')
    ) {
      await new CancelPendingNakhHandler(store, this.ids).execute({
        ...envelope,
        commandType: 'nakh.cancel-pending',
        data: {
          pendingNakhId: nav.reference,
          expectedVersion: nav.version,
          resolution: nav.reason,
        },
      });
      await this.send(recipient, nav, t('nakh.ui.cancelled'), [
        await this.footer(recipient, nav, t),
      ]);
      return;
    }
    denied();
  }
  public async handle(input: unknown): Promise<Outcome> {
    const root = record(structuredClone(input)),
      message = record(root?.message),
      callback = record(root?.callback_query);
    const command = message?.text === '/nakhes',
      data = typeof callback?.data === 'string' ? callback.data : undefined;
    const reply = record(message?.reply_to_message),
      replyBot = record(reply?.from),
      replyId =
        replyBot?.is_bot === true &&
        String(replyBot.id) === this.botId &&
        Number.isSafeInteger(reply?.message_id)
          ? Number(reply?.message_id)
          : undefined;
    if (!command && !data?.startsWith('m9n:') && replyId === undefined) return 'unhandled';
    if (data !== undefined && !data.startsWith('m9n:')) return 'unhandled';
    const from = record(callback?.from ?? message?.from),
      chat = record(callback ? record(callback.message)?.chat : message?.chat),
      bot = record(record(callback?.message)?.from),
      sender = from?.id,
      updateId = root?.update_id;
    if (
      typeof sender !== 'number' ||
      !Number.isSafeInteger(sender) ||
      sender < 1 ||
      from?.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== sender ||
      typeof updateId !== 'number' ||
      !Number.isSafeInteger(updateId) ||
      updateId < 0 ||
      (callback !== undefined && message !== undefined) ||
      (callback &&
        (bot?.is_bot !== true ||
          String(bot.id) !== this.botId ||
          typeof callback.id !== 'string' ||
          !callback.id.length ||
          callback.id.length > 128))
    )
      throw new ApplicationError('invalid_request', 'error.interaction.unavailable', 400);
    const recipient = String(sender),
      life = await new PostgresTelegramUserResolver(this.database).resolveProductLife(recipient);
    if (!life) return 'unhandled';
    let nav: Nav | undefined;
    if (command) {
      const grant = await new PostgresUserSessionStore(this.database).issue(
        life,
        operation(['entry', this.botId, recipient, updateId]),
      );
      if (!grant) denied();
      nav = {
        actor: { kind: 'user', ...life, sessionGrantId: grant.id },
        version: 1,
        screen: 'nakhes',
        action: 'resume',
      };
    } else
      nav = data
        ? await this.tokens(recipient, life).callback(data)
        : await this.tokens(recipient, life).reply(replyId!);
    if (!nav && replyId !== undefined) return 'unhandled';
    const t = await this.renderer(recipient);
    const notice = async (
      key: 'signup.ui.expired' | 'error.rate_limit.exceeded' | 'nakh.ui.unavailable',
    ): Promise<Outcome> => {
      if (callback)
        await this.client.answerCallback(String(callback.id), t(key)).catch(() => undefined);
      else if (nav) {
        // These public notices go only to the verified private sender. Requiring
        // the expired grant again would turn a safe denial into a webhook retry
        // loop. Never issue a replacement grant or read the selected source.
        await this.screens.sendPrivateText({
          botId: this.botId,
          telegramUserId: recipient,
          text: t(key),
          keyboard: [],
        });
      }
      return 'notice';
    };
    if (!nav) return notice('signup.ui.expired');
    if (
      !(
        await this.limiter.consume({
          scope: 'telegram_nakhes',
          subject: life.userId,
          limit: 30,
          windowSeconds: 60,
        })
      ).allowed
    )
      return notice('error.rate_limit.exceeded');
    try {
      await this.current(recipient, nav.actor, nav.action !== 'home');
      // An expired provider callback acknowledgment is not a reason to discard a
      // retried, still-authorized native command or private delivery.
      if (callback) await this.client.answerCallback(String(callback.id)).catch(() => undefined);
      await this.action(
        recipient,
        nav,
        t,
        updateId,
        typeof message?.text === 'string' ? message.text : undefined,
      );
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500)
        return notice(error.status === 401 ? 'signup.ui.expired' : 'nakh.ui.unavailable');
      throw error;
    }
  }
}
export function createTelegramNakhCustomerRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    redis: ReturnType<typeof createRedisConnection>;
    resolveSecret?: (ref: string) => string;
    home?: (recipient: string, actor: UserSessionActor) => Promise<void>;
    credits?: (recipient: string, actor: UserSessionActor) => Promise<void>;
  }>,
): TelegramNakhCustomerRuntimePort {
  if (!input.config.telegram.nakhEnabled)
    return {
      enabled: false,
      handle: () => Promise.resolve('unhandled'),
      entryButton: () =>
        Promise.reject(new ApplicationError('capability_denied', 'error.capability.denied', 403)),
    };
  const resolve = input.resolveSecret ?? resolveSecretReference,
    config = input.config;
  const key = (ref: string): Buffer => {
    const raw = resolve(ref),
      value = Buffer.from(raw, 'base64url');
    if (value.length !== 32 || value.toString('base64url') !== raw)
      throw new Error('Nakh credentials unavailable.');
    return value;
  };
  const token = resolve(config.telegram.botTokenRef),
    match = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(token);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('Nakh bot unavailable.');
  const signing = key(config.media.signingKeyRef),
    audience = key(config.media.audienceKeyRef),
    action = key(config.telegram.actionTokenKeyRef);
  if (signing.equals(audience)) throw new Error('Nakh signing and audience keys must differ.');
  const origin = `https://${config.media.cdnHost}`;
  return new TelegramNakhCustomerRuntime(
    input.database,
    input.redis,
    config.redis.queuePrefix,
    match[1]!,
    action,
    config.environment === 'local' ? 'development' : config.environment,
    new TelegramBotApiMenuClient(token),
    new TelegramLockedLikedByScreenRelay(token),
    new TelegramCandidateMediaRelay(
      origin,
      token,
      new HmacMediaAudienceCredentials(origin, {
        currentKeyId: config.media.audienceKeyId,
        keys: new Map([[config.media.audienceKeyId, audience]]),
      }),
    ),
    new MediaDeliveryUrlSigner(
      origin,
      new HmacMediaDeliveryTokens({
        currentKeyId: config.media.signingKeyId,
        keys: new Map([[config.media.signingKeyId, signing]]),
      }),
    ),
    new RedisRateLimiter(input.redis, config.redis.queuePrefix),
    config.telegram.reportsEnabled,
    input.home,
    input.credits,
  );
}
