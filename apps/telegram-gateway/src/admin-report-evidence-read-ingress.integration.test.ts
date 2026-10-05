import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AesGcmProfileReportSnapshotProtector,
  AesGcmProfileReportSnapshotReader,
  AesGcmPhotoReportSnapshotProtector,
  AesGcmPhotoReportSnapshotReader,
  AesGcmChatReportSnapshotProtector,
  AesGcmChatReportSnapshotReader,
  AesGcmUnmatchedReportSnapshotProtector,
  AesGcmUnmatchedReportSnapshotReader,
  IntegrityMessageReportSnapshotReader,
  ReportTokens,
  type ReportSource,
} from '@nakh/application';
import {
  createDatabase,
  runMigrations,
  createPostgresReportServices,
  type NakhDatabase,
  type ReportEvidenceReaders,
  type ReportEvidenceCapabilities,
} from '@nakh/persistence-postgres';
import type { ReportEvidenceType } from '@nakh/contracts';
import {
  TelegramAdminTextDelivery,
  TelegramAdminReportQueueState,
  type TelegramAdminEvidenceDelivery,
} from '@nakh/telegram';
import {
  createReportFixtureAdmin,
  createRetainedReportPhoto,
  createReportUser,
  createReportLike,
  createReportChat,
  createReportMessage,
  createReportUnmatch,
  createReportPhoto,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createTelegramAdminSafetyReadIngress } from './admin-safety-read-ingress.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
