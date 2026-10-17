import { createHash } from 'node:crypto';
import {
  PrepareStarsInvoiceHandler,
  ValidateTelegramPreCheckoutHandler,
  RecordTelegramSuccessfulPaymentHandler,
  type UserSessionActor,
  type TelegramPreCheckoutWrite,
} from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { ApplicationError, NAKH_STARS_COST } from '@nakh/domain';
import { CatalogRenderer } from '@nakh/localization';
import {
  PostgresFundingStore,
  PostgresTelegramStarsReceiptStore,
  PostgresUserSessionStore,
  PostgresTelegramUserResolver,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  SystemIdGenerator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { signupRecord as record } from './signup-navigation.js';
import { TelegramStarsKeys } from './stars-keys.js';

type InvoiceInput = Readonly<{
  actor: UserSessionActor;
  telegramUserId: string;
  fundingIntentId: string;
  expectedVersion: number;
  commandId: string;
  requestId: string;
  idempotencyKey: string;
  occurredAt: string;
  locale: string;
}>;
export interface TelegramStarsRuntimePort {
  readonly enabled: boolean;
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
  invoice(input: InvoiceInput): Promise<void>;
  assertSeparateNavigationKey?(key: Uint8Array): void;
}
function invalid(): never {
  throw new ApplicationError('invalid_request', 'error.billing.provider_callback_invalid', 400);
}
function unavailable(): never {
  throw new ApplicationError('internal_error', 'error.billing.payment_unavailable', 503);
}
function positive(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) invalid();
  return String(value);
}
function external(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/u.test(value)) invalid();
  return value;
}
function paymentShape(update: unknown): boolean {
  const root = record(update);
  return (
    root?.pre_checkout_query !== undefined ||
    record(root?.message)?.successful_payment !== undefined
  );
}
/** Fixed Bot API transport. Invoices are at-least-once presentation of the same
 * native payment attempt; an API acknowledgement is never a paid receipt. */
