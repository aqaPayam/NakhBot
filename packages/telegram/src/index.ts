import { randomUUID, timingSafeEqual } from 'node:crypto';

import {
  RegisterTelegramIdentityHandler,
  routeStart,
  type IdentityStore,
  type RegisterTelegramIdentityUseCase,
  type RateLimiterPort,
  type StartViewModel,
  type TelegramClientPort,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export class TelegramWebhookAuthenticator {
  public constructor(private readonly expectedSecret: string) {}

  public verify(receivedSecret: string | undefined): boolean {
    return receivedSecret !== undefined && safeEqual(receivedSecret, this.expectedSecret);
  }
}

export class UnconfiguredTelegramClient implements TelegramClientPort {
  public sendText(): Promise<void> {
    return Promise.reject(new Error('The production Telegram client is configured in M1.'));
  }
}

type TelegramStartUpdate = Readonly<{
  updateId: string;
  telegramUserId: string;
  username: string | undefined;
}>;

export type TelegramStartResult =
  | Readonly<{ handled: false }>
  | Readonly<{ handled: true; userId: string; replayed: boolean; view: StartViewModel }>;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function parseStartUpdate(update: unknown): TelegramStartUpdate | undefined {
  const root = record(update);
  const message = record(root?.message);
  const from = record(message?.from);
  const updateId = root?.update_id;
  const userId = from?.id;
  const text = message?.text;
  if (
    !Number.isSafeInteger(updateId) ||
    !Number.isSafeInteger(userId) ||
    typeof text !== 'string' ||
    !/^\/start(?:\s|$)/u.test(text)
  ) {
    return undefined;
  }
  const username = from?.username;
  return {
    updateId: String(updateId),
    telegramUserId: String(userId),
    username: typeof username === 'string' ? username : undefined,
  };
}

export class TelegramStartAdapter {
  public constructor(
    private readonly useCase: RegisterTelegramIdentityUseCase,
    private readonly systemActorId = '00000000-0000-4000-8000-000000000001',
    private readonly uuid: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
    private readonly rateLimiter?: RateLimiterPort,
  ) {}

  public static withStore(
    store: IdentityStore,
    rateLimiter?: RateLimiterPort,
  ): TelegramStartAdapter {
    const ids = { uuid: randomUUID };
    const clock = { now: (): Date => new Date() };
    return new TelegramStartAdapter(
      new RegisterTelegramIdentityHandler(store, ids, clock),
      '00000000-0000-4000-8000-000000000001',
      randomUUID,
      () => new Date(),
      rateLimiter,
    );
  }

  public async handle(update: unknown): Promise<TelegramStartResult> {
    const parsed = parseStartUpdate(update);
    if (parsed === undefined) return { handled: false };
    const rate = await this.rateLimiter?.consume({
      scope: 'telegram_start',
      subject: parsed.telegramUserId,
      limit: 20,
      windowSeconds: 60,
    });
    if (rate !== undefined && !rate.allowed)
      throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429, {
        retryAfterSeconds: String(rate.retryAfterSeconds),
      });
    const result = await this.useCase.execute({
      commandId: this.uuid(),
      commandType: 'identity.register-telegram-identity',
      schemaVersion: 1,
      actor: { userId: this.systemActorId, kind: 'system' },
      requestId: this.uuid(),
      idempotencyKey: `telegram-update:${parsed.updateId}`,
      occurredAt: this.now().toISOString(),
      locale: 'en',
      channelContext: { channel: 'telegram', channelIdentityId: parsed.telegramUserId },
      data: {
        telegramUserId: parsed.telegramUserId,
        updateId: parsed.updateId,
        ...(parsed.username === undefined ? {} : { username: parsed.username }),
      },
    });
    return {
      handled: true,
      userId: result.context.userId,
      replayed: result.replayed,
      view: routeStart(result.context.entryRoute),
    };
  }
}
