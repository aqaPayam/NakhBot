import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChangeSettingsWrite,
  NotificationPreferenceWrite,
  UserSessionActor,
} from '@nakh/application';
import { shouldCreateTelegramDelivery } from '@nakh/domain';
import type { ChangeVisibilityCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createMediaAuthorityFixture } from './testing/media-authority-fixture.js';
import { createReportUser } from './testing/report-fixture.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresIdentityStore } from './identity-store.js';
import { PostgresProfileStore } from './profile-store.js';
import { PostgresNotificationPreferenceStore } from './notification-preference-store.js';
import { insertNotification } from './notification-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('native owned account settings and editor snapshots', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, database: NakhDatabase;
  let actor: UserSessionActor,
    peer: string,
    identity: PostgresIdentityStore,
    prefs: PostgresNotificationPreferenceStore;
  const visibility = (
    enabled = false,
  ): ChangeSettingsWrite & { command: ChangeVisibilityCommand } => ({
    command: {
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'identity.change-visibility',
      schemaVersion: 1,
      actor: { kind: 'user', userId: actor.userId },
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { visibilityEnabled: enabled, expectedSettingsVersion: 1 },
    },
    auditId: randomUUID(),
    eventId: randomUUID(),
    processedAt: new Date(),
  });
  const preference = (
    kind: 'chat' | 'like' | 'nakh' | 'match' = 'chat',
    expectedVersion = 1,
  ): NotificationPreferenceWrite => ({
    command: {
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'notification.change-preference',
      schemaVersion: 1,
      actor: { kind: 'user', userId: actor.userId },
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { kind, enabled: false, expectedVersion },
    },
    auditId: randomUUID(),
    processedAt: new Date(),
  });
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'owned_account_settings');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 20000,
    });
  });
  beforeEach(async () => {
    const fixture = await createMediaAuthorityFixture(database),
      userId = fixture.ownerUserId;
    peer = await createReportUser(database);
    const now = new Date();
    await database
      .insertInto('identity.user_settings')
      .values({ user_id: peer, created_at: now, updated_at: now })
      .execute();
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: userId, created_at: now, updated_at: now })
      .execute();
    const profile = await database
      .selectFrom('profile.profiles')
      .select('id')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    const interests = await database
      .selectFrom('catalog.interests')
      .select('id')
      .where('is_active', '=', true)
      .orderBy('display_order')
      .limit(5)
      .execute();
    await database
      .insertInto('profile.profile_interests')
      .values(interests.map((v) => ({ profile_id: profile.id, interest_id: v.id })))
      .execute();
    const session = await new PostgresUserSessionStore(database).issue(
      { userId, productEpoch: 0 },
      randomUUID(),
    );
    actor = { kind: 'user', userId, productEpoch: 0, sessionGrantId: session!.id };
    identity = new PostgresIdentityStore(database, actor);
    prefs = new PostgresNotificationPreferenceStore(database, actor);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  it('converges concurrent settings retries under the original session, with one audit effect', async () => {
    const input = visibility(),
      results = await Promise.all(Array.from({ length: 20 }, () => identity.changeSettings(input)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.visibilityEnabled === false && r.settingsVersion === 2)).toBe(
      true,
    );
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('actor_user_id', '=', actor.userId)
        .where('event_type', '=', 'identity.visibility-changed.v1')
        .execute(),
    ).toHaveLength(1);
  });
  it('denies cached settings replies after original session revocation or a ban', async () => {
    const input = visibility();
    await identity.changeSettings(input);
    await database
      .updateTable('identity.accounts')
      .set({ state: 'banned', version: sql`version+1` })
      .where('user_id', '=', actor.userId)
      .execute();
    await expect(identity.changeSettings(input)).rejects.toMatchObject({ status: 403 });
    await database
      .updateTable('identity.accounts')
      .set({ state: 'active', version: sql`version+1` })
      .where('user_id', '=', actor.userId)
      .execute();
    await new PostgresUserSessionStore(database).revoke(actor, actor.sessionGrantId, randomUUID());
    await expect(identity.changeSettings(input)).rejects.toMatchObject({ status: 401 });
  });
  it('captures settings ownership and command bodies before waits and rejects another user', async () => {
    const input = visibility(),
      expected = new Date(input.processedAt);
    const pending = identity.changeSettings(input);
    input.command.data.visibilityEnabled = true;
    input.processedAt.setTime(0);
    const result = await pending;
    expect(result.visibilityEnabled).toBe(false);
    expect(
      (
        await database
          .selectFrom('identity.user_settings')
          .select('updated_at')
          .where('user_id', '=', actor.userId)
          .executeTakeFirstOrThrow()
      ).updated_at,
    ).toEqual(expected);
    const other = visibility();
    other.command.actor = { kind: 'user', userId: peer };
    await expect(identity.changeSettings(other)).rejects.toMatchObject({ status: 401 });
    expect(
      (
        await database
          .selectFrom('identity.user_settings')
          .select('visibility_enabled')
          .where('user_id', '=', peer)
          .executeTakeFirstOrThrow()
      ).visibility_enabled,
    ).toBe(true);
  });
  it('persists four finite notification switches without muting critical categories', async () => {
    let version = 1;
    for (const kind of ['chat', 'like', 'nakh', 'match'] as const) {
      const result = await prefs.change(preference(kind, version));
      expect(result.changed).toBe(true);
      version = result.version;
    }
    const saved = await prefs.read();
    expect(saved).toMatchObject({
      version: 5,
      chatEnabled: false,
      likeEnabled: false,
      nakhEnabled: false,
      matchEnabled: false,
    });
    for (const type of [
      'new_chat_message',
      'like_received',
      'nakh_received',
      'match_created',
    ] as const)
      expect(shouldCreateTelegramDelivery(type, saved)).toBe(false);
    for (const type of [
      'ban_warning',
      'restriction_warning',
      'payment_success',
      'payment_failure',
      'admin_notice',
      'safety_notice',
      'report_result',
    ] as const)
      expect(shouldCreateTelegramDelivery(type, saved)).toBe(true);
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('actor_user_id', '=', actor.userId)
        .where('event_type', '=', 'notification.preference-changed.v1')
        .execute(),
    ).toHaveLength(4);
    const invalid = preference();
    Object.assign(invalid.command.data, { kind: 'safety' });
    expect(() => prefs.change(invalid)).toThrowError(expect.objectContaining({ status: 401 }));
    const ordinary = await insertNotification(database, {
      userId: actor.userId,
      type: 'new_chat_message',
      titleKey: 'notification.chat.title',
      bodyKey: 'notification.chat.body',
      payload: {},
      deduplicationKey: randomUUID(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
    });
    const safety = await insertNotification(database, {
      userId: actor.userId,
      type: 'safety_notice',
      titleKey: 'notification.safety.title',
      bodyKey: 'notification.safety.body',
      payload: {},
      deduplicationKey: randomUUID(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
    });
    expect(ordinary.telegramDeliveryId).toBeUndefined();
    expect(safety.telegramDeliveryId).toBeDefined();
  });
  it('serializes preference retries and rejects stale competing choices without lost updates', async () => {
    const input = preference(),
      results = await Promise.all(Array.from({ length: 20 }, () => prefs.change(input)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await prefs.read()).version).toBe(2);
    await expect(prefs.change(preference('like', 1))).rejects.toMatchObject({ status: 409 });
    expect((await prefs.read()).likeEnabled).toBe(true);
    await new PostgresUserSessionStore(database).revoke(actor, actor.sessionGrantId, randomUUID());
    await expect(prefs.change(input)).rejects.toMatchObject({ status: 401 });
  });
  it('requires the original owner for private editor snapshots and preserves optional siblings', async () => {
    const store = new PostgresProfileStore(database, actor),
      before = await store.getOwnEditSnapshot(actor.userId);
    expect(before).toBeDefined();
    const optional = {
      ...before!.optionalDetails,
      job: 'Existing job',
      bio: 'Existing private bio',
    };
    await store.updateOwnProfile({
      command: {
        commandId: randomUUID(),
        requestId: randomUUID(),
        commandType: 'profile.update',
        schemaVersion: 1,
        actor: { kind: 'user', userId: actor.userId },
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          expectedProfileVersion: before!.profile.version,
          patch: { optionalDetails: optional },
        },
      },
      auditId: randomUUID(),
      eventId: randomUUID(),
      processedAt: new Date(),
    });
    const current = await store.getOwnEditSnapshot(actor.userId);
    expect(current?.optionalDetails).toMatchObject({
      job: 'Existing job',
      bio: 'Existing private bio',
    });
    await store.updateOwnProfile({
      command: {
        commandId: randomUUID(),
        requestId: randomUUID(),
        commandType: 'profile.update',
        schemaVersion: 1,
        actor: { kind: 'user', userId: actor.userId },
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          expectedProfileVersion: current!.profile.version,
          patch: { optionalDetails: { ...current!.optionalDetails, job: 'Updated job' } },
        },
      },
      auditId: randomUUID(),
      eventId: randomUUID(),
      processedAt: new Date(),
    });
    expect((await store.getOwnEditSnapshot(actor.userId))?.optionalDetails).toMatchObject({
      job: 'Updated job',
      bio: 'Existing private bio',
    });
    await expect(store.getOwnEditSnapshot(peer)).rejects.toMatchObject({ status: 401 });
    await expect(
      new PostgresProfileStore(database).getOwnEditSnapshot(actor.userId),
    ).rejects.toMatchObject({ status: 401 });
    await new PostgresUserSessionStore(database).revoke(actor, actor.sessionGrantId, randomUUID());
    await expect(store.getOwnEditSnapshot(actor.userId)).rejects.toMatchObject({ status: 401 });
  });
});
