import 'reflect-metadata';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpaqueTokenStore } from '@nakh/application';
import { parseConfig } from '@nakh/config';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  PostgresIdentityStore,
  PostgresSignupStore,
  PostgresAccountReturnStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createRedisConnection } from '@nakh/queue-redis';
import { TelegramBotApiMenuClient, TelegramStartAdapter } from '@nakh/telegram';
import { seedValidMedia } from '../../../packages/persistence-postgres/src/media-fixtures.js';
import { createAccountReturnFixture } from '../../../packages/persistence-postgres/src/testing/account-return-fixture.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { TelegramGatewayModule } from './app.js';
import { TelegramSignupRuntime } from './signup-runtime.js';
import { signupRecord as record, type SignupNavigation } from './signup-navigation.js';
const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
const botId = 12345,
  botToken = `${botId}:${'a'.repeat(24)}`,
  key = Buffer.alloc(32, 154);
let serial = 200000;
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
  it.skipIf(redisUrl === undefined)(
    'uses the authenticated process composition and real Redis, including the verified post-Return activation bridge',
    async () => {
      // Match the native deletion fixture's independently recorded namespace.
      const prefix = 'm8-native-final',
        redis = createRedisConnection(redisUrl!);
      let app: NestFastifyApplication | undefined;
      vi.stubEnv('M9_UI_BOT', botToken);
      vi.stubEnv('M9_UI_KEY', key.toString('base64url'));
      const config = parseConfig({
        NAKH_ENV: 'test',
        NAKH_SERVICE_NAME: 'telegram-gateway',
        NAKH_DATABASE_URL: isolated.url,
        NAKH_REDIS_URL: redisUrl!,
        NAKH_QUEUE_PREFIX: prefix,
        NAKH_TELEGRAM_BOT_TOKEN_REF: 'M9_UI_BOT',
        NAKH_TELEGRAM_WEBHOOK_SECRET: '1'.repeat(32),
        NAKH_TELEGRAM_ACTION_TOKEN_KEY_REF: 'M9_UI_KEY',
        NAKH_TELEGRAM_START_DELIVERY_ENABLED: 'true',
        NAKH_TELEGRAM_SIGNUP_ENABLED: 'true',
        NAKH_MEDIA_INGESTION_ENABLED: 'true',
        NAKH_MEDIA_TRANSPORT_KEY_REF: 'M9_UI_KEY',
        NAKH_R2_ENDPOINT: 'https://r2.invalid',
        NAKH_R2_BUCKET: 'test',
        NAKH_R2_ACCESS_KEY_REF: 'fake',
        NAKH_R2_SECRET_KEY_REF: 'fake',
        NAKH_MEDIA_CDN_HOST: 'media.invalid',
        NAKH_MEDIA_SIGNING_KEY_REF: 'M9_UI_KEY',
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
            keyboard: menu.replyMarkup.inline_keyboard.map((row) => [...row]),
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
        await redis.quit();
      }
    },
  );
});
