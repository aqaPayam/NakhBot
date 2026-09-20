import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { InteractionStore } from '@nakh/application';
import type { GetNextExploreCandidateQuery, SendLikeCommand } from '@nakh/contracts';
import {
  createDatabase,
  PostgresCandidateDeliveryStore,
  PostgresCandidateReservationStore,
  PostgresInteractionStore,
  runMigrations,
  type NakhDatabase,
} from '@nakh/persistence-postgres';

import { seedValidMedia } from '../packages/persistence-postgres/src/media-fixtures.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error('NAKH_TEST_DATABASE_URL is required for M3 load smoke.');

const manGenderId = '20000000-0000-4000-8000-000000000001';
const womanGenderId = '20000000-0000-4000-8000-000000000002';
const menPreferenceId = '20000000-0000-4000-8000-000000000011';
const womenPreferenceId = '20000000-0000-4000-8000-000000000012';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';

type SeededUser = Readonly<{ userId: string; profileId: string }>;

async function seedActiveUsers(
  database: NakhDatabase,
  genders: readonly ('man' | 'woman')[],
): Promise<readonly SeededUser[]> {
  const now = new Date();
  const users = genders.map((gender) => ({
    userId: randomUUID(),
    profileId: randomUUID(),
    gender,
  }));
  await database
    .insertInto('identity.users')
    .values(
      users.map(({ userId }) => ({
        id: userId,
        last_activity_at: now,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await database
    .insertInto('identity.accounts')
    .values(
      users.map(({ userId }) => ({
        user_id: userId,
        state: 'active' as const,
        state_reason: null,
        state_changed_at: now,
      })),
    )
    .execute();
  await database
    .insertInto('identity.user_settings')
    .values(users.map(({ userId }) => ({ user_id: userId, created_at: now, updated_at: now })))
    .execute();
  await database
    .insertInto('profile.profiles')
    .values(
      users.map(({ userId, profileId, gender }) => ({
        id: profileId,
        user_id: userId,
        name: 'Synthetic M3 load fixture',
        birth_year: now.getUTCFullYear() - 30,
        gender_option_id: gender === 'man' ? manGenderId : womanGenderId,
        gender_preference_id: gender === 'man' ? womenPreferenceId : menPreferenceId,
        relationship_goal_id: relationshipGoalId,
        country_id: countryId,
        province_id: provinceId,
        city_id: cityId,
        highlight: 'Synthetic M3 load fixture',
        bio: null,
        completion_status: 'complete' as const,
        ever_completed: true,
        completed_at: now,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  return users;
}

async function addPrimaryPhoto(database: NakhDatabase, user: SeededUser): Promise<void> {
  const assetId = await seedValidMedia(database, user.userId);
  const now = new Date();
  await database
    .insertInto('media.profile_photos')
    .values({
      id: randomUUID(),
      profile_id: user.profileId,
      asset_id: assetId,
      status: 'visible',
      is_primary: true,
      display_order: 0,
      created_at: now,
      updated_at: now,
      hidden_at: null,
      deleted_at: null,
    })
    .execute();
}

function candidateQuery(viewerUserId: string): GetNextExploreCandidateQuery {
  return {
    actor: { kind: 'user', userId: viewerUserId },
    requestId: randomUUID(),
    mode: 'explore',
  };
}

function reservationGenerated(): Readonly<{
  deliveryId: string;
  eventId: string;
  reservedAt: Date;
}> {
  return { deliveryId: randomUUID(), eventId: randomUUID(), reservedAt: new Date() };
}

function deliveredGenerated(): Readonly<{
  auditId: string;
  deliveryEventId: string;
  consumptionEventId: string;
  processedAt: Date;
}> {
  return {
    auditId: randomUUID(),
    deliveryEventId: randomUUID(),
    consumptionEventId: randomUUID(),
    processedAt: new Date(),
  };
}

function likeCommand(senderUserId: string, receiverUserId: string): SendLikeCommand {
  return {
    commandId: randomUUID(),
    commandType: 'interaction.send-like',
    schemaVersion: 1,
    actor: { kind: 'user', userId: senderUserId },
    requestId: randomUUID(),
    idempotencyKey: `m3-load-like:${randomUUID()}`,
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

await runMigrations(databaseUrl, resolve(process.cwd(), 'migrations'));
const database = createDatabase({
  url: databaseUrl,
  poolMax: 40,
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 15_000,
});

try {
  const [viewer] = await seedActiveUsers(database, ['man']);
  const candidates = await seedActiveUsers(
    database,
    Array.from({ length: 12 }, () => 'woman'),
  );
  for (const candidate of candidates) await addPrimaryPhoto(database, candidate);

  const reservations = new PostgresCandidateReservationStore(database);
  const deliveries = new PostgresCandidateDeliveryStore(database);
  const reservationStartedAt = performance.now();
  const firstWave = await Promise.all(
    Array.from({ length: 50 }, () =>
      reservations.reserveNext(candidateQuery(viewer!.userId), reservationGenerated()),
    ),
  );
  const first = firstWave[0];
  if (
    first === undefined ||
    firstWave.some(
      (item) => item?.deliveryId !== first.deliveryId || item.targetUserId !== first.targetUserId,
    )
  )
    throw new Error('ACC-016 failed: concurrent reservations did not converge.');

  const completions = await Promise.all(
    Array.from({ length: 25 }, () =>
      deliveries.recordDelivered(
        { deliveryId: first.deliveryId, providerMessageId: '16001' },
        deliveredGenerated(),
      ),
    ),
  );
  if (
    completions.filter((result) => !result.replayed).length !== 1 ||
    completions.filter((result) => result.replayed).length !== 24
  )
    throw new Error('ACC-016 failed: delivery completion was not replay-safe.');

  const secondWave = await Promise.all(
    Array.from({ length: 25 }, () =>
      reservations.reserveNext(candidateQuery(viewer!.userId), reservationGenerated()),
    ),
  );
  const second = secondWave[0];
  if (
    second === undefined ||
    second.targetUserId === first.targetUserId ||
    secondWave.some(
      (item) => item?.deliveryId !== second.deliveryId || item.targetUserId !== second.targetUserId,
    )
  )
    throw new Error('ACC-016 failed: consumed candidate repeated or replacement diverged.');
  const reservationDurationMs = Math.round(performance.now() - reservationStartedAt);

  const pairCount = 20;
  const pairUsers = await seedActiveUsers(
    database,
    Array.from({ length: pairCount * 2 }, (_, index) => (index % 2 === 0 ? 'man' : 'woman')),
  );
  const interactions = new PostgresInteractionStore(database);
  const likeStartedAt = performance.now();
  const likeResults = await Promise.all(
    Array.from({ length: pairCount }, (_, index) => {
      const left = pairUsers[index * 2]!;
      const right = pairUsers[index * 2 + 1]!;
      return [
        interactions.sendLike(likeCommand(left.userId, right.userId), likeGenerated()),
        interactions.sendLike(likeCommand(right.userId, left.userId), likeGenerated()),
      ];
    }).flat(),
  );
  const matchIds = [
    ...new Set(
      likeResults.flatMap((result) =>
        result.outcome === 'matched' && result.matchId !== undefined ? [result.matchId] : [],
      ),
    ),
  ];
  if (
    likeResults.filter((result) => result.outcome === 'liked').length !== pairCount ||
    likeResults.filter((result) => result.outcome === 'matched').length !== pairCount ||
    matchIds.length !== pairCount
  )
    throw new Error('ACC-017 failed: opposite Likes did not converge to one Match per pair.');
  const [matches, matchParticipants, chats, chatParticipants] = await Promise.all([
    database.selectFrom('matching.matches').select('id').where('id', 'in', matchIds).execute(),
    database
      .selectFrom('matching.match_participants')
      .select('match_id')
      .where('match_id', 'in', matchIds)
      .execute(),
    database
      .selectFrom('chat.chat_sessions')
      .select(['id', 'match_id'])
      .where('match_id', 'in', matchIds)
      .execute(),
    database
      .selectFrom('chat.chat_participants')
      .innerJoin(
        'chat.chat_sessions',
        'chat.chat_sessions.id',
        'chat.chat_participants.chat_session_id',
      )
      .select('chat.chat_participants.user_id')
      .where('chat.chat_sessions.match_id', 'in', matchIds)
      .execute(),
  ]);
  const likeDurationMs = Math.round(performance.now() - likeStartedAt);
  if (
    matches.length !== pairCount ||
    matchParticipants.length !== pairCount * 2 ||
    chats.length !== pairCount ||
    chatParticipants.length !== pairCount * 2 ||
    reservationDurationMs > 30_000 ||
    likeDurationMs > 30_000
  )
    throw new Error(
      `M3 load smoke failed: matches=${matches.length}, matchParticipants=${matchParticipants.length}, chats=${chats.length}, chatParticipants=${chatParticipants.length}, reservationDurationMs=${reservationDurationMs}, likeDurationMs=${likeDurationMs}`,
    );

  process.stdout.write(
    `${JSON.stringify({ scenarios: ['ACC-016/M3-CONSUMPTION-RACE', 'ACC-017/M3-MUTUAL-LIKE-RACE'], reservationAttempts: 75, deliveryCompletionAttempts: 25, matchedPairs: pairCount, reservationDurationMs, likeDurationMs })}\n`,
  );
} finally {
  await database.destroy();
}
