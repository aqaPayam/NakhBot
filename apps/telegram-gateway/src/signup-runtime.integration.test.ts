import 'reflect-metadata';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpaqueTokenStore } from '@nakh/application';
import {
  AesGcmProfileReportSnapshotReader,
  AesGcmPhotoReportSnapshotReader,
} from '@nakh/application';
import { parseConfig } from '@nakh/config';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  PostgresIdentityStore,
  PostgresSignupStore,
  PostgresAccountReturnStore,
  PostgresMediaDeliveryAuthorization,
  PostgresUserSessionStore,
  PostgresCreditLedgerStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createRedisConnection } from '@nakh/queue-redis';
import {
  TelegramBotApiMenuClient,
  TelegramStartAdapter,
  TelegramCandidateMediaRelay,
} from '@nakh/telegram';
import { seedValidMedia } from '../../../packages/persistence-postgres/src/media-fixtures.js';
import { createAccountReturnFixture } from '../../../packages/persistence-postgres/src/testing/account-return-fixture.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createMediaAuthorityFixture } from '../../../packages/persistence-postgres/src/testing/media-authority-fixture.js';
import { createReportPhoto } from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import {
  HmacMediaDeliveryTokens,
  EdgeHmacMediaAudienceAuthenticator,
  HmacMediaAudienceCredentials,
  MediaDeliveryUrlSigner,
} from '@nakh/media-delivery';
import { GuestPreviewRuntime } from './guest-preview-runtime.js';
import { TelegramGatewayModule } from './app.js';
import { TelegramSignupRuntime } from './signup-runtime.js';
import { signupRecord as record, type SignupNavigation } from './signup-navigation.js';
import { TelegramStarsClient, TelegramStarsRuntime } from './stars-runtime.js';
import { TelegramStarsKeys } from './stars-keys.js';
import { createTelegramReportRuntime, TelegramReportRuntime } from './report-runtime.js';
const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
const botId = 12345,
  botToken = `${botId}:${'a'.repeat(24)}`,
  key = Buffer.alloc(32, 154);
