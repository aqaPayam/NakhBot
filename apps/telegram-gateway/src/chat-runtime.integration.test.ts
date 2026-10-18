import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ReportSnapshotKeyRing,
  SpendCreditsForPaidActionHandler,
  type UserSessionActor,
} from '@nakh/application';
import { parseConfig } from '@nakh/config';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  PostgresUserSessionStore,
  PostgresCreditLedgerStore,
  PostgresPaidActionStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  createRedisConnection,
  RedisOwnedOpaqueTokenStore,
  RedisRateLimiter,
} from '@nakh/queue-redis';
import { TelegramBotApiMenuClient } from '@nakh/telegram';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import {
  createReportChat,
  createReportUser,
  createReportMessage,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { TelegramChatRuntime } from './chat-runtime.js';
import { TelegramReportRuntime } from './report-runtime.js';
import { SignupNavigationTokens, type SignupNavigation } from './signup-navigation.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
type Menu = {
  chat_id: string;
  text: string;
  reply_markup?: {
    inline_keyboard?: { text: string; callback_data: string }[][];
    force_reply?: boolean;
  };
};
type Callback = {
  update_id: number;
  callback_query: {
    id: string;
    from: { id: number; is_bot: boolean };
    message: {
      message_id: number;
      chat: { id: number; type: string };
      from: { id: number; is_bot: boolean };
    };
    data: string;
  };
};
type Fixture = {
  runtime: TelegramChatRuntime;
  reports?: TelegramReportRuntime;
  peer: string;
  actor: UserSessionActor;
  recipient: string;
  menus: Menu[];
  nav: (screen: string, extra?: Partial<SignupNavigation>) => SignupNavigation;
  tokens: SignupNavigationTokens;
  callback: (data: string, id?: number) => Callback;
  button: (label: string) => string;
  chat: { matchId: string; chatSessionId: string };
  lastMessageId: () => number;
  failWarning: (value: boolean) => void;
};
describe.skipIf(url === undefined || redisUrl === undefined)(
  'native Telegram chat composition',
  () => {
    let database: NakhDatabase,
      isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
      redis: ReturnType<typeof createRedisConnection>;
    const config = parseConfig({
        NAKH_ENV: 'test',
        NAKH_SERVICE_NAME: 'telegram-gateway',
        NAKH_DATABASE_URL: 'postgresql://fixture',
        NAKH_REDIS_URL: 'redis://fixture',
        NAKH_TELEGRAM_BOT_TOKEN_REF: 'BOT',
        NAKH_TELEGRAM_WEBHOOK_SECRET: 'synthetic-chat-webhook-secret-00000000',
        NAKH_R2_ENDPOINT: 'https://r2.invalid',
        NAKH_R2_ACCOUNT_ID: 'fixture',
        NAKH_R2_BUCKET: 'fixture',
        NAKH_R2_ACCESS_KEY_REF: 'ACCESS',
        NAKH_R2_SECRET_KEY_REF: 'SECRET',
        NAKH_MEDIA_CDN_HOST: 'media.invalid',
        NAKH_MEDIA_SIGNING_KEY_REF: 'SIGNING',
      }),
      key = Buffer.alloc(32, 81);
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'm9_chat_transport');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 20000,
        lockTimeoutMs: 15000,
      });
      redis = createRedisConnection(redisUrl!);
    });
    afterAll(async () => {
      await redis?.quit();
      await database?.destroy();
      await isolated?.destroy();
    });
    async function fixture(withReports = false): Promise<Fixture> {
      const first = await createReportUser(database, true),
        second = await createReportUser(database, true),
        recipient = String(5000000000 + Math.floor(Math.random() * 1000000000)),
        now = new Date();
      for (const userId of [first, second]) {
        await database
          .insertInto('identity.user_settings')
          .values({ user_id: userId, visibility_enabled: true, created_at: now, updated_at: now })
          .execute();
        await database
          .insertInto('identity.guest_preview_counters')
          .values({
            user_id: userId,
            preview_count: 0,
            limit_count: 3,
            first_preview_at: null,
            last_preview_at: null,
          })
          .execute();
        await database
          .insertInto('notification.notification_preferences')
          .values({ user_id: userId, created_at: now, updated_at: now })
          .execute();
        await database
          .insertInto('billing.credit_accounts')
          .values({ user_id: userId, created_at: now, updated_at: now })
          .execute();
      }
      await database
        .insertInto('identity.telegram_identities')
        .values({
          user_id: first,
          telegram_user_id: recipient,
          username: null,
          first_seen_at: now,
          last_seen_at: now,
        })
        .execute();
      const chat = await createReportChat(database, first, second),
        [low, high] = [first, second].sort() as [string, string];
      await database
        .insertInto('interaction.user_pair_states')
        .values({
          user_low_id: low,
          user_high_id: high,
          state: 'matched',
          reason_code: 'mutual_like',
          changed_at: now,
        })
        .execute();
      const grant = (await new PostgresUserSessionStore(database).issue(
        { userId: first, productEpoch: 0 },
        randomUUID(),
      ))!;
      const actor: UserSessionActor = {
        kind: 'user',
        userId: first,
        productEpoch: 0,
        sessionGrantId: grant.id,
      };
      const prefix = `m9-chat-${randomUUID()}`,
        menus: Menu[] = [];
      let messageId = 1000,
        failWarning = false,
        updateId = 1;
      const fetcher = vi.fn((_input: string, init?: RequestInit): Promise<Response> => {
        if (typeof init?.body !== 'string') throw Error('Synthetic provider body missing');
        const body = JSON.parse(init.body) as Menu;
        if (failWarning && body.text?.startsWith('Stay safe'))
          return Promise.resolve(new Response('{}', { status: 503 }));
        if (body.text !== undefined) menus.push(body);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                message_id: ++messageId,
                chat: { id: Number(recipient), type: 'private' },
                from: { id: 12345, is_bot: true },
              },
            }),
          ),
        );
      });
      const client = new TelegramBotApiMenuClient(`12345:${'a'.repeat(24)}`, fetcher);
      const reports = withReports
        ? new TelegramReportRuntime(
            database,
            '12345',
            key,
            new ReportSnapshotKeyRing(
              JSON.stringify([
                {
                  keyId: 'native-chat-report',
                  keyVersion: 1,
                  key: Buffer.alloc(32, 82).toString('base64url'),
                },
              ]),
            ),
            'native-chat-report',
            1,
            client,
            new RedisRateLimiter(redis, prefix),
            (life) => new RedisOwnedOpaqueTokenStore(redis, prefix, life),
          )
        : undefined;
      await reports?.onModuleInit();
      const runtime = new TelegramChatRuntime(
        { ...config, redis: { ...config.redis, queuePrefix: prefix } },
        database,
        redis,
        '12345',
        key,
        client,
        new RedisRateLimiter(redis, prefix),
        reports,
      );
      await runtime.onModuleInit();
      const tokens = new SignupNavigationTokens(
        new RedisOwnedOpaqueTokenStore(redis, prefix, actor),
        key,
        '12345',
        recipient,
        actor,
        Date.now,
        'chat',
      );
      const nav = (screen: string, extra: Partial<SignupNavigation> = {}): SignupNavigation => ({
        actor,
        screen,
        action: 'resume',
        version: 1,
        reference: chat.matchId,
        field: chat.chatSessionId,
        group: randomUUID().replaceAll('-', '').slice(0, 16),
        ...extra,
      });
      const callback = (data: string, id = updateId++): Callback => ({
        update_id: id,
        callback_query: {
          id: `callback-${id}`,
          from: { id: Number(recipient), is_bot: false },
          message: {
            message_id: 500,
            chat: { id: Number(recipient), type: 'private' },
            from: { id: 12345, is_bot: true },
          },
          data,
        },
      });
      const button = (label: string): string => {
        const found = menus
          .at(-1)
          ?.reply_markup?.inline_keyboard?.flat()
          .find((b) => b.text === label);
        if (found === undefined) throw Error(`Missing native chat button: ${label}`);
        return found.callback_data;
      };
      return {
        runtime,
        ...(reports === undefined ? {} : { reports }),
        peer: second,
        actor,
        recipient,
        menus,
        nav,
        tokens,
        callback,
        button,
        chat,
        lastMessageId: () => messageId,
        failWarning: (value: boolean) => {
          failWarning = value;
        },
      };
    }
    it('submits conversation, visible message and post-Unmatch reports with the original grant', async () => {
      const f = await fixture(true),
        reports = f.reports!;
      await createReportMessage(
        database,
        f.chat.chatSessionId,
        f.peer,
        'Native report selection body',
      );
      await f.runtime.handle(f.callback(await f.tokens.button(f.nav('chat_view'))));
      const chatReport = f.button('Report conversation'),
        messageReport = f.button('Report message 1');
      for (const token of [chatReport, messageReport]) {
        expect(token).toMatch(/^m9r:/u);
        for (const id of [
          f.actor.userId,
          f.peer,
          f.actor.sessionGrantId,
          f.chat.matchId,
          f.chat.chatSessionId,
        ])
          expect(token).not.toContain(id);
      }
      let event = 20000;
      const report = async (token: string, retries = 1): Promise<void> => {
        await reports.handle(f.callback(token, event++));
        const reason = f.menus.at(-1)!.reply_markup!.inline_keyboard![0]![0]!.callback_data;
        await reports.handle(f.callback(reason, event++));
        const submit = f.menus
          .toReversed()
          .flatMap((m) => m.reply_markup?.inline_keyboard?.flat() ?? [])
          .find((b) => b.text === 'Submit report')!.callback_data;
        const update = f.callback(submit, event++);
        await Promise.all(Array.from({ length: retries }, () => reports.handle(update)));
      };
      await report(chatReport, 8);
      await report(messageReport);
      await f.runtime.handle(f.callback(await f.tokens.button(f.nav('chat_unmatch'))));
      await f.runtime.handle(f.callback(f.button('Confirm')));
      await f.runtime.open(f.recipient, f.actor);
      await f.runtime.handle(f.callback(f.button('Ended chats')));
      const endedReport = f.menus.at(-1)!.reply_markup!.inline_keyboard![0]![0]!.callback_data;
      await report(endedReport);
      const rows = await database
        .selectFrom('moderation.reports as report')
        .innerJoin('moderation.report_evidence as evidence', 'evidence.report_id', 'report.id')
        .select(['evidence.evidence_type', 'report.target_user_id'])
        .where('report.reporter_user_id', '=', f.actor.userId)
        .execute();
      expect(rows.map((r) => r.evidence_type).sort()).toEqual([
        'chat',
        'message',
        'unmatched_user',
      ]);
      expect(rows.every((r) => r.target_user_id === f.peer)).toBe(true);
      expect(
        await database
          .selectFrom('platform.audit_logs')
          .select('id')
          .where('actor_user_id', '=', f.actor.userId)
          .where('event_type', '=', 'identity.user-session-issued.v1')
          .execute(),
      ).toHaveLength(1);
      await new PostgresUserSessionStore(database).revoke(
        f.actor,
        f.actor.sessionGrantId,
        randomUUID(),
      );
      await reports.handle(f.callback(endedReport, event++));
      expect(
        await database
          .selectFrom('moderation.reports')
          .select('id')
          .where('reporter_user_id', '=', f.actor.userId)
          .execute(),
      ).toHaveLength(3);
    });
    it('bounds rejected callback audit writes without recording the callback body', async () => {
      const f = await fixture(),
        marker = 'PRIVATE_CALLBACK_BODY';
      const results = await Promise.allSettled(
        Array.from({ length: 65 }, () => f.runtime.handle(f.callback('m9c:' + marker))),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(60);
      expect(
        results
          .filter((r) => r.status === 'rejected')
          .every(
            (r) => r.reason instanceof Error && 'status' in r.reason && r.reason.status === 429,
          ),
      ).toBe(true);
      const audits = await database
        .selectFrom('platform.audit_logs')
        .select(['metadata', 'event_type'])
        .where('actor_user_id', '=', f.actor.userId)
        .where('event_type', '=', 'chat.navigation-denied.v1')
        .execute();
      expect(audits).toHaveLength(60);
      expect(JSON.stringify(audits)).not.toContain(marker);
    });
    it('keeps signed mute and confirmed Unmatch available during launch stop without chat history or product actions', async () => {
      const f = await fixture();
      await f.runtime.open(f.recipient, f.actor);
      const select = f.menus.at(-1)!.reply_markup!.inline_keyboard![0]![0]!.callback_data;
      await f.runtime.handle(f.callback(select));
      const mute = f.callback(f.button('Mute chat'));
      f.menus.length = 0;
      await f.runtime.handle(mute, { safetyOnly: true });
      await f.runtime.handle(mute, { safetyOnly: true });
      expect(f.menus).toHaveLength(0);
      expect(
        (
          await database
            .selectFrom('chat.chat_participants')
            .select('muted_at')
            .where('chat_session_id', '=', f.chat.chatSessionId)
            .where('user_id', '=', f.actor.userId)
            .executeTakeFirstOrThrow()
        ).muted_at,
      ).not.toBeNull();
      const question = await f.tokens.button(f.nav('chat_questions'));
      await f.runtime.handle(f.callback(question), { safetyOnly: true });
      expect(f.menus).toHaveLength(0);
      expect(
        await database
          .selectFrom('chat.chat_messages')
          .select('id')
          .where('chat_session_id', '=', f.chat.chatSessionId)
          .execute(),
      ).toHaveLength(0);
      await f.runtime.handle(f.callback(await f.tokens.button(f.nav('chat_unmatch'))), {
        safetyOnly: true,
      });
      const confirm = f.callback(f.button('Confirm'));
      f.menus.length = 0;
      await f.runtime.handle(confirm, { safetyOnly: true });
      await f.runtime.handle(confirm, { safetyOnly: true });
      expect(
        (
          await database
            .selectFrom('matching.matches')
            .select('status')
            .where('id', '=', f.chat.matchId)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('unmatched');
      expect(f.menus.map((menu) => menu.text)).toEqual([
        'This chat is closed.',
        'This chat is closed.',
      ]);
      expect(f.menus.every((menu) => menu.reply_markup?.inline_keyboard?.length === 0)).toBe(true);
      expect(
        await database
          .selectFrom('platform.outbox_events')
          .select('id')
          .where('aggregate_id', '=', f.chat.matchId)
          .where('event_type', '=', 'matching.unmatched.v1')
          .execute(),
      ).toHaveLength(1);
      expect(
        await database
          .selectFrom('matching.unmatch_records')
          .select('match_id')
          .where('match_id', '=', f.chat.matchId)
          .execute(),
      ).toHaveLength(1);
    });
    it('opens private opaque menus, sends a predefined question once and makes mute retries stable', async () => {
      const f = await fixture();
      await f.runtime.open(f.recipient, f.actor);
      const select = f.menus.at(-1)!.reply_markup!.inline_keyboard![0]![0]!.callback_data;
      expect(select).toMatch(/^m9c:/u);
      expect(select).not.toContain(f.chat.matchId);
      await f.runtime.handle(f.callback(select));
      expect(f.menus.at(-1)!.text).toContain('No messages');
      await f.runtime.handle(f.callback(f.button('Ask a question')));
      const question = f.menus.at(-1)!.reply_markup!.inline_keyboard![0]![0]!.callback_data,
        update = f.callback(question);
      await Promise.all(Array.from({ length: 10 }, () => f.runtime.handle(update)));
      expect(
        await database
          .selectFrom('chat.chat_messages')
          .select('id')
          .where('chat_session_id', '=', f.chat.chatSessionId)
          .execute(),
      ).toHaveLength(1);
      await f.runtime.handle(f.callback(select));
      const mute = f.callback(f.button('Mute chat'));
      await f.runtime.handle(mute);
      await f.runtime.handle(mute);
      expect(
        (
          await database
            .selectFrom('chat.chat_participants')
            .select('muted_at')
            .where('chat_session_id', '=', f.chat.chatSessionId)
            .where('user_id', '=', f.actor.userId)
            .executeTakeFirstOrThrow()
        ).muted_at,
      ).not.toBeNull();
    });
    it('requires explicit unlock confirmation and preserves one debit across exact retries', async () => {
      const f = await fixture();
      await new PostgresCreditLedgerStore(database).append({
        transactionId: randomUUID(),
        userId: f.actor.userId,
        transactionType: 'admin_adjustment',
        amount: 100n,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      });
      const open = await f.tokens.button(f.nav('chat_unlock'));
      await f.runtime.handle(f.callback(open));
      expect(
        (await new PostgresCreditLedgerStore(database).getBalance(f.actor.userId)).balance,
      ).toBe(100n);
      const confirmation = f.callback(f.button('Confirm'));
      const commands = vi.spyOn(SpendCreditsForPaidActionHandler.prototype, 'execute');
      await Promise.all(Array.from({ length: 10 }, () => f.runtime.handle(confirmation)));
      const captured = commands.mock.calls.map(([command]) => command);
      commands.mockRestore();
      expect(captured.length).toBeGreaterThan(0);
      for (const command of captured) {
        expect(command.data.target.type).toBe('chat_unlock');
        if (command.data.target.type === 'chat_unlock')
          expect(command.data.target.actionToken).toMatch(
            /^v1\.pa\.[A-Za-z0-9_-]{16,128}\.[A-Za-z0-9_-]{16,128}$/u,
          );
      }
      expect(
        await database
          .selectFrom('interaction.feature_unlocks')
          .select('id')
          .where('match_id', '=', f.chat.matchId)
          .execute(),
      ).toHaveLength(1);
      expect(
        (await new PostgresCreditLedgerStore(database).getBalance(f.actor.userId)).balance,
      ).toBeLessThan(100n);
      const debits = await database
        .selectFrom('billing.credit_transactions')
        .select('id')
        .where('user_id', '=', f.actor.userId)
        .where('transaction_type', '=', 'spend_chat_unlock')
        .execute();
      expect(debits).toHaveLength(1);
      const balance = (await new PostgresCreditLedgerStore(database).getBalance(f.actor.userId))
        .balance;
      await new PostgresUserSessionStore(database).revoke(
        f.actor,
        f.actor.sessionGrantId,
        randomUUID(),
      );
      await expect(
        new PostgresPaidActionStore(database, f.actor).spendCredits({
          userId: f.actor.userId,
          target: { type: 'match', targetId: f.chat.matchId },
          featureUnlockId: randomUUID(),
          creditTransactionId: randomUUID(),
          outboxEventId: randomUUID(),
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 401 });
      expect(
        (await new PostgresCreditLedgerStore(database).getBalance(f.actor.userId)).balance,
      ).toBe(balance);
    });
    it('acknowledges safety before accepting owned private text and requires a separate Unmatch confirmation', async () => {
      const f = await fixture();
      await new PostgresCreditLedgerStore(database).append({
        transactionId: randomUUID(),
        userId: f.actor.userId,
        transactionType: 'admin_adjustment',
        amount: 100n,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      });
      await new PostgresPaidActionStore(database, f.actor).spendCredits({
        userId: f.actor.userId,
        target: { type: 'match', targetId: f.chat.matchId },
        featureUnlockId: randomUUID(),
        creditTransactionId: randomUUID(),
        outboxEventId: randomUUID(),
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      });
      const view = await f.tokens.button(f.nav('chat_view'));
      f.failWarning(true);
      await expect(f.runtime.handle(f.callback(view))).rejects.toMatchObject({ status: 500 });
      const warning = (): Promise<{ unlock_safety_warning_shown_at: Date | null }> =>
        database
          .selectFrom('chat.chat_participants')
          .select('unlock_safety_warning_shown_at')
          .where('chat_session_id', '=', f.chat.chatSessionId)
          .where('user_id', '=', f.actor.userId)
          .executeTakeFirstOrThrow();
      expect((await warning()).unlock_safety_warning_shown_at).toBeNull();
      f.failWarning(false);
      await f.runtime.handle(f.callback(view));
      expect((await warning()).unlock_safety_warning_shown_at).not.toBeNull();
      await f.runtime.handle(f.callback(f.button('Write a message')));
      const prompt = await f.tokens.reply(f.lastMessageId());
      expect(prompt?.actor).toEqual(f.actor);
      const replyId = f.lastMessageId();
      const reply = {
        update_id: 9000,
        message: {
          message_id: 9001,
          text: 'Private transport body',
          chat: { id: Number(f.recipient), type: 'private' },
          from: { id: Number(f.recipient), is_bot: false },
          reply_to_message: {
            message_id: replyId,
            from: { id: 12345, is_bot: true },
            chat: { id: Number(f.recipient), type: 'private' },
          },
        },
      };
      await f.runtime.handle({
        ...reply,
        message: { ...reply.message, photo: [{ file_id: 'not-chat-text' }] },
      });
      expect(
        await database
          .selectFrom('chat.chat_messages')
          .select('id')
          .where('chat_session_id', '=', f.chat.chatSessionId)
          .execute(),
      ).toHaveLength(0);
      await f.runtime.handle(reply);
      await f.runtime.handle(reply);
      expect(
        await database
          .selectFrom('chat.chat_messages')
          .select('text')
          .where('chat_session_id', '=', f.chat.chatSessionId)
          .execute(),
      ).toEqual([{ text: 'Private transport body' }]);
      await f.runtime.handle(f.callback(f.button('Unmatch')));
      expect(
        (
          await database
            .selectFrom('matching.matches')
            .select('status')
            .where('id', '=', f.chat.matchId)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('active');
      const confirm = f.callback(f.button('Confirm'));
      await f.runtime.handle(confirm);
      await f.runtime.handle(confirm);
      expect(
        (
          await database
            .selectFrom('matching.matches')
            .select('status')
            .where('id', '=', f.chat.matchId)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('unmatched');
    });
    it('denies text while locked and rejects revoked original grants before writes or private delivery', async () => {
      const f = await fixture(),
        text = await f.tokens.button(f.nav('chat_text'));
      await f.runtime.handle(f.callback(text));
      expect(f.menus.every((m) => m.reply_markup?.force_reply !== true)).toBe(true);
      const question = await database
        .selectFrom('chat.predefined_questions')
        .select('id')
        .where('is_active', '=', true)
        .executeTakeFirstOrThrow();
      const selected = await f.tokens.button(
        f.nav('chat_question_send', { action: 'pick', code: question.id }),
      );
      await new PostgresUserSessionStore(database).revoke(
        f.actor,
        f.actor.sessionGrantId,
        randomUUID(),
      );
      const previous = f.menus.length;
      await f.runtime.handle(f.callback(selected));
      expect(f.menus).toHaveLength(previous);
      expect(
        await database
          .selectFrom('chat.chat_messages')
          .select('id')
          .where('chat_session_id', '=', f.chat.chatSessionId)
          .execute(),
      ).toHaveLength(0);
      await expect(f.runtime.open(f.recipient, f.actor)).rejects.toMatchObject({ status: 401 });
    });
  },
);
