import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AesGcmPhotoReportSnapshotReader,
  type EvidenceRevealDraft,
  type AuditedReportPhotoRequest,
} from '@nakh/application';
import {
  createDatabase,
  runMigrations,
  PostgresConfirmedReportEvidenceReveals,
  PostgresAuditedReportPhotoStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { TelegramAdminEvidenceAdapter, type TelegramAdminSessionVerifier } from '@nakh/telegram';
import {
  createReportFixtureAdmin,
  createRetainedReportPhoto,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { confirmationFixture } from '../../../packages/persistence-postgres/src/testing/admin-confirmation.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createTelegramAdminEvidenceDelivery } from './admin-evidence-delivery.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('exact audited private retained byte delivery', () => {
  let database: NakhDatabase;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_photo_delivery');
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
    source: Awaited<ReturnType<typeof createRetainedReportPhoto>>;
    adminId: string;
    recipient: string;
    bytes: Buffer;
    native: PostgresConfirmedReportEvidenceReveals;
    command: Parameters<PostgresConfirmedReportEvidenceReveals['execute']>[0];
    current: ReturnType<typeof vi.fn<TelegramAdminSessionVerifier['current']>>;
  }> {
    const bytes = Buffer.alloc(32);
    bytes.write('RIFF');
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WEBP', 8);
    const source = await createRetainedReportPhoto(database, bytes),
      adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'moderator',
        assigned_by_admin_id: adminId,
        revoked_at: null,
        revoked_by_admin_id: null,
      })
      .execute();
    const f = await confirmationFixture(database, adminId);
    const recipient = (
      await database
        .selectFrom('administration.admin_users')
        .select('telegram_user_id')
        .where('id', '=', adminId)
        .executeTakeFirstOrThrow()
    ).telegram_user_id;
    const draft: EvidenceRevealDraft = {
      actor: f.actor,
      commandId: randomUUID(),
      commandType: 'moderation.reveal-evidence',
      schemaVersion: 1,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        evidenceId: source.evidenceId,
        reason: 'Review exact captured photo',
        adminActionToken: await f.issue({
          commandCode: 'moderation.reveal-evidence',
          requiredPermission: 'view_reports',
          targetType: 'report_evidence',
          targetId: source.evidenceId,
          expectedTargetVersion: 1,
        }),
      },
    };
    const native = new PostgresConfirmedReportEvidenceReveals(database, f.tokens, f.key, {
      photo: new AesGcmPhotoReportSnapshotReader({ resolve: () => source.key }),
    });
    const command = {
      ...draft,
      data: { ...draft.data, confirmationToken: await native.prepare(draft, f.actor) },
    };
    const now = new Date();
    const current = vi.fn<TelegramAdminSessionVerifier['current']>().mockResolvedValue({
      actor: f.actor,
      telegramUserId: recipient,
      locale: 'en',
      expiresAt: new Date(now.getTime() + 300000),
      mfaExpiresAt: new Date(now.getTime() + 300000),
    });
    return { source, adminId, recipient, bytes, native, command, current };
  }
  it.each([
    'success',
    'logical-delete',
    'revoked',
    'session-expired',
    'corrupt',
    'storage-failed',
    'provider-failed',
  ] as const)('delivers one exact held image under concurrent retries: %s', async (scenario) => {
    const f = await fixture();
    const sent: FormData[] = [];
    const held = await database
      .selectFrom('media.report_photo_evidence_holds as hold')
      .innerJoin('media.photo_variants as variant', 'variant.id', 'hold.variant_id')
      .select(['hold.asset_id', 'hold.variant_id', 'variant.storage_key'])
      .where('hold.report_evidence_id', '=', f.source.evidenceId)
      .executeTakeFirstOrThrow();
    if (scenario === 'logical-delete') {
      await database
        .updateTable('media.profile_photos')
        .set({ status: 'deleted', is_primary: false, deleted_at: new Date(), version: 2 })
        .where('id', '=', f.source.photoId)
        .execute();
      await database
        .updateTable('media.photo_variants')
        .set({ deleted_at: new Date() })
        .where('id', '=', held.variant_id)
        .execute();
      await database
        .updateTable('media.media_assets')
        .set({ deleted_at: new Date() })
        .where('id', '=', held.asset_id)
        .execute();
    }
    const getObject = vi.fn(
      async (key: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> => {
        expect(key).toBe(held.storage_key);
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(
          await database
            .selectFrom('moderation.evidence_access_audits')
            .select('outcome')
            .where('command_id', '=', f.command.commandId)
            .execute(),
        ).toEqual([{ outcome: 'revealed' }]);
        if (scenario === 'storage-failed') throw new Error('private object store response');
        if (scenario === 'revoked')
          await database
            .updateTable('administration.admin_user_roles')
            .set({ revoked_at: new Date(), revoked_by_admin_id: f.adminId })
            .where('admin_user_id', '=', f.adminId)
            .execute();
        if (scenario === 'session-expired') f.current.mockResolvedValue(undefined);
        return (async function* () {
          yield await Promise.resolve(
            scenario === 'corrupt' ? Buffer.alloc(32) : f.bytes.subarray(0, 16),
          );
          if (scenario !== 'corrupt') yield f.bytes.subarray(16);
        })();
      },
    );
    const fetcher = vi.fn((endpoint: string, init?: RequestInit): Promise<Response> => {
      if (endpoint.endsWith('/sendPhoto')) {
        sent.push(init!.body as FormData);
        if (scenario === 'provider-failed')
          return Promise.reject(new Error('secret provider response'));
      } else {
        expect(JSON.parse(init!.body as string)).toMatchObject({
          protect_content: true,
          link_preview_options: { is_disabled: true },
        });
        expect(init!.body as string).not.toContain(f.source.evidenceId);
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
    });
    const delivery = createTelegramAdminEvidenceDelivery({
      database,
      objects: { getObject },
      sessions: { current: f.current },
      botToken: '123:synthetic',
      fetcher,
    });
    const adapter = new TelegramAdminEvidenceAdapter(
      { current: f.current },
      { resolve: () => Promise.resolve(f.command) },
      f.native,
      delivery,
      { render: (_locale, intent) => intent.key },
    );
    const update = {
      update_id: 1,
      callback_query: {
        data: `m7e:${'a'.repeat(22)}`,
        from: { id: Number(f.recipient), is_bot: false },
        message: { chat: { id: Number(f.recipient), type: 'private' } },
      },
    };
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () => adapter.handle(update)),
    );
    expect(getObject).toHaveBeenCalledTimes(1);
    const succeeds = scenario === 'success' || scenario === 'logical-delete';
    expect(sent).toHaveLength(succeeds || scenario === 'provider-failed' ? 1 : 0);
    if (succeeds) {
      expect(attempts.every((result) => result.status === 'fulfilled')).toBe(true);
      expect([...sent[0]!.keys()]).toEqual(['chat_id', 'protect_content', 'photo']);
      expect(sent[0]!.get('chat_id')).toBe(f.recipient);
      expect(sent[0]!.get('protect_content')).toBe('true');
      expect(new Uint8Array(await (sent[0]!.get('photo') as Blob).arrayBuffer())).toEqual(
        new Uint8Array(f.bytes),
      );
    } else expect(attempts.some((result) => result.status === 'rejected')).toBe(true);
    f.current.mockResolvedValue({
      actor: f.command.actor,
      telegramUserId: f.recipient,
      locale: 'en',
      expiresAt: new Date(Date.now() + 300000),
      mfaExpiresAt: new Date(Date.now() + 300000),
    });
    await Promise.all(Array.from({ length: 12 }, () => adapter.handle(update)));
    expect(getObject).toHaveBeenCalledTimes(1);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select(['result', 'safe_code'])
        .where('command_id', '=', f.command.commandId)
        .execute(),
    ).toEqual([{ result: 'succeeded', safe_code: 'evidence_revealed' }]);
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('outcome')
        .where('command_id', '=', f.command.commandId)
        .execute(),
    ).toEqual([{ outcome: 'revealed' }]);
    expect(
      await database
        .selectFrom('media.report_photo_evidence_holds')
        .select('variant_id')
        .where('report_evidence_id', '=', f.source.evidenceId)
        .execute(),
    ).toEqual([{ variant_id: held.variant_id }]);
  });
  it('requires matching successful committed audits and current private identity for exact physical hold resolution', async () => {
    const f = await fixture();
    const store = new PostgresAuditedReportPhotoStore(database);
    const input: AuditedReportPhotoRequest = {
      actor: f.command.actor,
      recipient: f.recipient,
      objectRef: f.source.content.evidenceObjectRef,
      contentSha256: f.source.content.contentSha256,
      commandId: f.command.commandId,
      logId: randomUUID(),
    };
    expect(await store.resolve(input)).toBeUndefined();
    const result = await f.native.execute(f.command, f.command.actor);
    const valid = { ...input, logId: result.logId };
    expect(await store.resolve(valid)).toMatchObject({ sha256: input.contentSha256 });
    for (const changed of [
      { ...valid, logId: randomUUID() },
      { ...valid, commandId: randomUUID() },
      { ...valid, recipient: '999' },
      { ...valid, actor: { kind: 'admin' as const, userId: randomUUID() } },
      { ...valid, objectRef: `v1.pe.${randomUUID()}` },
      { ...valid, contentSha256: '0'.repeat(64) },
    ])
      expect(await store.resolve(changed)).toBeUndefined();
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('id')
        .where('command_id', '=', f.command.commandId)
        .execute(),
    ).toHaveLength(1);
  });
});
