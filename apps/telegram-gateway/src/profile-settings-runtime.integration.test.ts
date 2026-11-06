import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  PostgresProfileStore,
  PostgresUserSessionStore,
  PostgresNotificationPreferenceStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createRedisConnection } from '@nakh/queue-redis';
import { TelegramBotApiMenuClient } from '@nakh/telegram';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createMediaAuthorityFixture } from '../../../packages/persistence-postgres/src/testing/media-authority-fixture.js';
import { createReportUser } from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { referenceFixtureConfig } from '../../../packages/persistence-postgres/src/testing/release-reference-config.js';
import { TelegramProfileRuntime } from './profile-runtime.js';
import { TelegramAccountRuntime } from './account-runtime.js';
import { TelegramSignupRuntime } from './signup-runtime.js';
import type { UserSessionActor } from '@nakh/application';

const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
type Message = {
  id: number;
  recipient: string;
  text: string;
  prompt: boolean;
  buttons: Array<{ text: string; callback_data: string }>;
};
describe.skipIf(url === undefined || redisUrl === undefined)(
  'owned profile and settings bot journeys',
  () => {
    let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
      database: NakhDatabase,
      redis: ReturnType<typeof createRedisConnection>;
    let userId: string,
      peer: string,
      sender: number,
      profile: TelegramProfileRuntime,
      account: TelegramAccountRuntime,
      rootMenu: TelegramSignupRuntime,
      prefix: string;
    let serial = 70000;
    const messages: Message[] = [];
    const homeCalls: Array<UserSessionActor> = [];
    const incoming = (text: string): Record<string, unknown> => ({
      update_id: serial++,
      message: {
        message_id: serial++,
        text,
        from: { id: sender, is_bot: false },
        chat: { id: sender, type: 'private' },
      },
    });
    const callback = (data: string, from = sender): unknown => ({
      update_id: serial++,
      callback_query: {
        id: String(serial++),
        data,
        from: { id: from, is_bot: false },
        message: {
          message_id: 1,
          from: { id: 12345, is_bot: true },
          chat: { id: from, type: 'private' },
        },
      },
    });
    const latest = (): Message => messages.at(-1)!;
    const button = (label: string): string => {
      const found = latest().buttons.find((b) => b.text === label);
      if (!found) throw new Error('Missing synthetic menu button: ' + label);
      return found.callback_data;
    };
    const reply = (text: string): unknown => {
      const prompt = messages.findLast((m) => m.prompt && m.recipient === String(sender));
      if (!prompt) throw new Error('Missing synthetic prompt');
      const update = incoming(text),
        message = update.message as Record<string, unknown>;
      message.reply_to_message = {
        message_id: prompt.id,
        from: { id: 12345, is_bot: true },
        chat: { id: sender, type: 'private' },
      };
      return update;
    };
    const actor = async (): Promise<UserSessionActor> => {
      const grant = await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('actor_user_id', '=', userId)
        .where('event_type', '=', 'identity.user-session-issued.v1')
        .orderBy('occurred_at', 'desc')
        .executeTakeFirstOrThrow();
      return { kind: 'user', userId, productEpoch: 0, sessionGrantId: grant.id };
    };
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'profile_settings_ui');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 20000,
      });
      redis = createRedisConnection(redisUrl!);
    });
    beforeEach(async () => {
      messages.length = 0;
      homeCalls.length = 0;
      sender = 73330000 + serial++;
      const fixture = await createMediaAuthorityFixture(database);
      userId = fixture.ownerUserId;
      peer = await createReportUser(database);
      const now = new Date(),
        p = await database
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
        .values(interests.map((v) => ({ profile_id: p.id, interest_id: v.id })))
        .execute();
      await database
        .insertInto('profile.profile_optional_details')
        .values({
          profile_id: p.id,
          height_cm: 174,
          job_title: 'Existing job',
          education_level_code: null,
          smoking_preference_code: null,
          pets_preference_code: null,
          exercise_frequency_code: null,
          religion_importance_code: null,
          children_preference_code: null,
        })
        .execute();
      await database
        .updateTable('profile.profiles')
        .set({ bio: 'Existing private biography' })
        .where('id', '=', p.id)
        .execute();
      await database
        .insertInto('notification.notification_preferences')
        .values({ user_id: userId, created_at: now, updated_at: now })
        .execute();
      await database
        .insertInto('identity.guest_preview_counters')
        .values({ user_id: userId, limit_count: 10, first_preview_at: null, last_preview_at: null })
        .execute();
      await database
        .insertInto('identity.telegram_identities')
        .values([
          {
            user_id: userId,
            telegram_user_id: String(sender),
            username: null,
            first_seen_at: now,
            last_seen_at: now,
          },
          {
            user_id: peer,
            telegram_user_id: String(sender + 1),
            username: null,
            first_seen_at: now,
            last_seen_at: now,
          },
        ])
        .execute();
      prefix = 'profile-settings-' + randomUUID();
      const base = referenceFixtureConfig(),
        config = {
          ...base,
          telegram: { ...base.telegram, accountMenuEnabled: true },
          redis: { ...base.redis, queuePrefix: prefix },
        };
      const client = new TelegramBotApiMenuClient(`12345:${'a'.repeat(24)}`, (input, init) => {
        if (input.endsWith('/answerCallbackQuery'))
          return Promise.resolve(new Response('{"ok":true,"result":true}'));
        if (typeof init?.body !== 'string') throw new Error('Missing synthetic bot request');
        const body = JSON.parse(init.body) as {
          chat_id: string;
          text: string;
          reply_markup?: {
            inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
            force_reply?: boolean;
          };
        };
        const id = serial++;
        messages.push({
          id,
          recipient: body.chat_id,
          text: body.text,
          prompt: body.reply_markup?.force_reply === true,
          buttons: body.reply_markup?.inline_keyboard?.flat() ?? [],
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                message_id: id,
                from: { id: 12345, is_bot: true },
                chat: { id: Number(body.chat_id), type: 'private' },
              },
            }),
          ),
        );
      });
      const home = (_recipient: string, original: UserSessionActor): Promise<void> => {
        homeCalls.push({ ...original });
        return rootMenu.openRoot(_recipient, original);
      };
      profile = new TelegramProfileRuntime(
        config,
        database,
        redis,
        '12345',
        Buffer.alloc(32, 53),
        client,
        home,
      );
      account = new TelegramAccountRuntime(
        config,
        database,
        database,
        redis,
        '12345',
        Buffer.alloc(32, 53),
        client,
        home,
      );
      rootMenu = new TelegramSignupRuntime(
        database,
        redis,
        prefix,
        '12345',
        Buffer.alloc(32, 53),
        client,
        { consume: () => Promise.resolve({ allowed: true, remaining: 119, retryAfterSeconds: 0 }) },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        database,
        account,
        profile,
      );
      await rootMenu.onModuleInit();
      await profile.onModuleInit();
      await account.onModuleInit();
    });
    afterAll(async () => {
      await redis?.quit();
      await database?.destroy();
      await isolated?.destroy();
    });
    it('edits a name from its exact private prompt and keeps raw field text out of Redis', async () => {
      await profile.handle(incoming('/edit_profile'));
      await profile.handle(callback(button('Name')));
      await profile.handle(reply('Private edited name'));
      expect(latest().text).toContain('Profile saved.');
      expect(latest().text).toContain('Private edited name');
      expect(
        (await new PostgresProfileStore(database, await actor()).getOwnProfile(userId))?.name,
      ).toBe('Private edited name');
      const values: string[] = [];
      for (const key of await redis.keys(prefix + '*'))
        if ((await redis.type(key)) === 'string') values.push((await redis.get(key)) ?? '');
      expect(values.join('\n')).not.toContain('Private edited name');
      await profile.handle(callback(button('Main menu')));
      expect(homeCalls).toHaveLength(1);
      expect(homeCalls[0]?.sessionGrantId).toBe((await actor()).sessionGrantId);
    });
    it('opens both owned menus from the composed main menu without renewing the original grant', async () => {
      await profile.handle(incoming('/edit_profile'));
      const original = await actor();
      await profile.handle(callback(button('Main menu')));
      await rootMenu.handle(callback(button('Settings')));
      expect(latest().buttons.some((b) => b.text === 'Language')).toBe(true);
      await account.handle(callback(button('Main menu')));
      await rootMenu.handle(callback(button('Edit profile')));
      expect(latest().buttons.some((b) => b.text === 'Name')).toBe(true);
      expect((await actor()).sessionGrantId).toBe(original.sessionGrantId);
    });
    it('changes an optional field without clearing existing bio, height or other fields', async () => {
      await profile.handle(incoming('/edit_profile'));
      await profile.handle(callback(button('Optional details')));
      await profile.handle(callback(button('Job')));
      await profile.handle(reply('Updated private job'));
      const saved = await new PostgresProfileStore(database, await actor()).getOwnEditSnapshot(
        userId,
      );
      expect(saved?.optionalDetails).toMatchObject({
        job: 'Updated private job',
        bio: 'Existing private biography',
        heightCm: 174,
      });
      await profile.handle(callback(button('Bio')));
      await profile.handle(reply('Updated private biography'));
      expect(
        (await new PostgresProfileStore(database, await actor()).getOwnEditSnapshot(userId))
          ?.optionalDetails,
      ).toMatchObject({
        job: 'Updated private job',
        bio: 'Updated private biography',
        heightCm: 174,
      });
    });
    it('rejects stale edits instead of overwriting a concurrent profile change', async () => {
      await profile.handle(incoming('/edit_profile'));
      await profile.handle(callback(button('Name')));
      const original = await actor(),
        store = new PostgresProfileStore(database, original),
        before = await store.getOwnProfile(userId);
      await store.updateOwnProfile({
        command: {
          commandId: randomUUID(),
          requestId: randomUUID(),
          commandType: 'profile.update',
          schemaVersion: 1,
          actor: { kind: 'user', userId },
          idempotencyKey: randomUUID(),
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: { expectedProfileVersion: before!.version, patch: { name: 'Concurrent name' } },
        },
        auditId: randomUUID(),
        eventId: randomUUID(),
        processedAt: new Date(),
      });
      await profile.handle(reply('Stale replacement'));
      expect(latest().text).toContain('Your profile changed');
      expect((await store.getOwnProfile(userId))?.name).toBe('Concurrent name');
    });
    it('commits a complete location hierarchy only after the final city choice', async () => {
      await profile.handle(incoming('/edit_profile'));
      const store = new PostgresProfileStore(database, await actor());
      const before = await store.getOwnProfile(userId);
      await profile.handle(callback(button('Location')));
      await profile.handle(callback(button('Iran')));
      await profile.handle(callback(button('Isfahan')));
      expect((await store.getOwnProfile(userId))?.version).toBe(before?.version);
      await profile.handle(callback(button('Isfahan')));
      expect(await store.getOwnProfile(userId)).toMatchObject({
        countryCode: 'iran',
        provinceCode: 'isfahan',
        cityCode: 'isfahan',
        version: before!.version + 1,
      });
    });
    it('makes multi-select taps absolute and clears only the selected optional field', async () => {
      await profile.handle(incoming('/edit_profile'));
      await profile.handle(callback(button('Optional details')));
      await profile.handle(callback(button('Spoken languages')));
      const english = button('English');
      await profile.handle(callback(english));
      await profile.handle(callback(english));
      const store = new PostgresProfileStore(database, await actor());
      expect((await store.getOwnEditSnapshot(userId))?.optionalDetails.languageCodes).toEqual([
        'english',
      ]);
      await profile.handle(callback(button('Remove this answer')));
      expect((await store.getOwnEditSnapshot(userId))?.optionalDetails).toMatchObject({
        languageCodes: [],
        job: 'Existing job',
        heightCm: 174,
        bio: 'Existing private biography',
      });
    });
    it('prevents borrowed buttons and revoked original prompts from exposing or changing profiles', async () => {
      await profile.handle(incoming('/edit_profile'));
      const name = button('Name'),
        count = messages.length;
      await expect(profile.handle(callback(name, sender + 1))).rejects.toMatchObject({
        status: 401,
      });
      expect(messages).toHaveLength(count);
      await profile.handle(callback(name));
      const original = await actor();
      await new PostgresUserSessionStore(database).revoke(
        original,
        original.sessionGrantId,
        randomUUID(),
      );
      const before = messages.length;
      await expect(profile.handle(reply('Revoked write'))).rejects.toMatchObject({ status: 401 });
      expect(messages).toHaveLength(before);
    });
    it('submits a protected birth-year correction for review without changing the protected value', async () => {
      await profile.handle(incoming('/edit_profile'));
      const original = await actor(),
        before = await new PostgresProfileStore(database, original).getOwnProfile(userId);
      await profile.handle(callback(button('Request birth-year or gender correction')));
      await profile.handle(callback(button('Birth year')));
      await profile.handle(reply('1994\nPrivate correction reason'));
      expect(latest().text).toContain('submitted for review');
      expect(latest().text).toContain('Pending');
      expect(
        (await new PostgresProfileStore(database, original).getOwnProfile(userId))?.birthYear,
      ).toBe(before!.birthYear);
      const request = await database
        .selectFrom('profile.profile_change_requests')
        .select(['status', 'requested_value'])
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(request).toMatchObject({ status: 'pending', requested_value: 1994 });
      const values: string[] = [];
      for (const key of await redis.keys(prefix + '*'))
        if ((await redis.type(key)) === 'string') values.push((await redis.get(key)) ?? '');
      expect(values.join('\n')).not.toContain('Private correction reason');
    });
    it('changes visibility and ordinary notifications through versioned native commands without financial reads', async () => {
      await account.handle(incoming('/settings'));
      const hide = button('Profile visible: On');
      await account.handle(callback(hide));
      expect(latest().buttons.some((b) => b.text === 'Profile visible: Off')).toBe(true);
      await account.handle(callback(hide));
      expect(
        (
          await database
            .selectFrom('identity.user_settings')
            .select('version')
            .where('user_id', '=', userId)
            .executeTakeFirstOrThrow()
        ).version,
      ).toBe(2);
      await account.handle(callback(button('Notifications')));
      await account.handle(callback(button('Chat messages: On')));
      expect(
        (await new PostgresNotificationPreferenceStore(database, await actor()).read()).chatEnabled,
      ).toBe(false);
      expect(latest().buttons.some((b) => b.text === 'Chat messages: Off')).toBe(true);
      await account.handle(callback(button('Back to settings')));
      await account.handle(callback(button('Language')));
      expect(latest().buttons.some((b) => b.text === '✓ English')).toBe(true);
      expect(
        await database
          .selectFrom('billing.credit_accounts')
          .select('user_id')
          .where('user_id', '=', userId)
          .execute(),
      ).toEqual([]);
    });
  },
);
