import { resolveSecretReference, type AppConfig } from '@nakh/config';
import {
  PostgresLaunchCohortAdmission,
  PostgresTelegramUserResolver,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { signupRecord as record } from './signup-navigation.js';

type Life = Readonly<{ userId: string; productEpoch: number }>;
export interface TelegramLaunchAdmissionPort {
  readonly enabled: boolean;
  allowsUpdate(update: unknown): Promise<boolean>;
  allowsLife(recipient: string, life: Life): Promise<boolean>;
}

/** Admission of a new dispatch, not cancellation of an already executing command.
 * Only authenticated webhook dispatch may use this capability. Business grants,
 * account/pair checks and idempotency remain authoritative inside each handler. */
export class TelegramLaunchAdmission implements TelegramLaunchAdmissionPort {
  public readonly enabled = true;
  public constructor(
    private readonly botId: string,
    private readonly life: (recipient: string) => Promise<Life | undefined>,
    private readonly allows: (userId: string) => Promise<boolean>,
  ) {}
  public async allowsLife(recipient: string, input: Life): Promise<boolean> {
    const original = { ...input };
    try {
      const before = await this.life(recipient);
      if (
        before?.userId !== original.userId ||
        before.productEpoch !== original.productEpoch ||
        !(await this.allows(original.userId))
      )
        return false;
      const after = await this.life(recipient);
      return after?.userId === original.userId && after.productEpoch === original.productEpoch;
    } catch {
      return false;
    }
  }
  public async allowsUpdate(input: unknown): Promise<boolean> {
    const root = record(input),
      callback = record(root?.callback_query),
      message = record(callback?.message ?? root?.message),
      from = record(callback?.from ?? message?.from),
      chat = record(message?.chat),
      origin = record(message?.from);
    if (
      !Number.isSafeInteger(root?.update_id) ||
      Number(root?.update_id) < 0 ||
      root?.edited_message !== undefined ||
      (callback !== undefined && root?.message !== undefined) ||
      typeof from?.id !== 'number' ||
      !Number.isSafeInteger(from.id) ||
      from.id <= 0 ||
      from.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== from.id ||
      (callback !== undefined && (origin?.is_bot !== true || String(origin.id) !== this.botId))
    )
      return false;
    try {
      const recipient = String(from.id),
        life = await this.life(recipient);
      return life !== undefined && (await this.allowsLife(recipient, life));
    } catch {
      return false;
    }
  }
}

/** Real staging/production product composition cannot opt out of the cohort gate.
 * Local/test profiles keep their existing synthetic journeys. */
export function createTelegramLaunchAdmission(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    resolveSecret?: (reference: string) => string;
  }>,
): TelegramLaunchAdmissionPort & { onModuleInit?: () => Promise<void> } {
  const { config, database } = input;
  const productEnabled =
    config.telegram.signupEnabled ||
    config.telegram.chatEnabled ||
    config.telegram.guestPreviewEnabled ||
    config.telegram.exploreEnabled ||
    config.telegram.likedByDeliveryEnabled ||
    config.media.ingestionEnabled;
  if (!productEnabled || (config.environment !== 'staging' && config.environment !== 'production'))
    return {
      enabled: false,
      allowsUpdate: () => Promise.resolve(true),
      allowsLife: () => Promise.resolve(true),
    };
  const token = (input.resolveSecret ?? resolveSecretReference)(config.telegram.botTokenRef),
    match = /^([1-9][0-9]{0,15}):[A-Za-z0-9_-]{20,}$/u.exec(token);
  if (match === null) throw new Error('Launch admission credentials unavailable.');
  const users = new PostgresTelegramUserResolver(database),
    admission = new PostgresLaunchCohortAdmission(database, {
      sourceSha: config.release,
      environment: config.environment,
      telegramBotId: match[1]!,
    }),
    gate = new TelegramLaunchAdmission(
      match[1]!,
      (recipient) => users.resolveProductLife(recipient),
      (userId) => admission.allows(userId),
    );
  return Object.assign(gate, {
    onModuleInit: async (): Promise<void> => {
      if (
        (await database
          .selectFrom('platform.schema_migrations')
          .select('name')
          .where('name', '=', '000163_m9_launch_cohort_authority.sql')
          .executeTakeFirst()) === undefined
      )
        throw new Error('Launch admission schema unavailable.');
    },
  });
}
