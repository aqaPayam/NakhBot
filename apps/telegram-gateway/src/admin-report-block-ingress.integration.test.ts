import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AesGcmChatReportSnapshotProtector,
  AesGcmChatReportSnapshotReader,
  ReportTokens,
  type InternalBlockDraft,
} from '@nakh/application';
import { normalizeUserPair } from '@nakh/domain';
import {
  createDatabase,
  runMigrations,
  createPostgresReportServices,
  PostgresGetAdminReportQueueActionsHandler,
  PostgresPrepareSelectedReportInternalBlockHandler,
  PostgresConfirmedInternalBlocks,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { TelegramAdminTextDelivery, TelegramAdminReportQueueState } from '@nakh/telegram';
import {
  createReportUser,
  createReportChat,
  createReportFixtureAdmin,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createTelegramAdminSafetyReadIngress } from './admin-safety-read-ingress.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
type Menu = { reply_markup: { inline_keyboard: { callback_data: string }[][] } };
describe.skipIf(url === undefined)('native Report pair private block ingress', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_report_block_ui');
    await runMigrations(isolated.url, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 20,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    try {
      await database?.destroy();
    } finally {
      await isolated?.destroy();
    }
  });
  async function fixture(): Promise<{
    reporter: string;
    target: string;
    reportId: string;
    matchId: string;
    chatSessionId: string;
    adminId: string;
    f: Awaited<ReturnType<typeof confirmationFixture>>;
    telegramUserId: string;
  }> {
    const reporter = await createReportUser(database),
      target = await createReportUser(database);
    const chat = await createReportChat(database, reporter, target);
    const pair = normalizeUserPair(reporter, target);
    await database
      .insertInto('interaction.user_pair_states')
      .values({
        ...{ user_low_id: pair.userLowId, user_high_id: pair.userHighId },
        state: 'matched',
        reason_code: 'mutual_like_match',
        changed_at: new Date(),
      })
      .execute();
    const adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'super_admin',
        assigned_by_admin_id: adminId,
        revoked_at: null,
        revoked_by_admin_id: null,
      })
      .execute();
    const f = await confirmationFixture(database, adminId);
    const tokens = new ReportTokens(f.tokens, f.key),
      key = Buffer.alloc(32, 71);
    const services = createPostgresReportServices(database, tokens, f.tokens, f.key, {
      chat: {
        protector: new AesGcmChatReportSnapshotProtector('block-fixture', 1, key),
        reader: new AesGcmChatReportSnapshotReader({ resolve: () => key }),
      },
    });
    const actor = { kind: 'user' as const, userId: reporter };
    const prepared = await services.prepare.execute(
      {
        actor,
        requestId: randomUUID(),
        sourceActionToken: (
          await tokens.issueSource(reporter, { kind: 'match', referenceId: chat.matchId })
        ).token,
        requestedEvidenceTypes: ['chat'],
      },
      actor,
    );
    const report = await services.submit.execute(
      {
        actor,
        commandId: randomUUID(),
        commandType: 'moderation.submit-report',
        schemaVersion: 1,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { reasonCode: 'harassment', evidenceIntentToken: prepared.evidenceIntentToken },
      },
      actor,
    );

    const admin = await database
      .selectFrom('administration.admin_users')
      .select('telegram_user_id')
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow();
    return {
      reporter,
      target,
      reportId: report.reportId,
      ...chat,
      adminId,
      f,
      telegramUserId: admin.telegram_user_id,
    };
  }
  async function nativeCreate(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
    const root = await new PostgresGetAdminReportQueueActionsHandler(
      database,
      f.f.tokens,
      f.f.key,
    ).execute({ actor: f.f.actor, requestId: randomUUID() }, f.f.actor);
    const selected = await new PostgresPrepareSelectedReportInternalBlockHandler(
      database,
      f.f.tokens,
      f.f.key,
    ).execute(
      {
        actor: f.f.actor,
        requestId: randomUUID(),
        adminActionToken: root.metadataActionToken,
        reportId: f.reportId,
        expectedReportVersion: 1,
        action: 'create',
      },
      f.f.actor,
    );
    const id = randomUUID(),
      draft: InternalBlockDraft = {
        actor: f.f.actor,
        commandId: id,
        requestId: id,
        idempotencyKey: id,
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        commandType: 'moderation.change-internal-block',
        data: {
          adminActionToken: selected.adminActionToken,
          expectedTargetVersion: selected.pairVersion,
          action: 'create',
          reason: 'Independent winning block',
        },
      };
    const commands = new PostgresConfirmedInternalBlocks(database, f.f.tokens, f.f.key);
    expect(
      await commands.execute(
        {
          ...draft,
          data: { ...draft.data, confirmationToken: await commands.prepare(draft, f.f.actor) },
        },
        f.f.actor,
      ),
    ).toMatchObject({ result: 'succeeded' });
  }
  it.each(['success', 'cancelled', 'revoked', 'stale', 'expired'] as const)(
    'preserves native pair effects and exact private boundaries for %s',
    async (mode) => {
      const f = await fixture(),
        now = new Date(),
        sent: string[] = [];
      let expired = false;
      const fetcher = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockImplementation((_url, init) => {
          sent.push(init!.body as string);
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } })),
          );
        });
      const ingress = createTelegramAdminSafetyReadIngress({
        database,
        botId: '123',
        tokens: f.f.tokens,
        adminKey: f.f.key,
        uiEncryptionKey: new Uint8Array(32).fill(1),
        uiReferenceKey: new Uint8Array(32).fill(2),
        sessions: {
          current: () =>
            Promise.resolve(
              expired
                ? undefined
                : {
                    actor: f.f.actor,
                    telegramUserId: f.telegramUserId,
                    locale: 'en',
                    expiresAt: new Date(now.getTime() + 300000),
                    mfaExpiresAt: new Date(now.getTime() + 300000),
                  },
            ),
        },
        renderer: { render: (_locale, intent) => intent.key },
        delivery: new TelegramAdminTextDelivery('123:synthetic-token', fetcher),
      });
      const state = new TelegramAdminReportQueueState(
        f.f.tokens,
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
      const from = { id: Number(f.telegramUserId), is_bot: false },
        chat = { id: Number(f.telegramUserId), type: 'private' };
      let updateId = 100;
      const callback = (data: string, id = updateId++): Promise<'notice' | 'unhandled'> =>
        ingress.handle({ update_id: id, callback_query: { from, data, message: { chat } } });
      await ingress.handle({
        update_id: updateId++,
        message: { from, chat, date: Math.floor(now.getTime() / 1000), text: '/admin_reports' },
      });
      let reference: string | undefined;
      for (let page = 0; page < 20; page++) {
        const rows = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard;
        for (const data of rows.flat().map((button) => button.callback_data))
          if (
            data.startsWith('m7T:') &&
            (await state.choice(f.f.actor, data.slice(4)))?.targetId === f.reportId
          )
            reference = data.slice(4);
        if (reference !== undefined) break;
        const next = rows.flat().find((button) => button.callback_data.startsWith('m7O:'));
        expect(next).toBeDefined();
        await callback(next!.callback_data);
      }
      expect(reference).toBeDefined();
      await callback('m7T:' + reference);
      expect(
        (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard
          .flat()
          .map((b) => b.callback_data),
      ).toContain('m7bC:' + reference);
      expect(
        (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard
          .flat()
          .map((b) => b.callback_data),
      ).not.toContain('m7bR:' + reference);
      const notificationsBefore = await database
        .selectFrom('notification.notifications')
        .select('id')
        .execute();
      async function prepare(code: 'C' | 'R'): Promise<string> {
        await callback('m7b' + code + ':' + reference);
        const promptId = sent.length;
        expect(await state.promptSelection(f.f.actor, promptId)).toBeUndefined();
        expect(await state.photoPrompt(f.f.actor, promptId)).toBeUndefined();
        expect(await state.evidencePrompt(f.f.actor, promptId)).toBeUndefined();
        expect(await state.blockPrompt(f.f.actor, promptId)).toEqual({
          reference,
          blockAction: code === 'C' ? 'create' : 'remove',
        });
        await ingress.handle({
          update_id: updateId++,
          message: {
            from,
            chat,
            date: Math.floor(now.getTime() / 1000),
            text: 'Synthetic internal block reason',
            reply_to_message: { message_id: promptId, from: { id: 123, is_bot: true } },
          },
        });
        const data = (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard[0]![0]!
          .callback_data;
        expect(data).toMatch(/^m7bY:[A-Za-z0-9_-]{22}$/u);
        return data;
      }
      const confirm = await prepare('C');
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('admin_user_id', '=', f.adminId)
          .execute(),
      ).toHaveLength(0);
      if (mode === 'revoked')
        await database
          .updateTable('administration.admin_user_roles')
          .set({ revoked_at: new Date(), revoked_by_admin_id: f.adminId })
          .where('admin_user_id', '=', f.adminId)
          .execute();
      if (mode === 'stale') await nativeCreate(f);
      if (mode === 'expired') expired = true;
      const decision = mode === 'cancelled' ? confirm.replace('m7bY:', 'm7bN:') : confirm;
      const id = updateId++;
      await Promise.all(Array.from({ length: 12 }, () => callback(decision, id)));
      if (mode === 'success') {
        await callback('m7T:' + reference);
        expect(
          (JSON.parse(sent.at(-1)!) as Menu).reply_markup.inline_keyboard
            .flat()
            .map((b) => b.callback_data),
        ).toContain('m7bR:' + reference);
        const remove = await prepare('R'),
          removeId = updateId++;
        await Promise.all(Array.from({ length: 12 }, () => callback(remove, removeId)));
        const replayId = updateId++;
        await Promise.all(Array.from({ length: 12 }, () => callback(confirm, replayId)));
      }
      const logs = await database
        .selectFrom('administration.admin_action_logs')
        .select(['result', 'safe_code'])
        .where('admin_user_id', '=', f.adminId)
        .execute();
      if (mode === 'success') expect(logs).toHaveLength(2);
      if (mode === 'cancelled' || mode === 'expired') expect(logs).toHaveLength(0);
      if (mode === 'revoked')
        expect(logs).toEqual([{ result: 'rejected', safe_code: 'forbidden' }]);
      if (mode === 'stale')
        expect(logs).toEqual(
          expect.arrayContaining([{ result: 'rejected', safe_code: 'version_conflict' }]),
        );
      const actions = await database
        .selectFrom('moderation.moderation_actions')
        .select(['action_type', 'source_report_id'])
        .where('actor_admin_id', '=', f.adminId)
        .execute();
      expect(actions).toHaveLength(mode === 'success' ? 2 : mode === 'stale' ? 1 : 0);
      for (const action of actions) expect(action.source_report_id).toBe(f.reportId);
      const pair = normalizeUserPair(f.reporter, f.target),
        row = await database
          .selectFrom('interaction.user_pair_states')
          .select(['state'])
          .where('user_low_id', '=', pair.userLowId)
          .where('user_high_id', '=', pair.userHighId)
          .executeTakeFirst();
      if (mode === 'success') expect(row).toBeUndefined();
      else expect(row?.state).toBe(mode === 'stale' ? 'blocked' : 'matched');
      const closed = mode === 'success' || mode === 'stale';
      expect(
        await database
          .selectFrom('matching.matches')
          .select('status')
          .where('id', '=', f.matchId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: closed ? 'closed' : 'active' });
      expect(
        await database
          .selectFrom('chat.chat_sessions')
          .select('status')
          .where('id', '=', f.chatSessionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: closed ? 'closed' : 'active' });
      expect(
        await database
          .selectFrom('moderation.reports')
          .select(['status', 'version'])
          .where('id', '=', f.reportId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'pending_review', version: 1 });
      expect(
        await database
          .selectFrom('moderation.moderation_reviews')
          .select(['status', 'assigned_admin_id'])
          .where('report_id', '=', f.reportId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'pending', assigned_admin_id: null });
      expect(
        await database
          .selectFrom('identity.accounts')
          .select(['state', 'version'])
          .where('user_id', 'in', [f.reporter, f.target])
          .execute(),
      ).toEqual([
        { state: 'active', version: 1 },
        { state: 'active', version: 1 },
      ]);
      expect(
        await database.selectFrom('notification.notifications').select('id').execute(),
      ).toEqual(notificationsBefore);
      expect(
        await database
          .selectFrom('moderation.evidence_access_audits')
          .select('id')
          .where('report_id', '=', f.reportId)
          .execute(),
      ).toHaveLength(0);
      for (const body of sent) {
        const payload = JSON.parse(body) as Record<string, unknown>;
        expect(payload.chat_id).toBe(f.telegramUserId);
        expect(payload.protect_content).toBe(true);
        expect(payload.parse_mode).toBeUndefined();
        for (const secret of [
          f.reportId,
          f.reporter,
          f.target,
          f.adminId,
          f.f.actor.userId,
          f.matchId,
          f.chatSessionId,
        ])
          expect(body).not.toContain(secret);
      }
    },
  );
});