let serial = 200000;
function formText(form: FormData, key: string): string {
  const value = form.get(key);
  if (typeof value !== 'string') throw new Error('Missing synthetic provider field');
  return value;
}
type Message = {
  id: number;
  sender: string;
  text: string;
  keyboard: Array<Array<{ text: string; callback_data: string }>>;
  prompt: boolean;
};
function incoming(sender: string, text = '/start', updateId = serial++): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: serial++,
      text,
      from: { id: Number(sender), is_bot: false },
      chat: { id: Number(sender), type: 'private' },
    },
  };
}
function callback(sender: string, data: string, updateId = serial++): Record<string, unknown> {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      data,
      from: { id: Number(sender), is_bot: false },
      message: {
        message_id: 1,
        from: { id: botId, is_bot: true },
        chat: { id: Number(sender), type: 'private' },
      },
    },
  };
}
function response(
  sender: string,
  text: string,
  promptId: number,
  updateId = serial++,
): Record<string, unknown> {
  const update = incoming(sender, text, updateId),
    message = record(update.message)!;
  message.reply_to_message = {
    message_id: promptId,
    from: { id: botId, is_bot: true },
    chat: { id: Number(sender), type: 'private' },
  };
  return update;
}
class Transport {
  public readonly messages: Message[] = [];
  public fail = false;
  public readonly client = new TelegramBotApiMenuClient(botToken, (input, init) => {
    if (input.endsWith('/answerCallbackQuery'))
      return Promise.resolve(new Response('{"ok":true,"result":true}', { status: 200 }));
    if (this.fail) {
      this.fail = false;
      throw Error('private-provider-token-and-response');
    }
    if (typeof init?.body !== 'string') throw Error('Invalid synthetic provider request');
    const body = JSON.parse(init.body) as {
      chat_id: string;
      text: string;
      reply_markup?: { inline_keyboard?: Message['keyboard']; force_reply?: boolean };
    };
    const id = serial++;
    this.messages.push({
      id,
      sender: body.chat_id,
      text: body.text,
      keyboard: body.reply_markup?.inline_keyboard ?? [],
      prompt: body.reply_markup?.force_reply === true,
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: id,
            from: { id: botId, is_bot: true },
            chat: { id: Number(body.chat_id), type: 'private' },
          },
        }),
        { status: 200 },
      ),
    );
  });
  public last(sender: string): Message {
    const message = this.messages.findLast((m) => m.sender === sender);
    if (message === undefined) throw Error('Missing bot message');
    return message;
  }
}
// Native business commands and real Bot API serialization; the provider itself
// is synthetic. The optional composed-host case uses actual Redis as well.
describe.skipIf(url === undefined)('M9 interactive signup through bot transport', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, database: NakhDatabase;
  let transport: Transport,
    values: Map<string, Map<string, string>>,
    runtime: TelegramSignupRuntime;
  const limiter = {
    consume: () => Promise.resolve({ allowed: true, remaining: 119, retryAfterSeconds: 0 }),
  };
  function cache(life: Readonly<{ userId: string; productEpoch: number }>): OpaqueTokenStore {
    const id = `${life.userId}:${life.productEpoch}`;
    let map = values.get(id);
    if (map === undefined) {
      map = new Map();
      values.set(id, map);
    }
    const data = map;
    return {
      get: (k) => Promise.resolve(data.get(k)),
      putIfAbsent: (k, v) => {
        if (data.has(k)) return Promise.resolve(false);
        data.set(k, v);
        return Promise.resolve(true);
      },
    };
  }
  function instance(): TelegramSignupRuntime {
    return new TelegramSignupRuntime(
      database,
      {} as ReturnType<typeof createRedisConnection>,
      'm9-ui-native',
      String(botId),
      key,
      transport.client,
      limiter,
      cache,
    );
  }
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_signup_transport');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
  });
  beforeEach(() => {
    transport = new Transport();
    values = new Map();
    runtime = instance();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  async function open(sender: string, existingUser?: string): Promise<string> {
    const update = incoming(sender);
    let userId = existingUser;
    if (userId === undefined) {
      const result = await TelegramStartAdapter.withStore(
        new PostgresIdentityStore(database),
      ).handle(update);
      if (!result.handled) throw Error('No registration');
      userId = result.userId;
    }
    const context = await new PostgresIdentityStore(database).getByUserId(userId);
    if (context === undefined) throw Error('No context');
    const account = await database
      .selectFrom('identity.accounts')
      .select('product_epoch')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    await runtime.openStart({
      telegramUserId: sender,
      updateId: Number(update.update_id),
      life: { userId, productEpoch: account.product_epoch, accountVersion: context.accountVersion },
      context,
    });
    return userId;
  }
  async function eligibleExplorePair(viewer: string, target: string): Promise<void> {
    const preference = await database
      .selectFrom('profile.profiles')
      .select('gender_preference_id')
      .where('user_id', '=', viewer)
      .executeTakeFirstOrThrow();
    const gender = await database
      .selectFrom('catalog.gender_preference_members')
      .select('gender_option_id')
      .where('gender_preference_id', '=', preference.gender_preference_id)
      .orderBy('gender_option_id')
      .executeTakeFirstOrThrow();
    await database
      .updateTable('profile.profiles')
      .set({
        gender_option_id: gender.gender_option_id,
        gender_preference_id: preference.gender_preference_id,
      })
      .where('user_id', 'in', [viewer, target])
      .execute();
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: true })
      .where('user_id', 'in', [viewer, target])
      .execute();
  }
  function state(sender: string, data: string): SignupNavigation {
    const id = data.split(':')[1]!;
    for (const map of values.values())
      if (map.has(id)) {
        const env = JSON.parse(map.get(id)!) as { body: string };
        const body = JSON.parse(env.body) as { state: SignupNavigation };
        return body.state;
      }
    throw Error(`Missing test navigation for ${sender}`);
  }
  function find(
    sender: string,
    predicate: (nav: SignupNavigation, label: string) => boolean,
  ): string | undefined {
    return transport
      .last(sender)
      .keyboard.flat()
      .find((button) => predicate(state(sender, button.callback_data), button.text))?.callback_data;
  }
  async function action(
    sender: string,
    kind: SignupNavigation['action'],
    code?: string,
  ): Promise<void> {
    const data = find(
      sender,
      (nav) => nav.action === kind && (code === undefined || nav.code === code),
    );
    if (data === undefined) throw Error(`Missing ${kind} action`);
    await runtime.handle(callback(sender, data));
  }
  async function pick(sender: string, code: string): Promise<void> {
    for (let i = 0; i < 30; i++) {
      const back = find(
        sender,
        (nav) => nav.action === 'page' && Number(nav.code) < (nav.page ?? 0),
      );
      if (back === undefined) break;
      await runtime.handle(callback(sender, back));
    }
    for (let i = 0; i < 30; i++) {
      const target = find(sender, (nav) => nav.action === 'pick' && nav.code === code);
      if (target !== undefined) {
        await runtime.handle(callback(sender, target));
        return;
      }
      const next = find(
        sender,
        (nav) => nav.action === 'page' && Number(nav.code) > (nav.page ?? 0),
      );
      if (next === undefined) break;
      await runtime.handle(callback(sender, next));
    }
    throw Error('Missing catalog choice');
  }
  async function answer(sender: string, text: string): Promise<void> {
    const prompt = transport.last(sender);
    expect(prompt.prompt).toBe(true);
    await runtime.handle(response(sender, text, prompt.id));
  }
  async function toOptional(
    sender: string,
  ): Promise<{ userId: string; oldPrompt: number; primary: string; additional: string }> {
    const userId = await open(sender);
    await action(sender, 'begin');
    await action(sender, 'pick');
    const oldPrompt = transport.last(sender).id;
    await answer(sender, 'Private Signup Name');
    await answer(sender, '۱۹۹۵');
    await pick(sender, 'man');
    await pick(sender, 'women');
    for (const code of ['music', 'books', 'travel', 'coffee', 'art']) await pick(sender, code);
    await action(sender, 'save');
    await pick(sender, 'iran');
    await pick(sender, 'tehran');
    await pick(sender, 'tehran');
    await pick(sender, 'marriage');
    const primary = randomUUID(),
      additional = randomUUID();
    await seedValidMedia(database, userId, primary);
    await seedValidMedia(database, userId, additional);
    await action(sender, 'resume');
    await pick(sender, primary);
    await pick(sender, additional);
    await action(sender, 'save');
    await answer(sender, 'Private profile highlight');
    return { userId, oldPrompt, primary, additional };
  }
  it('completes all required steps and optional fields through signed buttons/replies, with one native confirmation across retries', async () => {
    const sender = String(serial++),
      f = await toOptional(sender);
    for (const [field, text] of [
      ['heightCm', '۱۸۰'],
      ['job', 'Private engineer'],
      ['bio', 'Private optional bio'],
    ] as const) {
      await action(sender, 'optional', field);
      await answer(sender, text);
    }
    for (const field of [
      'educationLevelCode',
      'smokingPreferenceCode',
      'petsPreferenceCode',
      'exerciseFrequencyCode',
      'religionCode',
      'childrenPreferenceCode',
    ]) {
      await action(sender, 'optional', field);
      await action(sender, 'pick');
    }
    for (const [field, code] of [
      ['languageCodes', 'persian'],
      ['personalityTagCodes', 'calm'],
    ] as const) {
      await action(sender, 'optional', field);
      await pick(sender, code);
      await action(sender, 'save');
    }
    await action(sender, 'save');
    expect(transport.last(sender).text).toContain('Private Signup Name');
    expect(transport.last(sender).text).toContain('180');
    expect(transport.last(sender).text).toContain('Private optional bio');
    const data = find(sender, (nav) => nav.action === 'finish')!;
    const update = callback(sender, data);
    await Promise.all(Array.from({ length: 10 }, () => runtime.handle(update)));
    expect(
      await database
        .selectFrom('profile.profiles')
        .select('id')
        .where('user_id', '=', f.userId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('media.profile_photos')
        .select('id')
        .where('asset_id', 'in', [f.primary, f.additional])
        .execute(),
    ).toHaveLength(2);
    expect(
      (
        await database
          .selectFrom('identity.accounts')
          .select('state')
          .where('user_id', '=', f.userId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('active');
    expect(transport.last(sender).text).toBe('What would you like to do?');
    for (const map of values.values())
      for (const body of map.values())
        for (const privateText of [
          'Private Signup Name',
          'Private profile highlight',
          'Private engineer',
          'Private optional bio',
        ])
          expect(body).not.toContain(privateText);
  });
  it('resumes from native state after cache loss and rejects an old reply instead of applying it to the current field', async () => {
    const sender = String(serial++),
      userId = await open(sender);
    await action(sender, 'begin');
    await action(sender, 'pick');
    const old = transport.last(sender).id;
    await answer(sender, 'Private Original Name');
    await runtime.handle(response(sender, '1900', old));
    const draft = await database
      .selectFrom('identity.signup_drafts')
      .select('draft_data')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(record(draft.draft_data.name)?.value).toBe('Private Original Name');
    expect(draft.draft_data.birth_year).toBeUndefined();
    values.clear();
    runtime = instance();
    await open(sender, userId);
    expect(transport.last(sender).text).toContain('Gregorian birth year');
    await answer(sender, '۱۹۹۵');
    expect((await new PostgresSignupStore(database).getSignupState(userId))?.currentStep).toBe(
      'gender',
    );
  });
  it('audits a borrowed or corrupt callback once, acknowledges it and exposes no private values', async () => {
    const first = String(serial++),
      other = String(serial++);
    await open(first);
    const borrowed = find(first, (nav) => nav.action === 'begin')!;
    const otherUser = await open(other);
    const update = callback(other, borrowed);
    await runtime.handle(update);
    await runtime.handle(update);
    expect(transport.last(other).text).toContain('no longer current');
    expect(
      await database
        .selectFrom('identity.signup_drafts')
        .select('user_id')
        .where('user_id', '=', otherUser)
        .execute(),
    ).toHaveLength(0);
    const audits = await database
      .selectFrom('platform.audit_logs')
      .select(['metadata', 'event_type'])
      .where('actor_user_id', '=', otherUser)
      .where('event_type', '=', 'identity.signup-navigation-denied.v1')
      .execute();
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(borrowed);
  });
  it('retries a lost provider response without a second signup transition', async () => {
    const sender = String(serial++),
      userId = await open(sender),
      data = find(sender, (nav) => nav.action === 'begin')!,
      update = callback(sender, data);
    transport.fail = true;
    await expect(runtime.handle(update)).rejects.toMatchObject({
      status: 500,
      message: 'error.identity.user_context_invalid',
    });
    await runtime.handle(update);
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('actor_user_id', '=', userId)
        .where('event_type', '=', 'identity.signup-started.v1')
        .execute(),
    ).toHaveLength(1);
  });
  it('refuses ordinary later-life start and preserves the completed native Return proof', async () => {
    const f = await createAccountReturnFixture(database),
      id = randomUUID();
    await new PostgresAccountReturnStore(database, f.control).return({
      commandId: id,
      commandType: 'account.return',
      schemaVersion: 1,
      actor: { kind: 'user', userId: f.userId },
      requestId: id,
      idempotencyKey: id,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { expectedAccountVersion: f.version },
    });
    const identity = await database
      .selectFrom('identity.telegram_identities')
      .select('telegram_user_id')
      .where('user_id', '=', f.userId)
      .executeTakeFirstOrThrow();
    await expect(open(identity.telegram_user_id, f.userId)).rejects.toMatchObject({ status: 401 });
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('actor_user_id', '=', f.userId)
        .where('event_type', '=', 'identity.user-session-issued.v1')
        .execute(),
    ).toHaveLength(0);
    expect(
      (
        await sql<{
          valid: boolean;
        }>`SELECT identity.account_return_completed(${f.recordId}::uuid) AS valid`.execute(database)
      ).rows[0]?.valid,
    ).toBe(true);
  });
  it('refuses startup when required signup text is disabled and accepts it after repair', async () => {
    await runtime.onModuleInit();
    await database
      .updateTable('catalog.ui_texts')
      .set({ is_active: false })
      .where('locale_code', '=', 'en')
      .where('text_key', '=', 'signup.ui.confirm_age')
      .execute();
    try {
      await expect(runtime.onModuleInit()).rejects.toThrow('Signup localization unavailable.');
    } finally {
      await database
        .updateTable('catalog.ui_texts')
        .set({ is_active: true })
        .where('locale_code', '=', 'en')
        .where('text_key', '=', 'signup.ui.confirm_age')
        .execute();
    }
    await runtime.onModuleInit();
  });
  it.each([0, 9])(
    'delivers one native guest card under callback replay from prior count %i',
    async (priorCount) => {
      await database
        .updateTable('identity.user_settings')
        .set({ visibility_enabled: false })
        .execute();
      const target = await createMediaAuthorityFixture(database),
        sender = String(serial++);
      const tokens = new HmacMediaDeliveryTokens({
        currentKeyId: 'm9',
        keys: new Map([['m9', key]]),
      });
      const audienceKey = Buffer.alloc(32, 156),
        audience = new EdgeHmacMediaAudienceAuthenticator(
          'https://media.invalid',
          new Map([['m9', audienceKey]]),
        );
      let viewer = '',
        providerCalls = 0,
        uncertain = false,
        nextData = '',
        detailData = '',
        detailProviderCalls = 0,
        mediaPurpose = '',
        withdrawDetails = false;
      await createReportPhoto(database, target.ownerUserId, false, new Uint8Array([7, 8, 9]));
      await database
        .updateTable('profile.profiles')
        .set({ bio: 'Synthetic full profile biography', version: sql`version+1` })
        .where('user_id', '=', target.ownerUserId)
        .execute();
      const relay = new TelegramCandidateMediaRelay(
        'https://media.invalid',
        botToken,
        new HmacMediaAudienceCredentials('https://media.invalid', {
          currentKeyId: 'm9',
          keys: new Map([['m9', audienceKey]]),
        }),
        async (input, init) => {
          if (input.startsWith('https://media.invalid/')) {
            const media = new URL(input);
            expect(
              await audience.authenticate(
                new Request(input, { headers: new Headers(init?.headers) }),
              ),
            ).toBe(viewer);
            const claims = tokens.verify(media.searchParams.get('token')!, {
              path: media.pathname,
              audienceId: viewer,
              now: Math.floor(Date.now() / 1000),
            });
            mediaPurpose = claims.purpose;
            expect(
              await new PostgresMediaDeliveryAuthorization(database, 'test').isCurrent(claims),
            ).toBe(true);
            return new Response(new Uint8Array([82, 73, 70, 70]), {
              headers: { 'content-type': 'image/webp' },
            });
          }
          expect(input).toBe(`https://api.telegram.org/bot${botToken}/sendPhoto`);
          const form = init?.body as FormData;
          expect(form.get('chat_id')).toBe(sender);
          const markup = JSON.parse(formText(form, 'reply_markup')) as {
            inline_keyboard: Message['keyboard'];
          };
          nextData = markup.inline_keyboard[0]![0]!.callback_data;
          detailData =
            markup.inline_keyboard.flat().find((b) => b.text === 'Show More')?.callback_data ??
            detailData;
          if (mediaPurpose === 'profile_detail') {
            detailProviderCalls++;
            if (withdrawDetails && detailProviderCalls === 8)
              await database
                .updateTable('identity.user_settings')
                .set({ visibility_enabled: false, version: sql`version+1` })
                .where('user_id', '=', target.ownerUserId)
                .execute();
          } else providerCalls++;
          if (uncertain && mediaPurpose === 'profile_card')
            throw new Error('synthetic uncertain provider result');
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                message_id: serial++,
                from: { id: botId, is_bot: true },
                chat: { id: Number(sender), type: 'private' },
              },
            }),
          );
        },
      );
      runtime = new TelegramSignupRuntime(
        database,
        {} as ReturnType<typeof createRedisConnection>,
        'm9-ui-native',
        String(botId),
        key,
        transport.client,
        limiter,
        cache,
        new GuestPreviewRuntime(
          database,
          'test',
          relay,
          new MediaDeliveryUrlSigner('https://media.invalid', tokens),
        ),
      );
      await runtime.onModuleInit();
      viewer = await open(sender);
      if (priorCount !== 0)
        await database
          .updateTable('identity.guest_preview_counters')
          .set({
            preview_count: priorCount,
            first_preview_at: new Date(),
            last_preview_at: new Date(),
          })
          .where('user_id', '=', viewer)
          .execute();
      const data = find(sender, (nav) => nav.action === 'preview');
      if (data === undefined) throw new Error('Missing preview navigation');
      const update = callback(sender, data);
      await Promise.all(Array.from({ length: 10 }, () => runtime.handle(update)));
      expect(providerCalls).toBe(1);
      const delivered = await database
        .selectFrom('discovery.candidate_deliveries')
        .selectAll()
        .where('viewer_user_id', '=', viewer)
        .executeTakeFirstOrThrow();
      expect(delivered.state).toBe('delivered');
      expect(delivered.target_user_id).toBe(target.ownerUserId);
      const count = async (): Promise<number> =>
        (
          await database
            .selectFrom('identity.guest_preview_counters')
            .select('preview_count')
            .where('user_id', '=', viewer)
            .executeTakeFirstOrThrow()
        ).preview_count;
      expect(await count()).toBe(priorCount + 1);
      await runtime.handle(update);
      expect(providerCalls).toBe(1);
      expect(detailData).not.toBe('');
      const more = callback(sender, detailData);
      for (let i = 0; i < 3; i++) await runtime.handle(more);
      expect(detailProviderCalls).toBe(6);
      expect(providerCalls).toBe(1);
      expect(await count()).toBe(priorCount + 1);
      expect(transport.last(sender).text).toContain('Synthetic full profile biography');
      await runtime.handle(callback(String(serial++), detailData));
      expect(detailProviderCalls).toBe(6);
      if (priorCount === 9) {
        await runtime.handle(callback(sender, nextData));
        expect(providerCalls).toBe(1);
        expect(await count()).toBe(10);
        expect(transport.last(sender).text).toContain('You have used all guest previews.');
        expect(find(sender, (nav) => nav.action === 'preview')).toBeUndefined();
        expect(find(sender, (nav) => nav.action === 'begin')).toBeDefined();
        await open(sender, viewer);
        expect(find(sender, (nav) => nav.action === 'preview')).toBeUndefined();
        await database
          .updateTable('identity.user_settings')
          .set({ visibility_enabled: false, version: sql`version+1` })
          .where('user_id', '=', target.ownerUserId)
          .execute();
        await runtime.handle(callback(sender, detailData));
        expect(detailProviderCalls).toBe(6);
        expect(transport.last(sender).text).not.toContain('Synthetic full profile biography');
        return;
      }
      const priorTexts = transport.messages.filter((m) =>
        m.text.includes('Synthetic full profile biography'),
      ).length;
      withdrawDetails = true;
      await runtime.handle(callback(sender, detailData));
      expect(detailProviderCalls).toBe(8);
      expect(
        transport.messages.filter((m) => m.text.includes('Synthetic full profile biography')),
      ).toHaveLength(priorTexts);
      expect(await count()).toBe(1);
      await createMediaAuthorityFixture(database);
      uncertain = true;
      const next = callback(sender, nextData);
      for (let i = 0; i < 3; i++) await runtime.handle(next);
      expect(providerCalls).toBe(2);
      expect(await count()).toBe(1);
      expect(
        await database
          .selectFrom('discovery.candidate_deliveries')
          .select('id')
          .where('viewer_user_id', '=', viewer)
          .where('state', '=', 'reserved')
          .where('attempt_count', '=', 1)
          .execute(),
      ).toHaveLength(1);
      const profile = await database
        .selectFrom('profile.profiles')
        .select(['name', 'highlight'])
        .where('user_id', '=', target.ownerUserId)
        .executeTakeFirstOrThrow();
      for (const map of values.values())
        for (const value of map.values()) {
          expect(value).not.toContain(profile.name);
          expect(value).not.toContain(profile.highlight);
          expect(value).not.toContain('/media/');
        }
    },
  );
  it.each(['like', 'reject', 'nakh_credits', 'nakh_pending', 'nakh_stars'] as const)(
    'performs Explore %s through delivered opaque cards without guest quota and fences replay',
    async (kind) => {
      await database
        .updateTable('identity.user_settings')
        .set({ visibility_enabled: false })
        .execute();
      const sender = String(serial++),
        viewer = await open(sender);
      expect(find(sender, (n) => n.action === 'explore')).toBeUndefined();
      await createMediaAuthorityFixture(database, 'owner_preview', viewer);
      const target = await createMediaAuthorityFixture(database);
      await eligibleExplorePair(viewer, target.ownerUserId);
      const isNakh = kind.startsWith('nakh_');
      if (isNakh)
        for (const userId of [viewer, target.ownerUserId])
          await database
            .insertInto('notification.notification_preferences')
            .values({ user_id: userId, created_at: new Date(), updated_at: new Date() })
            .onConflict((c) => c.column('user_id').doNothing())
            .execute();
      if (kind === 'nakh_credits')
        await new PostgresCreditLedgerStore(database).append({
          transactionId: randomUUID(),
          userId: viewer,
          transactionType: 'admin_adjustment',
          amount: 5n,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
        });
      const tokens = new HmacMediaDeliveryTokens({
        currentKeyId: 'm9',
        keys: new Map([['m9', key]]),
      });
      let uncertain = false;
      let cards = 0,
        details = 0;
      const relay = new TelegramCandidateMediaRelay(
        'https://media.invalid',
        botToken,
        new HmacMediaAudienceCredentials('https://media.invalid', {
          currentKeyId: 'm9',
          keys: new Map([['m9', Buffer.alloc(32, 156)]]),
        }),
        async (input, init) => {
          if (input.startsWith('https://media.invalid/')) {
            const media = new URL(input),
              claims = tokens.verify(media.searchParams.get('token')!, {
                path: media.pathname,
                audienceId: viewer,
                now: Math.floor(Date.now() / 1000),
              });
            expect(
              await new PostgresMediaDeliveryAuthorization(database, 'test').isCurrent(claims),
            ).toBe(true);
            // Reads may race before the native send CAS. Mark synthetic bytes
            // so the counters below measure actual Bot API invocations.
            return new Response(
              new Uint8Array([82, 73, 70, 70, claims.purpose === 'profile_card' ? 1 : 2]),
              {
                headers: { 'content-type': 'image/webp' },
              },
            );
          }
          const form = init?.body as FormData;
          expect(form.get('chat_id')).toBe(sender);
          const bytes = new Uint8Array(await (form.get('photo') as Blob).arrayBuffer());
          expect([...bytes.subarray(0, 4)]).toEqual([82, 73, 70, 70]);
          if (bytes[4] === 1) cards++;
          else {
            expect(bytes[4]).toBe(2);
            details++;
          }
          const markup = JSON.parse(formText(form, 'reply_markup')) as {
            inline_keyboard: Message['keyboard'];
          };
          transport.messages.push({
            id: serial++,
            sender,
            text: formText(form, 'caption'),
            keyboard: markup.inline_keyboard,
            prompt: false,
          });
          if (uncertain) throw new Error('synthetic ambiguous Explore acknowledgement');
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                message_id: serial++,
                from: { id: botId, is_bot: true },
                chat: { id: Number(sender), type: 'private' },
              },
            }),
          );
        },
      );
      const invoices: Record<string, unknown>[] = [];
      const stars = new TelegramStarsRuntime(
        database,
        new TelegramStarsKeys(
          JSON.stringify({
            activeKeyId: 'v1',
            digestKey: Buffer.alloc(32, 1).toString('base64url'),
            keys: [
              {
                id: 'v1',
                invoiceKey: Buffer.alloc(32, 2).toString('base64url'),
                evidenceKey: Buffer.alloc(32, 3).toString('base64url'),
              },
            ],
          }),
        ),
        'test',
        String(botId),
        new TelegramStarsClient(botToken, (_url, init) => {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<
            string,
            unknown
          >;
          invoices.push(body);
          return Promise.resolve(
            Response.json({
              ok: true,
              result: {
                message_id: serial++,
                chat: { id: Number(sender), type: 'private' },
                from: { id: botId, is_bot: true },
                invoice: { currency: 'XTR', total_amount: 2 },
              },
            }),
          );
        }),
      );
      runtime = new TelegramSignupRuntime(
        database,
        {} as ReturnType<typeof createRedisConnection>,
        'm9-explore',
        String(botId),
        key,
        transport.client,
        limiter,
        cache,
        undefined,
        new GuestPreviewRuntime(
          database,
          'test',
          relay,
          new MediaDeliveryUrlSigner('https://media.invalid', tokens),
          'explore',
        ),
        kind === 'nakh_stars' ? stars : undefined,
      );
      await runtime.onModuleInit();
      await open(sender, viewer);
      const enter = find(sender, (n) => n.action === 'explore')!;
      expect(enter).toBeDefined();
      const enterUpdate = callback(sender, enter);
      await Promise.all(Array.from({ length: 10 }, () => runtime.handle(enterUpdate)));
      expect(cards).toBe(1);
      const card = transport.messages.findLast(
        (m) => m.sender === sender && m.keyboard.flat().some((b) => b.text === 'Like'),
      )!;
      const button = (label: string): string =>
        card.keyboard.flat().find((b) => b.text === label)!.callback_data;
      const more = button('Show More'),
        intent = button(isNakh ? 'Send Nakh' : kind === 'like' ? 'Like' : 'Not interested');
      const source = state(sender, intent);
      expect(intent).not.toContain(target.ownerUserId);
      expect(source.code).toBeDefined();
      expect(state(sender, more).group).toBe(source.group);
      await runtime.handle(callback(sender, more));
      expect(details).toBe(1);
      const detailIntent = find(sender, (n) => n.action === (isNakh ? 'nakh' : kind))!;
      expect(state(sender, detailIntent).group).toBe(source.group);
      const foreign = String(serial++);
      await open(foreign);
      await runtime.handle(callback(foreign, intent));
      expect(transport.last(foreign).text).not.toContain('Private report fixture');
      const update = callback(sender, intent);
      await Promise.all(Array.from({ length: 10 }, () => runtime.handle(update)));
      const privateOpening = 'Private original Nakh opening 🌱';
      if (isNakh) {
        expect(
          await database
            .selectFrom('nakh.nakh_flows')
            .select('id')
            .where('sender_user_id', '=', viewer)
            .execute(),
        ).toHaveLength(0);
        expect(transport.last(sender).text).toContain('2 credits');
        expect(transport.last(sender).text).toContain('automatically');
        expect(find(sender, (n) => n.action === 'nakh_stars') !== undefined).toBe(
          kind === 'nakh_stars',
        );
        if (kind === 'nakh_pending') {
          await action(sender, 'nakh_credits');
          const unfundedPrompt = transport.last(sender);
          await runtime.handle(response(sender, privateOpening, unfundedPrompt.id));
          expect(
            transport.messages.some(
              (m) => m.sender === sender && m.text.includes('do not have enough credits'),
            ),
          ).toBe(true);
          expect(
            await database
              .selectFrom('nakh.nakh_flows')
              .select('id')
              .where('sender_user_id', '=', viewer)
              .execute(),
          ).toHaveLength(0);
        }
        await action(sender, kind);
        let prompt = transport.last(sender);
        expect(prompt.prompt).toBe(true);
        if (kind !== 'nakh_credits') expect(prompt.text).toContain('automatically');
        await runtime.handle(response(sender, '', prompt.id));
        prompt = transport.last(sender);
        expect(prompt.prompt).toBe(true);
        const opening = response(sender, privateOpening, prompt.id);
        await Promise.all(Array.from({ length: 10 }, () => runtime.handle(opening)));
        await runtime.handle(response(sender, 'Changed duplicate opening', prompt.id));
      }
      const table =
        kind === 'like'
          ? 'interaction.likes'
          : kind === 'reject'
            ? 'interaction.not_interested'
            : kind === 'nakh_credits'
              ? 'nakh.nakhes'
              : 'nakh.pending_nakhes';
      expect(
        await database
          .selectFrom(table)
          .select('id')
          .where('sender_user_id', '=', viewer)
          .execute(),
      ).toHaveLength(1);
      if (isNakh) {
        expect(
          await database
            .selectFrom('nakh.nakh_flows')
            .select('receiver_user_id')
            .where('sender_user_id', '=', viewer)
            .execute(),
        ).toEqual([{ receiver_user_id: target.ownerUserId }]);
        const row = await database
          .selectFrom(kind === 'nakh_credits' ? 'nakh.nakhes' : 'nakh.pending_nakhes')
          .select('text')
          .where('sender_user_id', '=', viewer)
          .executeTakeFirstOrThrow();
        expect(row.text).toBe(privateOpening);
        expect(
          (
            await database
              .selectFrom('billing.credit_accounts')
              .select('balance')
              .where('user_id', '=', viewer)
              .executeTakeFirstOrThrow()
          ).balance,
        ).toBe(kind === 'nakh_credits' ? '3' : '0');
        if (kind !== 'nakh_credits')
          expect(
            await database
              .selectFrom('nakh.nakhes')
              .select('id')
              .where('receiver_user_id', '=', target.ownerUserId)
              .execute(),
          ).toHaveLength(0);
        if (kind === 'nakh_stars') {
          // Presentation is at least once; all ten provider retries carry one
          // native attempt and the same opaque payload. Sending an invoice
          // never creates a paid receipt.
          expect(invoices).toHaveLength(10);
          expect(new Set(invoices.map((invoice) => JSON.stringify(invoice))).size).toBe(1);
          expect(invoices[0]).toMatchObject({
            chat_id: sender,
            currency: 'XTR',
            prices: [{ amount: 2 }],
          });
          expect(JSON.stringify(invoices)).not.toContain(privateOpening);
          const attempts = await database
            .selectFrom('billing.payment_records')
            .select(['status', 'stars_amount'])
            .where('user_id', '=', viewer)
            .execute();
          expect(attempts).toEqual([{ status: 'pending', stars_amount: '2' }]);
        } else expect(invoices).toHaveLength(0);
      } else {
        expect(
          await database
            .selectFrom(kind === 'like' ? 'interaction.likes' : 'interaction.not_interested')
            .select('receiver_user_id')
            .where('sender_user_id', '=', viewer)
            .execute(),
        ).toEqual([{ receiver_user_id: target.ownerUserId }]);
      }
      await runtime.handle(callback(sender, detailIntent));
      expect(
        await database
          .selectFrom(table)
          .select('id')
          .where('sender_user_id', '=', viewer)
          .execute(),
      ).toHaveLength(1);
      const opposite = button(kind === 'like' ? 'Not interested' : 'Like');
      await runtime.handle(callback(sender, opposite));
      const other = kind === 'like' ? 'interaction.not_interested' : 'interaction.likes';
      expect(
        await database
          .selectFrom(other)
          .select('id')
          .where('sender_user_id', '=', viewer)
          .execute(),
      ).toHaveLength(0);
      expect(
        await database
          .selectFrom('discovery.candidate_deliveries')
          .select(['mode', 'state'])
          .where('viewer_user_id', '=', viewer)
          .execute(),
      ).toEqual([{ mode: 'explore', state: 'delivered' }]);
      expect(
        (
          await database
            .selectFrom('identity.guest_preview_counters')
            .select('preview_count')
            .where('user_id', '=', viewer)
            .executeTakeFirstOrThrow()
        ).preview_count,
      ).toBe(0);
      await open(sender, viewer);
      const freshEntry = find(sender, (n) => n.action === 'explore')!;
      const nextTarget = await createMediaAuthorityFixture(database);
      await eligibleExplorePair(viewer, nextTarget.ownerUserId);
      uncertain = true;
      const uncertainUpdate = callback(sender, freshEntry);
      await runtime.handle(uncertainUpdate);
      await runtime.handle(uncertainUpdate);
      expect(cards).toBe(2);
      const uncertainCard = transport.messages.findLast(
        (m) => m.sender === sender && m.keyboard.flat().some((b) => b.text === 'Like'),
      )!;
      await runtime.handle(
        callback(
          sender,
          uncertainCard.keyboard
            .flat()
            .find(
              (b) =>
                b.text === (isNakh ? 'Send Nakh' : kind === 'like' ? 'Like' : 'Not interested'),
            )!.callback_data,
        ),
      );
      expect(
        await database
          .selectFrom(table)
          .select('id')
          .where('sender_user_id', '=', viewer)
          .execute(),
      ).toHaveLength(1);
      expect(
        await database
          .selectFrom('discovery.candidate_deliveries')
          .select('attempt_count')
          .where('viewer_user_id', '=', viewer)
          .where('state', '=', 'reserved')
          .execute(),
      ).toEqual([{ attempt_count: 1 }]);
      await new PostgresUserSessionStore(database).revoke(
        source.actor,
        source.actor.sessionGrantId,
        randomUUID(),
      );
      await runtime.handle(update);
      expect(transport.last(sender).text).toContain('no longer current');
      expect(cards).toBe(2);
      for (const map of values.values())
        for (const value of map.values()) {
          expect(value).not.toContain('Private report fixture');
          expect(value).not.toContain(privateOpening);
          expect(value).not.toContain('/media/');
        }
    },
  );
  it.skipIf(redisUrl === undefined)(
    'uses the authenticated process composition and real Redis, including the verified post-Return activation bridge',
    async () => {
      // Match the native deletion fixture's independently recorded namespace.
      const prefix = 'm8-native-final',
        redis = createRedisConnection(redisUrl!);
      let app: NestFastifyApplication | undefined;
      vi.stubEnv('M9_UI_BOT', botToken);
      vi.stubEnv('M9_UI_KEY', key.toString('base64url'));
      vi.stubEnv(
        'M9_UI_REPORT_KEYS',
        JSON.stringify([
          { keyId: 'report-key', keyVersion: 1, key: Buffer.alloc(32, 73).toString('base64url') },
        ]),
      );
      vi.stubEnv(
        'M9_UI_STARS',
        JSON.stringify({
          activeKeyId: 'v1',
          digestKey: Buffer.alloc(32, 1).toString('base64url'),
          keys: [
            {
              id: 'v1',
              invoiceKey: Buffer.alloc(32, 2).toString('base64url'),
              evidenceKey: Buffer.alloc(32, 3).toString('base64url'),
            },
          ],
        }),
      );
      const audienceKey = Buffer.alloc(32, 156);
      vi.stubEnv('M9_UI_AUDIENCE', audienceKey.toString('base64url'));
      const config = parseConfig({
        NAKH_ENV: 'test',
        NAKH_SERVICE_NAME: 'telegram-gateway',
        NAKH_DATABASE_URL: isolated.url,
        NAKH_REDIS_URL: redisUrl!,
        NAKH_QUEUE_PREFIX: prefix,
        NAKH_TELEGRAM_BOT_TOKEN_REF: 'M9_UI_BOT',
        NAKH_TELEGRAM_EXPLORE_ENABLED: 'true',
        NAKH_TELEGRAM_STARS_ENABLED: 'true',
        NAKH_TELEGRAM_REPORTS_ENABLED: 'true',
        NAKH_REPORT_SNAPSHOT_KEY_ID: 'report-key',
        NAKH_REPORT_SNAPSHOT_KEY_VERSION: '1',
        NAKH_DELETION_EVIDENCE_KEY_RING_REF: 'M9_UI_REPORT_KEYS',
        NAKH_STARS_KEY_RING_REF: 'M9_UI_STARS',
        NAKH_TELEGRAM_WEBHOOK_SECRET: '1'.repeat(32),
        NAKH_TELEGRAM_ACTION_TOKEN_KEY_REF: 'M9_UI_KEY',
        NAKH_TELEGRAM_START_DELIVERY_ENABLED: 'true',
        NAKH_TELEGRAM_SIGNUP_ENABLED: 'true',
        NAKH_TELEGRAM_GUEST_PREVIEW_ENABLED: 'true',
        NAKH_MEDIA_INGESTION_ENABLED: 'true',
        NAKH_MEDIA_TRANSPORT_KEY_REF: 'M9_UI_KEY',
        NAKH_R2_ENDPOINT: 'https://r2.invalid',
        NAKH_R2_BUCKET: 'test',
        NAKH_R2_ACCESS_KEY_REF: 'fake',
        NAKH_R2_SECRET_KEY_REF: 'fake',
        NAKH_MEDIA_CDN_HOST: 'media.invalid',
        NAKH_MEDIA_SIGNING_KEY_REF: 'M9_UI_KEY',
        NAKH_MEDIA_AUDIENCE_KEY_REF: 'M9_UI_AUDIENCE',
        NAKH_DELETION_TELEGRAM_ENABLED: 'true',
        NAKH_RETURN_TELEGRAM_ENABLED: 'true',
        NAKH_FRESH_ENTRY_TELEGRAM_ENABLED: 'true',
        NAKH_DELETION_WORKER_ENABLED: 'true',
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
        NAKH_DELETION_CUTOVER_EVIDENCE_HASH: 'b'.repeat(64),
        NAKH_DELETION_CONFIRMATION_KEY_REF: 'M9_UI_KEY',
      });
      // Provider methods are mocked below through an independent capture function;
      // native sessions, Redis activation and the actual HTTP controller are real.
      const sent: Array<{ sender: string; text: string; keyboard: Message['keyboard'] }> = [];
      vi.spyOn(TelegramBotApiMenuClient.prototype, 'sendMenu').mockImplementation(
        (sender, menu) => {
          sent.push({
            sender,
            text: menu.text,
            keyboard: menu.replyMarkup.inline_keyboard.map((row) =>
              row.map((button) => {
                if (typeof button.callback_data !== 'string' || button.url !== undefined)
                  throw new Error('Fresh activation fixture requires callback buttons.');
                return { text: button.text, callback_data: button.callback_data };
              }),
            ),
          });
          return Promise.resolve();
        },
      );
      vi.spyOn(TelegramBotApiMenuClient.prototype, 'answerCallback').mockResolvedValue(undefined);
      const f = await createAccountReturnFixture(database),
        id = randomUUID();
      await new PostgresAccountReturnStore(database, f.control).return({
        commandId: id,
        commandType: 'account.return',
        schemaVersion: 1,
        actor: { kind: 'user', userId: f.userId },
        requestId: id,
        idempotencyKey: id,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { expectedAccountVersion: f.version },
      });
      const identity = await database
          .selectFrom('identity.telegram_identities')
          .select('telegram_user_id')
          .where('user_id', '=', f.userId)
          .executeTakeFirstOrThrow(),
        sender = identity.telegram_user_id;
      await database
        .updateTable('identity.user_settings')
        .set({ visibility_enabled: false })
        .execute();
      const target = await createMediaAuthorityFixture(database);
      const photos: Array<{ keyboard: Message['keyboard']; caption: string }> = [];
      let mediaViewer = f.userId,
        mediaSender = sender,
        exploreUser: string | undefined;
      let ambiguous = false,
        providerCalls = 0,
        detailProviderCalls = 0;
      let expectedMediaPurpose: 'profile_card' | 'profile_detail' = 'profile_card';
      let forceReplyId = 0;
      const invoices: Array<Record<string, unknown>> = [],
        checkoutAnswers: Array<Record<string, unknown>> = [];
      const signing = new HmacMediaDeliveryTokens({
        currentKeyId: config.media.signingKeyId,
        keys: new Map([[config.media.signingKeyId, key]]),
      });
      const audience = new EdgeHmacMediaAudienceAuthenticator(
        'https://media.invalid',
        new Map([[config.media.audienceKeyId, audienceKey]]),
      );
      vi.stubGlobal('fetch', async (input: string, init?: RequestInit): Promise<Response> => {
        if (input === `https://api.telegram.org/bot${botToken}/sendInvoice`) {
          if (typeof init?.body !== 'string') throw new Error('Missing invoice body');
          const body = JSON.parse(init.body) as Record<string, unknown>;
          invoices.push(body);
          if (invoices.length === 1) throw new Error('Synthetic lost invoice acknowledgement');
          return Response.json({
            ok: true,
            result: {
              message_id: serial++,
              from: { id: botId, is_bot: true },
              chat: { id: Number(mediaSender), type: 'private' },
              invoice: { currency: 'XTR', total_amount: 2 },
            },
          });
        }
        if (input === `https://api.telegram.org/bot${botToken}/answerPreCheckoutQuery`) {
          if (typeof init?.body !== 'string') throw new Error('Missing checkout body');
          checkoutAnswers.push(JSON.parse(init.body) as Record<string, unknown>);
          return Response.json({ ok: true, result: true });
        }
        if (input === `https://api.telegram.org/bot${botToken}/sendMessage`) {
          if (typeof init?.body !== 'string') throw new Error('Missing synthetic prompt body');
          const body = JSON.parse(init.body) as {
            chat_id: string;
            text: string;
            reply_markup: { force_reply: boolean };
          };
          expect(String(body.chat_id)).toBe(mediaSender);
          expect(body.reply_markup.force_reply).toBe(true);
          if (body.text.includes('submit your report'))
            expect(body.text).toContain('Reply to this message');
          else expect(body.text).toContain('automatically');
          forceReplyId = serial++;
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                message_id: forceReplyId,
                from: { id: botId, is_bot: true },
                chat: { id: Number(mediaSender), type: 'private' },
              },
            }),
          );
        }
        if (input.startsWith('https://media.invalid/')) {
          const media = new URL(input);
          const viewer = await audience.authenticate(
            new Request(input, { headers: new Headers(init?.headers) }),
          );
          expect(viewer).toBe(mediaViewer);
          const claims = signing.verify(media.searchParams.get('token')!, {
            path: media.pathname,
            audienceId: mediaViewer,
            now: Math.floor(Date.now() / 1000),
          });
          expect(claims.purpose).toBe(expectedMediaPurpose);
          expect(
            await new PostgresMediaDeliveryAuthorization(database, 'test').isCurrent(claims),
          ).toBe(true);
          return new Response(new Uint8Array([82, 73, 70, 70]), {
            headers: { 'content-type': 'image/webp' },
          });
        }
        expect(input).toBe(`https://api.telegram.org/bot${botToken}/sendPhoto`);
        expect(init?.body).toBeInstanceOf(FormData);
        const body = init!.body as FormData;
        expect(body.get('chat_id')).toBe(mediaSender);
        expect(formText(body, 'caption')).not.toContain('/media/');
        const keyboard = JSON.parse(formText(body, 'reply_markup')) as {
          inline_keyboard: Message['keyboard'];
        };
        photos.push({ keyboard: keyboard.inline_keyboard, caption: formText(body, 'caption') });
        if (expectedMediaPurpose === 'profile_detail') detailProviderCalls++;
        else providerCalls++;
        expect(
          (
            await database
              .selectFrom('discovery.candidate_deliveries')
              .select('attempt_count')
              .where('viewer_user_id', '=', mediaViewer)
              .where(
                'state',
                '=',
                expectedMediaPurpose === 'profile_detail' ? 'delivered' : 'reserved',
              )
              .executeTakeFirstOrThrow()
          ).attempt_count,
        ).toBe(1);
        if (ambiguous) throw new Error('synthetic uncertain provider result');
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: serial++,
              from: { id: botId, is_bot: true },
              chat: { id: Number(mediaSender), type: 'private' },
            },
          }),
        );
      });
      const marker = `${prefix}:owned-action:{${createHash('sha256').update(f.userId).digest('hex')}}:life`;
      await redis.set(marker, 'blocked:0');
      try {
        app = await NestFactory.create<NestFastifyApplication>(
          TelegramGatewayModule.register(config),
          new FastifyAdapter(),
          { logger: false },
        );
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
        const route = '/v1/providers/telegram/webhook',
          headers = { 'x-telegram-bot-api-secret-token': '1'.repeat(32) };
        expect(
          (await app.inject({ method: 'POST', url: route, payload: incoming(sender) })).statusCode,
        ).toBe(401);
        expect(sent).toHaveLength(0);
        expect(
          (await app.inject({ method: 'POST', url: route, headers, payload: incoming(sender) }))
            .statusCode,
        ).toBe(201);
        const entry = sent.at(-1)?.keyboard[0]?.[0]?.callback_data;
        if (entry === undefined) throw Error('Missing fresh activation');
        expect(entry.startsWith('m8e:')).toBe(true);
        expect(await redis.get(marker)).toBe('blocked:0');
        const update = callback(sender, entry);
        for (let i = 0; i < 3; i++)
          expect(
            (await app.inject({ method: 'POST', url: route, headers, payload: update })).statusCode,
          ).toBe(201);
        expect(await redis.get(marker)).toBe('active:1');
        expect(
          sent
            .at(-1)
            ?.keyboard.flat()
            .some((b) => b.text === 'Sign up'),
        ).toBe(true);
        expect(
          await database
            .selectFrom('platform.audit_logs')
            .select('id')
            .where('actor_user_id', '=', f.userId)
            .where('event_type', '=', 'identity.user-session-issued.v1')
            .execute(),
        ).toHaveLength(1);
        const preview = sent
          .at(-1)!
          .keyboard.flat()
          .find((b) => b.text === 'Browse as guest')?.callback_data;
        if (preview === undefined) throw Error('Missing Guest Preview entry');
        const previewUpdate = callback(sender, preview);
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            app!.inject({ method: 'POST', url: route, headers, payload: previewUpdate }),
          ),
        );
        expect(results.every((r) => r.statusCode === 201)).toBe(true);
        expect(providerCalls).toBe(1);
        expect(photos[0]!.caption).toContain('approximately');
        expect(photos[0]!.keyboard.flat().map((b) => b.text)).toEqual([
          'Next profile',
          'Sign up',
          'Show More',
        ]);
        const delivered = await database
          .selectFrom('discovery.candidate_deliveries')
          .selectAll()
          .where('viewer_user_id', '=', f.userId)
          .executeTakeFirstOrThrow();
        expect(delivered.target_user_id).toBe(target.ownerUserId);
        expect(delivered.state).toBe('delivered');
        const count = async (): Promise<number> =>
          (
            await database
              .selectFrom('identity.guest_preview_counters')
              .select('preview_count')
              .where('user_id', '=', f.userId)
              .executeTakeFirstOrThrow()
          ).preview_count;
        expect(await count()).toBe(4);
        expect(
          (await app.inject({ method: 'POST', url: route, headers, payload: previewUpdate }))
            .statusCode,
        ).toBe(201);
        expect(providerCalls).toBe(1);
        expect(await count()).toBe(4);
        expectedMediaPurpose = 'profile_detail';
        const more = photos[0]!.keyboard.flat().find((b) => b.text === 'Show More')?.callback_data;
        if (!more) throw Error('Missing full Profile navigation');
        const moreUpdate = callback(sender, more);
        for (let i = 0; i < 2; i++)
          expect(
            (await app.inject({ method: 'POST', url: route, headers, payload: moreUpdate }))
              .statusCode,
          ).toBe(201);
        expect(detailProviderCalls).toBe(2);
        expect(providerCalls).toBe(1);
        expect(await count()).toBe(4);
        expect(
          await database
            .selectFrom('discovery.candidate_deliveries')
            .selectAll()
            .where('id', '=', delivered.id)
            .executeTakeFirstOrThrow(),
        ).toEqual(delivered);
        const publicProfile = await database
          .selectFrom('profile.profiles')
          .select(['name', 'highlight'])
          .where('user_id', '=', target.ownerUserId)
          .executeTakeFirstOrThrow();
        expect(sent.at(-1)?.text).toContain(publicProfile.name);
        expect(sent.at(-1)?.text).toContain(publicProfile.highlight);
        expectedMediaPurpose = 'profile_card';
        await createMediaAuthorityFixture(database);
        ambiguous = true;
        const next = callback(sender, photos[0]!.keyboard[0]![0]!.callback_data);
        for (let i = 0; i < 3; i++)
          expect(
            (await app.inject({ method: 'POST', url: route, headers, payload: next })).statusCode,
          ).toBe(201);
        expect(providerCalls).toBe(2);
        expect(await count()).toBe(4);
        expect(
          await database
            .selectFrom('discovery.candidate_deliveries')
            .select('id')
            .where('viewer_user_id', '=', f.userId)
            .where('state', '=', 'reserved')
            .where('attempt_count', '=', 1)
            .execute(),
        ).toHaveLength(1);
        // Keep the uncertain guest source above unresolved. A separate active
        // account exercises ordinary Explore through the same running host.
        const exploreSender = String(serial++);
        const registration = await TelegramStartAdapter.withStore(
          new PostgresIdentityStore(database),
        ).handle(incoming(exploreSender));
        if (!registration.handled) throw Error('Missing Explore registration');
        exploreUser = registration.userId;
        await database
          .updateTable('identity.user_settings')
          .set({ visibility_enabled: false })
          .execute();
        await createMediaAuthorityFixture(database, 'owner_preview', exploreUser);
        const exploreTarget = await createMediaAuthorityFixture(database);
        await eligibleExplorePair(exploreUser, exploreTarget.ownerUserId);
        mediaViewer = exploreUser;
        mediaSender = exploreSender;
        ambiguous = false;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: incoming(exploreSender),
            })
          ).statusCode,
        ).toBe(201);
        const explore = sent
          .at(-1)
          ?.keyboard.flat()
          .find((b) => b.text === 'Explore')?.callback_data;
        if (!explore) throw Error('Missing running Explore entry');
        const exploreUpdate = callback(exploreSender, explore);
        for (let i = 0; i < 3; i++)
          expect(
            (await app.inject({ method: 'POST', url: route, headers, payload: exploreUpdate }))
              .statusCode,
          ).toBe(201);
        expect(providerCalls).toBe(3);
        expect(
          await database
            .selectFrom('discovery.candidate_deliveries')
            .select(['mode', 'state', 'target_user_id'])
            .where('viewer_user_id', '=', exploreUser)
            .execute(),
        ).toEqual([
          { mode: 'explore', state: 'delivered', target_user_id: exploreTarget.ownerUserId },
        ]);
        const exploreCard = photos.at(-1)!;
        expect(exploreCard.keyboard.flat().map((b) => b.text)).toEqual([
          'Like',
          'Send Nakh',
          'Not interested',
          'Show More',
          'Report',
          'Next',
          'Back',
        ]);
        const like = exploreCard.keyboard.flat().find((b) => b.text === 'Like')!.callback_data;
        expect(like).not.toContain(exploreTarget.ownerUserId);
        const likeUpdate = callback(exploreSender, like);
        for (let i = 0; i < 3; i++)
          expect(
            (await app.inject({ method: 'POST', url: route, headers, payload: likeUpdate }))
              .statusCode,
          ).toBe(201);
        expect(
          await database
            .selectFrom('interaction.likes')
            .select('id')
            .where('sender_user_id', '=', exploreUser)
            .where('receiver_user_id', '=', exploreTarget.ownerUserId)
            .execute(),
        ).toHaveLength(1);
        expect(
          (
            await database
              .selectFrom('identity.guest_preview_counters')
              .select('preview_count')
              .where('user_id', '=', exploreUser)
              .executeTakeFirstOrThrow()
          ).preview_count,
        ).toBe(0);
        expect(await count()).toBe(4);
        const pendingTarget = await createMediaAuthorityFixture(database);
        const reportedPhotoId = await createReportPhoto(database, pendingTarget.ownerUserId, false);
        await eligibleExplorePair(exploreUser, pendingTarget.ownerUserId);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: incoming(exploreSender),
            })
          ).statusCode,
        ).toBe(201);
        const pendingExplore = sent
          .at(-1)!
          .keyboard.flat()
          .find((b) => b.text === 'Explore')!.callback_data;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, pendingExplore),
            })
          ).statusCode,
        ).toBe(201);
        const cancelReport = photos
          .at(-1)!
          .keyboard.flat()
          .find((button) => button.text === 'Report')!.callback_data;
        const pendingMore = photos
          .at(-1)!
          .keyboard.flat()
          .find((button) => button.text === 'Show More')!.callback_data;
        expectedMediaPurpose = 'profile_detail';
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, pendingMore),
            })
          ).statusCode,
        ).toBe(201);
        expectedMediaPurpose = 'profile_card';
        const profileReport = sent
          .at(-1)!
          .keyboard.flat()
          .find((button) => button.text === 'Report')!.callback_data;
        const photoReport = photos
          .at(-1)!
          .keyboard.flat()
          .find((button) => button.text === 'Report')!.callback_data;
        expect(photos.at(-1)!.caption).toContain('Photo 2 of 2');
        expect(photoReport).not.toContain(reportedPhotoId);
        const compose = photos
          .at(-1)!
          .keyboard.flat()
          .find((b) => b.text === 'Send Nakh')!.callback_data;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, compose),
            })
          ).statusCode,
        ).toBe(201);
        expect(sent.at(-1)!.text).toContain('automatically');
        const savePending = sent
          .at(-1)!
          .keyboard.flat()
          .find((b) => b.text === 'Pay with Telegram Stars')!.callback_data;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, savePending),
            })
          ).statusCode,
        ).toBe(201);
        expect(forceReplyId).toBeGreaterThan(0);
        const pendingOpening = response(exploreSender, 'Private host Nakh opening', forceReplyId);
        expect(
          (await app.inject({ method: 'POST', url: route, headers, payload: pendingOpening }))
            .statusCode,
        ).toBe(500);
        for (let i = 0; i < 3; i++)
          expect(
            (await app.inject({ method: 'POST', url: route, headers, payload: pendingOpening }))
              .statusCode,
          ).toBe(201);
        expect(
          await database
            .selectFrom('nakh.pending_nakhes')
            .select('text')
            .where('sender_user_id', '=', exploreUser)
            .execute(),
        ).toEqual([{ text: 'Private host Nakh opening' }]);
        expect(
          await database
            .selectFrom('nakh.nakhes')
            .select('id')
            .where('receiver_user_id', '=', pendingTarget.ownerUserId)
            .execute(),
        ).toHaveLength(0);
        expect(invoices).toHaveLength(4);
        expect(new Set(invoices.map((invoice) => JSON.stringify(invoice))).size).toBe(1);
        expect(JSON.stringify(invoices)).not.toContain('Private host Nakh opening');
        const attempt = await database
          .selectFrom('billing.payment_records')
          .select(['id', 'status', 'stars_amount'])
          .where('user_id', '=', exploreUser)
          .execute();
        expect(attempt).toHaveLength(1);
        expect(attempt[0]).toMatchObject({ status: 'pending', stars_amount: '2' });
        const paymentFacts = {
          currency: 'XTR',
          total_amount: 2,
          invoice_payload: invoices[0]!.payload,
        };
        const precheckout = {
          update_id: serial++,
          pre_checkout_query: {
            ...paymentFacts,
            id: 'host-checkout',
            from: { id: Number(exploreSender), is_bot: false },
          },
        };
        expect(
          (await app.inject({ method: 'POST', url: route, headers: {}, payload: precheckout }))
            .statusCode,
        ).toBe(401);
        expect(checkoutAnswers).toHaveLength(0);
        expect(
          (await app.inject({ method: 'POST', url: route, headers, payload: precheckout }))
            .statusCode,
        ).toBe(201);
        expect(checkoutAnswers).toEqual([{ pre_checkout_query_id: 'host-checkout', ok: true }]);
        const payment = {
          update_id: serial++,
          message: {
            from: { id: Number(exploreSender), is_bot: false },
            successful_payment: {
              ...paymentFacts,
              telegram_payment_charge_id: 'host-charge',
              provider_payment_charge_id: '',
            },
          },
        };
        for (let i = 0; i < 3; i++)
          expect(
            (await app.inject({ method: 'POST', url: route, headers, payload: payment }))
              .statusCode,
          ).toBe(201);
        expect(
          (
            await database
              .selectFrom('billing.payment_records')
              .select('status')
              .where('id', '=', attempt[0]!.id)
              .executeTakeFirstOrThrow()
          ).status,
        ).toBe('paid');
        expect(
          await database
            .selectFrom('billing.payment_provider_events')
            .select('id')
            .where('provider_event_id', '=', String(payment.update_id))
            .execute(),
        ).toHaveLength(1);
        const reportButton = profileReport;
        expect(reportButton).toMatch(/^m9r:/u);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, reportButton),
            })
          ).statusCode,
        ).toBe(201);
        const reason = sent
          .at(-1)!
          .keyboard.flat()
          .find((button) => button.text === 'Fake profile')!.callback_data;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, reason),
            })
          ).statusCode,
        ).toBe(201);
        const details = response(exploreSender, 'Private host report details', forceReplyId);
        for (let i = 0; i < 3; i++)
          expect(
            (await app.inject({ method: 'POST', url: route, headers, payload: details }))
              .statusCode,
          ).toBe(201);
        expect(sent.at(-1)!.text).toContain('Reports are confidential');
        const reports = await database
          .selectFrom('moderation.reports')
          .select(['id', 'target_user_id', 'extra_text'])
          .where('reporter_user_id', '=', exploreUser)
          .execute();
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          target_user_id: pendingTarget.ownerUserId,
          extra_text: 'Private host report details',
        });
        const snapshot = await database
          .selectFrom('moderation.report_snapshots')
          .selectAll()
          .where('report_id', '=', reports[0]!.id)
          .executeTakeFirstOrThrow();
        const content = new AesGcmProfileReportSnapshotReader({
          resolve: () => Buffer.alloc(32, 73),
        }).decrypt(
          { reportId: snapshot.report_id, evidenceId: snapshot.report_evidence_id },
          {
            schemaVersion: snapshot.schema_version,
            snapshotType: snapshot.snapshot_type,
            keyId: snapshot.encryption_key_id,
            keyVersion: snapshot.encryption_key_version,
            nonce: snapshot.nonce,
            ciphertext: snapshot.ciphertext,
            sha256: snapshot.content_sha256,
          },
        );
        expect(content.displayName).toBe(
          (
            await database
              .selectFrom('profile.profiles')
              .select('name')
              .where('user_id', '=', pendingTarget.ownerUserId)
              .executeTakeFirstOrThrow()
          ).name,
        );
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, cancelReport),
            })
          ).statusCode,
        ).toBe(201);
        const cancelReason = sent
          .at(-1)!
          .keyboard.flat()
          .find((button) => button.text === 'Fake profile')!.callback_data;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, cancelReason),
            })
          ).statusCode,
        ).toBe(201);
        const cancelledPrompt = forceReplyId;
        const cancel = sent
          .at(-1)!
          .keyboard.flat()
          .find((button) => button.text === 'Cancel')!.callback_data;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, cancel),
            })
          ).statusCode,
        ).toBe(201);
        expect(sent.at(-1)!.text).toContain('No report was submitted');
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: response(exploreSender, 'Cancelled private details', cancelledPrompt),
            })
          ).statusCode,
        ).toBe(201);
        expect(
          await database
            .selectFrom('moderation.reports')
            .select('id')
            .where('reporter_user_id', '=', exploreUser)
            .execute(),
        ).toHaveLength(1);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, photoReport),
            })
          ).statusCode,
        ).toBe(201);
        const photoReason = sent
          .at(-1)!
          .keyboard.flat()
          .find((button) => button.text === 'Fake profile')!.callback_data;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, photoReason),
            })
          ).statusCode,
        ).toBe(201);
        const photoSubmit = sent
          .at(-1)!
          .keyboard.flat()
          .find((button) => button.text === 'Submit report')!.callback_data;
        const photoUpdate = callback(exploreSender, photoSubmit);
        for (let i = 0; i < 3; i++)
          expect(
            (await app.inject({ method: 'POST', url: route, headers, payload: photoUpdate }))
              .statusCode,
          ).toBe(201);
        const selectedPhoto = await database
          .selectFrom('moderation.report_evidence as evidence')
          .innerJoin('moderation.reports as report', 'report.id', 'evidence.report_id')
          .innerJoin(
            'moderation.report_snapshots as snapshot',
            'snapshot.report_evidence_id',
            'evidence.id',
          )
          .innerJoin(
            'media.report_photo_evidence_holds as hold',
            'hold.report_evidence_id',
            'evidence.id',
          )
          .select([
            'report.id as reportId',
            'report.extra_text',
            'evidence.id as evidenceId',
            'evidence.profile_photo_id',
            'hold.photo_id',
            'hold.content_sha256',
            'hold.captured_primary',
            'snapshot.schema_version',
            'snapshot.snapshot_type',
            'snapshot.encryption_key_id',
            'snapshot.encryption_key_version',
            'snapshot.nonce',
            'snapshot.ciphertext',
            'snapshot.content_sha256 as snapshotSha256',
          ])
          .where('report.reporter_user_id', '=', exploreUser)
          .where('evidence.evidence_type', '=', 'photo')
          .execute();
        expect(selectedPhoto).toHaveLength(1);
        const held = selectedPhoto[0]!;
        expect(held).toMatchObject({
          profile_photo_id: reportedPhotoId,
          photo_id: reportedPhotoId,
          captured_primary: false,
          extra_text: null,
        });
        const thumbnail = await database
          .selectFrom('media.profile_photos as photo')
          .innerJoin('media.photo_variants as variant', 'variant.asset_id', 'photo.asset_id')
          .select('variant.sha256')
          .where('photo.id', '=', reportedPhotoId)
          .where('variant.variant_type', '=', 'thumbnail')
          .executeTakeFirstOrThrow();
        expect(
          new AesGcmPhotoReportSnapshotReader({ resolve: () => Buffer.alloc(32, 73) }).decrypt(
            { reportId: held.reportId, evidenceId: held.evidenceId },
            {
              schemaVersion: held.schema_version,
              snapshotType: held.snapshot_type,
              keyId: held.encryption_key_id,
              keyVersion: held.encryption_key_version,
              nonce: held.nonce,
              ciphertext: held.ciphertext,
              sha256: held.snapshotSha256,
            },
          ),
        ).toEqual({
          evidenceType: 'photo',
          evidenceObjectRef: `v1.pe.${held.evidenceId}`,
          contentSha256: thumbnail.sha256.toString('hex'),
          primary: false,
        });
        expect(held.content_sha256).toBe(thumbnail.sha256.toString('hex'));
        // The original other delivered card remains reportable while product
        // admission is stopped. A new process also verifies retained v1 custody
        // before using v2 for its separately selected write capability.
        const pausedReport = exploreCard.keyboard
          .flat()
          .find((button) => button.text === 'Report')!.callback_data;
        vi.stubEnv(
          'M9_UI_REPORT_KEYS',
          JSON.stringify(
            [1, 2].map((version) => ({
              keyId: 'report-key',
              keyVersion: version,
              key: Buffer.alloc(32, 72 + version).toString('base64url'),
            })),
          ),
        );
        await app.close();
        app = await NestFactory.create<NestFastifyApplication>(
          TelegramGatewayModule.register({
            ...config,
            telegram: {
              ...config.telegram,
              signupEnabled: false,
              startDeliveryEnabled: false,
              guestPreviewEnabled: false,
              exploreEnabled: false,
              reportSnapshotKeyVersion: 2,
            },
          }),
          new FastifyAdapter(),
          { logger: false },
        );
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, pausedReport),
            })
          ).statusCode,
        ).toBe(201);
        const pausedReason = sent
          .at(-1)!
          .keyboard.flat()
          .find((button) => button.text === 'Fake profile')!.callback_data;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: route,
              headers,
              payload: callback(exploreSender, pausedReason),
            })
          ).statusCode,
        ).toBe(201);
        const withoutText = sent
          .at(-1)!
          .keyboard.flat()
          .find((button) => button.text === 'Submit report')!.callback_data;
        const withoutTextUpdate = callback(exploreSender, withoutText);
        for (let i = 0; i < 3; i++)
          expect(
            (await app.inject({ method: 'POST', url: route, headers, payload: withoutTextUpdate }))
              .statusCode,
          ).toBe(201);
        const afterPause = await database
          .selectFrom('moderation.reports')
          .select(['id', 'target_user_id', 'extra_text'])
          .where('reporter_user_id', '=', exploreUser)
          .execute();
        expect(afterPause).toHaveLength(3);
        const noDetails = afterPause.find(
          (report) => report.id !== reports[0]!.id && report.id !== held.reportId,
        )!;
        expect(noDetails).toMatchObject({
          target_user_id: exploreTarget.ownerUserId,
          extra_text: null,
        });
        expect(
          (
            await database
              .selectFrom('moderation.report_snapshots')
              .select('encryption_key_version')
              .where('report_id', '=', noDetails.id)
              .executeTakeFirstOrThrow()
          ).encryption_key_version,
        ).toBe(2);
        vi.stubEnv(
          'M9_UI_REPORT_KEYS',
          JSON.stringify([
            { keyId: 'report-key', keyVersion: 2, key: Buffer.alloc(32, 74).toString('base64url') },
          ]),
        );
        const missingHistory = createTelegramReportRuntime({
          config: { ...config, telegram: { ...config.telegram, reportSnapshotKeyVersion: 2 } },
          database,
          redis,
        });
        if (!(missingHistory instanceof TelegramReportRuntime))
          throw new Error('Missing enabled report runtime');
        await expect(missingHistory.onModuleInit()).rejects.toThrow(
          'Report snapshot custody unavailable.',
        );
        expect(providerCalls).toBe(4);
      } finally {
        await app?.close();
        const index = `${prefix}:owned-action:{${createHash('sha256').update(f.userId).digest('hex')}}:1:index`;
        const entries = await redis.hkeys(index);
        const owned = entries.filter((entry) =>
          entry.startsWith(
            `${prefix}:owned-action:{${createHash('sha256').update(f.userId).digest('hex')}}:1:value:`,
          ),
        );
        if (owned.length > 0) await redis.unlink(...owned);
        await redis.unlink(
          marker,
          `${prefix}:owned-action:{${createHash('sha256').update(f.userId).digest('hex')}}:1:index`,
        );
        if (exploreUser !== undefined) {
          const owner = `${prefix}:owned-action:{${createHash('sha256').update(exploreUser).digest('hex')}}`;
          const entries = await redis.hkeys(`${owner}:0:index`);
          const owned = entries.filter((e) => e.startsWith(`${owner}:0:value:`));
          if (owned.length > 0)
            for (const value of await redis.mget(...owned)) {
              expect(value).not.toContain('Private host report details');
              expect(value).not.toContain('Private host Nakh opening');
            }
          if (owned.length > 0) await redis.unlink(...owned);
          await redis.unlink(`${owner}:life`, `${owner}:0:index`);
        }
        await redis.quit();
      }
    },
  );
});