type Menu = { reply_markup: { inline_keyboard: { callback_data: string }[][] } };
describe.skipIf(url === undefined)('actual separately confirmed Telegram evidence reads', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_evidence_read_ui');
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
  async function operator(
    viewOnly = true,
  ): Promise<
    Awaited<ReturnType<typeof confirmationFixture>> & { adminId: string; telegramUserId: string }
  > {
    const adminId = await createReportFixtureAdmin(database);
    const role = viewOnly ? `evidence_view_${adminId.replaceAll('-', '')}` : 'moderator';
    if (viewOnly) {
      await database
        .insertInto('administration.admin_roles')
        .values({ code: role, description: 'Synthetic metadata-only fixture' })
        .execute();
      await database
        .insertInto('administration.admin_role_permissions')
        .values({ role_code: role, permission_code: 'view_reports' })
        .execute();
    }
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: role,
        assigned_by_admin_id: adminId,
        revoked_at: null,
        revoked_by_admin_id: null,
      })
      .execute();
    const admin = await database
      .selectFrom('administration.admin_users')
      .select('telegram_user_id')
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow();
    return {
      ...(await confirmationFixture(database, adminId)),
      adminId,
      telegramUserId: admin.telegram_user_id,
    };
  }

  function harness(
    f: Awaited<ReturnType<typeof operator>>,
    readers: ReportEvidenceReaders,
  ): {
    sent: string[];
    state: TelegramAdminReportQueueState;
    callback: (data: string, updateId?: number) => Promise<'notice' | 'unhandled'>;
    queue: (status: string) => Promise<'notice' | 'unhandled'>;
    reply: (messageId: number, updateId?: number) => Promise<'notice' | 'unhandled'>;
    retainedPhoto: ReturnType<typeof vi.fn<TelegramAdminEvidenceDelivery['retainedPhoto']>>;
    ingress: ReturnType<typeof createTelegramAdminSafetyReadIngress>;
  } {
    const sent: string[] = [],
      now = new Date();
    const retainedPhoto = vi
      .fn<TelegramAdminEvidenceDelivery['retainedPhoto']>()
      .mockImplementation(async (input) => {
        expect(input.actor).toEqual(f.actor);
        expect(input.recipient).toBe(f.telegramUserId);
        expect(
          await database
            .selectFrom('moderation.evidence_access_audits')
            .select('id')
            .where('report_evidence_id', '=', input.objectRef.slice(6))
            .where('admin_user_id', '=', f.adminId)
            .where('outcome', '=', 'revealed')
            .execute(),
        ).toHaveLength(1);
      });
    const delivery = new TelegramAdminTextDelivery('123:synthetic-token', (_url, init) => {
      sent.push(init!.body as string);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } })),
      );
    });
    const ingress = createTelegramAdminSafetyReadIngress({
      database,
      botId: '123',
      tokens: f.tokens,
      adminKey: f.key,
      uiEncryptionKey: new Uint8Array(32).fill(1),
      uiReferenceKey: new Uint8Array(32).fill(2),
      sessions: {
        current: () =>
          Promise.resolve({
            actor: f.actor,
            telegramUserId: f.telegramUserId,
            locale: 'en',
            expiresAt: new Date(now.getTime() + 300000),
            mfaExpiresAt: new Date(now.getTime() + 300000),
          }),
      },
      delivery,
      renderer: { render: (_locale, intent) => intent.key },
      evidence: { readers, delivery: { text: delivery.text.bind(delivery), retainedPhoto } },
    });
    const from = { id: Number(f.telegramUserId), is_bot: false },
      chat = { id: Number(f.telegramUserId), type: 'private' };
    let updateId = 100;
    return {
      sent,
      ingress,
      retainedPhoto,
      state: new TelegramAdminReportQueueState(
        f.tokens,
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      ),
      callback: (data, id) =>
        ingress.handle({
          update_id: id ?? updateId++,
          callback_query: { from, data, message: { chat } },
        }),
      queue: (status) =>
        ingress.handle({
          update_id: updateId++,
          message: {
            from,
            chat,
            date: Math.floor(now.getTime() / 1000),
            text: `/admin_reports ${status}`,
          },
        }),
      reply: (messageId, id) =>
        ingress.handle({
          update_id: id ?? updateId++,
          message: {
            from,
            chat,
            date: Math.floor(now.getTime() / 1000),
            text: 'Review exact retained evidence',
            reply_to_message: { message_id: messageId, from: { id: 123, is_bot: true } },
          },
        }),
    };
  }
  async function choose(
    h: ReturnType<typeof harness>,
    f: Awaited<ReturnType<typeof operator>>,
    reportId: string,
    status: string,
  ): Promise<string> {
    await h.queue(status);
    for (let page = 0; page < 20; page++) {
      const rows = (JSON.parse(h.sent.at(-1)!) as Menu).reply_markup.inline_keyboard;
      for (const data of rows.flat().map((button) => button.callback_data)) {
        if (
          data.startsWith('m7T:') &&
          (await h.state.choice(f.actor, data.slice(4)))?.targetId === reportId
        ) {
          await h.callback(data);
          const options = (JSON.parse(h.sent.at(-1)!) as Menu).reply_markup.inline_keyboard
            .flat()
            .map((button) => button.callback_data);
          expect(options).toEqual(
            (status === 'pending_review' ? ['I', 'C'] : ['C']).map((code) =>
              data.replace('m7T:', `m7${code}:`),
            ),
          );
          await h.callback(data.replace('m7T:', 'm7C:'));
          const selection = (JSON.parse(h.sent.at(-1)!) as Menu).reply_markup
            .inline_keyboard[0]![0]!.callback_data;
          expect(selection).toMatch(/^m7J:[A-Za-z0-9_-]{22}$/u);
          return selection;
        }
      }
      const next = rows.flat().find((button) => button.callback_data.startsWith('m7O:'));
      expect(next).toBeDefined();
      await h.callback(next!.callback_data);
    }
    throw new Error('Synthetic selected report not found');
  }

  async function prepare(
    h: ReturnType<typeof harness>,
    f: Awaited<ReturnType<typeof operator>>,
    reportId: string,
  ): Promise<string> {
    const selected = await choose(h, f, reportId, 'submitted');
    await h.callback(selected);
    const view = (JSON.parse(h.sent.at(-1)!) as Menu).reply_markup.inline_keyboard[0]![0]!
      .callback_data;
    expect(view).toBe(selected.replace('m7J:', 'm7W:'));
    await h.callback(view);
    const promptId = h.sent.length;
    expect(await h.state.promptSelection(f.actor, promptId)).toBeUndefined();
    expect(await h.state.photoPrompt(f.actor, promptId)).toBeUndefined();
    expect(await h.state.evidencePrompt(f.actor, promptId)).toEqual({
      reference: selected.slice(4),
      read: 'evidence',
    });
    const beforeConfirm = h.sent.length;
    expect(
      await Promise.all(Array.from({ length: 10 }, () => h.reply(promptId, 900000 + promptId))),
    ).toEqual(Array(10).fill('notice'));
    const confirmations = h.sent
      .slice(beforeConfirm)
      .filter((row) => row.includes('m7K:'))
      .map((row) => (JSON.parse(row) as Menu).reply_markup.inline_keyboard[0]![0]!.callback_data);
    expect(new Set(confirmations).size).toBe(1);
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('id')
        .where('admin_user_id', '=', f.adminId)
        .where('report_id', '=', reportId)
        .execute(),
    ).toHaveLength(0);
    return confirmations.at(-1)!;
  }
  async function evidenceLogs(
    f: Awaited<ReturnType<typeof operator>>,
    evidenceId: string,
  ): Promise<readonly { result: string; safe_code: string }[]> {
    return database
      .selectFrom('administration.admin_action_logs')
      .select(['result', 'safe_code'])
      .where('admin_user_id', '=', f.adminId)
      .where('command_code', '=', 'moderation.reveal-evidence')
      .where('target_id', '=', evidenceId)
      .execute();
  }
  it('captures and reveals all five native evidence types once through owned private reasons and concurrent confirmations', async () => {
    const f = await operator(),
      key = Buffer.alloc(32, 77),
      readerKeys = { resolve: () => key };
    const capabilities: ReportEvidenceCapabilities = {
      profile: {
        protector: new AesGcmProfileReportSnapshotProtector('read-fixture', 1, key),
        reader: new AesGcmProfileReportSnapshotReader(readerKeys),
      },
      photo: {
        protector: new AesGcmPhotoReportSnapshotProtector('read-fixture', 1, key),
        reader: new AesGcmPhotoReportSnapshotReader(readerKeys),
      },
      chat: {
        protector: new AesGcmChatReportSnapshotProtector('read-fixture', 1, key),
        reader: new AesGcmChatReportSnapshotReader(readerKeys),
      },
      unmatched_user: {
        protector: new AesGcmUnmatchedReportSnapshotProtector('read-fixture', 1, key),
        reader: new AesGcmUnmatchedReportSnapshotReader(readerKeys),
      },
      message: { reader: new IntegrityMessageReportSnapshotReader() },
    };
    const tokens = new ReportTokens(f.tokens, new Uint8Array(32).fill(3));
    const services = createPostgresReportServices(database, tokens, f.tokens, f.key, capabilities);
    const reporter = await createReportUser(database),
      profileTarget = await createReportUser(database, true),
      like = await createReportLike(database, reporter, profileTarget);
    const chatTarget = await createReportUser(database),
      chat = await createReportChat(database, reporter, chatTarget);
    const contexts: { type: ReportEvidenceType; source: ReportSource }[] = [
      { type: 'profile', source: { kind: 'received_like', referenceId: like } },
      {
        type: 'photo',
        source: {
          kind: 'received_like',
          referenceId: like,
          photoId: await createReportPhoto(database, profileTarget),
        },
      },
      { type: 'chat', source: { kind: 'match', referenceId: chat.matchId } },
      {
        type: 'message',
        source: {
          kind: 'message',
          referenceId: await createReportMessage(database, chat.chatSessionId, chatTarget),
        },
      },
      {
        type: 'unmatched_user',
        source: {
          kind: 'unmatched',
          referenceId: (
            await createReportUnmatch(database, reporter, await createReportUser(database))
          ).matchId,
        },
      },
    ];
    const h = harness(f, {
      profile: capabilities.profile!.reader,
      photo: capabilities.photo!.reader,
      chat: capabilities.chat!.reader,
      message: capabilities.message!.reader,
      unmatched_user: capabilities.unmatched_user!.reader,
    });
    for (const context of contexts) {
      const actor = { kind: 'user' as const, userId: reporter };
      const sourceActionToken = (await tokens.issueSource(reporter, context.source)).token;
      const intent = await services.prepare.execute(
        {
          actor,
          requestId: randomUUID(),
          sourceActionToken,
          requestedEvidenceTypes: [context.type],
        },
        actor,
      );
      const commandId = randomUUID();
      const report = await services.submit.execute(
        {
          actor,
          commandId,
          requestId: commandId,
          idempotencyKey: commandId,
          commandType: 'moderation.submit-report',
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: { reasonCode: 'harassment', evidenceIntentToken: intent.evidenceIntentToken },
        },
        actor,
      );
      const evidence = await database
        .selectFrom('moderation.report_evidence')
        .select('id')
        .where('report_id', '=', report.reportId)
        .executeTakeFirstOrThrow();
      const before = h.sent.length;
      const confirmation = await prepare(h, f, report.reportId);
      expect(h.retainedPhoto).toHaveBeenCalledTimes(
        0 +
          (contexts.slice(0, contexts.indexOf(context)).some((item) => item.type === 'photo')
            ? 1
            : 0),
      );
      expect(
        h.sent.slice(before).every((row) => !row.includes('Private message evidence fixture')),
      ).toBe(true);
      const confirmUpdate = 1000000 + h.sent.length;
      expect(
        await Promise.all(
          Array.from({ length: 10 }, () => h.callback(confirmation, confirmUpdate)),
        ),
      ).toEqual(Array(10).fill('notice'));
      expect(await evidenceLogs(f, evidence.id)).toEqual([
        { result: 'succeeded', safe_code: 'evidence_revealed' },
      ]);
      expect(
        await database
          .selectFrom('moderation.evidence_access_audits')
          .select(['outcome'])
          .where('admin_user_id', '=', f.adminId)
          .where('report_evidence_id', '=', evidence.id)
          .execute(),
      ).toEqual([{ outcome: 'revealed' }]);
    }
    expect(h.retainedPhoto).toHaveBeenCalledOnce();
    expect(h.sent.filter((row) => row.includes('Private message evidence fixture'))).toHaveLength(
      1,
    );
    for (const row of h.sent) {
      expect(JSON.parse(row)).toMatchObject({
        protect_content: true,
        link_preview_options: { is_disabled: true },
      });
      expect(JSON.parse(row)).not.toHaveProperty('parse_mode');
      for (const secret of [
        reporter,
        profileTarget,
        chatTarget,
        chat.chatSessionId,
        f.actor.userId,
        f.adminId,
        'v1.pe.',
      ])
        expect(row).not.toContain(secret);
    }
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select('id')
        .where(
          'report_id',
          'in',
          database
            .selectFrom('moderation.reports')
            .select('id')
            .where('reporter_user_id', '=', reporter),
        )
        .execute(),
    ).toHaveLength(0);
  });
  it.each(['cancel', 'revoked', 'provider-failed'] as const)(
    'keeps one exact native outcome for %s without content redelivery',
    async (mode) => {
      const f = await operator(),
        source = await createRetainedReportPhoto(database);
      const h = harness(f, {
        photo: new AesGcmPhotoReportSnapshotReader({ resolve: () => source.key }),
      });
      const confirmation = await prepare(h, f, source.reportId);
      if (mode === 'cancel') await h.callback(confirmation.replace('m7K:', 'm7Q:'), 899);
      if (mode === 'revoked')
        await database
          .updateTable('administration.admin_user_roles')
          .set({ revoked_at: new Date(), revoked_by_admin_id: f.adminId })
          .where('admin_user_id', '=', f.adminId)
          .execute();
      if (mode === 'provider-failed')
        h.retainedPhoto.mockRejectedValueOnce(new Error('Private provider detail'));
      const attempts = await Promise.allSettled(
        Array.from({ length: 10 }, () => h.callback(confirmation, 900)),
      );
      for (const attempt of attempts)
        if (attempt.status === 'rejected')
          expect(attempt.reason).toMatchObject({ status: 500, message: 'error.m7.internal' });
      expect(
        await Promise.all(Array.from({ length: 10 }, () => h.callback(confirmation, 900))),
      ).toEqual(Array(10).fill('notice'));
      expect(h.retainedPhoto).toHaveBeenCalledTimes(mode === 'provider-failed' ? 1 : 0);
      expect(await evidenceLogs(f, source.evidenceId)).toEqual(
        mode === 'cancel'
          ? []
          : [
              {
                result: mode === 'revoked' ? 'rejected' : 'succeeded',
                safe_code: mode === 'revoked' ? 'forbidden' : 'evidence_revealed',
              },
            ],
      );
      expect(
        await database
          .selectFrom('moderation.evidence_access_audits')
          .select(['outcome'])
          .where('admin_user_id', '=', f.adminId)
          .where('report_evidence_id', '=', source.evidenceId)
          .execute(),
      ).toEqual(
        mode === 'cancel' ? [] : [{ outcome: mode === 'revoked' ? 'rejected' : 'revealed' }],
      );
      for (const encoded of h.sent)
        for (const secret of [
          source.reportId,
          source.evidenceId,
          source.reporter,
          source.target,
          source.photoId,
          source.content.evidenceObjectRef,
          'Private provider detail',
        ])
          expect(encoded).not.toContain(secret);
    },
  );
});
