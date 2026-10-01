import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AesGcmPhotoReportSnapshotProtector,
  AesGcmPhotoReportSnapshotReader,
  ReportTokens,
  SubmitPhotoReportHandler,
} from '@nakh/application';
import type { SubmitReportCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { SystemIdGenerator } from './foundation-store.js';
import {
  createReportPhoto,
  createReportLike,
  createReportFixtureAdmin,
  createReportUser,
} from './testing/report-fixture.js';
import { PostgresPreparePhotoReportEvidenceHandler } from './photo-report-source-store.js';
import {
  PostgresPhotoReportSubmissionStore,
  PostgresSubmitPhotoReportHandler,
} from './photo-report-submission-store.js';
const url = process.env.NAKH_TEST_DATABASE_URL,
  key = Buffer.alloc(32, 73);
describe.skipIf(url === undefined)('transactional photo report submission', () => {
  let database: NakhDatabase;
  const reporters: string[] = [],
    values = new Map<string, string>();
  const tokens = new ReportTokens(
    {
      get: (id) => Promise.resolve(values.get(id)),
      putIfAbsent: (id, value) => {
        values.set(id, value);
        return Promise.resolve(true);
      },
    },
    key,
  );
  const snapshots = new AesGcmPhotoReportSnapshotProtector('photo-report-key', 1, key);
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 20,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 25000,
    });
  });
  afterAll(async () => {
    if (database === undefined) return;
    if (reporters.length > 0) {
      const admin = await createReportFixtureAdmin(database);
      await database
        .updateTable('moderation.moderation_reviews')
        .set({
          status: 'in_review',
          assigned_admin_id: admin,
          assigned_at: sql<Date>`transaction_timestamp()`,
          updated_at: sql<Date>`transaction_timestamp()`,
          version: sql<number>`version + 1`,
        })
        .where('status', '=', 'pending')
        .where(
          'report_id',
          'in',
          database
            .selectFrom('moderation.reports')
            .select('id')
            .where('reporter_user_id', 'in', reporters),
        )
        .execute();
    }
    await database.destroy();
  });
  async function prepare(
    target?: string,
  ): Promise<Readonly<{ command: SubmitReportCommand; photoId: string }>> {
    const reporter = await createReportUser(database),
      targetId = target ?? (await createReportUser(database, true));
    reporters.push(reporter);
    const photoId =
        target === undefined
          ? await createReportPhoto(database, targetId)
          : (
              await database
                .selectFrom('media.profile_photos')
                .select('id')
                .where(
                  'profile_id',
                  '=',
                  database
                    .selectFrom('profile.profiles')
                    .select('id')
                    .where('user_id', '=', targetId),
                )
                .where('status', '=', 'visible')
                .executeTakeFirstOrThrow()
            ).id,
      actor = { kind: 'user' as const, userId: reporter };
    const source = await tokens.issueSource(reporter, {
      kind: 'received_like',
      referenceId: await createReportLike(database, reporter, targetId),
      photoId,
    });
    const prepared = await new PostgresPreparePhotoReportEvidenceHandler(database, tokens).execute(
      {
        actor,
        requestId: randomUUID(),
        sourceActionToken: source.token,
        requestedEvidenceTypes: ['photo'],
      },
      actor,
    );
    return {
      photoId,
      command: {
        commandType: 'moderation.submit-report',
        schemaVersion: 1,
        actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          evidenceIntentToken: prepared.evidenceIntentToken,
          reasonCode: 'harassment',
          text: 'Private report explanation',
        },
      },
    };
  }
  it('commits one encrypted snapshot and review across concurrent retries, retains replay after token loss and emits no content', async () => {
    const input = await prepare();
    let arrived = 0,
      release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const handler = new SubmitPhotoReportHandler(
      {
        resolveIntent: async (token, actor) => {
          const intent = await tokens.resolveIntent(token, actor);
          if (++arrived === 6) release();
          await gate;
          return intent;
        },
      },
      new PostgresPhotoReportSubmissionStore(database, snapshots),
      new SystemIdGenerator(),
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, () => handler.execute(input.command, input.command.actor)),
    );
    expect(new Set(results.map((result) => result.reportId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const reportId = results[0]!.reportId;
    const saved = await database
      .selectFrom('moderation.report_snapshots')
      .selectAll()
      .where('report_id', '=', reportId)
      .execute();
    expect(saved).toHaveLength(1);
    const row = saved[0]!;
    const holds = await database
      .selectFrom('media.report_photo_evidence_holds')
      .selectAll()
      .where('report_evidence_id', '=', row.report_evidence_id)
      .execute();
    expect(holds).toHaveLength(1);
    expect(holds[0]!.photo_id).toBe(input.photoId);
    expect(
      new AesGcmPhotoReportSnapshotReader({ resolve: () => key }).decrypt(
        { reportId, evidenceId: row.report_evidence_id },
        {
          snapshotType: row.snapshot_type,
          schemaVersion: row.schema_version,
          keyId: row.encryption_key_id,
          keyVersion: row.encryption_key_version,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          sha256: row.content_sha256,
        },
      ),
    ).toEqual({
      evidenceType: 'photo',
      evidenceObjectRef: `v1.pe.${row.report_evidence_id}`,
      contentSha256: holds[0]!.content_sha256,
      primary: true,
    });
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('payload')
      .where('aggregate_id', '=', reportId)
      .execute();
    expect(events).toEqual([
      { payload: { reportId, evidenceTypes: ['photo'], status: 'pending_review' } },
    ]);
    const stable = new PostgresSubmitPhotoReportHandler(database, tokens, snapshots);
    values.clear();
    expect((await stable.execute(input.command, input.command.actor)).replayed).toBe(true);
    await expect(
      stable.execute(
        { ...input.command, data: { ...input.command.data, text: 'Changed' } },
        input.command.actor,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('rolls back the retention hold on invalid encryption and rejects media unavailable after preparation', async () => {
    const failed = await prepare();
    const before = await database
      .selectFrom('media.report_photo_evidence_holds')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    const handler = new PostgresSubmitPhotoReportHandler(database, tokens, {
      protect: (subject, content) => ({
        ...snapshots.protect(subject, content),
        ciphertext: Buffer.alloc(0),
      }),
    });
    await expect(handler.execute(failed.command, failed.command.actor)).rejects.toThrow();
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('command_id', '=', failed.command.commandId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('media.report_photo_evidence_holds')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(
      (
        await new PostgresSubmitPhotoReportHandler(database, tokens, snapshots).execute(
          failed.command,
          failed.command.actor,
        )
      ).replayed,
    ).toBe(false);
    const closed = await prepare();
    await database
      .updateTable('media.photo_variants')
      .set({ deleted_at: new Date() })
      .where(
        'asset_id',
        '=',
        database
          .selectFrom('media.profile_photos')
          .select('asset_id')
          .where('id', '=', closed.photoId),
      )
      .execute();
    await expect(
      new PostgresSubmitPhotoReportHandler(database, tokens, snapshots).execute(
        closed.command,
        closed.command.actor,
      ),
    ).rejects.toMatchObject({ code: 'report_unavailable' });
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('command_id', '=', closed.command.commandId)
        .execute(),
    ).toHaveLength(0);
  });
  it('shares the durable ten-report limit across concurrent photo submissions', async () => {
    const { command } = await prepare(),
      handler = new PostgresSubmitPhotoReportHandler(database, tokens, snapshots);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        handler.execute(
          { ...command, commandId: randomUUID(), idempotencyKey: randomUUID() },
          command.actor,
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'report_limit_reached' });
  });
  it('counts five distinct photo reporters toward one restriction episode', async () => {
    const target = await createReportUser(database, true);
    await createReportPhoto(database, target);
    const inputs = await Promise.all(Array.from({ length: 5 }, () => prepare(target)));
    const handler = new PostgresSubmitPhotoReportHandler(database, tokens, snapshots);
    await Promise.all(inputs.map((input) => handler.execute(input.command, input.command.actor)));
    expect(
      await database
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', target)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'restricted' });
    expect(
      await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('target_user_id', '=', target)
        .where('action_type', '=', 'restrict_user')
        .execute(),
    ).toHaveLength(1);
  });
});
