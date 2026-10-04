import { createHash, randomUUID } from 'node:crypto';
import type { NakhDatabase } from '../database.js';
import { PostgresAppealStore } from '../appeal-store.js';
import { createReportUser } from './report-fixture.js';
export async function createCurrentBanAppeal(
  database: NakhDatabase,
): Promise<Readonly<{ userId: string; banId: string; appealId: string }>> {
  const userId = await createReportUser(database),
    banId = randomUUID(),
    now = new Date();
  await database.transaction().execute(async (tx) => {
    await tx
      .updateTable('identity.accounts')
      .set({ state: 'banned', state_reason: 'test_ban', state_changed_at: now, version: 2 })
      .where('user_id', '=', userId)
      .execute();
    await tx
      .insertInto('identity.account_state_history')
      .values({
        id: banId,
        user_id: userId,
        previous_state: 'active',
        next_state: 'banned',
        reason_code: 'test_ban',
        actor_type: 'system',
        actor_user_id: null,
        actor_admin_id: null,
        changed_at: now,
      })
      .execute();
  });
  const commandId = randomUUID();
  const result = await new PostgresAppealStore(database).submit({
    userId,
    banHistoryId: banId,
    appealId: randomUUID(),
    eventId: randomUUID(),
    commandId,
    requestId: randomUUID(),
    idempotencyKey: commandId,
    requestDigest: createHash('sha256').update(commandId).digest('hex'),
    normalizedText: 'Private fixture appeal',
  });
  return { userId, banId, appealId: result.appealId };
}
