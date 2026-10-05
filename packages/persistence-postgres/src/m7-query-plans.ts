import { randomUUID } from 'node:crypto';
import { withM6SyntheticPlanSession } from './m6-query-plans.js';
import { sql, type RawBuilder } from 'kysely';
import type { NakhDatabase } from './database.js';
import { supportMetadataStatement, appealMetadataStatement } from './m7-queue-statements.js';
import { supportUnansweredStatement } from './support-store.js';
import { MODERATION_RECONCILIATION_PHASES } from '@nakh/application';
import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';
import {
  moderationIntegrityPhaseStatement,
  moderationIntegrityStatement,
  PostgresModerationIntegrityMetricsStore,
  withModerationIntegrityRead,
} from './moderation-integrity-metrics-store.js';
import { seedM7IntegrityPlans } from './m7-integrity-plan-fixture.js';
import {
  seedM7AppealIntegrityPlans,
  type M7TerminalAppealFixture,
} from './m7-appeal-integrity-plan-fixture.js';
export async function explainM7Queries(
  database: NakhDatabase,
  input: Readonly<{
    userId: string;
    targetId: string;
    at: string;
    afterAt: string;
    afterId: string;
  }>,
): Promise<Readonly<Record<string, unknown>>> {
  const statements: Readonly<Record<string, RawBuilder<unknown>>> = {
    supportQueue: supportMetadataStatement('open', 50, { at: input.afterAt, id: input.afterId }),
    appealQueue: appealMetadataStatement('submitted', 50, { at: input.afterAt, id: input.afterId }),
    supportUnanswered: supportUnansweredStatement(input.userId),
    reportAdmission: sql`SELECT count(*) FROM moderation.reports WHERE reporter_user_id = ${input.userId}::uuid
      AND submitted_at > ${input.at}::timestamptz - interval '24 hours'`,
    reportThreshold: sql`SELECT count(DISTINCT reporter_user_id) FROM moderation.reports
      WHERE target_user_id = ${input.targetId}::uuid AND status IN ('submitted','pending_review')
      AND submitted_at > ${input.at}::timestamptz - interval '30 days' AND submitted_at <= ${input.at}::timestamptz`,
    pendingAge: sql`SELECT submitted_at FROM moderation.reports WHERE status IN ('submitted','pending_review') ORDER BY submitted_at,id LIMIT 1`,
    inReviewAge: sql`SELECT updated_at FROM moderation.moderation_reviews WHERE status = 'in_review' ORDER BY updated_at,id LIMIT 1`,
    completedScan: sql`SELECT finished_at FROM billing.reconciliation_runs WHERE run_type = 'moderation' AND status = 'succeeded' ORDER BY finished_at DESC,id DESC LIMIT 1`,
    ...Object.fromEntries(
      MODERATION_RECONCILIATION_PHASES.map((phase) => [
        `integrity_${phase}`,
        moderationIntegrityPhaseStatement(phase),
      ]),
    ),
    integritySnapshot: moderationIntegrityStatement(),
  };
  const plans: Record<string, unknown> = {};
  for (const [name, statement] of Object.entries(statements)) {
    const explain = (
      connection: NakhDatabase,
    ): Promise<{ rows: readonly { 'QUERY PLAN': unknown }[] }> =>
      sql<{
        'QUERY PLAN': unknown;
      }>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`.execute(connection);
    const result = name.startsWith('integrity')
      ? await withModerationIntegrityRead(database, explain)
      : await explain(database);
    plans[name] = result.rows[0]?.['QUERY PLAN'];
  }
  return plans;
}
export async function analyzeM7QueryTables(database: NakhDatabase): Promise<void> {
  await sql`ANALYZE moderation.reports, moderation.moderation_reviews, moderation.user_appeals,
    support.support_threads, support.support_messages, billing.reconciliation_runs,
    moderation.report_evidence, moderation.report_snapshots, moderation.moderation_actions,
    moderation.restriction_episodes, moderation.appeal_unbans, administration.admin_users,
    administration.admin_action_logs, administration.safety_access_audits,
    moderation.evidence_access_audits, identity.telegram_identities, identity.account_state_history,
    platform.audit_logs, notification.notifications, interaction.user_pair_states,
    matching.matches, chat.chat_sessions, interaction.likes, interaction.feature_unlocks,
    media.report_photo_evidence_holds, media.photo_variants, media.media_assets,
    media.profile_photos, profile.profiles, chat.chat_message_snapshots`.execute(database);
}

async function explainTerminalAppealQueries(
  database: NakhDatabase,
  afterAt: string,
  afterId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const statements: Readonly<Record<string, RawBuilder<unknown>>> = {
    terminalAcceptedQueue: appealMetadataStatement('accepted', 50, { at: afterAt, id: afterId }),
    terminalRejectedQueue: appealMetadataStatement('rejected', 50, { at: afterAt, id: afterId }),
    terminalIntegrityAppeals: moderationIntegrityPhaseStatement('appeals'),
    terminalIntegrityActions: moderationIntegrityPhaseStatement('actions'),
    terminalIntegrityAdminLogs: moderationIntegrityPhaseStatement('admin_logs'),
    terminalIntegritySnapshot: moderationIntegrityStatement(),
  };
  const plans: Record<string, unknown> = {};
  for (const [name, statement] of Object.entries(statements)) {
    const result = await withModerationIntegrityRead(database, (connection) =>
      sql<{ 'QUERY PLAN': unknown }>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`.execute(
        connection,
      ),
    );
    plans[name] = result.rows[0]?.['QUERY PLAN'];
  }
  return plans;
}

