import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  OpenChatForMatchHandler,
  GetChatPageHandler,
  MarkChatReadHandler,
  ChangeChatMuteHandler,
  SendPredefinedQuestionHandler,
  SendPredefinedAnswerHandler,
  SendTextMessageHandler,
  UnmatchHandler,
  SpendCreditsForPaidActionHandler,
  type UserSessionActor,
  type ChatPageCursor,
  type StoredChatPage,
} from '@nakh/application';
import { ApplicationError, getPaidActionPrice } from '@nakh/domain';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { CatalogRenderer, M6_LOCALIZATION_ENTRIES, M9_CHAT_TEXTS } from '@nakh/localization';
import {
  PostgresChatStore,
  PostgresChatStateStore,
  PostgresUnmatchStore,
  PostgresPaidActionStore,
  PostgresUserSessionStore,
  PostgresTelegramUserResolver,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresSignupStore,
  SystemIdGenerator,
  requireCurrentUserSession,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  RedisOwnedOpaqueTokenStore,
  RedisRateLimiter,
  type createRedisConnection,
} from '@nakh/queue-redis';
import { TelegramBotApiMenuClient } from '@nakh/telegram';
import {
  SignupNavigationTokens,
  signupRecord as record,
  type SignupNavigation as Nav,
} from './signup-navigation.js';

export interface TelegramChatRuntimePort {
  readonly enabled: boolean;
  open(recipient: string, actor: UserSessionActor): Promise<void>;
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
}
type ChatMessage = StoredChatPage['items'][number];
type TelegramMenuButton = Parameters<
  TelegramBotApiMenuClient['sendMenu']
