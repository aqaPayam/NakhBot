import type { TelegramUserResolver } from '@nakh/application';

import type { NakhDatabase } from './database.js';

export class PostgresTelegramUserResolver implements TelegramUserResolver {
  public constructor(private readonly database: NakhDatabase) {}

  public async resolveUserId(telegramUserId: string): Promise<string | undefined> {
    if (!/^[1-9][0-9]{0,19}$/u.test(telegramUserId)) return undefined;
    const identity = await this.database
      .selectFrom('identity.telegram_identities')
      .select('user_id')
      .where('telegram_user_id', '=', telegramUserId)
      .executeTakeFirst();
    return identity?.user_id;
  }

  /** Freeze trusted ownership before asynchronous product work, never at issuance. */
  public async resolveProductLife(
    telegramUserId: string,
  ): Promise<Readonly<{ userId: string; productEpoch: number }> | undefined> {
    if (!/^[1-9][0-9]{0,19}$/u.test(telegramUserId)) return undefined;
    const identity = await this.database
      .selectFrom('identity.telegram_identities as telegram')
      .innerJoin('identity.accounts as account', 'account.user_id', 'telegram.user_id')
      .select(['account.user_id', 'account.product_epoch'])
      .where('telegram.telegram_user_id', '=', telegramUserId)
      .where('account.state', '!=', 'deleted')
      .executeTakeFirst();
    return identity === undefined
      ? undefined
      : { userId: identity.user_id, productEpoch: identity.product_epoch };
  }
}
