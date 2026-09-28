import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  canonicalAdminPairTargetId,
  type AdminCommandAttempt,
  type InteractionStore,
  type SpendCreditsForPaidActionWrite,
} from '@nakh/application';
import type { SendLikeCommand } from '@nakh/contracts';
import { normalizeUserPair } from '@nakh/domain';

import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresInteractionStore } from './interaction-store.js';
import { PostgresInternalBlockWorkflow } from './internal-block-store.js';
import { runMigrations } from './migrations.js';
import { PostgresPaidActionStore } from './paid-action-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const genderOptionId = '20000000-0000-4000-8000-000000000001';
const genderPreferenceId = '20000000-0000-4000-8000-000000000013';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createActiveUser(database: NakhDatabase): Promise<string> {
  const userId = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('identity.accounts')
    .values({ user_id: userId, state: 'active', state_reason: null, state_changed_at: now })
    .execute();
  await database
    .insertInto('identity.user_settings')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('profile.profiles')
    .values({
      id: randomUUID(),
      user_id: userId,
      name: 'Internal block fixture',
      birth_year: now.getUTCFullYear() - 30,
      gender_option_id: genderOptionId,
      gender_preference_id: genderPreferenceId,
      relationship_goal_id: relationshipGoalId,
      country_id: countryId,
      province_id: provinceId,
      city_id: cityId,
      highlight: 'Internal block fixture',
      bio: null,
      completion_status: 'complete',
      ever_completed: true,
      completed_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await database
    .insertInto('billing.credit_accounts')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  return userId;
}

async function createAdmin(database: NakhDatabase): Promise<string> {
  const userId = await createActiveUser(database);
  const adminUserId = randomUUID();
  const telegramUserId = String(2_000_000_000 + Math.floor(Math.random() * 7_000_000_000));
  const now = new Date();
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
      id: adminUserId,
      user_id: userId,
      telegram_user_id: telegramUserId,
      is_active: true,
      disabled_at: null,
      identity_verified_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await database
    .insertInto('administration.admin_user_roles')
    .values({
      admin_user_id: adminUserId,
      role_code: 'moderator',
      assigned_by_admin_id: adminUserId,
      revoked_by_admin_id: null,
      revoked_at: null,
    })
    .execute();
  return adminUserId;
}

function likeCommand(senderUserId: string, receiverUserId: string): SendLikeCommand {
  return {
    commandId: randomUUID(),
    commandType: 'interaction.send-like',
    schemaVersion: 1,
    actor: { kind: 'user', userId: senderUserId },
    requestId: randomUUID(),
    idempotencyKey: `internal-block-like:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { targetUserId: receiverUserId },
  };
}

function likeGenerated(): Parameters<InteractionStore['sendLike']>[1] {
  return {
    likeId: randomUUID(),
    matchId: randomUUID(),
    chatSessionId: randomUUID(),
    auditId: randomUUID(),
    likeEventId: randomUUID(),
    likeClosedEventId: randomUUID(),
    matchEventId: randomUUID(),
    consumptionEventId: randomUUID(),
    occurredAt: new Date(),
  };
}

function blockAttempt(
  adminUserId: string,
  firstUserId: string,
  secondUserId: string,
  action: 'create' | 'remove',
  expectedTargetVersion: number,
): AdminCommandAttempt {
  const pair = normalizeUserPair(firstUserId, secondUserId);
  const commandId = randomUUID();
  return {
    logId: randomUUID(),
    adminUserId,
    commandId,
    requestId: randomUUID(),
    requestDigest: digest(
      `${commandId}:${pair.userLowId}:${pair.userHighId}:${action}:${expectedTargetVersion}`,
    ),
    commandCode: 'moderation.change-internal-block',
    requiredPermission: 'manage_internal_blocks',
    targetType: 'user_pair',
    targetId: canonicalAdminPairTargetId(pair),
    targetPair: pair,
    expectedTargetVersion,
    reasonDigest: digest('confirmed internal safety separation'),
    metadata: {},
    correlationId: randomUUID(),
  };
}

async function fund(database: NakhDatabase, userId: string): Promise<void> {
  await new PostgresCreditLedgerStore(database).append({
    transactionId: randomUUID(),
    userId,
    transactionType: 'admin_adjustment',
    amount: 10n,
    idempotencyKey: `internal-block-funding:${randomUUID()}`,
    correlationId: randomUUID(),
  });
}

function unlockWrite(userId: string, matchId: string): SpendCreditsForPaidActionWrite {
  return {
    featureUnlockId: randomUUID(),
    creditTransactionId: randomUUID(),
    outboxEventId: randomUUID(),
    userId,
    target: { type: 'match', targetId: matchId },
    idempotencyKey: `internal-block-unlock:${randomUUID()}`,
    correlationId: randomUUID(),
  };
}

describe.skipIf(databaseUrl === undefined)('M7 internal block lifecycle', () => {
  let database: NakhDatabase;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 20,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('silently closes an active Match, chat, and scoped access without restoring them on removal', async () => {
    const adminUserId = await createAdmin(database);
    const firstUserId = await createActiveUser(database);
    const secondUserId = await createActiveUser(database);
    const interactions = new PostgresInteractionStore(database);
    await interactions.sendLike(likeCommand(firstUserId, secondUserId), likeGenerated());
    const matched = await interactions.sendLike(
      likeCommand(secondUserId, firstUserId),
      likeGenerated(),
    );
    expect(matched.outcome).toBe('matched');
    const matchId = matched.matchId!;
    await fund(database, firstUserId);
    const unlock = await new PostgresPaidActionStore(database).spendCredits(
      unlockWrite(firstUserId, matchId),
    );
    const notificationsBefore = await database
      .selectFrom('notification.notifications')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('user_id', 'in', [firstUserId, secondUserId])
      .executeTakeFirstOrThrow();
    const workflow = new PostgresInternalBlockWorkflow(database);
    const created = await workflow.change(
      blockAttempt(adminUserId, firstUserId, secondUserId, 'create', 1),
      'create',
    );

    expect(created).toMatchObject({
      result: 'succeeded',
      safeCode: 'internal_block_created',
      value: {
        previousState: 'matched',
        nextState: 'blocked',
        pairVersion: 2,
        closedMatchId: matchId,
        revokedUnlockCount: 1,
      },
    });
    const session = await database
      .selectFrom('chat.chat_sessions')
      .select(['id', 'status', 'closed_reason', 'version'])
      .where('match_id', '=', matchId)
      .executeTakeFirstOrThrow();
    expect(session).toMatchObject({
      status: 'closed',
      closed_reason: 'internal_block',
      version: 2,
    });
    await expect(
      database
        .selectFrom('matching.matches')
        .select(['status', 'version'])
        .where('id', '=', matchId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'closed', version: 2 });
    await expect(
      database
        .selectFrom('interaction.feature_unlocks')
        .select(['status', 'revoked_reason', 'revoked_by_admin_id', 'version'])
        .where('id', '=', unlock.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: 'revoked',
      revoked_reason: 'internal_block',
      revoked_by_admin_id: adminUserId,
      version: 2,
    });
    const notificationsAfter = await database
      .selectFrom('notification.notifications')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('user_id', 'in', [firstUserId, secondUserId])
      .executeTakeFirstOrThrow();
    expect(notificationsAfter.count).toBe(notificationsBefore.count);

    const removed = await workflow.change(
      blockAttempt(adminUserId, firstUserId, secondUserId, 'remove', 2),
      'remove',
    );
    expect(removed).toMatchObject({
      result: 'succeeded',
      safeCode: 'internal_block_removed',
      value: { previousState: 'blocked', pairVersion: null },
    });
    const pair = normalizeUserPair(firstUserId, secondUserId);
    await expect(
      database
        .selectFrom('interaction.user_pair_states')
        .select('state')
        .where('user_low_id', '=', pair.userLowId)
        .where('user_high_id', '=', pair.userHighId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    await expect(
      database
        .selectFrom('matching.matches')
        .select('status')
        .where('id', '=', matchId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'closed' });
    await expect(
      database
        .selectFrom('interaction.feature_unlocks')
        .select('status')
        .where('id', '=', unlock.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'revoked' });
  });

  it('serializes against Match creation and leaves no active Match, chat, or Like', async () => {
    const adminUserId = await createAdmin(database);
    const firstUserId = await createActiveUser(database);
    const secondUserId = await createActiveUser(database);
    const interactions = new PostgresInteractionStore(database);
    await interactions.sendLike(likeCommand(firstUserId, secondUserId), likeGenerated());
    const workflow = new PostgresInternalBlockWorkflow(database);

    const [matchRace, blockRace] = await Promise.allSettled([
      interactions.sendLike(likeCommand(secondUserId, firstUserId), likeGenerated()),
      workflow.change(blockAttempt(adminUserId, firstUserId, secondUserId, 'create', 1), 'create'),
    ]);
    expect(blockRace.status).toBe('fulfilled');
    if (blockRace.status === 'fulfilled') expect(blockRace.value.result).toBe('succeeded');
    if (matchRace.status === 'rejected')
      expect(matchRace.reason).toMatchObject({ code: 'pair_unavailable' });

    const pair = normalizeUserPair(firstUserId, secondUserId);
    await expect(
      database
        .selectFrom('interaction.user_pair_states')
        .select('state')
        .where('user_low_id', '=', pair.userLowId)
        .where('user_high_id', '=', pair.userHighId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: 'blocked' });
    const activeLikes = await database
      .selectFrom('interaction.likes')
      .select('id')
      .where((expression) =>
        expression.or([
          expression.and([
            expression('sender_user_id', '=', pair.userLowId),
            expression('receiver_user_id', '=', pair.userHighId),
          ]),
          expression.and([
            expression('sender_user_id', '=', pair.userHighId),
            expression('receiver_user_id', '=', pair.userLowId),
          ]),
        ]),
      )
      .where('status', '=', 'active')
      .execute();
    expect(activeLikes).toHaveLength(0);
    const match = await database
      .selectFrom('matching.matches')
      .select(['id', 'status'])
      .where('user_low_id', '=', pair.userLowId)
      .where('user_high_id', '=', pair.userHighId)
      .executeTakeFirst();
    if (match !== undefined) {
      expect(match.status).toBe('closed');
      await expect(
        database
          .selectFrom('chat.chat_sessions')
          .select(['status', 'closed_reason'])
          .where('match_id', '=', match.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: 'closed', closed_reason: 'internal_block' });
    }
  });
});
