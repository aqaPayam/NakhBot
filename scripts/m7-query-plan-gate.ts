import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MODERATION_RECONCILIATION_PHASES } from '@nakh/application';
import { createDatabase, runMigrations, measureM7SyntheticPlans } from '@nakh/persistence-postgres';
import { summarizeM7Plan, m7PlanPasses, type M7PlanSummary } from './m7-plan-evidence.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
if (url === undefined) throw new Error('NAKH_TEST_DATABASE_URL is required for M7 plan evidence.');
const volume = Number(process.env.NAKH_M7_PLAN_VOLUME ?? '20000');
if (!Number.isSafeInteger(volume) || volume < 1000 || volume > 20000)
  throw new Error('M7 plan volume must be between 1000 and 20000.');
await runMigrations(url, resolve(process.cwd(), 'migrations'));
const database = createDatabase({
  url,
  poolMax: 5,
  statementTimeoutMs: 60000,
  lockTimeoutMs: 10000,
});
let summaries: Record<string, M7PlanSummary> | undefined;
try {
  const { plans, terminalAppeals, retainedPhotos, unrestrictions } = await measureM7SyntheticPlans(
    database,
    volume,
  );
  summaries = Object.fromEntries(
    Object.entries(plans).map(([name, plan]) => [name, summarizeM7Plan(plan)]),
  );
  const requiredIndexes: Readonly<Record<string, readonly string[] | undefined>> = {
    supportQueue: ['support_threads_status_created_idx'],
    appealQueue: ['user_appeals_queue_idx', 'user_appeals_status_submitted_idx'],
    supportUnanswered: undefined,
    reportAdmission: ['reports_reporter_window_idx'],
    reportThreshold: ['reports_target_threshold_idx'],
    pendingAge: ['reports_pending_age_idx'],
    inReviewAge: ['moderation_reviews_in_review_age_idx'],
    completedScan: ['reconciliation_runs_moderation_completed_idx'],
    ...Object.fromEntries(
      MODERATION_RECONCILIATION_PHASES.map((phase) => [`integrity_${phase}`, undefined]),
    ),
    integritySnapshot: undefined,
    operationalHealth: undefined,
    terminalAcceptedQueue: ['user_appeals_status_submitted_idx'],
    terminalRejectedQueue: ['user_appeals_status_submitted_idx'],
    terminalIntegrityAppeals: undefined,
    terminalIntegrityActions: undefined,
    terminalIntegrityAdminLogs: undefined,
    terminalIntegritySnapshot: ['moderation_actions_episode_resolution_idx'],
    terminalOperationalHealth: ['moderation_actions_episode_resolution_idx'],
  };
  await mkdir(resolve(process.cwd(), 'artifacts'), { recursive: true });
  await writeFile(
    resolve(process.cwd(), 'artifacts/m7-query-plans.json'),
    JSON.stringify(
      {
        schemaVersion: 11,
        fixtureScale: volume,
        fixtureTables: 27,
        thresholdChains: {
          systemRestrictions: volume,
          validResolutions: unrestrictions.bound,
          invalidResolutions: unrestrictions.digestDrift,
          admissionWitnesses: volume * 5,
        },
        integrityPhases: MODERATION_RECONCILIATION_PHASES,
        minimumRowsPerIntegrityPhase: volume,
        repeatedSnapshotSamples: 3,
        terminalAppeals,
        retainedPhotos,
        unrestrictions,
        repeatedUnrestrictionSnapshotSamples: 3,
        repeatedRetainedPhotoSnapshotSamples: 3,
        repeatedTerminalSnapshotSamples: 3,
        repeatedTerminalOperationalHealthSamples: 3,
        fixtureScope:
          'metadata-capture-drift-retained-photo-custody-threshold-chains-separate-unrestrictions-digest-drift-account-restrictions-submitted-reviewed-appeals-separate-unbans-mixed-unlocks',
        remainingVolumeBranches: ['encrypted-capture'],
        maximumExecutionMs: 1500,
        requiredIndexes,
        plans: summaries,
      },
      null,
      2,
    ) + '\n',
  );
  for (const [name, index] of Object.entries(requiredIndexes)) {
    const plan = summaries?.[name];
    if (!m7PlanPasses(plan, index))
      throw new Error(`M7 query-plan budget or index failed: ${name}.`);
  }
  process.stdout.write(
    JSON.stringify({
      scenario: 'M7-PRODUCTION-QUERY-PLAN',
      volume,
      queries: Object.keys(requiredIndexes),
    }) + '\n',
  );
} catch {
  throw new Error(
    'M7 query-plan gate failed; inspect the aggregate artifact and isolated database diagnostics.',
  );
} finally {
  await database.destroy();
}
