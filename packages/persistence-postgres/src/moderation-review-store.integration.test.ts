import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AesGcmReviewNoteProtector,
  ReviewDecisionWorkflow,
  type AdminCommandAttempt,
} from '@nakh/application';
import {
  PostgresReviewDecisionStore,
  PostgresReviewDecisionWorkflow,
} from './review-decision-store.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
import { SystemIdGenerator } from './foundation-store.js';

import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresModerationReviewWorkflow } from './moderation-review-store.js';
import { PostgresConfirmedReviewAssignments } from './confirmed-review-assignment-store.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import type { AssignModerationReviewCommand, DecideModerationReviewCommand } from '@nakh/contracts';
import { PostgresConfirmedReviewDecisions } from './confirmed-review-decision-store.js';
import { sql } from 'kysely';
import type { RawBuilder } from 'kysely';
import { PostgresGetReportMetadataPageHandler } from './report-metadata-store.js';
import type { GetReportMetadataPageQuery, ReportMetadataPage } from '@nakh/contracts';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const genderOptionId = '20000000-0000-4000-8000-000000000001';
const genderPreferenceId = '20000000-0000-4000-8000-000000000013';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createUser(database: NakhDatabase): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  return id;
}

async function createAdmin(database: NakhDatabase, withRole = true): Promise<string> {
  const userId = await createUser(database);
  const adminUserId = randomUUID();
  const telegramUserId = String(2_000_000_000 + Math.floor(Math.random() * 7_000_000_000));
  const now = new Date();
  await database
    .insertInto('identity.telegram_identities')
    .values({
      user_id: userId,
      telegram_user_id: telegramUserId,
      username: null,
      first_seen_at: now,
      last_seen_at: now,
    })
    .execute();
  await database
    .insertInto('administration.admin_users')
    .values({
      id: adminUserId,
      user_id: userId,
      telegram_user_id: telegramUserId,
      is_active: true,
      disabled_at: null,
      identity_verified_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  if (withRole)
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminUserId,
        role_code: 'moderator',
        assigned_by_admin_id: adminUserId,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
  return adminUserId;
}

async function createPendingReview(
  database: NakhDatabase,
  input: Readonly<{
    priority: 'normal' | 'threshold';
    createdAt: Date;
    submittedAt?: RawBuilder<Date>;
  }>,
): Promise<Readonly<{ reportId: string; reviewId: string }>> {
  const reporterUserId = await createUser(database);
  const targetUserId = await createUser(database);
  const profileId = randomUUID();
  await database
    .insertInto('profile.profiles')
    .values({
      id: profileId,
      user_id: targetUserId,
      name: 'Review fixture',
      birth_year: input.createdAt.getUTCFullYear() - 30,
      gender_option_id: genderOptionId,
      gender_preference_id: genderPreferenceId,
      relationship_goal_id: relationshipGoalId,
      country_id: countryId,
      province_id: provinceId,
      city_id: cityId,
      highlight: 'Review fixture',
      bio: null,
      completion_status: 'complete',
      ever_completed: true,
      completed_at: input.createdAt,
      created_at: input.createdAt,
      updated_at: input.createdAt,
    })
    .execute();
  await database
    .insertInto('interaction.likes')
    .values({
      id: randomUUID(),
      sender_user_id: targetUserId,
      receiver_user_id: reporterUserId,
      status: 'active',
      created_at: input.createdAt,
      closed_at: null,
    })
    .execute();
  const reason = await database
    .selectFrom('moderation.report_reasons')
    .select('id')
    .where('code', '=', 'harassment')
    .executeTakeFirstOrThrow();
  const reportId = randomUUID();
  const reviewId = randomUUID();
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('moderation.reports')
      .values({
        id: reportId,
        reporter_user_id: reporterUserId,
        target_user_id: targetUserId,
        reason_id: reason.id,
        extra_text: null,
        status: 'pending_review',
        priority: input.priority,
        command_id: randomUUID(),
        request_id: randomUUID(),
        idempotency_key: `report:${reportId}`,
        request_digest: digest(`report:${reportId}`),
        submitted_at: input.submittedAt ?? input.createdAt,
        reviewed_at: null,
        closed_at: null,
      })
      .execute();
    await transaction
      .insertInto('moderation.report_evidence')
      .values({
        id: randomUUID(),
        report_id: reportId,
        evidence_type: 'profile',
        profile_id: profileId,
        profile_photo_id: null,
        chat_session_id: null,
        chat_message_id: null,
        unmatch_record_id: null,
      })
      .execute();
    await transaction
      .insertInto('moderation.moderation_reviews')
      .values({
        id: reviewId,
        report_id: reportId,
        status: 'pending',
        assigned_admin_id: null,
        assigned_at: null,
        decided_at: null,
        decision_note_ciphertext: null,
        decision_note_key_id: null,
        decision_note_key_version: null,
        decision_note_nonce: null,
        decision_note_sha256: null,
        created_at: input.createdAt,
        updated_at: input.createdAt,
      })
      .execute();
  });
  return { reportId, reviewId };
}

