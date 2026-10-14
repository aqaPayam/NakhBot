import type { SafetyContactState, SafetyContactStateStore } from '@nakh/application';
import type { NakhDatabase } from './database.js';

/** One statement gives a consistent projection of the exact current ban; never reads restricted text. */
export class PostgresSafetyContactStore implements SafetyContactStateStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async get(userId: string, expectedProductEpoch?: number): Promise<SafetyContactState> {
    if (
      expectedProductEpoch !== undefined &&
      (!Number.isSafeInteger(expectedProductEpoch) || expectedProductEpoch < 0)
    )
      return { route: 'unavailable' };
    let query = this.database
      .selectFrom('identity.accounts as a')
      .leftJoin('identity.account_state_history as h', (join) =>
        join
          .onRef('h.user_id', '=', 'a.user_id')
          .onRef('h.changed_at', '=', 'a.state_changed_at')
          .on('h.next_state', '=', 'banned'),
      )
      .leftJoin('moderation.user_appeals as p', 'p.ban_state_history_id', 'h.id')
      .select(['a.state', 'a.product_epoch', 'h.id as banId', 'p.status'])
      .where('a.user_id', '=', userId);
    if (expectedProductEpoch !== undefined)
      query = query.where('a.product_epoch', '=', expectedProductEpoch);
    const row = await query.orderBy('h.id', 'desc').executeTakeFirst();
    if (
      row === undefined ||
      row.state === 'deleted' ||
      (expectedProductEpoch !== undefined && row.product_epoch !== expectedProductEpoch)
    )
      return { route: 'unavailable' };
    if (row.state !== 'banned') return { route: 'support' };
    if (row.banId === null) return { route: 'unavailable' };
    return { route: 'appeal', ...(row.status === null ? {} : { status: row.status }) };
  }
}
