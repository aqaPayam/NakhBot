import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CreatePendingNakhHandler, type UserSessionActor } from '@nakh/application';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  PostgresUserSessionStore,
  PostgresPendingNakhStore,
  SystemIdGenerator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createRedisConnection } from '@nakh/queue-redis';
import {
  TelegramBotApiMenuClient,
  TelegramLockedLikedByScreenRelay,
  TelegramCandidateMediaRelay,
} from '@nakh/telegram';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createMediaAuthorityFixture } from '../../../packages/persistence-postgres/src/testing/media-authority-fixture.js';
import {
  createReportNakh,
  createReportUser,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { TelegramNakhCustomerRuntime } from './nakh-customer-runtime.js';
import { TelegramSignupRuntime } from './signup-runtime.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
type Incoming = {
  update_id: number;
  message: {
    message_id: number;
    text: string;
    from: { id: number; is_bot: boolean };
    chat: { id: number; type: string };
  };
};
type BotRequest = {
  chat_id: string;
  text: string;
  protect_content?: boolean;
  reply_markup?: {
    force_reply?: boolean;
    inline_keyboard?: { text: string; callback_data: string }[][];
  };
};
type Message = {
  id: number;
  recipient: string;
  text: string;
  prompt: boolean;
  buttons: { text: string; callback_data: string }[];
  protected: boolean;
  photo: boolean;
};
describe.skipIf(url === undefined || redisUrl === undefined)('Nakh customer bot journeys', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
    database: NakhDatabase,
    redis: ReturnType<typeof createRedisConnection>;
  let runtime: TelegramNakhCustomerRuntime,
    receiver: string,
    sender: string,
    recipient: number,
    nakhId: string,
    prefix: string;
  let serial = 900000;
  let client: TelegramBotApiMenuClient;
  const messages: Message[] = [],
    home: UserSessionActor[] = [];
  const token = `12345:${'a'.repeat(24)}`;
  const incoming = (text: string): Incoming => ({
    update_id: serial++,
    message: {
      message_id: serial++,
      text,
      from: { id: recipient, is_bot: false },
      chat: { id: recipient, type: 'private' },
    },
  });
  const callback = (data: string, account = recipient): unknown => ({
    update_id: serial++,
    callback_query: {
      id: String(serial++),
      data,
      from: { id: account, is_bot: false },
      message: {
        message_id: 1,
        from: { id: 12345, is_bot: true },
        chat: { id: account, type: 'private' },
      },
    },
  });
  const last = (): Message => messages.at(-1)!;
  const button = (text: string): string => {
    const found = last().buttons.find((b) => b.text === text);
    if (!found) throw new Error('Missing synthetic button: ' + text);
    return found.callback_data;
  };
  const open = async (): Promise<void> => {
    await runtime.handle(incoming('/nakhes'));
  };
  const currentActor = async (): Promise<UserSessionActor> => {
    const grant = await database
      .selectFrom('platform.audit_logs')
      .select('id')
      .where('actor_user_id', '=', receiver)
      .where('event_type', '=', 'identity.user-session-issued.v1')
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    return { kind: 'user', userId: receiver, productEpoch: 0, sessionGrantId: grant.id };
  };
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_customer_ui');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    redis = createRedisConnection(redisUrl!);
  });
  beforeEach(async () => {
    messages.length = 0;
    home.length = 0;
    const source = await createMediaAuthorityFixture(database);
    sender = source.ownerUserId;
    receiver = await createReportUser(database, true);
    recipient = 600000000000 + serial++;
    const now = new Date();
    await database
      .insertInto('identity.telegram_identities')
      .values({
        user_id: receiver,
        telegram_user_id: String(recipient),
        username: null,
        first_seen_at: now,
        last_seen_at: now,
      })
      .execute();
    nakhId = await createReportNakh(database, receiver, sender);
    await database
      .insertInto('identity.guest_preview_counters')
      .values({ user_id: receiver, limit_count: 10, first_preview_at: null, last_preview_at: null })
      .execute();
    prefix = 'nakh-ui-' + randomUUID();
    const provider = (address: string, init?: RequestInit): Promise<Response> => {
      if (address.startsWith('https://media.invalid/'))
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } }),
        );
      if (address.endsWith('/answerCallbackQuery'))
        return Promise.resolve(new Response('{"ok":true,"result":true}'));
      const form = init?.body instanceof FormData ? init.body : undefined;
      let body: BotRequest;
      if (form) {
        const chat = form.get('chat_id'),
          caption = form.get('caption'),
          markup = form.get('reply_markup');
        if (typeof chat !== 'string' || typeof caption !== 'string' || typeof markup !== 'string')
          throw new Error('Invalid synthetic photo request');
        body = {
          chat_id: chat,
          text: caption,
          protect_content: form.get('protect_content') === 'true',
          reply_markup: JSON.parse(markup) as NonNullable<BotRequest['reply_markup']>,
        };
      } else {
        if (typeof init?.body !== 'string') throw new Error('Invalid synthetic text request');
        body = JSON.parse(init.body) as BotRequest;
      }
      const id = serial++;
      messages.push({
        id,
        recipient: String(body.chat_id),
        text: String(body.text),
        prompt: body.reply_markup?.force_reply === true,
        buttons: body.reply_markup?.inline_keyboard?.flat() ?? [],
        protected: body.protect_content === true,
        photo: form !== undefined,
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
    };
    client = new TelegramBotApiMenuClient(token, provider);
    runtime = new TelegramNakhCustomerRuntime(
      database,
      redis,
      prefix,
      '12345',
      Buffer.alloc(32, 71),
      'test',
      client,
      new TelegramLockedLikedByScreenRelay(token, provider),
      new TelegramCandidateMediaRelay(
        'https://media.invalid',
        token,
        { tokenFor: () => Promise.resolve('synthetic-audience-credential') },
        provider,
      ),
      { sign: (q) => `https://media.invalid${q.path}?token=synthetic.signature` },
      { consume: () => Promise.resolve({ allowed: true, remaining: 29, retryAfterSeconds: 0 }) },
      true,
      (_to, actor) => {
        home.push(actor);
        return Promise.resolve();
      },
    );
    await runtime.onModuleInit();
  });
  afterAll(async () => {
    await redis?.quit();
    await database?.destroy();
    await isolated?.destroy();
  });
  it('opens the received Nakh, views a protected profile repeatedly, then accepts exactly once', async () => {
    await open();
    const actor = await currentActor();
    await runtime.handle(callback(button('Received')));
    expect(last().buttons[0]!.text).toContain('Sent');
    await runtime.handle(callback(last().buttons[0]!.callback_data));
    expect(last().text).toContain('Private Nakh text');
    const view = button('View profile');
    await runtime.handle(callback(view));
    expect(messages.filter((m) => m.photo)).toHaveLength(1);
    expect(messages.filter((m) => m.photo).every((m) => m.protected)).toBe(true);
    expect(last().protected).toBe(true);
    expect(last().text).toContain('Private report bio');
    expect(last().buttons.some((b) => b.callback_data.startsWith('m9r:'))).toBe(true);
    await runtime.handle(callback(view));
    expect(
      await database
        .selectFrom('nakh.nakh_receiver_actions')
        .select('id')
        .where('nakh_id', '=', nakhId)
        .where('action_type', '=', 'view_profile')
        .execute(),
    ).toHaveLength(1);
    const accept = button('Accept');
    await runtime.handle(callback(accept));
    await runtime.handle(callback(accept));
    expect(last().text).toContain('new Match');
    expect(
      await database
        .selectFrom('matching.matches')
        .select('id')
        .where((eb) => eb.or([eb('user_low_id', '=', receiver), eb('user_high_id', '=', receiver)]))
        .execute(),
    ).toHaveLength(1);
    await runtime.handle(callback(button('Main menu')));
    expect(home).toEqual([actor]);
  });
  it('does not renew borrowed or revoked callback authority and leaves unrelated replies for their runtime', async () => {
    await open();
    const received = button('Received'),
      actor = await currentActor(),
      count = messages.length;
    await runtime.handle(callback(received, recipient + 1));
    expect(messages).toHaveLength(count);
    await new PostgresUserSessionStore(database).revoke(actor, actor.sessionGrantId, randomUUID());
    await open();
    const fresh = await currentActor();
    expect(fresh.sessionGrantId).not.toBe(actor.sessionGrantId);
    const before = messages.length;
    await runtime.handle(callback(received));
    expect(messages).toHaveLength(before);
    const unrelated = incoming('unrelated reply');
    Object.assign(unrelated.message, {
      reply_to_message: { message_id: 999, from: { id: 12345, is_bot: true } },
    });
    expect(await runtime.handle(unrelated)).toBe('unhandled');
  });
  it('keeps pending text sender-only, edits by original prompt and offers explicit cancel conversion', async () => {
    // The trial account now sends its own unfunded draft to a separate pair.
    const target = await createReportUser(database, true),
      now = new Date();
    await database
      .insertInto('identity.user_settings')
      .values({ user_id: target, created_at: now, updated_at: now })
      .execute();
    const result = await new CreatePendingNakhHandler(
      new PostgresPendingNakhStore(database),
      new SystemIdGenerator(),
    ).execute({
      commandType: 'nakh.create-pending',
      schemaVersion: 1,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      actor: { kind: 'user', userId: receiver },
      occurredAt: now.toISOString(),
      locale: 'en',
      data: { targetUserId: target, text: 'Draft secret', autoSettleAuthorized: true },
    });
    await open();
    await runtime.handle(callback(button('Pending')));
    await runtime.handle(callback(last().buttons[0]!.callback_data));
    expect(last().text).toContain('Draft secret');
    await runtime.handle(callback(button('Edit text')));
    const promptActor = await currentActor();
    const prompt = last();
    expect(prompt.prompt).toBe(true);
    const reply = incoming('Updated private draft');
    Object.assign(reply.message, {
      reply_to_message: { message_id: prompt.id, from: { id: 12345, is_bot: true } },
    });
    await runtime.handle(reply);
    await runtime.handle(reply);
    expect(
      await database
        .selectFrom('nakh.pending_nakhes')
        .select(['text', 'version'])
        .where('id', '=', result.pendingNakhId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ text: 'Updated private draft', version: 2 });
    await open();
    await runtime.handle(callback(button('Pending')));
    await runtime.handle(callback(last().buttons[0]!.callback_data));
    await runtime.handle(callback(button('Cancel pending Nakh')));
    expect(last().buttons.some((b) => b.text === 'Cancel and Like')).toBe(true);
    const cancel = button('Cancel and Not interested');
    await runtime.handle(callback(cancel));
    await runtime.handle(callback(cancel));
    expect(last().text).toContain('cancelled');
    await open();
    await runtime.handle(callback(button('Past pending Nakhes')));
    await runtime.handle(callback(last().buttons[0]!.callback_data));
    expect(last().text).toContain('Cancelled');
    expect(last().buttons.some((b) => b.text === 'Edit text')).toBe(false);
    for (const key of await redis.keys(prefix + '*')) {
      if ((await redis.type(key)) === 'string') {
        const value = await redis.get(key);
        expect(value ?? '').not.toContain('Updated private draft');
        expect(value ?? '').not.toContain('Draft secret');
      }
    }
    await new PostgresUserSessionStore(database).revoke(
      promptActor,
      promptActor.sessionGrantId,
      randomUUID(),
    );
    await open();
    const fresh = await currentActor();
    await runtime.handle(reply);
    expect(last().text).toBe('This prompt is no longer current. Send /start to resume.');
    expect((await currentActor()).sessionGrantId).toBe(fresh.sessionGrantId);
    expect(
      await database
        .selectFrom('nakh.pending_nakhes')
        .select(['text', 'status', 'version'])
        .where('id', '=', result.pendingNakhId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ text: 'Updated private draft', status: 'cancelled', version: 3 });
  });
  it('closes a received Nakh without opening a profile and shows terminal history', async () => {
    await open();
    await runtime.handle(callback(button('Received')));
    await runtime.handle(callback(last().buttons[0]!.callback_data));
    const close = button('Close Nakh');
    await runtime.handle(callback(close));
    await runtime.handle(callback(close));
    expect(last().text).toContain('now closed');
    await open();
    await runtime.handle(callback(button('Received')));
    await runtime.handle(callback(last().buttons[0]!.callback_data));
    expect(last().text).toContain('Closed');
    expect(last().buttons.some((b) => b.text === 'Accept')).toBe(false);
    expect(messages.some((m) => m.photo)).toBe(false);
  });
  it('composes Nakhes, Matches and profile-fix/support entries without replacing the original session', async () => {
    await open();
    const actor = await currentActor(),
      calls: UserSessionActor[] = [];
    const capture = (_recipient: string, original: UserSessionActor): Promise<void> => {
      calls.push(original);
      return Promise.resolve();
    };
    const root = new TelegramSignupRuntime(
      database,
      redis,
      prefix,
      '12345',
      Buffer.alloc(32, 71),
      client,
      { consume: () => Promise.resolve({ allowed: true, remaining: 29, retryAfterSeconds: 0 }) },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { enabled: true, handle: () => Promise.resolve('unhandled'), open: capture },
      database,
      {
        enabled: true,
        supportEnabled: true,
        handle: () => Promise.resolve('unhandled'),
        open: capture,
        openSupport: capture,
      },
      { enabled: true, handle: () => Promise.resolve('unhandled'), open: capture },
      undefined,
      runtime,
    );
    await root.onModuleInit();
    await root.openRoot(String(recipient), actor);
    expect(last().buttons.some((b) => b.text === 'Nakhes')).toBe(true);
    expect(last().buttons.some((b) => b.text === 'Matches')).toBe(true);
    await runtime.handle(callback(button('Nakhes')));
    expect(last().text).toBe('Nakhes');
    await database
      .updateTable('profile.profiles')
      .set({ completion_status: 'invalid' })
      .where('user_id', '=', receiver)
      .execute();
    await root.openRoot(String(recipient), actor);
    expect(last().buttons.some((b) => b.text === 'Fix profile')).toBe(true);
    expect(last().buttons.some((b) => b.text === 'Nakhes')).toBe(true);
    const support = button('Support');
    await root.handle(callback(button('Fix profile')));
    await root.handle(callback(support));
    expect(calls).toEqual([actor, actor]);
    expect((await currentActor()).sessionGrantId).toBe(actor.sessionGrantId);
  });
});