export class TelegramStarsClient {
  private readonly botId: string;
  public constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {
    const match = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(token);
    if (match === null || !Number.isSafeInteger(Number(match[1])))
      throw new Error('Stars credentials unavailable.');
    this.botId = match[1]!;
  }
  private async call(
    method: 'sendInvoice' | 'answerPreCheckoutQuery',
    body: unknown,
  ): Promise<unknown> {
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > 262144) throw new Error('oversized');
      const json = record(JSON.parse(text));
      if (!response.ok || json?.ok !== true) throw new Error('rejected');
      return json.result;
    } catch {
      throw new ApplicationError('internal_error', 'error.billing.payment_unavailable', 502);
    }
  }
  public async invoice(
    telegramUserId: string,
    title: string,
    description: string,
    payload: string,
    amount: bigint,
  ): Promise<void> {
    if (
      !/^[1-9][0-9]{0,19}$/u.test(telegramUserId) ||
      !Number.isSafeInteger(Number(telegramUserId)) ||
      Array.from(title).length < 1 ||
      Array.from(title).length > 32 ||
      Array.from(description).length < 1 ||
      Array.from(description).length > 255 ||
      !/^[A-Za-z0-9_-]{32}$/u.test(payload) ||
      amount !== NAKH_STARS_COST
    )
      invalid();
    const result = record(
      await this.call('sendInvoice', {
        chat_id: telegramUserId,
        title,
        description,
        payload,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: title, amount: Number(amount) }],
        start_parameter: payload,
      }),
    );
    const chat = record(result?.chat),
      from = record(result?.from),
      invoice = record(result?.invoice);
    if (
      !Number.isSafeInteger(result?.message_id) ||
      Number(result?.message_id) < 1 ||
      chat?.type !== 'private' ||
      String(chat.id) !== telegramUserId ||
      from?.is_bot !== true ||
      String(from.id) !== this.botId ||
      invoice?.currency !== 'XTR' ||
      invoice.total_amount !== Number(amount)
    )
      throw new ApplicationError('internal_error', 'error.billing.payment_unavailable', 502);
  }
  public async answer(queryId: string, allowed: boolean, errorMessage: string): Promise<void> {
    external(queryId);
    if (!allowed && (errorMessage.length < 1 || errorMessage.length > 200)) unavailable();
    if (
      (await this.call('answerPreCheckoutQuery', {
        pre_checkout_query_id: queryId,
        ok: allowed,
        ...(allowed ? {} : { error_message: errorMessage }),
      })) !== true
    )
      unavailable();
  }
}
export class TelegramStarsRuntime implements TelegramStarsRuntimePort {
  public readonly enabled = true;
  private readonly ids = new SystemIdGenerator();
  public constructor(
    private readonly database: NakhDatabase,
    private readonly keys: TelegramStarsKeys,
    private readonly environment: AppConfig['environment'],
    private readonly botId: string,
    private readonly client: TelegramStarsClient,
  ) {}
  public assertSeparateNavigationKey(key: Uint8Array): void {
    this.keys.assertSeparateNavigationKey(key);
  }
  private get botDigest(): string {
    return createHash('sha256').update(this.botId).digest('hex');
  }
  public async onModuleInit(): Promise<void> {
    await this.keys.verifyCustody(this.database);
    const locales = await this.database
      .selectFrom('catalog.locales')
      .select('code')
      .where('is_active', '=', true)
      .execute();
    for (const { code } of locales) {
      const catalog = await new PostgresLocalizationStore(this.database).loadActiveCatalog(code);
      for (const name of [
        'error.billing.payment_unavailable',
        'nakh.compose.title',
        'nakh.compose.cost.stars',
      ])
        if (
          typeof catalog.messages[name] !== 'string' ||
          catalog.messages[name].trim() === '' ||
          /[{}]/u.test(catalog.messages[name])
        )
          throw new Error('Stars localization unavailable.');
    }
  }
  private async text(telegramUserId: string, key: string): Promise<string> {
    const identity = await new PostgresIdentityStore(this.database).getByTelegramUserId(
      telegramUserId,
    );
    const catalog = await new PostgresLocalizationStore(this.database).loadActiveCatalog(
      identity?.uiLocale ?? 'en',
    );
    return new CatalogRenderer(
      { [catalog.resolvedLocale]: catalog.messages },
      catalog.resolvedLocale,
    ).render(catalog.resolvedLocale, { key, variables: {} });
  }
  private async current(actor: UserSessionActor, telegramUserId: string): Promise<void> {
    const owner = await new PostgresTelegramUserResolver(this.database).resolveProductLife(
      telegramUserId,
    );
    if (
      owner?.userId !== actor.userId ||
      owner.productEpoch !== actor.productEpoch ||
      (await new PostgresUserSessionStore(this.database).current(actor, actor.sessionGrantId)) ===
        undefined
    )
      throw new ApplicationError('unauthorized', 'error.billing.payment_unavailable', 401);
  }
  public async invoice(input: InvoiceInput): Promise<void> {
    const request = structuredClone(input);
    await this.current(request.actor, request.telegramUserId);
    const prepared = await new PrepareStarsInvoiceHandler(
      new PostgresFundingStore(this.database, request.actor),
      this.keys,
      this.ids,
      this.environment,
      this.botDigest,
    ).execute({
      commandId: request.commandId,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      occurredAt: request.occurredAt,
      locale: request.locale,
      schemaVersion: 1,
      actor: { kind: 'user', userId: request.actor.userId },
      commandType: 'billing.create-stars-invoice',
      data: { fundingIntentId: request.fundingIntentId, expectedVersion: request.expectedVersion },
    });
    const title = await this.text(request.telegramUserId, 'nakh.compose.title'),
      description = await this.text(request.telegramUserId, 'nakh.compose.cost.stars');
    await this.current(request.actor, request.telegramUserId);
    await this.client.invoice(
      request.telegramUserId,
      title,
      description,
      prepared.invoicePayload,
      prepared.starsAmount,
    );
  }
  public async handle(input: unknown): Promise<'unhandled' | 'notice'> {
    if (!paymentShape(input)) return 'unhandled';
    const update = record(structuredClone(input));
    if (
      update === undefined ||
      typeof update.update_id !== 'number' ||
      !Number.isSafeInteger(update.update_id) ||
      update.update_id < 0
    )
      invalid();
    const query = record(update.pre_checkout_query),
      message = record(update.message),
      payment = record(message?.successful_payment);
    if (
      (query === undefined) === (payment === undefined) ||
      update.callback_query !== undefined ||
      update.edited_message !== undefined
    )
      invalid();
    if (query !== undefined && update.message !== undefined) invalid();
    const sender = record(query?.from ?? message?.from);
    if (sender?.is_bot !== false) invalid();
    const telegramUserId = positive(sender.id),
      facts = query ?? payment!;
    if (
      typeof facts.currency !== 'string' ||
      !/^[A-Z]{3}$/u.test(facts.currency) ||
      typeof facts.invoice_payload !== 'string' ||
      !/^[A-Za-z0-9_-]{32}$/u.test(facts.invoice_payload) ||
      typeof facts.total_amount !== 'number' ||
      !Number.isSafeInteger(facts.total_amount) ||
      facts.total_amount <= 0
    )
      invalid();
    const eventType = query === undefined ? 'successful_payment' : 'pre_checkout',
      providerEventId = String(update.update_id),
      queryId = query === undefined ? undefined : external(query.id),
      telegramChargeId =
        payment === undefined ? undefined : external(payment.telegram_payment_charge_id),
      providerChargeId =
        payment?.provider_payment_charge_id === undefined ||
        payment.provider_payment_charge_id === ''
          ? undefined
          : external(payment.provider_payment_charge_id);
    const evidence = this.keys.protectEvidence({
      eventType,
      providerEventId,
      telegramUserId,
      invoicePayload: facts.invoice_payload,
      currency: facts.currency,
      totalAmount: String(facts.total_amount),
      environment: this.environment,
      botDigest: this.botDigest,
      ...(queryId === undefined ? {} : { queryId }),
      ...(telegramChargeId === undefined ? {} : { telegramChargeId }),
      ...(providerChargeId === undefined ? {} : { providerChargeId }),
    });
    const write: TelegramPreCheckoutWrite = {
      providerEventId,
      telegramUserId,
      invoicePayload: facts.invoice_payload,
      currency: facts.currency,
      totalAmount: BigInt(facts.total_amount),
      providerEnvironment: this.environment,
      providerBotIdDigest: this.botDigest,
      evidence,
    };
    const store = new PostgresTelegramStarsReceiptStore(this.database, this.ids, this.keys);
    if (queryId !== undefined) {
      const decision = await new ValidateTelegramPreCheckoutHandler(store).execute(write);
      const decline = decision.allowed
        ? ''
        : await this.text(telegramUserId, 'error.billing.payment_unavailable');
      await this.client.answer(queryId, decision.allowed, decline);
    } else {
      await new RecordTelegramSuccessfulPaymentHandler(store).execute({
        ...write,
        telegramChargeId: telegramChargeId!,
        ...(providerChargeId === undefined ? {} : { providerChargeId }),
      });
    }
    return 'notice';
  }
}
export function createTelegramStarsRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    resolveSecret?: (reference: string) => string;
  }>,
): TelegramStarsRuntimePort {
  if (!input.config.telegram.starsEnabled)
    return {
      enabled: false,
      invoice: () =>
        Promise.reject(
          new ApplicationError('internal_error', 'error.billing.payment_unavailable', 503),
        ),
      handle: (update) =>
        paymentShape(update)
          ? Promise.reject(
              new ApplicationError('internal_error', 'error.billing.payment_unavailable', 503),
            )
          : Promise.resolve('unhandled'),
    };
  const resolve = input.resolveSecret ?? resolveSecretReference,
    token = resolve(input.config.telegram.botTokenRef),
    keys = new TelegramStarsKeys(resolve(input.config.telegram.starsKeyRingRef)),
    client = new TelegramStarsClient(token);
  return new TelegramStarsRuntime(
    input.database,
    keys,
    input.config.environment,
    token.split(':')[0]!,
    client,
  );
}
