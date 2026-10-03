import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AesGcmProfileReportSnapshotProtector,
  AesGcmProfileReportSnapshotReader,
  AesGcmChatReportSnapshotProtector,
  AesGcmChatReportSnapshotReader,
  AesGcmUnmatchedReportSnapshotProtector,
  AesGcmUnmatchedReportSnapshotReader,
  AesGcmPhotoReportSnapshotProtector,
  AesGcmPhotoReportSnapshotReader,
  ReportTokens,
  type EvidenceRevealDraft,
  type ReportSource,
} from '@nakh/application';
import type {
  PrepareReportEvidenceQuery,
  ReportEvidenceType,
  SubmitReportCommand,
} from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createPostgresReportServices } from './report-services.js';
import {
  createReportChat,
  createReportFixtureAdmin,
  createReportLike,
  createReportUnmatch,
  createReportUser,
  createReportPhoto,
} from './testing/report-fixture.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import { PostgresSubmitProfileReportHandler } from './profile-report-submission-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  key = Buffer.alloc(32, 77);
describe.skipIf(url === undefined)('composed report evidence services', () => {
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
  const capabilities = {
    photo: {
      protector: new AesGcmPhotoReportSnapshotProtector('bundle-key', 1, key),
      reader: new AesGcmPhotoReportSnapshotReader({ resolve: () => key }),
    },
    profile: {
      protector: new AesGcmProfileReportSnapshotProtector('bundle-key', 1, key),
      reader: new AesGcmProfileReportSnapshotReader({ resolve: () => key }),
    },
    chat: {
      protector: new AesGcmChatReportSnapshotProtector('bundle-key', 1, key),
      reader: new AesGcmChatReportSnapshotReader({ resolve: () => key }),
    },
    unmatched_user: {
      protector: new AesGcmUnmatchedReportSnapshotProtector('bundle-key', 1, key),
      reader: new AesGcmUnmatchedReportSnapshotReader({ resolve: () => key }),
    },
  };
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
  async function fixture(): Promise<{
    admin: string;
    authorization: Awaited<ReturnType<typeof confirmationFixture>>;
    actor: { kind: 'user'; userId: string };
    services: ReturnType<typeof createPostgresReportServices>;
    inputs: {
      type: ReportEvidenceType;
      query: PrepareReportEvidenceQuery;
      command: SubmitReportCommand;
    }[];
  }> {
    const admin = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: admin,
        role_code: 'super_admin',
        assigned_by_admin_id: admin,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    const authorization = await confirmationFixture(database, admin);
    const services = createPostgresReportServices(
      database,
      tokens,
      authorization.tokens,
      authorization.key,
      capabilities,
    );
    const reporter = await createReportUser(database);
    reporters.push(reporter);
    const actor = { kind: 'user' as const, userId: reporter };
    const photoTarget = await createReportUser(database, true);
    const contexts: { type: ReportEvidenceType; source: ReportSource }[] = [
      {
        type: 'photo',
        source: {
          kind: 'received_like',
          referenceId: await createReportLike(database, reporter, photoTarget),
          photoId: await createReportPhoto(database, photoTarget),
        },
      },
      {
        type: 'profile',
        source: {
          kind: 'received_like',
          referenceId: await createReportLike(
            database,
            reporter,
            await createReportUser(database, true),
          ),
        },
      },
      {
        type: 'chat',
        source: {
          kind: 'match',
          referenceId: (
            await createReportChat(database, reporter, await createReportUser(database))
          ).matchId,
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
    const inputs = [];
    for (const context of contexts) {
      const query = {
        actor,
        requestId: randomUUID(),
        requestedEvidenceTypes: [context.type],
        sourceActionToken: (await tokens.issueSource(reporter, context.source)).token,
      };
      const prepared = await services.prepare.execute(query, actor);
      const command: SubmitReportCommand = {
        commandType: 'moderation.submit-report',
        schemaVersion: 1,
        actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { reasonCode: 'harassment', evidenceIntentToken: prepared.evidenceIntentToken },
      };
      inputs.push({ type: context.type, query, command });
    }
    return { admin, authorization, actor, services, inputs };
  }
  it('connects four evidence types to confirmed review, preserves legacy replay and disables unsupported capabilities consistently', async () => {
    const { authorization, actor, services, inputs } = await fixture();
    const profileOnly = createPostgresReportServices(
      database,
      tokens,
      authorization.tokens,
      authorization.key,
      { profile: capabilities.profile },
    );
    for (const input of inputs) {
      if (input.type !== 'profile') {
        await expect(profileOnly.prepare.execute(input.query, actor)).rejects.toMatchObject({
          code: 'report_unavailable',
        });
        await expect(profileOnly.submit.execute(input.command, actor)).rejects.toMatchObject({
          code: 'report_unavailable',
        });
      }
      // A receipt created by the original profile entry point must survive service composition.
      const receipt =
        input.type === 'profile'
          ? await new PostgresSubmitProfileReportHandler(
              database,
              tokens,
              capabilities.profile.protector,
            ).execute(input.command, actor)
          : await services.submit.execute(input.command, actor);
      expect((await services.submit.execute(input.command, actor)).replayed).toBe(true);
      const query = {
        actor: authorization.actor,
        requestId: randomUUID(),
        adminActionToken: await authorization.issue({
          commandCode: 'moderation.evidence-metadata',
          requiredPermission: 'view_reports',
          targetType: 'report',
          targetId: receipt.reportId,
          expectedTargetVersion: 1,
        }),
      };
      const selection = await services.evidenceActions.execute(query, authorization.actor);
      const selected = selection.items[0]!;
      expect(selected.evidenceType).toBe(input.type);
      expect(selected.revealActionToken).toMatch(/^v1\.ad\./u);
      if (input.type !== 'profile')
        expect(
          (await profileOnly.evidenceActions.execute(query, authorization.actor)).items[0]!
            .revealActionToken,
        ).toBeUndefined();
      const draft: EvidenceRevealDraft = {
        commandType: 'moderation.reveal-evidence',
        schemaVersion: 1,
        actor: authorization.actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          adminActionToken: selected.revealActionToken!,
          evidenceId: selected.evidenceId,
          reason: 'Review selected captured evidence',
        },
      };
      const command = {
        ...draft,
        data: {
          ...draft.data,
          confirmationToken: await services.reveals.prepare(draft, authorization.actor),
        },
      };
      const result = await services.reveals.execute(command, authorization.actor);
      expect(result.value?.content.evidenceType).toBe(input.type);
      expect(
        await database
          .selectFrom('moderation.evidence_access_audits')
          .select('outcome')
          .where('command_id', '=', draft.commandId)
          .execute(),
      ).toEqual([{ outcome: 'revealed' }]);
    }
    values.clear();
    for (const input of inputs)
      expect((await services.submit.execute(input.command, actor)).replayed).toBe(true);
    await expect(
      services.prepare.execute(
        { ...inputs[0]!.query, requestedEvidenceTypes: ['profile', 'chat'] },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'report_unavailable' });
  });
  it('shares one ten-report admission limit across concurrent profile, photo, chat and unmatch commands', async () => {
    const { actor, services, inputs } = await fixture();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => {
        const input = inputs[index % inputs.length]!;
        return services.submit.execute(
          { ...input.command, commandId: randomUUID(), idempotencyKey: randomUUID() },
          actor,
        );
      }),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'report_limit_reached' });
    const evidence = await database
      .selectFrom('moderation.reports as report')
      .innerJoin('moderation.report_evidence as evidence', 'evidence.report_id', 'report.id')
      .select('evidence.evidence_type')
      .where('report.reporter_user_id', '=', actor.userId)
      .execute();
    expect(evidence).toHaveLength(10);
    expect(new Set(evidence.map((row) => row.evidence_type))).toEqual(
      new Set(['profile', 'photo', 'chat', 'unmatched_user']),
    );
  });
});