async function seed(
  database: NakhDatabase,
  prefix: string,
  volume: number,
  at: Date,
  old: Date,
): Promise<void> {
  // Isolated synthetic metadata only; rollback removes every fixture, including incomplete evidence.
  await sql`INSERT INTO support.support_threads (id,user_id,status,open_command_id,open_idempotency_key,open_request_digest,last_message_at,created_at,closed_at)
    SELECT md5(${prefix} || 'thread' || n)::uuid, md5(${prefix} || 'user' || (n % 257))::uuid,
      CASE WHEN n % 3 = 0 THEN 'open' ELSE 'closed' END,md5(${prefix} || 'open' || n)::uuid,
      md5(${prefix} || 'open-key' || n),repeat('a',64),${old}::timestamptz + n * interval '1 millisecond',
      ${old}::timestamptz + n * interval '1 millisecond',CASE WHEN n % 3 = 0 THEN NULL ELSE ${at}::timestamptz END
    FROM generate_series(1,${volume}) AS n`.execute(database);
  await sql`INSERT INTO support.support_messages (id,support_thread_id,sender_type,sender_user_id,sender_admin_id,message_text,command_id,request_id,request_digest,idempotency_key,thread_version_after,unanswered_user_messages_after,created_at)
    SELECT md5(${prefix} || 'message' || n)::uuid,md5(${prefix} || 'thread' || n)::uuid,
      CASE WHEN n % 2 = 0 THEN 'user' ELSE 'admin' END,
      CASE WHEN n % 2 = 0 THEN md5(${prefix} || 'user' || (n % 257))::uuid ELSE NULL END,
      CASE WHEN n % 2 = 1 THEN md5(${prefix} || 'admin')::uuid ELSE NULL END,'Synthetic private support fixture',
      md5(${prefix} || 'message-command' || n)::uuid,md5(${prefix} || 'request' || n)::uuid,repeat('b',64),
      md5(${prefix} || 'message-key' || n),1,1,${old}::timestamptz + n * interval '1 millisecond'
    FROM generate_series(1,${volume}) AS n`.execute(database);
  await sql`INSERT INTO moderation.user_appeals (id,user_id,ban_state_history_id,message_text,status,submitted_at,reviewed_by_admin_id,admin_note,reviewed_at)
    SELECT md5(${prefix} || 'appeal' || n)::uuid,md5(${prefix} || 'user' || (n % 257))::uuid,
      md5(${prefix} || 'ban' || n)::uuid,'Synthetic private appeal fixture','submitted',${old}::timestamptz+n*interval '1 millisecond',NULL,NULL,NULL
    FROM generate_series(1,${volume}) AS n`.execute(database);
  await sql`INSERT INTO moderation.reports (id,reporter_user_id,target_user_id,reason_id,extra_text,status,command_id,request_id,idempotency_key,request_digest,submitted_at,reviewed_at)
    SELECT md5(${prefix} || 'report' || n)::uuid,md5(${prefix} || 'user' || (n % 257))::uuid,
      md5(${prefix} || 'target' || (n % 64))::uuid,md5(${prefix} || 'reason')::uuid,NULL,
      CASE WHEN n % 2 = 0 THEN 'pending_review' ELSE 'actioned' END,
      md5(${prefix} || 'report-command' || n)::uuid,md5(${prefix} || 'report-request' || n)::uuid,
      md5(${prefix} || 'report-key' || n),repeat('c',64),${old}::timestamptz+n*interval '1 millisecond',
      CASE WHEN n % 2 = 0 THEN NULL ELSE ${at}::timestamptz END
    FROM generate_series(1,${volume}) AS n`.execute(database);
  await sql`INSERT INTO moderation.moderation_reviews (id,report_id,status,assigned_admin_id,assigned_at,decided_at,created_at,updated_at)
    SELECT md5(${prefix} || 'review' || n)::uuid,md5(${prefix} || 'report' || n)::uuid,'in_review',
      md5(${prefix} || 'admin')::uuid,${old}::timestamptz,NULL,${old}::timestamptz,${old}::timestamptz+n*interval '1 millisecond'
    FROM generate_series(1,${volume}) AS n`.execute(database);
  await sql`INSERT INTO billing.reconciliation_runs (id,run_type,status,cursor,started_at,finished_at)
    SELECT md5(${prefix} || 'run' || n)::uuid,'moderation','succeeded','{}'::jsonb,
      ${old}::timestamptz,${old}::timestamptz+n*interval '1 millisecond' FROM generate_series(1,${volume}) AS n`.execute(
    database,
  );
}

