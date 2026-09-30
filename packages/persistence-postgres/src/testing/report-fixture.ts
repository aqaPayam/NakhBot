import { randomUUID } from 'node:crypto';
import type { NakhDatabase } from '../database.js';
import { CreateDirectNakhHandler } from '@nakh/application';
import { PostgresDirectNakhStore } from '../direct-nakh-store.js';
import { PostgresCreditLedgerStore } from '../credit-ledger-store.js';
import { SystemIdGenerator } from '../foundation-store.js';
import { PostgresCandidateDeliveryStore } from '../candidate-delivery-store.js';

export async function createReportMatch(
  database: NakhDatabase,
  first: string,
  second: string,
): Promise<string> {
  const id = randomUUID(),
    now = new Date();
  const [low, high] = [first, second].sort() as [string, string];
  const a = await createReportLike(database, first, second),
    b = await createReportLike(database, second, first);
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('matching.matches')
      .values({
        id,
        user_low_id: low,
        user_high_id: high,
        source: 'mutual_like',
        source_like_a_id: a,
        source_like_b_id: b,
        source_nakh_id: null,
        status: 'active',
        created_at: now,
        closed_at: null,
      })
      .execute();
    await transaction
      .insertInto('matching.match_participants')
      .values([
        { match_id: id, user_id: low, joined_at: now },
        { match_id: id, user_id: high, joined_at: now },
      ])
      .execute();
  });
  return id;
}

export async function createReportDelivery(
  database: NakhDatabase,
  reporter: string,
  target: string,
  state: 'reserved' | 'delivered' | 'failed' = 'delivered',
): Promise<string> {
  const id = randomUUID(),
    now = new Date();
  await database
    .insertInto('discovery.candidate_deliveries')
    .values({
      id,
      viewer_user_id: reporter,
      target_user_id: target,
      mode: 'explore',
      filter_version: 1,
      state: 'reserved',
      expires_at: new Date(now.getTime() + 300000),
      provider_message_id: null,
      reserved_at: now,
      delivered_at: null,
      failed_at: null,
      updated_at: now,
    })
    .execute();
  const store = new PostgresCandidateDeliveryStore(database);
  if (state === 'delivered')
    await store.recordDelivered(
      { deliveryId: id, providerMessageId: '123' },
      {
        auditId: randomUUID(),
        deliveryEventId: randomUUID(),
        consumptionEventId: randomUUID(),
        processedAt: new Date(),
      },
    );
  if (state === 'failed')
    await store.recordDefinitiveFailure(
      { deliveryId: id, reasonCode: 'provider_rejected' },
      { auditId: randomUUID(), eventId: randomUUID(), processedAt: new Date() },
    );
  return id;
}

export async function createReportUser(
  database: NakhDatabase,
  withProfile = false,
): Promise<string> {
  const id = randomUUID(),
    now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('identity.accounts')
    .values({ user_id: id, state: 'active', state_reason: null, state_changed_at: now })
    .execute();
  if (withProfile)
    await database
      .insertInto('profile.profiles')
      .values({
        id: randomUUID(),
        user_id: id,
        name: 'Private report fixture',
        birth_year: 1995,
        gender_option_id: '20000000-0000-4000-8000-000000000001',
        gender_preference_id: '20000000-0000-4000-8000-000000000013',
        relationship_goal_id: '20000000-0000-4000-8000-000000000021',
        country_id: '20000000-0000-4000-8000-000000000101',
        province_id: '20000000-0000-4000-8000-000000000111',
        city_id: '20000000-0000-4000-8000-000000000121',
        highlight: 'Private highlight',
        bio: 'Private report bio',
        completion_status: 'complete',
        ever_completed: true,
        completed_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  return id;
}
export async function createReportLike(
  database: NakhDatabase,
  reporter: string,
  target: string,
): Promise<string> {
  const id = randomUUID();
  await database
    .insertInto('interaction.likes')
    .values({
      id,
      sender_user_id: target,
      receiver_user_id: reporter,
      status: 'active',
      created_at: new Date(),
      closed_at: null,
    })
    .execute();
  return id;
}

export async function createReportFixtureAdmin(database: NakhDatabase): Promise<string> {
  const userId = await createReportUser(database),
    id = randomUUID(),
    now = new Date();
  const telegramUserId = String(2_000_000_000 + Math.floor(Math.random() * 7_000_000_000));
  await database
    .insertInto('identity.telegram_identities')
    .values({
      user_id: userId,
      telegram_user_id: telegramUserId,
      username: null,
      first_seen_at: now,
      last_seen_at: now,
    })
    .execute();
  await database
    .insertInto('administration.admin_users')
    .values({
      id,
      user_id: userId,
      telegram_user_id: telegramUserId,
      is_active: true,
      disabled_at: null,
      identity_verified_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

export async function createReportNakh(
  database: NakhDatabase,
  reporter: string,
  target: string,
): Promise<string> {
  const now = new Date();
  for (const userId of [reporter, target]) {
    await database
      .insertInto('identity.user_settings')
      .values({ user_id: userId, created_at: now, updated_at: now })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
    await database
      .insertInto('billing.credit_accounts')
      .values({ user_id: userId, created_at: now, updated_at: now })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: userId, created_at: now, updated_at: now })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
  }
  await new PostgresCreditLedgerStore(database).append({
    transactionId: randomUUID(),
    userId: target,
    transactionType: 'admin_adjustment',
    amount: 2n,
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
  });
  const result = await new CreateDirectNakhHandler(
    new PostgresDirectNakhStore(database),
    new SystemIdGenerator(),
  ).execute({
    commandType: 'nakh.create-direct',
    schemaVersion: 1,
    commandId: randomUUID(),
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    actor: { kind: 'user', userId: target },
    occurredAt: now.toISOString(),
    locale: 'en',
    data: { targetUserId: reporter, text: 'Private Nakh text is not report evidence' },
  });
  return result.nakhId;
}
