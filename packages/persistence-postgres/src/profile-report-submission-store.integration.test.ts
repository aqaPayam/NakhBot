import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AesGcmProfileReportSnapshotProtector,
  ReportTokens,
  SubmitProfileReportHandler,
  profileReportSnapshotAad,
  type ProfileReportSnapshotProtector,
} from '@nakh/application';
import type { SubmitReportCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresPrepareProfileReportEvidenceHandler } from './profile-report-source-store.js';
import {
  PostgresProfileReportSubmissionStore,
  PostgresSubmitProfileReportHandler,
} from './profile-report-submission-store.js';
import { SystemIdGenerator } from './foundation-store.js';
import {
  createReportFixtureAdmin,
  createReportDelivery,
  createReportLike,
  createReportNakh,
  createReportUser,
} from './testing/report-fixture.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL,
  key = Buffer.alloc(32, 25);
describe.skipIf(databaseUrl === undefined)('transactional encrypted profile reports', () => {
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
    Buffer.alloc(32, 26),
  );
  const snapshots = new AesGcmProfileReportSnapshotProtector('report-key', 1, key);
  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 20,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 25000,
    });
  });
  afterAll(async () => {
    if (database !== undefined) {
      // Keep this suite's retained reports out of other suites' shared unassigned review queue.
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
    }
  });
  async function command(
    target?: string,
    sourceKind: 'received_like' | 'received_nakh' | 'delivered_candidate' = 'received_like',
  ): Promise<SubmitReportCommand> {
    const reporter = await createReportUser(database, sourceKind === 'received_nakh');
    reporters.push(reporter);
    const targetId = target ?? (await createReportUser(database, true));
    const source = await tokens.issueSource(reporter, {
      kind: sourceKind,
      referenceId:
        sourceKind === 'delivered_candidate'
          ? await createReportDelivery(database, reporter, targetId)
          : sourceKind === 'received_like'
            ? await createReportLike(database, reporter, targetId)
            : await createReportNakh(database, reporter, targetId),
    });
    const actor = { kind: 'user' as const, userId: reporter };
    const prepared = await new PostgresPrepareProfileReportEvidenceHandler(
      database,
      tokens,
    ).execute(
      {
        actor,
        requestId: randomUUID(),
        sourceActionToken: source.token,
        requestedEvidenceTypes: ['profile'],
      },
      actor,
    );
    return {
      commandType: 'moderation.submit-report',
      schemaVersion: 1,
      commandId: randomUUID(),
      requestId: randomUUID(),
      actor,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        evidenceIntentToken: prepared.evidenceIntentToken,
        reasonCode: 'harassment',
        text: '  private report text  ',
      },
    };
  }
  function barrierHandler(
    count: number,
    protector: ProfileReportSnapshotProtector = snapshots,
  ): SubmitProfileReportHandler {
    let arrive = 0,
      release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    return new SubmitProfileReportHandler(
      {
        resolveIntent: async (token, actor) => {
          const intent = await tokens.resolveIntent(token, actor);
          if (++arrive === count) release();
          await gate;
          return intent;
        },
      },
      new PostgresProfileReportSubmissionStore(database, protector),
      new SystemIdGenerator(),
    );
  }
  it('submits profile evidence from an actual recorded discovery delivery and replays once', async () => {
    const input = await command(undefined, 'delivered_candidate');
    const handler = new PostgresSubmitProfileReportHandler(database, tokens, snapshots);
    const first = await handler.execute(input, input.actor);
    expect(first.replayed).toBe(false);
    expect(await handler.execute(input, input.actor)).toEqual({ ...first, replayed: true });
    const evidence = await database
      .selectFrom('moderation.report_evidence')
      .select(['evidence_type', 'profile_id'])
      .where('report_id', '=', first.reportId)
      .execute();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.evidence_type).toBe('profile');
    expect(evidence[0]?.profile_id).not.toBeNull();
  });
  it('commits one encrypted snapshot, review and safe event across simultaneous retries and survives token loss', async () => {
    const input = await command(),
      handler = barrierHandler(6);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => handler.execute(input, input.actor)),
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
    const snapshot = saved[0]!,
      ciphertext = snapshot.ciphertext;
    const decipher = createDecipheriv('aes-256-gcm', key, snapshot.nonce);
    decipher.setAAD(
      profileReportSnapshotAad(
        { reportId, evidenceId: snapshot.report_evidence_id },
        {
          schemaVersion: 1,
          snapshotType: 'profile',
          keyId: snapshot.encryption_key_id,
          keyVersion: snapshot.encryption_key_version,
          sha256: snapshot.content_sha256,
        },
      ),
    );
    decipher.setAuthTag(ciphertext.subarray(-16));
    expect(
      JSON.parse(
        Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString(
          'utf8',
        ),
      ),
    ).toEqual({
      evidenceType: 'profile',
      displayName: 'Private report fixture',
      birthYear: 1995,
      bio: 'Private report bio',
    });
    const event = await database
      .selectFrom('platform.outbox_events')
      .select('payload')
      .where('aggregate_id', '=', reportId)
      .execute();
    expect(event).toEqual([
      { payload: { reportId, evidenceTypes: ['profile'], status: 'pending_review' } },
    ]);
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select('id')
        .where('report_id', '=', reportId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('extra_text')
        .where('id', '=', reportId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ extra_text: 'private report text' });
    values.clear();
    const normal = new PostgresSubmitProfileReportHandler(database, tokens, snapshots);
    await expect(normal.execute(input, input.actor)).resolves.toMatchObject({
      reportId,
      replayed: true,
    });
    await expect(
      normal.execute({ ...input, data: { ...input.data, text: 'changed' } }, input.actor),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('admits only ten competing commands and does not count one reporter as five', async () => {
    const input = await command(),
      handler = barrierHandler(12);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        handler.execute(
          { ...input, commandId: randomUUID(), idempotencyKey: randomUUID() },
          input.actor,
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(10);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected')
        expect(outcome.reason).toMatchObject({ code: 'report_limit_reached' });
    const reports = await database
      .selectFrom('moderation.reports')
      .select(['id', 'target_user_id'])
      .where('reporter_user_id', '=', input.actor.userId)
      .execute();
    expect(reports).toHaveLength(10);
    expect(
      await database
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', reports[0]!.target_user_id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'active' });
    expect(
      await database
        .selectFrom('moderation.report_snapshots')
        .select('id')
        .where(
          'report_id',
          'in',
          reports.map((report) => report.id),
        )
        .execute(),
    ).toHaveLength(10);
  });
  it('restricts once for five distinct simultaneous reporters with atomic evidence and queue entries', async () => {
    const target = await createReportUser(database, true);
    const commands = await Promise.all(Array.from({ length: 5 }, () => command(target)));
    const handler = barrierHandler(5);
    const results = await Promise.all(commands.map((input) => handler.execute(input, input.actor)));
    expect(results).toHaveLength(5);
    expect(
      await database
        .selectFrom('identity.accounts')
        .select(['state', 'version'])
        .where('user_id', '=', target)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'restricted', version: 2 });
    expect(
      await database
        .selectFrom('moderation.restriction_episodes')
        .select('id')
        .where('target_user_id', '=', target)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('target_user_id', '=', target)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select('id')
        .where(
          'report_id',
          'in',
          results.map((result) => result.reportId),
        )
        .execute(),
    ).toHaveLength(5);
    expect(
      await database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', '=', target)
        .where('notification_type', '=', 'restriction_warning')
        .execute(),
    ).toHaveLength(1);
  });
  it('reauthorizes forged server intent and rolls back partial writes when snapshot persistence fails', async () => {
    const input = await command();
    const original = await tokens.resolveIntent(input.data.evidenceIntentToken, input.actor.userId);
    const forged = await tokens.issueIntent(input.actor.userId, {
      ...original!,
      source: { ...original!.source, referenceId: randomUUID() },
    });
    const normal = new PostgresSubmitProfileReportHandler(database, tokens, snapshots);
    await expect(
      normal.execute(
        { ...input, data: { ...input.data, evidenceIntentToken: forged.token } },
        input.actor,
      ),
    ).rejects.toMatchObject({ code: 'report_unavailable' });
    const broken = new PostgresSubmitProfileReportHandler(database, tokens, {
      protect: (subject, content) => ({
        ...snapshots.protect(subject, content),
        ciphertext: new Uint8Array(1),
      }),
    });
    await expect(broken.execute(input, input.actor)).rejects.toMatchObject({ code: '23514' });
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('reporter_user_id', '=', input.actor.userId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('causation_id', '=', input.commandId)
        .execute(),
    ).toHaveLength(0);
    await expect(normal.execute(input, input.actor)).resolves.toMatchObject({ replayed: false });
  });
  it('submits profile-only evidence from a real funded Nakh and denies its sender and unrelated users', async () => {
    const input = await command(undefined, 'received_nakh');
    const intent = (await tokens.resolveIntent(
      input.data.evidenceIntentToken,
      input.actor.userId,
    ))!;
    const preparation = new PostgresPrepareProfileReportEvidenceHandler(database, tokens);
    for (const userId of [intent.targetUserId, await createReportUser(database)]) {
      const source = await tokens.issueSource(userId, intent.source),
        actor = { kind: 'user' as const, userId };
      await expect(
        preparation.execute(
          {
            actor,
            requestId: randomUUID(),
            sourceActionToken: source.token,
            requestedEvidenceTypes: ['profile'],
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: 'report_unavailable' });
    }
    const handler = new PostgresSubmitProfileReportHandler(database, tokens, snapshots);
    const result = await handler.execute(input, input.actor);
    await expect(handler.execute(input, input.actor)).resolves.toMatchObject({
      reportId: result.reportId,
      replayed: true,
    });
    const evidence = await database
      .selectFrom('moderation.report_evidence')
      .select(['evidence_type', 'profile_id', 'chat_message_id'])
      .where('report_id', '=', result.reportId)
      .execute();
    expect(evidence).toEqual([
      {
        evidence_type: 'profile',
        profile_id: intent.evidence[0]!.referenceId,
        chat_message_id: null,
      },
    ]);
    const snapshot = await database
      .selectFrom('moderation.report_snapshots')
      .select(['snapshot_type', 'content_sha256'])
      .where('report_id', '=', result.reportId)
      .executeTakeFirstOrThrow();
    expect(snapshot).toEqual({
      snapshot_type: 'profile',
      content_sha256: createHash('sha256')
        .update(
          JSON.stringify({
            evidenceType: 'profile',
            displayName: 'Private report fixture',
            birthYear: 1995,
            bio: 'Private report bio',
          }),
        )
        .digest('hex'),
    });
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('payload')
      .where('causation_id', '=', input.commandId)
      .execute();
    for (const secret of [
      intent.source.referenceId,
      input.actor.userId,
      intent.targetUserId,
      'Private Nakh text',
      'private report text',
    ])
      expect(JSON.stringify(events)).not.toContain(secret);
  });
  it('rejects a cached report intent after a ban and allows safety reporting after restriction', async () => {
    const input = await command();
    const intent = (await tokens.resolveIntent(
      input.data.evidenceIntentToken,
      input.actor.userId,
    ))!;
    const source = await tokens.issueSource(input.actor.userId, intent.source);
    await database
      .updateTable('identity.accounts')
      .set({
        state: 'banned',
        state_reason: 'fixture_ban',
        state_changed_at: new Date(),
        version: 2,
      })
      .where('user_id', '=', input.actor.userId)
      .execute();
    await expect(
      new PostgresPrepareProfileReportEvidenceHandler(database, tokens).execute(
        {
          actor: input.actor,
          requestId: randomUUID(),
          sourceActionToken: source.token,
          requestedEvidenceTypes: ['profile'],
        },
        input.actor,
      ),
    ).rejects.toMatchObject({ code: 'report_unavailable' });
    const handler = new PostgresSubmitProfileReportHandler(database, tokens, snapshots);
    await expect(handler.execute(input, input.actor)).rejects.toMatchObject({
      code: 'report_unavailable',
    });
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('reporter_user_id', '=', input.actor.userId)
        .execute(),
    ).toHaveLength(0);
    await database
      .updateTable('identity.accounts')
      .set({
        state: 'restricted',
        state_reason: 'fixture_restriction',
        state_changed_at: new Date(),
        version: 3,
      })
      .where('user_id', '=', input.actor.userId)
      .execute();
    await expect(handler.execute(input, input.actor)).resolves.toMatchObject({ replayed: false });
  });
  it('admits reciprocal reports without reversing account locks', async () => {
    const first = await createReportUser(database, true),
      second = await createReportUser(database, true);
    reporters.push(first, second);
    async function reciprocal(actorUserId: string, target: string): Promise<SubmitReportCommand> {
      const actor = { kind: 'user' as const, userId: actorUserId };
      const source = await tokens.issueSource(actorUserId, {
        kind: 'received_like',
        referenceId: await createReportLike(database, actorUserId, target),
      });
      const prepared = await new PostgresPrepareProfileReportEvidenceHandler(
        database,
        tokens,
      ).execute(
        {
          actor,
          requestId: randomUUID(),
          sourceActionToken: source.token,
          requestedEvidenceTypes: ['profile'],
        },
        actor,
      );
      return {
        actor,
        commandType: 'moderation.submit-report',
        schemaVersion: 1,
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { evidenceIntentToken: prepared.evidenceIntentToken, reasonCode: 'harassment' },
      };
    }
    const commands = await Promise.all([reciprocal(first, second), reciprocal(second, first)]);
    const handler = barrierHandler(2);
    const results = await Promise.all(commands.map((input) => handler.execute(input, input.actor)));
    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.reportId)).size).toBe(2);
  });
});
