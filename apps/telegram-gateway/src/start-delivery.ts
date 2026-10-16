import { routeStart, type IdentityContextSnapshot } from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { ApplicationError } from '@nakh/domain';
import { CatalogRenderer } from '@nakh/localization';
import {
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresTelegramUserResolver,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { TelegramBotApiMenuClient, type TelegramStartAdapter } from '@nakh/telegram';

type StartAdapter = Pick<TelegramStartAdapter, 'handle'>;
type Life = Readonly<{ userId: string; productEpoch: number; accountVersion: number }>;
type State = Readonly<{ life: Life; context: IdentityContextSnapshot }>;
type ReadState = (telegramUserId: string) => Promise<State | undefined>;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
function unavailable(): ApplicationError {
  return new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
}

/** Delivers only a public route title. It issues no product/session/action grants.
 * The controller must authenticate the webhook and run M8 controls first. */
export class TelegramStartDelivery implements StartAdapter {
  public constructor(
    private readonly adapter: StartAdapter,
    private readonly readState: ReadState,
    private readonly render: (context: IdentityContextSnapshot) => Promise<string>,
    private readonly send: (telegramUserId: string, text: string) => Promise<void>,
  ) {}

  public async handle(update: unknown): ReturnType<StartAdapter['handle']> {
    const root = record(update),
      message = record(root?.message);
    if (typeof message?.text !== 'string' || !/^\/start(?:\s|$)/u.test(message.text))
      return { handled: false };
    const from = record(message.from),
      chat = record(message.chat),
      sender = from?.id;
    if (
      typeof root?.update_id !== 'number' ||
      !Number.isSafeInteger(root.update_id) ||
      root.update_id < 0 ||
      root.callback_query !== undefined ||
      typeof sender !== 'number' ||
      !Number.isSafeInteger(sender) ||
      sender <= 0 ||
      from?.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== sender
    )
      throw new ApplicationError('invalid_request', 'error.identity.user_context_invalid', 400);
    const telegramUserId = String(sender);
    try {
      const before = await this.readState(telegramUserId);
      const result = await this.adapter.handle(update);
      if (!result.handled) return result;
      // Registration receipts can contain an earlier route or locale on replay.
      const state = await this.readState(telegramUserId);
      if (
        state === undefined ||
        state.life.userId !== result.userId ||
        state.context.userId !== result.userId ||
        state.life.accountVersion !== state.context.accountVersion ||
        (before === undefined
          ? state.life.productEpoch !== 0
          : before.life.userId !== state.life.userId ||
            before.life.productEpoch !== state.life.productEpoch)
      )
        throw unavailable();
      const text = await this.render(state.context);
      if (text.length < 1 || text.length > 4096) throw new Error('Invalid start title.');
      const current = await this.readState(telegramUserId);
      if (
        current === undefined ||
        current.life.userId !== state.life.userId ||
        current.life.productEpoch !== state.life.productEpoch ||
        current.life.accountVersion !== state.life.accountVersion ||
        current.context.userId !== state.context.userId ||
        current.context.accountVersion !== state.context.accountVersion ||
        current.context.settingsVersion !== state.context.settingsVersion ||
        current.context.entryRoute !== state.context.entryRoute ||
        current.context.uiLocale !== state.context.uiLocale
      )
        throw unavailable();
      await this.send(telegramUserId, text);
      return { ...result, view: routeStart(state.context.entryRoute) };
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      // Provider errors can include the bot token in their URL or response body.
      throw new ApplicationError('internal_error', 'error.identity.user_context_invalid', 500);
    }
  }
}

export function createTelegramStartDelivery(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    adapter: StartAdapter;
    resolveSecret?: (reference: string) => string;
  }>,
): StartAdapter {
  if (!input.config.telegram.startDeliveryEnabled) return input.adapter;
  const token = (input.resolveSecret ?? resolveSecretReference)(input.config.telegram.botTokenRef);
  if (!/^[1-9][0-9]{0,19}:[A-Za-z0-9_-]{20,}$/u.test(token))
    throw new Error('Telegram bot token is invalid.');
  const identities = new PostgresIdentityStore(input.database),
    users = new PostgresTelegramUserResolver(input.database),
    localization = new PostgresLocalizationStore(input.database),
    client = new TelegramBotApiMenuClient(token);
  return new TelegramStartDelivery(
    input.adapter,
    async (telegramUserId) => {
      const life = await users.resolveAccountControlLife(telegramUserId);
      if (life === undefined) return undefined;
      const context = await identities.getByTelegramUserId(telegramUserId);
      if (
        context === undefined ||
        context.userId !== life.userId ||
        context.accountVersion !== life.accountVersion
      )
        throw unavailable();
      return { life, context };
    },
    async (context) => {
      const catalog = await localization.loadActiveCatalog(context.uiLocale),
        renderer = new CatalogRenderer(
          { [catalog.resolvedLocale]: catalog.messages },
          catalog.resolvedLocale,
        );
      return renderer.render(catalog.resolvedLocale, routeStart(context.entryRoute).title);
    },
    (telegramUserId, text) =>
      client.sendMenu(telegramUserId, { text, replyMarkup: { inline_keyboard: [] } }),
  );
}