>[1]['replyMarkup']['inline_keyboard'][number][number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// The immutable prompt catalog uses md5-derived PostgreSQL UUIDs.
const CATALOG_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
function unavailable(): ApplicationError {
  return new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
}
function operation(parts: readonly unknown[]): string {
  const b = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16);
  b[6] = (b[6]! & 15) | 0x50;
  b[8] = (b[8]! & 63) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Original primary grants enter through open or signed navigation. No issuance,
 * current-life replacement or plaintext message cache belongs to this transport. */
export class TelegramChatRuntime implements TelegramChatRuntimePort {
  public readonly enabled = true;
  private renderer: CatalogRenderer | undefined;
  private readonly users: PostgresTelegramUserResolver;
  private readonly sessions: PostgresUserSessionStore;
  private readonly ids = new SystemIdGenerator();
  public constructor(
    private readonly config: AppConfig,
    private readonly database: NakhDatabase,
    private readonly redis: ReturnType<typeof createRedisConnection>,
    private readonly botId: string,
    private readonly key: Uint8Array,
    private readonly client: TelegramBotApiMenuClient,
    private readonly limiter: Pick<RedisRateLimiter, 'consume'>,
  ) {
    this.key = Uint8Array.from(key);
    this.users = new PostgresTelegramUserResolver(database);
    this.sessions = new PostgresUserSessionStore(database);
  }
  public async onModuleInit(): Promise<void> {
    if (
      (await this.database
        .selectFrom('platform.schema_migrations')
        .select('name')
        .where('name', '=', '000159_m9_chat_presentation.sql')
        .executeTakeFirst()) === undefined
    )
      throw new Error('Chat schema unavailable.');
    const locales = await this.database
      .selectFrom('catalog.locales')
      .select(['code', 'is_default'])
      .where('is_active', '=', true)
      .execute();
    const defaultLocale = locales.find((l) => l.is_default)?.code;
    if (defaultLocale === undefined) throw new Error('Chat localization unavailable.');
    const expected = {
      ...Object.fromEntries(M6_LOCALIZATION_ENTRIES.map((e) => [e.key, e.english])),
      ...M9_CHAT_TEXTS,
      'notification.chat_unlock_safety.title': '',
      'notification.chat_unlock_safety.body': '',
    };
    const catalogs: Record<string, Readonly<Record<string, string>>> = {};
    const variables = (text: string): string =>
      [...new Set([...text.matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((m) => m[1]))].sort().join(',');
    for (const locale of locales) {
      const catalog = await new PostgresLocalizationStore(this.database).loadActiveCatalog(
        locale.code,
      );
      for (const [name, english] of Object.entries(expected)) {
        const value = catalog.messages[name];
        if (
          typeof value !== 'string' ||
          value.trim() === '' ||
          variables(value) !== variables(english)
        )
          throw new Error('Chat localization unavailable.');
      }
      catalogs[locale.code] = Object.freeze({ ...catalog.messages });
    }
    this.renderer = new CatalogRenderer(Object.freeze(catalogs), defaultLocale);
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
      'chat',
    );
  }
  private async current(recipient: string, actor: UserSessionActor): Promise<void> {
    const copied = { ...actor };
    const life = await this.users.resolveProductLife(recipient);
    if (
      life?.userId !== copied.userId ||
      life.productEpoch !== copied.productEpoch ||
      (await this.sessions.current(copied, copied.sessionGrantId)) === undefined
    )
      throw new ApplicationError('unauthorized', 'error.chat.unavailable', 401);
  }
  private async text(
    actor: UserSessionActor,
    key: string,
    variables: Record<string, string | number> = {},
  ): Promise<string> {
    const context = await new PostgresIdentityStore(this.database).getByUserId(actor.userId);
    if (context === undefined || this.renderer === undefined) throw unavailable();
    return this.renderer.render(context.uiLocale, { key, variables });
  }
  private async send(
    recipient: string,
    actor: UserSessionActor,
    text: string,
    buttons: TelegramMenuButton[][] = [],
  ): Promise<void> {
    await this.current(recipient, actor);
    await this.client.sendMenu(recipient, { text, replyMarkup: { inline_keyboard: buttons } });
  }
  private async notice(recipient: string, actor: UserSessionActor, key: string): Promise<void> {
    await this.send(recipient, actor, await this.text(actor, key));
  }
  private nav(actor: UserSessionActor, screen: string, fields: Partial<Nav> = {}): Nav {
    return {
      ...fields,
      actor: Object.freeze({ ...actor }),
      version: fields.version ?? 1,
      screen,
      action: fields.action ?? 'resume',
      group: randomBytes(12).toString('base64url'),
    };
  }
  public async open(recipient: string, actor: UserSessionActor): Promise<void> {
    const original = Object.freeze({ ...actor });
    await this.current(recipient, original);
    await this.list(recipient, this.nav(original, 'chat_list'));
  }
  private async list(recipient: string, nav: Nav): Promise<void> {
    const actor = nav.actor;
    const rows = await this.database.transaction().execute(async (tx) => {
      await requireCurrentUserSession(tx, actor.userId, actor);
      let query = tx
        .selectFrom('matching.current_match_lives as match')
        .innerJoin('chat.chat_sessions as session', 'session.match_id', 'match.id')
        .innerJoin('chat.chat_participants as participant', (j) =>
          j
            .onRef('participant.chat_session_id', '=', 'session.id')
            .on('participant.user_id', '=', actor.userId),
        )
        .innerJoin('interaction.user_pair_states as pair', (j) =>
          j
            .onRef('pair.user_low_id', '=', 'match.user_low_id')
            .onRef('pair.user_high_id', '=', 'match.user_high_id'),
        )
        .select(['match.id', 'session.id as chatId', 'participant.version'])
        .where('match.status', '=', 'active')
        .where('session.status', '=', 'active')
        .where('pair.state', '=', 'matched')
        .orderBy('match.id')
        .limit(21);
      if (nav.reference !== undefined) {
        if (!UUID.test(nav.reference)) throw unavailable();
        query = query.where('match.id', '>', nav.reference);
      }
      return query.execute();
    });
    const tokens = this.tokens(recipient, actor),
      buttons: TelegramMenuButton[][] = [];
    for (const row of rows.slice(0, 20)) {
      const alias = createHmac('sha256', this.key)
        .update(JSON.stringify(['chat-alias', actor.userId, actor.productEpoch, row.id]))
        .digest('hex')
        .slice(0, 8)
        .toUpperCase();
      buttons.push([
        {
          text: (await this.text(actor, 'chat.title')) + ' ' + alias,
          callback_data: await tokens.button(
            this.nav(actor, 'chat_view', {
              reference: row.id,
              field: row.chatId,
              version: row.version,
            }),
          ),
        },
      ]);
    }
    if (rows.length > 20)
      buttons.push([
        {
          text: await this.text(actor, 'chat.history.older'),
          callback_data: await tokens.button(
            this.nav(actor, 'chat_list', { action: 'page', reference: rows[19]!.id }),
          ),
        },
      ]);
    await this.send(
      recipient,
      actor,
      await this.text(actor, rows.length === 0 ? 'chat.list.empty' : 'chat.list.title'),
      buttons,
    );
  }
  /** M6 ports resolve only the already verified opaque channel selection. The
   * channel's MAC is never accepted as an independently supplied native ID. */
  private services(
    nav: Nav,
    identity: string,
  ): {
    store: PostgresChatStore;
    state: PostgresChatStateStore;
    references: {
      resolveMatchAction: (token: string, userId: string) => Promise<string | undefined>;
      resolveChatAction: (token: string, userId: string) => Promise<string | undefined>;
      issueChatAction: (userId: string, chatId: string, requestId: string) => Promise<string>;
      resolveMessageCursor: (token: string, userId: string) => Promise<ChatPageCursor | undefined>;
      issueMessageCursor: (
        userId: string,
        cursor: ChatPageCursor,
        requestId: string,
      ) => Promise<string>;
      resolveLikedByAction: () => Promise<undefined>;
      resolveChatUnlockAction: (token: string, userId: string) => Promise<string | undefined>;
    };
    chatToken: string;
    matchToken: string;
    cursorToken: string;
    cursor: () => ChatPageCursor | undefined;
  } {
    if (
      nav.reference === undefined ||
      nav.field === undefined ||
      !UUID.test(nav.reference) ||
      !UUID.test(nav.field)
    )
      throw unavailable();
    const tag = createHmac('sha256', this.key)
      .update(JSON.stringify(['chat-native-port', nav.actor, identity]))
      .digest('base64url');
    const core = (purpose: string): string => `v1.${purpose}.${tag.slice(0, 22)}.${tag.slice(22)}`;
    const chatToken = core('ch'),
      matchToken = core('mt'),
      cursorToken = core('cm');
    let cursor: ChatPageCursor | undefined;
    const match = (token: string, userId: string): Promise<string | undefined> =>
      Promise.resolve(
        userId === nav.actor.userId && token === matchToken ? nav.reference : undefined,
      );
    return {
      store: new PostgresChatStore(this.database, nav.actor),
      state: new PostgresChatStateStore(this.database, nav.actor),
      chatToken,
      matchToken,
      cursorToken,
      cursor: () => cursor,
      references: {
        resolveMatchAction: match,
        resolveChatUnlockAction: match,
        resolveLikedByAction: () => Promise.resolve(undefined),
        resolveChatAction: (token, userId) =>
          Promise.resolve(
            userId === nav.actor.userId && token === chatToken ? nav.field : undefined,
          ),
        issueChatAction: (userId, chatId) => {
          if (userId !== nav.actor.userId || chatId !== nav.field) throw unavailable();
          return Promise.resolve(chatToken);
        },
        resolveMessageCursor: (token, userId) =>
          Promise.resolve(
            userId === nav.actor.userId &&
              token === cursorToken &&
              nav.code !== undefined &&
              /^[1-9][0-9]{0,18}$/u.test(nav.code)
              ? { chatSessionId: nav.field!, beforeSequenceNumber: nav.code }
              : undefined,
          ),
        issueMessageCursor: (userId, value) => {
          if (userId !== nav.actor.userId || value.chatSessionId !== nav.field) throw unavailable();
          cursor = { ...value };
          return Promise.resolve(cursorToken);
        },
      },
    };
  }
  private envelope(
    nav: Nav,
    identity: string,
  ): {
    commandId: string;
    requestId: string;
    idempotencyKey: string;
    schemaVersion: 1;
    actor: { kind: 'user'; userId: string };
    occurredAt: string;
    locale: string;
  } {
    const id = operation(['chat', this.botId, nav.actor, identity]);
    return {
      commandId: id,
      requestId: id,
      idempotencyKey: id,
      schemaVersion: 1,
      actor: { kind: 'user', userId: nav.actor.userId },
      occurredAt: new Date().toISOString(),
      locale: 'en',
    };
  }
  private async view(recipient: string, nav: Nav, identity: string): Promise<void> {
    const s = this.services(nav, identity),
      actor = nav.actor;
    const cap = await new OpenChatForMatchHandler(s.store, s.references, {
      show: async (warning) => {
        await this.send(
          recipient,
          actor,
          [await this.text(actor, warning.titleKey), await this.text(actor, warning.bodyKey)].join(
            '\n',
          ),
        );
      },
    }).execute({
      ...this.envelope(nav, identity),
      commandType: 'chat.open-for-match',
      data: { matchActionToken: s.matchToken },
    });
    if (cap.chatSessionId !== nav.field || cap.matchId !== nav.reference) throw unavailable();
    const page = await new GetChatPageHandler(s.state, s.references).execute({
      actor: { kind: 'user', userId: actor.userId },
      requestId: operation(['chat-page', identity, actor]),
      chatActionToken: s.chatToken,
      limit: 10,
      ...(nav.action === 'page' ? { cursor: s.cursorToken } : {}),
    });
    const lines: string[] = [];
    for (const message of page.items.toReversed()) lines.push(await this.message(actor, message));
    if (lines.length > 0) {
      let chunk = '';
      for (const char of lines.join('\n')) {
        if (chunk.length + char.length > 3500) {
          await this.send(recipient, actor, chunk);
          chunk = '';
        }
        chunk += char;
      }
      if (chunk !== '') await this.send(recipient, actor, chunk);
    }
    const tokens = this.tokens(recipient, actor),
      buttons: TelegramMenuButton[][] = [];
    const base = { reference: nav.reference, field: nav.field, version: cap.version };
    const button = async (
      key: string,
      screen: string,
      action: Nav['action'] = 'resume',
      extra: Partial<Nav> = {},
    ): Promise<void> => {
      buttons.push([
        {
          text: await this.text(actor, key),
          callback_data: await tokens.button(
            this.nav(actor, screen, { ...base, ...extra, action }),
          ),
        },
      ]);
    };
    await button('chat.history.refresh', 'chat_view');
    if (s.cursor() !== undefined)
      await button('chat.history.older', 'chat_view', 'page', {
        code: s.cursor()!.beforeSequenceNumber,
      });
    if (cap.canSendPredefined) await button('chat.button.questions', 'chat_questions');
    for (const message of page.items
      .filter((m) => m.sender === 'match' && m.messageType === 'predefined_question')
      .slice(0, 3)) {
      if (message.content !== undefined && 'questionId' in message.content)
        await button('chat.button.questions', 'chat_answers', 'resume', {
          code: message.content.questionId,
        });
    }
    if (cap.canSendText) await button('chat.text.prompt', 'chat_text');
    if (!cap.textUnlocked && cap.canSendPredefined)
      await button('chat.button.unlock', 'chat_unlock');
    await button(cap.muted ? 'chat.button.unmute' : 'chat.button.mute', 'chat_mute', 'save', {
      code: cap.muted ? 'unmute' : 'mute',
    });
    if (page.items[0] !== undefined)
      await button('chat.button.mark_read', 'chat_read', 'save', {
        code: page.items[0].sequenceNumber,
      });
    if (cap.canUnmatch) await button('chat.button.unmatch', 'chat_unmatch');
    buttons.push([
      {
        text: await this.text(actor, 'chat.button.back'),
        callback_data: await tokens.button(this.nav(actor, 'chat_list')),
      },
    ]);
    await this.send(
      recipient,
      actor,
      await this.text(
        actor,
        page.items.length === 0 ? 'chat.empty' : cap.canSendText ? 'chat.unlocked' : 'chat.locked',
      ),
      buttons,
    );
  }
  private async message(actor: UserSessionActor, message: ChatMessage): Promise<string> {
    let text: string;
    if (message.messageType === 'text') text = message.content.text;
    else if (message.messageType === 'system')
      text = await this.text(actor, message.content.textKey, message.content.arguments);
    else text = await this.text(actor, message.content.textKey);
    return (
      (await this.text(
        actor,
        message.sender === 'self' ? 'chat.history.self' : 'chat.history.peer',
      )) +
      ': ' +
      text
    );
  }
  private async choices(recipient: string, nav: Nav): Promise<void> {
    const s = this.services(nav, 'choices');
    const capability = await s.store.loadForSession(nav.actor.userId, nav.field!);
    if (!capability.canSendPredefined || capability.matchId !== nav.reference) throw unavailable();
    const actor = nav.actor,
      tokens = this.tokens(recipient, actor),
      buttons: TelegramMenuButton[][] = [];
    const group = randomBytes(12).toString('base64url');
    if (nav.screen === 'chat_answers') {
      if (nav.code === undefined || !CATALOG_ID.test(nav.code)) throw unavailable();
      const rows = await this.database
        .selectFrom('chat.predefined_answers')
        .select(['id', 'text_key'])
        .where('question_id', '=', nav.code)
        .where('is_active', '=', true)
        .orderBy('id')
        .limit(20)
        .execute();
      for (const row of rows)
        buttons.push([
          {
            text: (await this.text(actor, row.text_key)).slice(0, 64),
            callback_data: await tokens.button({
              ...this.nav(actor, 'chat_answer_send', {
                ...nav,
                action: 'pick',
                selection: [row.id],
              }),
              group,
            }),
          },
        ]);
    } else {
      const rows = await this.database
        .selectFrom('chat.predefined_questions as question')
        .innerJoin(
          'chat.predefined_question_sets as catalog',
          'catalog.id',
          'question.question_set_id',
        )
        .select(['question.id', 'question.text_key'])
        .where('question.is_active', '=', true)
        .where('catalog.is_active', '=', true)
        .orderBy('question.id')
        .limit(20)
        .execute();
      for (const row of rows)
        buttons.push([
          {
            text: (await this.text(actor, row.text_key)).slice(0, 64),
            callback_data: await tokens.button({
              ...this.nav(actor, 'chat_question_send', { ...nav, action: 'pick', code: row.id }),
              group,
            }),
          },
        ]);
    }
    buttons.push([
      {
        text: await this.text(actor, 'chat.button.back'),
        callback_data: await tokens.button(
          this.nav(actor, 'chat_view', { reference: nav.reference, field: nav.field }),
        ),
      },
    ]);
    await this.send(recipient, actor, await this.text(actor, 'chat.button.questions'), buttons);
  }
  private async execute(
    recipient: string,
    nav: Nav,
    identity: string,
    text?: string,
  ): Promise<void> {
    const s = this.services(nav, identity),
      e = this.envelope(nav, identity);
    const perChat = await this.limiter.consume({
      scope: 'chat_session_write',
      subject: nav.actor.userId + ':' + nav.field!,
      limit: 30,
      windowSeconds: 60,
    });
    if (!perChat.allowed)
      throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429);
    switch (nav.screen) {
      case 'chat_question_send':
        if (nav.code === undefined || !CATALOG_ID.test(nav.code)) throw unavailable();
        await new SendPredefinedQuestionHandler(s.store, s.references, this.ids).execute({
          ...e,
          commandType: 'chat.send-predefined-question',
          data: { chatActionToken: s.chatToken, questionId: nav.code },
        });
        break;
      case 'chat_answer_send':
        if (
          nav.code === undefined ||
          !CATALOG_ID.test(nav.code) ||
          nav.selection?.length !== 1 ||
          !CATALOG_ID.test(nav.selection[0]!)
        )
          throw unavailable();
        await new SendPredefinedAnswerHandler(s.store, s.references, this.ids).execute({
          ...e,
          commandType: 'chat.send-predefined-answer',
          data: { chatActionToken: s.chatToken, questionId: nav.code, answerId: nav.selection[0]! },
        });
        break;
      case 'chat_text':
        if (typeof text !== 'string') throw unavailable();
        await new SendTextMessageHandler(s.store, s.references, this.ids).execute({
          ...e,
          commandType: 'chat.send-text',
          data: { chatActionToken: s.chatToken, text },
        });
        break;
      case 'chat_read':
        if (nav.code === undefined) throw unavailable();
        await new MarkChatReadHandler(s.state, s.references, this.ids).execute({
          ...e,
          commandType: 'chat.mark-read',
          data: { chatActionToken: s.chatToken, throughSequenceNumber: nav.code },
        });
        break;
      case 'chat_mute': {
        if (nav.code !== 'mute' && nav.code !== 'unmute') throw unavailable();
        await new ChangeChatMuteHandler(s.state, s.references, this.ids).execute({
          ...e,
          commandType: 'chat.change-mute',
          data: {
            chatActionToken: s.chatToken,
            muted: nav.code === 'mute',
            expectedVersion: nav.version,
          },
        });
        break;
      }
      case 'chat_unmatch':
        await new UnmatchHandler(
          new PostgresUnmatchStore(this.database, nav.actor),
          s.references,
          this.ids,
        ).execute({
          ...e,
          commandType: 'matching.unmatch',
          data: { matchActionToken: s.matchToken },
        });
        await this.notice(recipient, nav.actor, 'chat.status.closed');
        await this.list(recipient, this.nav(nav.actor, 'chat_list'));
        return;
      case 'chat_unlock':
        await new SpendCreditsForPaidActionHandler(
          new PostgresPaidActionStore(this.database, nav.actor),
          s.references,
          this.ids,
        ).execute({
          ...e,
          commandType: 'billing.spend-credits-for-action',
          data: { target: { type: 'chat_unlock', actionToken: s.matchToken } },
        });
        break;
      default:
        throw unavailable();
    }
    await this.view(
      recipient,
      this.nav(nav.actor, 'chat_view', { reference: nav.reference, field: nav.field }),
      identity,
    );
  }
  private async admit(userId: string): Promise<void> {
    const allowed = await this.limiter.consume({
      scope: 'chat_write',
      subject: userId,
      limit: 60,
      windowSeconds: 60,
    });
    if (!allowed.allowed)
      throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429);
  }
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const root = record(update),
      callback = record(root?.callback_query),
      message = record(callback?.message) ?? record(root?.message),
      reply = record(message?.reply_to_message),
      from = record(callback?.from) ?? record(message?.from),
      chat = record(message?.chat);
    const data = callback?.data;
    if (callback !== undefined && (typeof data !== 'string' || !data.startsWith('m9c:')))
      return 'unhandled';
    if (callback === undefined && reply === undefined) return 'unhandled';
    if (
      !Number.isSafeInteger(root?.update_id) ||
      Number(root?.update_id) < 0 ||
      typeof from?.id !== 'number' ||
      !Number.isSafeInteger(from.id) ||
      from.id <= 0 ||
      from.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== from.id
    )
      throw unavailable();
    const recipient = String(from.id),
      life = await this.users.resolveProductLife(recipient);
    if (life === undefined) return callback === undefined ? 'unhandled' : 'notice';
    const tokens = this.tokens(recipient, life);
    // Bound rejected chat callbacks before their native audit write. Unowned
    // replies must remain available to the other gateway journeys.
    if (callback !== undefined) await this.admit(life.userId);
    const nav =
      callback === undefined
        ? typeof reply?.message_id === 'number'
          ? await tokens.reply(reply.message_id)
          : undefined
        : await tokens.callback(String(data));
    if (nav === undefined) {
      if (callback === undefined) return 'unhandled';
      await new PostgresSignupStore(this.database).recordNavigationDenial(
        life.userId,
        life.productEpoch,
        operation(['chat-invalid', this.botId, life, root?.update_id]),
        'chat',
      );
      return 'notice';
    }
    try {
      if (callback === undefined) await this.admit(life.userId);
      await this.current(recipient, nav.actor);
      const identity =
        callback === undefined
          ? `reply:${String(reply?.message_id)}:${String(message?.message_id)}`
          : String(data);
      if (callback !== undefined) {
        const origin = record(message?.from);
        if (
          origin?.is_bot !== true ||
          String(origin.id) !== this.botId ||
          typeof callback.id !== 'string' ||
          callback.id.length < 1 ||
          callback.id.length > 128 ||
          !Number.isSafeInteger(message?.message_id) ||
          Number(message?.message_id) < 1
        )
          throw unavailable();
        await this.client.answerCallback(callback.id);
        if (nav.action === 'save' || nav.action === 'pick' || nav.action === 'finish') {
          const claim = await tokens.claim(nav, Number(root?.update_id), String(data), nav);
          if (!claim.accepted) {
            if (nav.screen === 'chat_unmatch')
              await this.list(recipient, this.nav(nav.actor, 'chat_list'));
            else
              await this.view(
                recipient,
                this.nav(nav.actor, 'chat_view', { reference: nav.reference, field: nav.field }),
                identity,
              );
            return 'notice';
          }
          await this.execute(recipient, nav, identity);
          return 'notice';
        }
        switch (nav.screen) {
          case 'chat_list':
            await this.list(recipient, nav);
            break;
          case 'chat_view':
            await this.view(recipient, nav, identity);
            break;
          case 'chat_questions':
          case 'chat_answers':
            await this.choices(recipient, nav);
            break;
          case 'chat_text': {
            const cap = await this.services(nav, identity).store.loadForSession(
              nav.actor.userId,
              nav.field!,
            );
            if (!cap.canSendText) throw unavailable();
            await this.current(recipient, nav.actor);
            const prompt = await this.client.sendPrompt(
              recipient,
              await this.text(nav.actor, 'chat.text.prompt'),
            );
            await tokens.prompt(
              prompt,
              this.nav(nav.actor, 'chat_text', { ...nav, action: 'reply' }),
            );
            break;
          }
          case 'chat_unmatch':
          case 'chat_unlock': {
            await this.services(nav, identity).store.loadForSession(nav.actor.userId, nav.field!);
            await this.send(
              recipient,
              nav.actor,
              await this.text(
                nav.actor,
                nav.screen === 'chat_unmatch' ? 'chat.unmatch.confirm' : 'chat.unlock.confirm',
                { credits: getPaidActionPrice('unlock_chat', 'credits').toString() },
              ),
              [
                [
                  {
                    text: await this.text(nav.actor, 'chat.button.confirm'),
                    callback_data: await tokens.button(
                      this.nav(nav.actor, nav.screen, { ...nav, action: 'finish' }),
                    ),
                  },
                ],
                [
                  {
                    text: await this.text(nav.actor, 'chat.button.cancel'),
                    callback_data: await tokens.button(
                      this.nav(nav.actor, 'chat_view', {
                        reference: nav.reference,
                        field: nav.field,
                      }),
                    ),
                  },
                ],
              ],
            );
            break;
          }
          default:
            throw unavailable();
        }
      } else {
        const origin = record(reply?.from),
          replyChat = record(reply?.chat);
        if (
          origin?.is_bot !== true ||
          String(origin.id) !== this.botId ||
          replyChat?.type !== 'private' ||
          replyChat.id !== from.id ||
          nav.screen !== 'chat_text' ||
          !Number.isSafeInteger(message?.message_id) ||
          typeof message?.text !== 'string' ||
          Object.keys(message).some((k) =>
            [
              'photo',
              'document',
              'audio',
              'video',
              'voice',
              'sticker',
              'animation',
              'dice',
              'contact',
              'location',
              'poll',
              'forward_origin',
              'via_bot',
            ].includes(k),
          )
        )
          throw unavailable();
        await this.execute(recipient, nav, identity, message.text);
      }
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) {
        if ((await this.sessions.current(nav.actor, nav.actor.sessionGrantId)) !== undefined)
          await this.notice(recipient, nav.actor, 'error.chat.unavailable');
        return 'notice';
      }
      throw new ApplicationError('internal_error', 'error.chat.unavailable', 500);
    }
  }
}
export function createTelegramChatRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    redis: ReturnType<typeof createRedisConnection>;
    resolveSecret?: (reference: string) => string;
  }>,
): TelegramChatRuntimePort {
  if (!input.config.telegram.chatEnabled)
    return {
      enabled: false,
      open: () => Promise.reject(unavailable()),
      handle: () => Promise.resolve('unhandled'),
    };
  const resolve = input.resolveSecret ?? resolveSecretReference,
    token = resolve(input.config.telegram.botTokenRef),
    bot = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(token),
    encoded = resolve(input.config.telegram.actionTokenKeyRef),
    key = Buffer.from(encoded, 'base64url');
  if (
    bot === null ||
    !Number.isSafeInteger(Number(bot[1])) ||
    key.length !== 32 ||
    key.toString('base64url') !== encoded
  )
    throw new Error('Chat credentials unavailable.');
  return new TelegramChatRuntime(
    input.config,
    input.database,
    input.redis,
    bot[1]!,
    key,
    new TelegramBotApiMenuClient(token),
    new RedisRateLimiter(input.redis, input.config.redis.queuePrefix),
  );
}
