import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ModerationThresholdWrite } from '@nakh/application';
import type { PrepareAccountModerationActionCommand } from '@nakh/contracts';
import { PostgresConfirmedAccountActions } from './confirmed-account-store.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import { createReportFixtureAdmin } from './testing/report-fixture.js';
import { PostgresModerationIntegrityMetricsStore } from './moderation-integrity-metrics-store.js';
import { PostgresM7OperationalHealthStore } from './moderation-operational-health-store.js';

import { createDatabase, type NakhDatabase } from './database.js';
import {
  applyModerationThreshold,
  PostgresModerationThresholdStore,
} from './moderation-threshold-store.js';
import { runMigrations } from './migrations.js';
import {
  scanRestrictionEpisodes,
  scanModerationActions,
} from './moderation-review-reconciliation.js';
import { reconciliationCursorBefore } from './testing/reconciliation-cursor.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const genderOptionId = '20000000-0000-4000-8000-000000000001';
const genderPreferenceId = '20000000-0000-4000-8000-000000000013';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';

type SeededReport = Readonly<{
  id: string;
  reporterUserId: string;
  targetUserId: string;
  submittedAt: Date;
  status?: 'submitted' | 'pending_review' | 'dismissed' | 'actioned' | 'closed';
}>;

async function createUser(database: NakhDatabase, withAccount = false): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  if (withAccount)
    await database
      .insertInto('identity.accounts')
      .values({ user_id: id, state: 'active', state_reason: null, state_changed_at: now })
      .execute();
  if (withAccount)
    await database
      .insertInto('profile.profiles')
      .values({
        id: randomUUID(),
        user_id: id,
        name: 'Moderation fixture',
        birth_year: now.getUTCFullYear() - 30,
        gender_option_id: genderOptionId,
        gender_preference_id: genderPreferenceId,
        relationship_goal_id: relationshipGoalId,
        country_id: countryId,
        province_id: provinceId,
        city_id: cityId,
        highlight: 'Moderation fixture',
        bio: null,
        completion_status: 'complete',
        ever_completed: true,
        completed_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  return id;
}

async function insertFocusedReport(database: NakhDatabase, report: SeededReport): Promise<void> {
  const profile = await database
    .selectFrom('profile.profiles')
    .select('id')
    .where('user_id', '=', report.targetUserId)
    .executeTakeFirstOrThrow();
  await database
    .insertInto('interaction.likes')
    .values({
      id: randomUUID(),
      sender_user_id: report.targetUserId,
      receiver_user_id: report.reporterUserId,
      status: 'active',
      created_at: report.submittedAt,
      closed_at: null,
    })
    .onConflict((conflict) => conflict.columns(['sender_user_id', 'receiver_user_id']).doNothing())
    .execute();
  const reason = await database
    .selectFrom('moderation.report_reasons')
    .select('id')
    .where('code', '=', 'harassment')
    .executeTakeFirstOrThrow();
  const reviewedAt =
    report.status === 'dismissed' || report.status === 'actioned' || report.status === 'closed'
      ? report.submittedAt
      : null;
  await database
    .insertInto('moderation.reports')
    .values({
      id: report.id,
      reporter_user_id: report.reporterUserId,
      target_user_id: report.targetUserId,
      reason_id: reason.id,
      extra_text: null,
      status: report.status ?? 'submitted',
      priority: 'normal',
      command_id: randomUUID(),
      request_id: randomUUID(),
      idempotency_key: `report:${randomUUID()}`,
      request_digest: 'a'.repeat(64),
      submitted_at: report.submittedAt,
      reviewed_at: reviewedAt,
      closed_at: report.status === 'closed' ? report.submittedAt : null,
    })
    .execute();
  await database
    .insertInto('moderation.report_evidence')
    .values({
      id: randomUUID(),
      report_id: report.id,
      evidence_type: 'profile',
      profile_id: profile.id,
      profile_photo_id: null,
      chat_session_id: null,
      chat_message_id: null,
      unmatch_record_id: null,
    })
    .execute();
}

/** Preserves boundary timestamps while still creating restorable, constraint-valid evidence. */
async function seedFocusedReports(
  database: NakhDatabase,
  reports: readonly SeededReport[],
): Promise<void> {
  await database.connection().execute(async (connection) => {
    await sql`SET session_replication_role = replica`.execute(connection);
    try {
      for (const report of reports) await insertFocusedReport(connection, report);
    } finally {
      await sql`SET session_replication_role = origin`.execute(connection);
    }
  });
}

function thresholdWrite(sourceReportId: string): ModerationThresholdWrite {
  return {
    sourceReportId,
    requestId: randomUUID(),
    commandId: randomUUID(),
    restrictionEpisodeId: randomUUID(),
    reviewId: randomUUID(),
    actionId: randomUUID(),
    auditId: randomUUID(),
    accountHistoryId: randomUUID(),
    notificationId: randomUUID(),
    notificationDeliveryId: randomUUID(),
    notificationDeliveryEventId: randomUUID(),
    accountEventId: randomUUID(),
    thresholdEventId: randomUUID(),
    actionEventId: randomUUID(),
  };
}

async function insertAndEvaluate(
  database: NakhDatabase,
  report: SeededReport,
): ReturnType<typeof applyModerationThreshold> {
  return database.transaction().execute(async (transaction) => {
    await insertFocusedReport(transaction, report);
    return applyModerationThreshold(transaction, thresholdWrite(report.id));
  });
}

describe.skipIf(databaseUrl === undefined)('M7 threshold restriction persistence', () => {
  let database: NakhDatabase;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 30,
      statementTimeoutMs: 30_000,
      lockTimeoutMs: 25_000,
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  async function nativeEpisode(): Promise<{
    targetUserId: string;
    write: ModerationThresholdWrite;
  }> {
    const targetUserId = await createUser(database, true);
    const reporters = await Promise.all(Array.from({ length: 5 }, () => createUser(database)));
    const reports = reporters.map((reporterUserId) => ({
      id: randomUUID(),
      reporterUserId,
      targetUserId,
      submittedAt: new Date(),
    }));
    await seedFocusedReports(database, reports);
    const write = thresholdWrite(reports[4]!.id);
    expect((await new PostgresModerationThresholdStore(database).evaluate(write)).outcome).toBe(
      'create_restriction_episode',
    );
    return { targetUserId, write };
  }
  async function corrupt(work: (tx: NakhDatabase) => Promise<void>): Promise<void> {
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await work(tx);
    });
  }

  it('detects and clears each native threshold chain drift consistently across scans, health and aggregate sampling', async () => {
    const { write } = await nativeEpisode();
    const cursor = {
      phase: 'episodes' as const,
      lastId: reconciliationCursorBefore(write.restrictionEpisodeId),
    };
    const history = await database
      .selectFrom('identity.account_state_history')
      .selectAll()
      .where('id', '=', write.accountHistoryId)
      .executeTakeFirstOrThrow();
    const audit = await database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('id', '=', write.auditId)
      .executeTakeFirstOrThrow();
    const notice = await database
      .selectFrom('notification.notifications')
      .selectAll()
      .where('id', '=', write.notificationId)
      .executeTakeFirstOrThrow();
    const delivery = await database
      .selectFrom('notification.notification_deliveries')
      .selectAll()
      .where('id', '=', write.notificationDeliveryId)
      .executeTakeFirstOrThrow();
    const metrics = new PostgresModerationIntegrityMetricsStore(database),
      health = new PostgresM7OperationalHealthStore(database);
    const initialCount = (await metrics.measure()).counts.episodes,
      initialHealth = (await health.measure()).thresholdMismatchCount;
    const cases = [
      {
        anomaly: 'threshold_episode_history_missing',
        break: async (tx: NakhDatabase): Promise<void> => {
          await tx
            .updateTable('identity.account_state_history')
            .set({ reason_code: 'synthetic_drift' })
            .where('id', '=', history.id)
            .execute();
        },
        repair: async (tx: NakhDatabase): Promise<void> => {
          await tx
            .updateTable('identity.account_state_history')
            .set({ reason_code: history.reason_code })
            .where('id', '=', history.id)
            .execute();
        },
      },
      {
        anomaly: 'threshold_episode_audit_invalid',
        break: async (tx: NakhDatabase): Promise<void> => {
          await tx
            .updateTable('platform.audit_logs')
            .set({ metadata: { privateText: 'Private threshold fixture prose' } })
            .where('id', '=', audit.id)
            .execute();
        },
        repair: async (tx: NakhDatabase): Promise<void> => {
          await tx
            .updateTable('platform.audit_logs')
            .set({ metadata: audit.metadata })
            .where('id', '=', audit.id)
            .execute();
        },
      },
      {
        anomaly: 'threshold_episode_notice_invalid',
        break: async (tx: NakhDatabase): Promise<void> => {
          await tx
            .updateTable('notification.notifications')
            .set({ title_key: 'notification.synthetic.title' })
            .where('id', '=', notice.id)
            .execute();
        },
        repair: async (tx: NakhDatabase): Promise<void> => {
          await tx
            .updateTable('notification.notifications')
            .set({ title_key: notice.title_key })
            .where('id', '=', notice.id)
            .execute();
        },
      },
      {
        anomaly: 'threshold_episode_notice_invalid',
        break: async (tx: NakhDatabase): Promise<void> => {
          await tx
            .deleteFrom('notification.notification_deliveries')
            .where('id', '=', delivery.id)
            .execute();
        },
        repair: async (tx: NakhDatabase): Promise<void> => {
          await tx.insertInto('notification.notification_deliveries').values(delivery).execute();
        },
      },
    ];
    for (const probe of cases) {
      await corrupt(probe.break);
      try {
        const findings = (await scanRestrictionEpisodes(database, cursor, 1)).findings;
        expect(findings).toEqual([
          {
            anomalyType: probe.anomaly,
            entityType: 'restriction_episode',
            entityId: write.restrictionEpisodeId,
            keyId: write.restrictionEpisodeId,
            safeDetail: {},
          },
        ]);
        expect(JSON.stringify(findings)).not.toContain('Private threshold fixture prose');
        const samples = await Promise.all(Array.from({ length: 5 }, () => metrics.measure()));
        expect(samples.every((sample) => sample.counts.episodes === initialCount + 1)).toBe(true);
        expect((await health.measure()).thresholdMismatchCount).toBe(initialHealth + 1);
      } finally {
        await corrupt(probe.repair);
      }
      expect((await scanRestrictionEpisodes(database, cursor, 1)).findings).toEqual([]);
      expect((await metrics.measure()).counts.episodes).toBe(initialCount);
      expect((await health.measure()).thresholdMismatchCount).toBe(initialHealth);
    }
    // LOCAL test-only corruption must not weaken a pooled connection after commit.
    expect(
      (
        await sql<{ session_replication_role: string }>`SHOW session_replication_role`.execute(
          database,
        )
      ).rows[0]?.session_replication_role,
    ).toBe('origin');
  });

  it('preserves a resolved native episode through later Account actions and detects a missing successful resolution attempt', async () => {
    const { targetUserId, write } = await nativeEpisode(),
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
    const f = await confirmationFixture(database, adminId),
      actions = new PostgresConfirmedAccountActions(database, f.tokens, f.key);
    const apply = async (
      action: 'unrestrict_user' | 'ban_user',
      version: number,
    ): Promise<string> => {
      const command: PrepareAccountModerationActionCommand = {
        actor: f.actor,
        commandId: randomUUID(),
        requestId: randomUUID(),
        commandType: 'moderation.apply-account-action',
        schemaVersion: 1,
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          adminActionToken: await f.issue({
            commandCode: 'moderation.apply-account-action',
            requiredPermission: action,
            targetType: 'user',
            targetId: targetUserId,
            expectedTargetVersion: version,
          }),
          expectedTargetVersion: version,
          reason: 'Authorized historical threshold resolution',
          action,
        },
      };
      expect(
        (
          await actions.execute(
            {
              ...command,
              data: { ...command.data, confirmationToken: await actions.prepare(command, f.actor) },
            },
            f.actor,
          )
        ).result,
      ).toBe('succeeded');
      return command.commandId;
    };
    const resolutionCommandId = await apply('unrestrict_user', 2);
    await apply('ban_user', 3);
    const cursor = {
      phase: 'episodes' as const,
      lastId: reconciliationCursorBefore(write.restrictionEpisodeId),
    };
    expect(
      (
        await database
          .selectFrom('identity.accounts')
          .select('state')
          .where('user_id', '=', targetUserId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('banned');
    expect((await scanRestrictionEpisodes(database, cursor, 1)).findings).toEqual([]);
    await corrupt(async (tx) => {
      await tx
        .updateTable('administration.admin_action_logs')
        .set({ result: 'rejected', safe_code: 'forbidden' })
        .where('command_id', '=', resolutionCommandId)
        .execute();
    });
    try {
      expect((await scanRestrictionEpisodes(database, cursor, 1)).findings).toEqual([
        {
          anomalyType: 'threshold_episode_resolution_missing',
          entityType: 'restriction_episode',
          entityId: write.restrictionEpisodeId,
          keyId: write.restrictionEpisodeId,
          safeDetail: {},
        },
      ]);
    } finally {
      await corrupt(async (tx) => {
        await tx
          .updateTable('administration.admin_action_logs')
          .set({ result: 'succeeded', safe_code: 'account_unrestrict_user' })
          .where('command_id', '=', resolutionCommandId)
          .execute();
      });
    }
    expect((await scanRestrictionEpisodes(database, cursor, 1)).findings).toEqual([]);
  });

  it('counts later commits when the fifth report transaction began first', async () => {
    const targetUserId = await createUser(database, true);
    const reporters = await Promise.all(Array.from({ length: 5 }, () => createUser(database)));
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const begun = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    const finalReportId = randomUUID();
    const delayed = database.transaction().execute(async (transaction) => {
      await sql`SELECT transaction_timestamp()`.execute(transaction);
      started();
      await gate;
      await insertFocusedReport(transaction, {
        id: finalReportId,
        reporterUserId: reporters[4]!,
        targetUserId,
        submittedAt: new Date(),
      });
      return applyModerationThreshold(transaction, thresholdWrite(finalReportId));
    });
    await begun;
    try {
      for (const reporterUserId of reporters.slice(0, 4)) {
        await database.transaction().execute((transaction) =>
          insertFocusedReport(transaction, {
            id: randomUUID(),
            reporterUserId,
            targetUserId,
            submittedAt: new Date(),
          }),
        );
      }
    } finally {
      release();
    }
    await expect(delayed).resolves.toMatchObject({
      distinctReporterCount: 5,
      outcome: 'create_restriction_episode',
    });
    const reports = await database
      .selectFrom('moderation.reports')
      .select(['status', 'priority'])
      .where('target_user_id', '=', targetUserId)
      .execute();
    expect(reports).toHaveLength(5);
    expect(
      reports.every((row) => row.status === 'pending_review' && row.priority === 'threshold'),
    ).toBe(true);
    expect(
      await database
        .selectFrom('moderation.restriction_episodes')
        .select('id')
        .where('target_user_id', '=', targetUserId)
        .execute(),
    ).toHaveLength(1);
  });

  it('counts distinct unresolved reporters only inside the rolling 30-day window', async () => {
    const targetUserId = await createUser(database, true);
    const repeatedReporter = await createUser(database);
    const otherReporters = await Promise.all(Array.from({ length: 5 }, () => createUser(database)));
    const now = new Date();
    const reports: SeededReport[] = [
      ...Array.from({ length: 5 }, () => ({
        id: randomUUID(),
        reporterUserId: repeatedReporter,
        targetUserId,
        submittedAt: now,
      })),
      ...otherReporters.slice(0, 3).map((reporterUserId) => ({
        id: randomUUID(),
        reporterUserId,
        targetUserId,
        submittedAt: now,
      })),
      {
        id: randomUUID(),
        reporterUserId: otherReporters[3]!,
        targetUserId,
        submittedAt: now,
        status: 'dismissed',
      },
      {
        id: randomUUID(),
        reporterUserId: otherReporters[4]!,
        targetUserId,
        submittedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      },
    ];
    await seedFocusedReports(database, reports);

    const result = await new PostgresModerationThresholdStore(database).evaluate(
      thresholdWrite(reports[0]!.id),
    );
    expect(result).toMatchObject({
      distinctReporterCount: 4,
      outcome: 'below_threshold',
      accountVersion: 1,
    });
    expect(
      await database
        .selectFrom('moderation.restriction_episodes')
        .select('id')
        .where('target_user_id', '=', targetUserId)
        .execute(),
    ).toHaveLength(0);
  });

  it('serializes 20 candidate fifth reports into one complete restriction aggregate', async () => {
    const targetUserId = await createUser(database, true);
    const baselineReporters = await Promise.all(
      Array.from({ length: 4 }, () => createUser(database)),
    );
    const candidateReporters = await Promise.all(
      Array.from({ length: 20 }, () => createUser(database)),
    );
    const now = new Date();
    await seedFocusedReports(
      database,
      baselineReporters.map((reporterUserId) => ({
        id: randomUUID(),
        reporterUserId,
        targetUserId,
        submittedAt: now,
      })),
    );
    const candidates = candidateReporters.map((reporterUserId) => ({
      id: randomUUID(),
      reporterUserId,
      targetUserId,
      submittedAt: now,
    }));

    const results = await Promise.all(
      candidates.map((report) => insertAndEvaluate(database, report)),
    );
    expect(results.filter(({ outcome }) => outcome === 'create_restriction_episode')).toHaveLength(
      1,
    );
    expect(results.filter(({ outcome }) => outcome === 'episode_already_active')).toHaveLength(19);

    const account = await database
      .selectFrom('identity.accounts')
      .select(['state', 'state_reason', 'version'])
      .where('user_id', '=', targetUserId)
      .executeTakeFirstOrThrow();
    const reports = await database
      .selectFrom('moderation.reports')
      .select(['status', 'priority'])
      .where('target_user_id', '=', targetUserId)
      .execute();
    const episodes = await database
      .selectFrom('moderation.restriction_episodes')
      .selectAll()
      .where('target_user_id', '=', targetUserId)
      .execute();
    const actions = await database
      .selectFrom('moderation.moderation_actions')
      .selectAll()
      .where('target_user_id', '=', targetUserId)
      .execute();
    const histories = await database
      .selectFrom('identity.account_state_history')
      .selectAll()
      .where('user_id', '=', targetUserId)
      .where('reason_code', '=', 'distinct_reporter_threshold')
      .execute();
    const audits = await database
      .selectFrom('platform.audit_logs')
      .select(['id', 'metadata'])
      .where('subject_id', '=', targetUserId)
      .where('event_type', '=', 'moderation.threshold-restriction.v1')
      .execute();
    const notifications = await database
      .selectFrom('notification.notifications')
      .select(['id', 'payload'])
      .where('user_id', '=', targetUserId)
      .where('notification_type', '=', 'restriction_warning')
      .execute();
    const deliveries = await database
      .selectFrom('notification.notification_deliveries')
      .select('id')
      .where('notification_id', '=', notifications[0]!.id)
      .execute();
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('event_type')
      .where('aggregate_id', 'in', [
        targetUserId,
        episodes[0]!.id,
        actions[0]!.id,
        deliveries[0]!.id,
      ])
      .orderBy('event_type')
      .execute();

    expect(account).toEqual({
      state: 'restricted',
      state_reason: 'distinct_reporter_threshold',
      version: 2,
    });
    expect(reports).toHaveLength(24);
    expect(
      reports.every(
        ({ status, priority }) => status === 'pending_review' && priority === 'threshold',
      ),
    ).toBe(true);
    expect(episodes).toHaveLength(1);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action_type: 'restrict_user', actor_type: 'system' });
    expect(histories).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({
      reasonCode: 'distinct_reporter_threshold',
      distinctReporterCount: 5,
    });
    expect(notifications).toEqual([{ id: notifications[0]!.id, payload: {} }]);
    expect(deliveries).toHaveLength(1);
    expect(events.map(({ event_type }) => event_type)).toEqual([
      'identity.account-state-changed.v1',
      'moderation.action-recorded.v1',
      'moderation.threshold-reached.v1',
      'notification.delivery-requested.v1',
    ]);
    const episode = episodes[0]!,
      action = actions[0]!;
    const episodeCursor = {
      phase: 'episodes' as const,
      lastId: reconciliationCursorBefore(episode.id),
    };
    expect((await scanRestrictionEpisodes(database, episodeCursor, 1)).findings).toEqual([]);
    expect(
      (
        await scanModerationActions(
          database,
          { phase: 'actions', lastId: reconciliationCursorBefore(action.id) },
          1,
        )
      ).findings,
    ).toEqual([]);
    await database.connection().execute(async (connection) => {
      await sql`SET session_replication_role = replica`.execute(connection);
      try {
        await connection
          .deleteFrom('moderation.moderation_actions')
          .where('id', '=', action.id)
          .execute();
      } finally {
        await sql`SET session_replication_role = origin`.execute(connection);
      }
    });
    try {
      expect((await scanRestrictionEpisodes(database, episodeCursor, 1)).findings).toEqual([
        {
          anomalyType: 'threshold_episode_action_missing',
          entityType: 'restriction_episode',
          entityId: episode.id,
          keyId: episode.id,
          safeDetail: {},
        },
      ]);
    } finally {
      await database.insertInto('moderation.moderation_actions').values(action).execute();
    }
  });
});