export async function measureM7SyntheticPlans(
  database: NakhDatabase,
  volume: number,
): Promise<
  Readonly<{ plans: Readonly<Record<string, unknown>>; terminalAppeals: M7TerminalAppealFixture }>
> {
  if (!Number.isSafeInteger(volume) || volume < 1000 || volume > 20000)
    throw new Error('M7 plan volume invalid.');
  const prefix = randomUUID(),
    at = new Date(),
    old = new Date(at.getTime() - 60 * 60_000);
  let plans: Readonly<Record<string, unknown>> | undefined;
  let terminalAppeals: M7TerminalAppealFixture | undefined;
  await withM6SyntheticPlanSession(database, async (connection) => {
    try {
      await connection.transaction().execute(async (tx) => {
        await seed(tx, prefix, volume, at, old);
        await seedM7IntegrityPlans(tx, prefix, volume, at);
        await analyzeM7QueryTables(tx);
        // Reject empty-phase evidence. Count metadata in PostgreSQL; identities never enter artifacts.
        for (const phase of MODERATION_RECONCILIATION_PHASES) {
          const row = (
            await sql<{ count: string }>`SELECT count(*)::text AS count
            FROM (${MODERATION_INTEGRITY_SOURCES[phase]}) source`.execute(tx)
          ).rows[0]!;
          if (Number(row.count) < volume) throw new Error('M7 integrity fixture incomplete.');
        }
        const ids = (
          await sql<{
            userId: string;
            targetId: string;
            afterId: string;
          }>`SELECT md5(${prefix} || 'user0')::uuid AS "userId",
          md5(${prefix} || 'target0')::uuid AS "targetId",md5(${prefix} || 'thread1')::uuid AS "afterId"`.execute(
            tx,
          )
        ).rows[0]!;
        plans = await explainM7Queries(tx, {
          ...ids,
          at: at.toISOString(),
          afterAt: old.toISOString(),
        });
        // Actual production sampler under repeated fixture load, never synthetic SQL substitutes.
        for (let sample = 0; sample < 3; sample++) {
          const current = await new PostgresModerationIntegrityMetricsStore(tx).measure();
          if (
            current.counts.evidence < volume ||
            current.counts.episodes < volume ||
            current.counts.internal_blocks < Math.floor(volume / 2)
          )
            throw new Error('M7 integrity drift fixture incomplete.');
        }
        const baseline = await new PostgresModerationIntegrityMetricsStore(tx).measure();
        terminalAppeals = await seedM7AppealIntegrityPlans(tx, prefix, volume, at);
        await analyzeM7QueryTables(tx);
        plans = {
          ...plans,
          ...(await explainTerminalAppealQueries(tx, old.toISOString(), ids.afterId)),
        };
        for (let sample = 0; sample < 3; sample++) {
          const current = await new PostgresModerationIntegrityMetricsStore(tx).measure();
          for (const phase of MODERATION_RECONCILIATION_PHASES)
            if (current.counts[phase] !== baseline.counts[phase])
              throw new Error('M7 reviewed appeal/unban integrity mismatch.');
        }
        throw new SyntheticPlanRollback();
      });
    } catch (error) {
      if (!(error instanceof SyntheticPlanRollback)) throw error;
    }
  });
  await analyzeM7QueryTables(database);
  if (plans === undefined || terminalAppeals === undefined)
    throw new Error('M7 plan measurement unavailable.');
  return { plans, terminalAppeals };
}
class SyntheticPlanRollback extends Error {}