function adminAttempt(
  adminUserId: string,
  input: Readonly<{
    commandCode: 'moderation.assign-review' | 'moderation.claim-reviews';
    targetType: 'admin_user' | 'moderation_review';
    targetId: string;
    expectedTargetVersion: number | null;
  }>,
): AdminCommandAttempt {
  return {
    logId: randomUUID(),
    adminUserId,
    commandId: randomUUID(),
    requestId: randomUUID(),
    requestDigest: digest(JSON.stringify(input)),
    commandCode: input.commandCode,
    requiredPermission: 'view_reports',
    targetType: input.targetType,
    targetId: input.targetId,
    expectedTargetVersion: input.expectedTargetVersion,
    reasonDigest: digest('queue management'),
    metadata: {},
    correlationId: randomUUID(),
  };
}

describe.skipIf(databaseUrl === undefined)('M7 moderation review queue', () => {
  let database: NakhDatabase;
  let workflow: PostgresModerationReviewWorkflow;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 10,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
    workflow = new PostgresModerationReviewWorkflow(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });
  async function assignedReview(): Promise<{
    adminId: string;
    review: { reportId: string; reviewId: string };
    attempt: AdminCommandAttempt;
  }> {
    const adminId = await createAdmin(database);
    const review = await createPendingReview(database, {
      priority: 'normal',
      createdAt: new Date(Date.now() - 10000),
    });
    const assignment = adminAttempt(adminId, {
      commandCode: 'moderation.assign-review',
      targetType: 'moderation_review',
      targetId: review.reviewId,
      expectedTargetVersion: 1,
    });
    expect(
      await workflow.assign(assignment, {
        reviewId: review.reviewId,
        assigneeAdminId: adminId,
        expectedVersion: 1,
      }),
    ).toMatchObject({ result: 'succeeded' });
    const attempt: AdminCommandAttempt = {
      ...assignment,
      logId: randomUUID(),
      commandId: randomUUID(),
      commandCode: 'moderation.decide-review',
      requiredPermission: 'dismiss_report',
      expectedTargetVersion: 2,
    };
    return { adminId, review, attempt };
  }
  const notes = new AesGcmReviewNoteProtector('review-key', 1, Buffer.alloc(32, 17));
  it('pages privacy-safe metadata without skipping microsecond ties and rechecks authorization for every page', async () => {
    const adminId = await createAdmin(database);
    const fixtures: string[] = [];
    for (const [index, priority] of (['threshold', 'normal', 'normal'] as const).entries()) {
      const review = await createPendingReview(database, {
        priority,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        submittedAt: sql<Date>`${`2026-01-01T00:00:00.00000${index + 1}Z`}::timestamptz`,
      });
      await workflow.assign(
        adminAttempt(adminId, {
          commandCode: 'moderation.assign-review',
          targetType: 'moderation_review',
          targetId: review.reviewId,
          expectedTargetVersion: 1,
        }),
        { reviewId: review.reviewId, assigneeAdminId: adminId, expectedVersion: 1 },
      );
      fixtures.push(review.reportId);
    }
    const f = await confirmationFixture(database, adminId);
    const handler = new PostgresGetReportMetadataPageHandler(database, f.tokens, f.key);
    const query: GetReportMetadataPageQuery = {
      actor: f.actor,
      requestId: randomUUID(),
      limit: 1,
      adminActionToken: await f.issue({
        commandCode: 'moderation.report-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report_queue',
        targetId: null,
        expectedTargetVersion: null,
      }),
    };
    const items: ReportMetadataPage['items'] = [];
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
      const page = await handler.execute(
        { ...query, ...(cursor === undefined ? {} : { cursor }) },
        f.actor,
      );
      items.push(...page.items);
      firstCursor ??= page.nextCursor;
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }
    expect(cursor).toBeUndefined();
    expect(new Set(items.map((item) => item.reportId)).size).toBe(items.length);
    expect(
      items.filter((item) => fixtures.includes(item.reportId)).map((item) => item.reportId),
    ).toEqual(fixtures);
    for (const item of items)
      expect(Object.keys(item).sort()).toEqual([
        'evidenceTypes',
        'priorReportCount',
        'priority',
        'reasonCode',
        'reportId',
        'status',
        'submittedAt',
        'version',
      ]);
    expect(items.find((item) => item.reportId === fixtures[0])).toMatchObject({
      reasonCode: 'harassment',
      evidenceTypes: ['profile'],
      priorReportCount: 0,
    });
    await expect(
      handler.execute({ ...query, cursor: firstCursor!, status: 'dismissed' }, f.actor),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const otherId = await createAdmin(database),
      other = await confirmationFixture(database, otherId);
    const otherHandler = new PostgresGetReportMetadataPageHandler(database, f.tokens, f.key);
    await expect(
      otherHandler.execute({ ...query, actor: other.actor }, other.actor),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await database
      .updateTable('administration.admin_users')
      .set({
        is_active: false,
        disabled_at: sql<Date>`updated_at + interval '1 millisecond'`,
        updated_at: sql<Date>`updated_at + interval '1 millisecond'`,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', adminId)
      .execute();
    await expect(
      handler.execute({ ...query, cursor: firstCursor! }, f.actor),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('audits altered and missing confirmations, then serializes independently confirmed competing decisions', async () => {
    const { adminId, review } = await assignedReview();
    const f = await confirmationFixture(database, adminId);
    const commands = new PostgresConfirmedReviewDecisions(database, f.tokens, f.key, notes);
    const token = await f.issue({
      commandCode: 'moderation.decide-review',
      requiredPermission: 'dismiss_report',
      targetType: 'moderation_review',
      targetId: review.reviewId,
      expectedTargetVersion: 2,
    });
    const command: DecideModerationReviewCommand = {
      actor: f.actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'moderation.decide-review',
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: token,
        confirmationToken: '',
        expectedTargetVersion: 2,
        reason: 'Private dismissal reason',
        decision: 'dismissed',
        note: 'Private dismissal note',
      },
    };
    expect(await commands.execute(command, f.actor)).toMatchObject({
      result: 'rejected',
      safeCode: 'invalid_request',
    });
    command.commandId = randomUUID();
    command.data.confirmationToken = await commands.prepare(command, f.actor);
    expect(
      await commands.execute(
        { ...command, data: { ...command.data, note: 'altered private note' } },
        f.actor,
      ),
    ).toMatchObject({ result: 'rejected', safeCode: 'invalid_request' });
    const contenders = await Promise.all(
      Array.from({ length: 2 }, async () => {
        const next = { ...command, commandId: randomUUID(), data: { ...command.data } };
        next.data.confirmationToken = await commands.prepare(next, f.actor);
        return next;
      }),
    );
    const results = await Promise.all(contenders.map((next) => commands.execute(next, f.actor)));
    expect(results.filter((result) => result.result === 'succeeded')).toHaveLength(1);
    expect(results.filter((result) => result.result === 'rejected')).toHaveLength(1);
    const winner = contenders[results.findIndex((result) => result.result === 'succeeded')]!;
    expect(await commands.execute(winner, f.actor)).toMatchObject({
      result: 'succeeded',
      replayed: true,
    });
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .selectAll()
      .where('admin_user_id', '=', adminId)
      .where('command_code', '=', 'moderation.decide-review')
      .execute();
    expect(logs).toHaveLength(4);
    expect(JSON.stringify(logs)).not.toContain('Private dismissal');
    expect(JSON.stringify(logs)).not.toContain(token);
  });
  it('rechecks admin disablement after confirmation and safely records encryption failure', async () => {
    const { adminId, review } = await assignedReview();
    const f = await confirmationFixture(database, adminId);
    const commands = new PostgresConfirmedReviewDecisions(database, f.tokens, f.key, {
      protect: () => {
        throw new Error('Restricted key provider diagnostics');
      },
    });
    const command: DecideModerationReviewCommand = {
      actor: f.actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'moderation.decide-review',
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: await f.issue({
          commandCode: 'moderation.decide-review',
          requiredPermission: 'dismiss_report',
          targetType: 'moderation_review',
          targetId: review.reviewId,
          expectedTargetVersion: 2,
        }),
        confirmationToken: '',
        expectedTargetVersion: 2,
        reason: 'review resolution',
        decision: 'dismissed',
        note: 'Restricted note',
      },
    };
    command.data.confirmationToken = await commands.prepare(command, f.actor);
    expect(await commands.execute(command, f.actor)).toMatchObject({
      result: 'failed',
      safeCode: 'internal_error',
    });
    command.commandId = randomUUID();
    command.data.confirmationToken = await commands.prepare(command, f.actor);
    await database
      .updateTable('administration.admin_users')
      .set({
        is_active: false,
        disabled_at: sql<Date>`updated_at + interval '1 millisecond'`,
        updated_at: sql<Date>`updated_at + interval '1 millisecond'`,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', adminId)
      .execute();
    expect(await commands.execute(command, f.actor)).toMatchObject({
      result: 'rejected',
      safeCode: 'forbidden',
    });
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select(['status', 'version'])
        .where('id', '=', review.reviewId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'in_review', version: 2 });
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .selectAll()
      .where('admin_user_id', '=', adminId)
      .execute();
    expect(JSON.stringify(logs)).not.toContain('Restricted');
  });
  it('finalizes an already actioned report without performing the prior action again', async () => {
    const { review, attempt, adminId } = await assignedReview();
    const report = await database
      .selectFrom('moderation.reports')
      .select('target_user_id')
      .where('id', '=', review.reportId)
      .executeTakeFirstOrThrow();
    // Seed historical action evidence; the decision workflow may acknowledge it but never repeat it.
    const auditId = randomUUID(),
      actionId = randomUUID(),
      commandId = randomUUID();
    await database
      .insertInto('platform.audit_logs')
      .values({
        id: auditId,
        category: 'admin',
        event_type: 'moderation.action-recorded.v1',
        actor_type: 'admin',
        actor_user_id: null,
        actor_admin_id: adminId,
        subject_type: 'user',
        subject_id: report.target_user_id,
        result_code: 'restricted',
        metadata_schema_version: 1,
        metadata: {},
        request_id: randomUUID(),
        command_id: commandId,
        occurred_at: new Date(),
      })
      .execute();
    await database
      .insertInto('moderation.moderation_actions')
      .values({
        id: actionId,
        action_type: 'restrict_user',
        actor_type: 'admin',
        actor_admin_id: adminId,
        target_user_id: report.target_user_id,
        target_photo_id: null,
        target_pair_low_user_id: null,
        target_pair_high_user_id: null,
        source_report_id: review.reportId,
        restriction_episode_id: null,
        audit_log_id: auditId,
        notification_id: null,
        command_id: commandId,
        request_id: randomUUID(),
        request_digest: digest('historical action'),
        reason_code: 'admin_restrict',
      })
      .execute();
    const decisions = new PostgresReviewDecisionWorkflow(database, notes);
    expect(
      await decisions.decide({ ...attempt, requiredPermission: 'view_reports' }, 'actioned'),
    ).toMatchObject({ result: 'succeeded', value: { status: 'actioned', version: 3 } });
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('status')
        .where('id', '=', review.reportId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'actioned' });
    expect(
      await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('source_report_id', '=', review.reportId)
        .execute(),
    ).toEqual([{ id: actionId }]);
  });
  it('commits one encrypted dismissal, action, event and audit across concurrent retries', async () => {
    const { review, attempt } = await assignedReview();
    const decisions = new PostgresReviewDecisionWorkflow(database, notes);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        decisions.decide(attempt, 'dismissed', 'Private review decision'),
      ),
    );
    expect(results.every((result) => result.result === 'succeeded')).toBe(true);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const row = await database
      .selectFrom('moderation.moderation_reviews')
      .selectAll()
      .where('id', '=', review.reviewId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'dismissed',
      version: 3,
      decision_note_key_id: 'review-key',
      decision_note_key_version: 1,
    });
    expect(row.decision_note_ciphertext?.toString('utf8')).not.toContain('Private review decision');
    expect(
      await database
        .selectFrom('moderation.reports')
        .select(['status', 'version'])
        .where('id', '=', review.reportId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'dismissed', version: 2 });
    expect(
      await database
        .selectFrom('moderation.moderation_actions')
        .select(['action_type', 'source_report_id'])
        .where('command_id', '=', attempt.commandId)
        .execute(),
    ).toEqual([{ action_type: 'dismiss_report', source_report_id: review.reportId }]);
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .selectAll()
      .where('command_id', '=', attempt.commandId)
      .execute();
    const events = await database
      .selectFrom('platform.outbox_events')
      .selectAll()
      .where('causation_id', '=', attempt.commandId)
      .execute();
    expect(logs).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(JSON.stringify({ logs, events })).not.toContain('Private review decision');
    await expect(decisions.decide(attempt, 'dismissed', 'changed')).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(
      await decisions.decide(
        { ...attempt, commandId: randomUUID(), logId: randomUUID() },
        'dismissed',
      ),
    ).toMatchObject({ result: 'rejected', safeCode: 'version_conflict' });
  });
  it('rejects unassigned reviewers, unsupported actioned outcomes and invalid notes without mutations', async () => {
    const { review, attempt } = await assignedReview();
    const decisions = new PostgresReviewDecisionWorkflow(database, notes);
    const other = await createAdmin(database);
    expect(await decisions.decide({ ...attempt, adminUserId: other }, 'dismissed')).toMatchObject({
      result: 'rejected',
      safeCode: 'reviewer_unauthorized',
    });
    expect(
      await decisions.decide(
        {
          ...attempt,
          commandId: randomUUID(),
          logId: randomUUID(),
          requiredPermission: 'view_reports',
        },
        'actioned',
      ),
    ).toMatchObject({ result: 'rejected', safeCode: 'report_unavailable' });
    expect(
      await decisions.decide(
        { ...attempt, commandId: randomUUID(), logId: randomUUID() },
        'dismissed',
        'x'.repeat(2001),
      ),
    ).toMatchObject({ result: 'rejected', safeCode: 'admin_reason_invalid' });
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select(['status', 'version'])
        .where('id', '=', review.reviewId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'in_review', version: 2 });
  });
  it('rolls back partial decisions and records a single safe failure on retry', async () => {
    const { review, attempt } = await assignedReview();
    const store = new PostgresReviewDecisionStore();
    const failing = new ReviewDecisionWorkflow(
      new PostgresAdminCommandStore(database),
      {
        decide: async (context, write) => {
          await store.decide(context, write);
          throw new Error('Restricted provider diagnostics');
        },
      },
      notes,
      new SystemIdGenerator(),
    );
    expect(await failing.decide(attempt, 'dismissed')).toMatchObject({
      result: 'failed',
      safeCode: 'internal_error',
    });
    expect(await failing.decide(attempt, 'dismissed')).toMatchObject({
      result: 'failed',
      replayed: true,
    });
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('status')
        .where('id', '=', review.reportId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'pending_review' });
    expect(
      await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('command_id', '=', attempt.commandId)
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('causation_id', '=', attempt.commandId)
        .execute(),
    ).toEqual([]);
  });
  it('binds assignment confirmation to one reviewer and audits stale or unauthorized assignments', async () => {
    const adminId = await createAdmin(database),
      assignee = await createAdmin(database),
      other = await createAdmin(database),
      unauthorized = await createAdmin(database, false);
    const review = await createPendingReview(database, {
      priority: 'normal',
      createdAt: new Date(Date.now() - 10000),
    });
    const f = await confirmationFixture(database, adminId);
    const commands = new PostgresConfirmedReviewAssignments(database, f.tokens, f.key);
    const adminActionToken = await f.issue({
      commandCode: 'moderation.assign-review',
      requiredPermission: 'view_reports',
      targetType: 'moderation_review',
      targetId: review.reviewId,
      expectedTargetVersion: 1,
    });
    const command: AssignModerationReviewCommand = {
      actor: f.actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'moderation.assign-review',
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken,
        confirmationToken: '',
        expectedTargetVersion: 1,
        reason: 'Restricted assignment reason',
        assigneeAdminId: assignee,
      },
    };
    command.data.confirmationToken = await commands.prepare(command, f.actor);
    const changed = { ...command, data: { ...command.data, assigneeAdminId: other } };
    expect(await commands.execute(changed, f.actor)).toMatchObject({
      result: 'rejected',
      safeCode: 'invalid_request',
    });
    command.commandId = randomUUID();
    command.data.confirmationToken = await commands.prepare(command, f.actor);
    expect(await commands.execute(command, f.actor)).toMatchObject({
      result: 'succeeded',
      value: { assignedAdminId: assignee, reviewVersion: 2 },
    });
    expect(await commands.execute(command, f.actor)).toMatchObject({
      result: 'succeeded',
      replayed: true,
    });
    const stale = {
      ...command,
      commandId: randomUUID(),
      data: { ...command.data, assigneeAdminId: other },
    };
    stale.data.confirmationToken = await commands.prepare(stale, f.actor);
    expect(await commands.execute(stale, f.actor)).toMatchObject({
      result: 'rejected',
      safeCode: 'version_conflict',
    });
    const denied = {
      ...command,
      commandId: randomUUID(),
      data: {
        ...command.data,
        assigneeAdminId: unauthorized,
        expectedTargetVersion: 2,
        adminActionToken: await f.issue({
          commandCode: 'moderation.assign-review',
          requiredPermission: 'view_reports',
          targetType: 'moderation_review',
          targetId: review.reviewId,
          expectedTargetVersion: 2,
        }),
      },
    };
    denied.data.confirmationToken = await commands.prepare(denied, f.actor);
    expect(await commands.execute(denied, f.actor)).toMatchObject({
      result: 'rejected',
      safeCode: 'reviewer_unauthorized',
    });
    expect(
      await database
        .selectFrom('moderation.moderation_reviews')
        .select(['assigned_admin_id', 'version'])
        .where('id', '=', review.reviewId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ assigned_admin_id: assignee, version: 2 });
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .selectAll()
      .where('admin_user_id', '=', adminId)
      .execute();
    expect(logs).toHaveLength(4);
    expect(JSON.stringify(logs)).not.toContain('Restricted assignment reason');
  });

  it('claims priority-first batches exactly once and replays without another mutation', async () => {
    const adminUserId = await createAdmin(database);
    const base = Date.now() - 60_000;
    const normalOld = await createPendingReview(database, {
      priority: 'normal',
      createdAt: new Date(base),
    });
    const normalNew = await createPendingReview(database, {
      priority: 'normal',
      createdAt: new Date(base + 1_000),
    });
    const threshold = await createPendingReview(database, {
      priority: 'threshold',
      createdAt: new Date(base + 2_000),
    });
    const attempt = adminAttempt(adminUserId, {
      commandCode: 'moderation.claim-reviews',
      targetType: 'admin_user',
      targetId: adminUserId,
      expectedTargetVersion: null,
    });

    const first = await workflow.claim(attempt, { limit: 2 });
    expect(first).toMatchObject({ result: 'succeeded', safeCode: 'reviews_claimed' });
    expect(first.value?.map(({ reviewId }) => reviewId)).toEqual([
      threshold.reviewId,
      normalOld.reviewId,
    ]);
    await expect(workflow.claim(attempt, { limit: 2 })).resolves.toMatchObject({
      result: 'succeeded',
      replayed: true,
      value: undefined,
    });
    const remaining = await database
      .selectFrom('moderation.moderation_reviews')
      .select('id')
      .where('status', '=', 'pending')
      .where('id', 'in', [normalOld.reviewId, normalNew.reviewId, threshold.reviewId])
      .execute();
    expect(remaining).toEqual([{ id: normalNew.reviewId }]);
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .select(['result', 'safe_code'])
      .where('command_id', '=', attempt.commandId)
      .execute();
    expect(logs).toEqual([{ result: 'succeeded', safe_code: 'reviews_claimed' }]);
  });

  it('assigns and reassigns with optimistic versioning and rejects unauthorized assignees', async () => {
    const actorAdminId = await createAdmin(database);
    const firstAssigneeId = await createAdmin(database);
    const secondAssigneeId = await createAdmin(database);
    const unauthorizedAssigneeId = await createAdmin(database, false);
    const review = await createPendingReview(database, {
      priority: 'normal',
      createdAt: new Date(Date.now() - 30_000),
    });

    const firstAttempt = adminAttempt(actorAdminId, {
      commandCode: 'moderation.assign-review',
      targetType: 'moderation_review',
      targetId: review.reviewId,
      expectedTargetVersion: 1,
    });
    await expect(
      workflow.assign(firstAttempt, {
        reviewId: review.reviewId,
        assigneeAdminId: firstAssigneeId,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({
      result: 'succeeded',
      value: { assignedAdminId: firstAssigneeId, reviewVersion: 2 },
    });

    const staleAttempt = adminAttempt(actorAdminId, {
      commandCode: 'moderation.assign-review',
      targetType: 'moderation_review',
      targetId: review.reviewId,
      expectedTargetVersion: 1,
    });
    await expect(
      workflow.assign(staleAttempt, {
        reviewId: review.reviewId,
        assigneeAdminId: secondAssigneeId,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ result: 'rejected', safeCode: 'version_conflict' });

    const unauthorizedAttempt = adminAttempt(actorAdminId, {
      commandCode: 'moderation.assign-review',
      targetType: 'moderation_review',
      targetId: review.reviewId,
      expectedTargetVersion: 2,
    });
    await expect(
      workflow.assign(unauthorizedAttempt, {
        reviewId: review.reviewId,
        assigneeAdminId: unauthorizedAssigneeId,
        expectedVersion: 2,
      }),
    ).resolves.toMatchObject({ result: 'rejected', safeCode: 'reviewer_unauthorized' });

    const secondAttempt = adminAttempt(actorAdminId, {
      commandCode: 'moderation.assign-review',
      targetType: 'moderation_review',
      targetId: review.reviewId,
      expectedTargetVersion: 2,
    });
    await expect(
      workflow.assign(secondAttempt, {
        reviewId: review.reviewId,
        assigneeAdminId: secondAssigneeId,
        expectedVersion: 2,
      }),
    ).resolves.toMatchObject({
      result: 'succeeded',
      value: { assignedAdminId: secondAssigneeId, reviewVersion: 3 },
    });
  });

  it('rechecks current PostgreSQL permission and records a denied claim without touching the queue', async () => {
    const adminUserId = await createAdmin(database, false);
    const review = await createPendingReview(database, {
      priority: 'normal',
      createdAt: new Date(Date.now() - 15_000),
    });
    const attempt = adminAttempt(adminUserId, {
      commandCode: 'moderation.claim-reviews',
      targetType: 'admin_user',
      targetId: adminUserId,
      expectedTargetVersion: null,
    });
    await expect(workflow.claim(attempt, { limit: 1 })).resolves.toMatchObject({
      result: 'rejected',
      safeCode: 'forbidden',
      value: undefined,
    });
    await expect(
      database
        .selectFrom('moderation.moderation_reviews')
        .select(['status', 'version'])
        .where('id', '=', review.reviewId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'pending', version: 1 });
  });
});
