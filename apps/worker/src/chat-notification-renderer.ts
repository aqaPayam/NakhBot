import { randomBytes } from 'node:crypto';
import type {
  LocalizationStore,
  TelegramNotificationProjection,
  UserSessionActor,
} from '@nakh/application';
import { CatalogRenderer, M6_LOCALIZATION_ENTRIES, M9_CHAT_TEXTS } from '@nakh/localization';
import {
  PostgresUserSessionStore,
  PostgresTelegramUserResolver,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { RedisOwnedOpaqueTokenStore, type createRedisConnection } from '@nakh/queue-redis';
import { SignupNavigationTokens, telegramChatAlias, type SignupNavigation } from '@nakh/telegram';
import { WorkerNotificationRenderer } from './notification-renderer.js';
import type {
  NotificationRendererPort,
  RenderedNotification,
} from './notification-delivery-processor.js';

/** Renders the native stored message only. No Telegram forwarding, peer transport
 * identity, private-body cache, or grant issuance belongs to this adapter. */
export class WorkerChatNotificationRenderer implements NotificationRendererPort {
  private readonly key: Uint8Array;
  private readonly generic: WorkerNotificationRenderer;
  public constructor(
    private readonly database: NakhDatabase,
    private readonly localization: Pick<LocalizationStore, 'loadActiveCatalog'>,
    private readonly redis: ReturnType<typeof createRedisConnection>,
    private readonly prefix: string,
    private readonly botId: string,
    key: Uint8Array,
  ) {
    if (key.byteLength !== 32) throw Error('Chat navigation unavailable.');
    this.key = Uint8Array.from(key);
    this.generic = new WorkerNotificationRenderer(localization);
  }
  public async verifyReadiness(): Promise<void> {
    if (
      (await this.database
        .selectFrom('platform.schema_migrations')
        .select('name')
        .where('name', '=', '000160_m9_chat_relay_presentation.sql')
        .executeTakeFirst()) === undefined
    )
      throw Error('Chat relay schema unavailable.');
    const locales = await this.database
      .selectFrom('catalog.locales')
      .select('code')
      .where('is_active', '=', true)
      .execute();
    for (const locale of locales) {
      const catalog = await this.localization.loadActiveCatalog(locale.code);
      const required = {
        ...Object.fromEntries(M6_LOCALIZATION_ENTRIES.map(({ key, english }) => [key, english])),
        ...M9_CHAT_TEXTS,
        'notification.chat_unlock_safety.title': 'Stay safe',
        'notification.chat_unlock_safety.body': 'Keep personal and financial information private.',
      };
      for (const [key, text] of Object.entries(required)) {
        const value = catalog.messages[key];
        if (
          typeof value !== 'string' ||
          value.trim() === '' ||
          [...value.matchAll(/\{([A-Za-z0-9_]+)\}/gu)]
            .map((m) => m[1])
            .sort()
            .join(',') !==
            [...text.matchAll(/\{([A-Za-z0-9_]+)\}/gu)]
              .map((m) => m[1])
              .sort()
              .join(',')
        )
          throw Error('Chat relay localization unavailable.');
      }
    }
  }
  private tokens(recipient: string, actor: UserSessionActor): SignupNavigationTokens {
    return new SignupNavigationTokens(
      new RedisOwnedOpaqueTokenStore(this.redis, this.prefix, actor),
      this.key,
      this.botId,
      recipient,
      actor,
      Date.now,
      'chat',
    );
  }
  private async current(recipient: string, actor: UserSessionActor): Promise<boolean> {
    const life = await new PostgresTelegramUserResolver(this.database).resolveProductLife(
      recipient,
    );
    return (
      life?.userId === actor.userId &&
      life.productEpoch === actor.productEpoch &&
      (await new PostgresUserSessionStore(this.database).current(actor, actor.sessionGrantId)) !==
        undefined
    );
  }
  public async render(input: TelegramNotificationProjection): Promise<RenderedNotification> {
    const projection = structuredClone(input),
      chat = projection.chat;
    if (chat === undefined) return this.generic.render(projection);
    const catalog = await this.localization.loadActiveCatalog(projection.locale),
      renderer = new CatalogRenderer(
        { [catalog.resolvedLocale]: catalog.messages },
        catalog.resolvedLocale,
      );
    const t = (key: string, variables: Readonly<Record<string, string | number>> = {}): string =>
      renderer.render(catalog.resolvedLocale, { key, variables });
    const message = chat.message;
    let body =
      message.messageType === 'text'
        ? message.content.text
        : message.messageType === 'system'
          ? t(message.content.textKey, message.content.arguments)
          : t(message.content.textKey);
    if (chat.mustShowSafetyWarning && message.messageType === 'text')
      body = [
        t('notification.chat_unlock_safety.title'),
        t('notification.chat_unlock_safety.body'),
        body,
      ].join('\n');
    const title = t('chat.title') + ' ' + telegramChatAlias(this.key, chat, chat.matchId),
      actor = chat.replyActor;
    if (actor === undefined || !(await this.current(projection.telegramUserId, actor)))
      return { title, body: body + '\n' + t('chat.relay.resume'), format: 'plain' };
    const captured = Object.freeze({ ...actor }),
      base = {
        actor: captured,
        version: chat.version,
        reference: chat.matchId,
        field: chat.chatSessionId,
        group: randomBytes(12).toString('base64url'),
      };
    const token = await this.tokens(projection.telegramUserId, captured).button({
      ...base,
      screen: 'chat_view',
      action: 'resume',
    });
    const state: SignupNavigation = Object.freeze({
      ...base,
      screen: 'chat_text',
      action: 'reply',
    });
    return {
      title,
      body: body + (chat.canReplyWithText ? '\n' + t('chat.relay.reply') : ''),
      format: 'plain',
      replyMarkup: { inline_keyboard: [[{ text: t('chat.relay.open'), callback_data: token }]] },
      ...(chat.canReplyWithText
        ? { replyBinding: { recipient: projection.telegramUserId, state } }
        : {}),
    };
  }
  public async delivered(
    rendered: RenderedNotification,
    providerMessageKey: string,
  ): Promise<void> {
    const binding = rendered.replyBinding;
    if (binding === undefined) return;
    const match = /^telegram:([1-9][0-9]{0,15})$/u.exec(providerMessageKey),
      messageId = Number(match?.[1]);
    if (
      match === null ||
      !Number.isSafeInteger(messageId) ||
      !(await this.current(binding.recipient, binding.state.actor))
    )
      return;
    await this.tokens(binding.recipient, binding.state.actor).prompt(messageId, binding.state);
  }
}
