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
}
