import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InteractionStore } from '@nakh/application';
import type { MarkNotInterestedCommand, SendLikeCommand } from '@nakh/contracts';

import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresInteractionStore } from './interaction-store.js';
import { PostgresLikedByStore } from './liked-by-store.js';
import { PostgresMediaDeliveryAuthorization } from './media-delivery-authorization.js';
import { seedValidMedia } from './media-fixtures.js';
import { runMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const manGenderId = '20000000-0000-4000-8000-000000000001';
const womanGenderId = '20000000-0000-4000-8000-000000000002';
const everyonePreferenceId = '20000000-0000-4000-8000-000000000013';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';

async function createActiveUser(database: NakhDatabase, genderOptionId: string): Promise<string> {
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
      name: 'Interaction fixture',
      birth_year: new Date().getUTCFullYear() - 30,
      gender_option_id: genderOptionId,
      gender_preference_id: everyonePreferenceId,
      relationship_goal_id: relationshipGoalId,
      country_id: countryId,
      province_id: provinceId,
      city_id: cityId,
      highlight: 'Interaction fixture',
      bio: null,
      completion_status: 'complete',
      ever_completed: true,
      completed_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return userId;
}

async function addPrimaryPhoto(
  database: NakhDatabase,
  userId: string,
): Promise<Readonly<{ photoId: string; assetId: string }>> {
  const profile = await database
    .selectFrom('profile.profiles')
    .select('id')
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  const assetId = await seedValidMedia(database, userId);
  const now = new Date();
  const photoId = randomUUID();
  await database
    .insertInto('media.profile_photos')
    .values({
      id: photoId,
      profile_id: profile.id,
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
  return { photoId, assetId };
}

function likeCommand(senderUserId: string, receiverUserId: string): SendLikeCommand {
  return {
    commandId: randomUUID(),
    commandType: 'interaction.send-like',
    schemaVersion: 1,
    actor: { kind: 'user', userId: senderUserId },
    requestId: randomUUID(),
    idempotencyKey: `like:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { targetUserId: receiverUserId },
  };
}

function rejectionCommand(senderUserId: string, receiverUserId: string): MarkNotInterestedCommand {
  return {
    commandId: randomUUID(),
    commandType: 'interaction.mark-not-interested',
    schemaVersion: 1,
    actor: { kind: 'user', userId: senderUserId },
    requestId: randomUUID(),
    idempotencyKey: `reject:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { targetUserId: receiverUserId, source: 'explore' },
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

function rejectionGenerated(): Parameters<InteractionStore['markNotInterested']>[1] {
  return {
    rejectionId: randomUUID(),
    auditId: randomUUID(),
    rejectionEventId: randomUUID(),
    likeClosedEventId: randomUUID(),
    consumptionEventId: randomUUID(),
    occurredAt: new Date(),
  };
}

describe.skipIf(databaseUrl === undefined)('M3 interaction persistence', () => {
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

  it('serializes opposite Likes into exactly one Match and one two-person Chat', async () => {
    const firstUserId = await createActiveUser(database, manGenderId);
    const secondUserId = await createActiveUser(database, womanGenderId);
    const firstCommand = likeCommand(firstUserId, secondUserId);
    const secondCommand = likeCommand(secondUserId, firstUserId);
    const firstGenerated = likeGenerated();
    const secondGenerated = likeGenerated();
    const store = new PostgresInteractionStore(database);
    const results = await Promise.all([
      store.sendLike(firstCommand, firstGenerated),
      store.sendLike(secondCommand, secondGenerated),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['liked', 'matched']);
    const matched = results.find((result) => result.outcome === 'matched')!;
    const replayCommand = results[0].outcome === 'matched' ? firstCommand : secondCommand;
    await expect(store.sendLike(replayCommand, likeGenerated())).resolves.toMatchObject({
      outcome: 'matched',
      matchId: matched.matchId,
      replayed: true,
    });

    const likes = await database
      .selectFrom('interaction.likes')
      .select('status')
      .where('sender_user_id', 'in', [firstUserId, secondUserId])
      .execute();
    const matches = await database
      .selectFrom('matching.matches')
      .select('id')
      .where('user_low_id', '=', [firstUserId, secondUserId].sort()[0]!)
      .where('user_high_id', '=', [firstUserId, secondUserId].sort()[1]!)
      .execute();
    const matchParticipants = await database
      .selectFrom('matching.match_participants')
      .select('user_id')
      .where('match_id', '=', matched.matchId!)
      .execute();
    const chats = await database
      .selectFrom('chat.chat_sessions')
      .select('id')
      .where('match_id', '=', matched.matchId!)
      .execute();
    const chatParticipants = await database
      .selectFrom('chat.chat_participants')
      .select('user_id')
      .where('chat_session_id', '=', chats[0]!.id)
      .execute();
    expect(likes.map((like) => like.status)).toEqual(['closed_by_match', 'closed_by_match']);
    expect(matches).toHaveLength(1);
    expect(matchParticipants.map((row) => row.user_id).sort()).toEqual(
      [firstUserId, secondUserId].sort(),
    );
    expect(chats).toHaveLength(1);
    expect(chatParticipants.map((row) => row.user_id).sort()).toEqual(
      [firstUserId, secondUserId].sort(),
    );
  });

  it('records an irreversible silent rejection and closes the received Like', async () => {
    const receiverUserId = await createActiveUser(database, manGenderId);
    const likerUserId = await createActiveUser(database, womanGenderId);
    const store = new PostgresInteractionStore(database);
    const receivedLike = await store.sendLike(
      likeCommand(likerUserId, receiverUserId),
      likeGenerated(),
    );
    await expect(
      store.markNotInterested(
        {
          ...rejectionCommand(receiverUserId, likerUserId),
          data: { targetUserId: likerUserId, source: 'liked_by' },
        },
        rejectionGenerated(),
      ),
    ).rejects.toMatchObject({ code: 'interaction_unavailable' });
    const command = rejectionCommand(receiverUserId, likerUserId);
    const generated = rejectionGenerated();
    await expect(store.markNotInterested(command, generated)).resolves.toEqual({
      outcome: 'rejected',
      interactionId: generated.rejectionId,
      replayed: false,
    });
    await expect(store.markNotInterested(command, rejectionGenerated())).resolves.toMatchObject({
      interactionId: generated.rejectionId,
      replayed: true,
    });
    const like = await database
      .selectFrom('interaction.likes')
      .select('status')
      .where('id', '=', receivedLike.interactionId)
      .executeTakeFirstOrThrow();
    const eventTypes = await database
      .selectFrom('platform.outbox_events')
      .select('event_type')
      .where('causation_id', '=', command.commandId)
      .orderBy('event_type')
      .execute();
    expect(like.status).toBe('closed_by_not_interested');
    expect(eventTypes.map((event) => event.event_type)).toEqual([
      'discovery.consumption-created.v1',
      'interaction.like-closed.v1',
      'interaction.not-interested-created.v1',
    ]);
  });

  it('uses one actionable predicate for Liked By count and keyset page', async () => {
    const receiverId = await createActiveUser(database, manGenderId);
    const firstLikerId = await createActiveUser(database, womanGenderId);
    const secondLikerId = await createActiveUser(database, womanGenderId);
    const excludedLikerId = await createActiveUser(database, womanGenderId);
    await Promise.all([
      addPrimaryPhoto(database, firstLikerId),
      addPrimaryPhoto(database, secondLikerId),
      addPrimaryPhoto(database, excludedLikerId),
    ]);
    const interactions = new PostgresInteractionStore(database);
    await interactions.sendLike(likeCommand(firstLikerId, receiverId), likeGenerated());
    await interactions.sendLike(likeCommand(secondLikerId, receiverId), likeGenerated());
    await interactions.sendLike(likeCommand(excludedLikerId, receiverId), likeGenerated());
    await database
      .updateTable('identity.accounts')
      .set({ state: 'restricted', state_changed_at: new Date() })
      .where('user_id', '=', excludedLikerId)
      .execute();

    const store = new PostgresLikedByStore(database);
    const query = {
      actor: { kind: 'user' as const, userId: receiverId },
      requestId: randomUUID(),
      limit: 1,
    };
    const firstPage = await store.readActionablePage(query);
    expect(firstPage).toMatchObject({ totalCount: 2, hasMore: true });
    expect(firstPage.rows).toHaveLength(1);
    expect(Object.keys(firstPage.rows[0]!).sort()).toEqual([
      'createdAt',
      'likeId',
      'primaryPhotoId',
    ]);
    const secondPage = await store.readActionablePage(query, {
      createdAt: firstPage.rows[0]!.createdAt,
      likeId: firstPage.rows[0]!.likeId,
    });
    expect(secondPage).toMatchObject({ totalCount: 2, hasMore: false });
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.rows[0]!.likeId).not.toBe(firstPage.rows[0]!.likeId);

    await interactions.markNotInterested(
      rejectionCommand(receiverId, firstLikerId),
      rejectionGenerated(),
    );
    const finalPage = await store.readActionablePage({ ...query, limit: 10 });
    expect(finalPage).toMatchObject({ totalCount: 1, hasMore: false });
    expect(finalPage.rows).toHaveLength(1);
  });

  it('authorizes only the current actionable Liked By blurred primary photo', async () => {
    const receiverId = await createActiveUser(database, manGenderId);
    const likerId = await createActiveUser(database, womanGenderId);
    const strangerId = await createActiveUser(database, manGenderId);
    const { photoId, assetId } = await addPrimaryPhoto(database, likerId);
    const interactions = new PostgresInteractionStore(database);
    const delivery = new PostgresMediaDeliveryAuthorization(database);
    await interactions.sendLike(likeCommand(likerId, receiverId), likeGenerated());
    const request = {
      actor: { kind: 'user' as const, userId: receiverId },
      photoId,
      purpose: 'liked_by_blur' as const,
      requestedVariant: 'blurred_preview' as const,
    };
    await expect(delivery.authorize(request)).rejects.toMatchObject({
      code: 'media_delivery_denied',
    });
    await database
      .insertInto('media.photo_variants')
      .values({
        id: randomUUID(),
        asset_id: assetId,
        variant_type: 'blurred_preview',
        transformation_version: 1,
        storage_provider: 'r2',
        storage_key: `variants/test/${assetId}/blurred-preview-v1.webp`,
        delivery_path: `/media/${assetId}/blurred-preview-v1.webp`,
        width: 96,
        height: 96,
        sha256: Buffer.alloc(32, 1),
        generated_at: new Date(),
        verified_at: new Date(),
        deleted_at: null,
        storage_deleted_at: null,
      })
      .execute();
    await expect(delivery.authorize(request)).resolves.toEqual({
      deliveryPath: `/media/${assetId}/blurred-preview-v1.webp`,
      variantType: 'blurred_preview',
      cachePolicy: 'no-store',
    });
    await expect(
      delivery.authorize({ ...request, actor: { kind: 'user', userId: strangerId } }),
    ).rejects.toMatchObject({ code: 'media_delivery_denied' });
    await expect(
      delivery.authorize({ ...request, requestedVariant: 'thumbnail' }),
    ).rejects.toMatchObject({ code: 'media_delivery_denied' });
    await expect(delivery.authorize({ ...request, photoId: randomUUID() })).rejects.toMatchObject({
      code: 'media_delivery_denied',
    });
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: false })
      .where('user_id', '=', likerId)
      .execute();
    await expect(delivery.authorize(request)).resolves.toMatchObject({
      variantType: 'blurred_preview',
    });
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: false })
      .where('user_id', '=', receiverId)
      .execute();
    await expect(delivery.authorize(request)).rejects.toMatchObject({
      code: 'media_delivery_denied',
    });
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: true })
      .where('user_id', '=', receiverId)
      .execute();
    await database
      .updateTable('identity.accounts')
      .set({ state: 'restricted', state_changed_at: new Date() })
      .where('user_id', '=', likerId)
      .execute();
    await expect(delivery.authorize(request)).rejects.toMatchObject({
      code: 'media_delivery_denied',
    });
    await database
      .updateTable('identity.accounts')
      .set({ state: 'active', state_changed_at: new Date() })
      .where('user_id', '=', likerId)
      .execute();
    await interactions.markNotInterested(
      rejectionCommand(receiverId, likerId),
      rejectionGenerated(),
    );
    await expect(delivery.authorize(request)).rejects.toMatchObject({
      code: 'media_delivery_denied',
    });
  });
});
