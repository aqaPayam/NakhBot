import { createHash } from 'node:crypto';
import { captureLaunchCohortCommand, type LaunchCohortCommand } from './launch-cohort-store.js';
import type { measureLaunchHealth } from './launch-health-store.js';

export const LAUNCH_REVIEW_COMMON_EVIDENCE = [
  'deployment',
  'error_budget',
  'capacity',
  'alert_delivery',
  'support_safety_review',
  'security_privacy_review',
  'staffing',
] as const;
export const LAUNCH_REVIEW_DRILL_EVIDENCE = [
  'canary_journeys',
  'moderation_drill',
  'payment_drill',
  'deletion_return_drill',
] as const;
export const LAUNCH_REVIEW_EVIDENCE = [
  ...LAUNCH_REVIEW_COMMON_EVIDENCE,
  ...LAUNCH_REVIEW_DRILL_EVIDENCE,
  'canary_plan',
] as const;
export type LaunchReviewEvidenceRole = (typeof LAUNCH_REVIEW_EVIDENCE)[number];
export type LaunchReviewRequest = Readonly<{
  operation: 'prepare-review';
  phase: 'canary' | 'cohort' | 'daily';
  intent: LaunchCohortCommand;
  evidence: readonly Readonly<{
    role: LaunchReviewEvidenceRole;
    sha256: string;
    observedAt: string;
    expiresAt: string;
  }>[];
}>;
function requiredEvidence(
  phase: LaunchReviewRequest['phase'],
): readonly LaunchReviewEvidenceRole[] {
  return [
    ...LAUNCH_REVIEW_COMMON_EVIDENCE,
    ...(phase === 'canary' ? (['canary_plan'] as const) : LAUNCH_REVIEW_DRILL_EVIDENCE),
  ];
}
function invalid(): never {
  throw new Error('Launch review unavailable.');
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    invalid();
}
function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalid();
  return value;
}
export function captureLaunchReviewRequest(value: unknown): LaunchReviewRequest {
  const c = object(structuredClone(value));
  exact(c, ['operation', 'phase', 'intent', 'evidence']);
  if (
    c.operation !== 'prepare-review' ||
    !['canary', 'cohort', 'daily'].includes(String(c.phase)) ||
    !Array.isArray(c.evidence) ||
    c.evidence.length > LAUNCH_REVIEW_EVIDENCE.length
  )
    invalid();
  const intent = captureLaunchCohortCommand(c.intent);
  intent.members.forEach(Object.freeze);
  Object.freeze(intent.members);
  Object.freeze(intent);
  const evidence = c.evidence
    .map((value: unknown) => {
      const entry = object(value);
      exact(entry, ['role', 'sha256', 'observedAt', 'expiresAt']);
      if (
        !LAUNCH_REVIEW_EVIDENCE.includes(entry.role as LaunchReviewEvidenceRole) ||
        typeof entry.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(entry.sha256)
      )
        invalid();
      const observedAt = timestamp(entry.observedAt),
        expiresAt = timestamp(entry.expiresAt);
      if (
        Date.parse(expiresAt) <= Date.parse(observedAt) ||
        Date.parse(expiresAt) - Date.parse(observedAt) > 86400000
      )
        invalid();
      return Object.freeze({
        role: entry.role as LaunchReviewEvidenceRole,
        sha256: entry.sha256,
        observedAt,
        expiresAt,
      });
    })
    .sort((a, b) => a.role.localeCompare(b.role));
  if (new Set(evidence.map((entry) => entry.role)).size !== evidence.length) invalid();
  return Object.freeze({
    operation: 'prepare-review',
    phase: c.phase as LaunchReviewRequest['phase'],
    intent,
    evidence: Object.freeze(evidence),
  });
}
/** Excluding only reviewDigest avoids a circular hash. The final approved native
 * command includes the resulting dossier digest and still requires its own approval. */
export function launchReviewIntentDigest(value: unknown): string {
  const command = captureLaunchCohortCommand(value);
  const body = Object.fromEntries(
    Object.entries(command).filter(([key]) => key !== 'reviewDigest'),
  );
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
export function prepareLaunchReview(
  health: Awaited<ReturnType<typeof measureLaunchHealth>>,
  value: unknown,
  operatorId: string,
): { reviewDigest: string; dossier: object } {
  const request = captureLaunchReviewRequest(value);
  const { sourceSha, environment, telegramBotId } = request.intent;
  if (
    health.audience.sourceSha !== sourceSha ||
    health.audience.environment !== environment ||
    health.audience.telegramBotId !== telegramBotId ||
    health.observationScope !== 'native_metadata' ||
    health.launchAuthorized !== false ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(operatorId)
  )
    invalid();
  const now = Date.parse(health.sampledAt),
    blockers = new Set<string>();
  if (!Number.isFinite(now)) invalid();
  const required = requiredEvidence(request.phase);
  for (const role of required) {
    const evidence = request.evidence.find((entry) => entry.role === role);
    if (!evidence) blockers.add('missing_' + role);
    else if (
      Date.parse(evidence.observedAt) > now ||
      Date.parse(evidence.expiresAt) <= now ||
      now - Date.parse(evidence.observedAt) > 86400000
    )
      blockers.add('stale_' + role);
  }
  for (const evidence of request.evidence)
    if (
      Date.parse(evidence.observedAt) > now ||
      Date.parse(evidence.expiresAt) <= now ||
      now - Date.parse(evidence.observedAt) > 86400000
    )
      blockers.add('stale_' + evidence.role);
  for (const time of [health.integrity.sampledAt, health.deletion.sampledAt]) {
    const age = now - Date.parse(time);
    // The native transaction's first timestamp precedes its later statements.
    if (!Number.isFinite(age) || age > 900000 || age < -60000)
      blockers.add('native_sample_freshness');
  }
  if (Object.values(health.integrity.counts).some((count) => count > 0))
    blockers.add('safety_integrity');
  if (Object.values(health.deletion.phases).some((phase) => phase.inconsistent > 0))
    blockers.add('deletion_integrity');
  if (
    Object.entries(health.deletion.phases).some(
      ([name, phase]) => name !== 'completed' && phase.oldestAgeSeconds >= 86400,
    )
  )
    blockers.add('deletion_age');
  if (
    health.safety.oldestPendingReportAgeSeconds >= 900 ||
    health.safety.oldestInReviewAgeSeconds >= 900
  )
    blockers.add('safety_backlog');
  if (
    health.safety.reconciliationNeverCompleted !== 0 ||
    health.safety.completedReconciliationAgeSeconds >= 3600 ||
    health.safety.activeReconciliationAgeSeconds >= 1800
  )
    blockers.add('safety_scan_freshness');
  for (const run of health.reconciliation) {
    if (
      run.status !== 'succeeded' ||
      run.finishedAt === null ||
      now - Date.parse(run.finishedAt) >= 3600000 ||
      Date.parse(run.finishedAt) > now
    )
      blockers.add('reconciliation_' + run.kind);
  }
  if (
    request.intent.mode !== 'cohort' ||
    request.intent.expiresAt === null ||
    Date.parse(request.intent.expiresAt) <= now ||
    Date.parse(request.intent.expiresAt) - now > 86400000
  )
    blockers.add('intent_expiry');
  const dossier = {
    schemaVersion: 1,
    observationScope: 'operator_review_dossier',
    audience: { sourceSha, environment, telegramBotId },
    operatorId: operatorId.toLowerCase(),
    phase: request.phase,
    sampledAt: health.sampledAt,
    expiresAt: new Date(
      Math.min(
        now + 900000,
        ...request.evidence.map((evidence) => Date.parse(evidence.expiresAt)),
        ...(request.intent.expiresAt === null ? [] : [Date.parse(request.intent.expiresAt)]),
      ),
    ).toISOString(),
    intentDigest: launchReviewIntentDigest(request.intent),
    nativeHealth: health,
    evidence: request.evidence,
    evidenceVerification: 'operator_supplied_bytes',
    requiresHumanApproval: true,
    launchAuthorized: false,
    historicalFindingsRequireDispositionReview: health.reconciliation.some(
      (run) => (run.historicalFindings ?? 0) > 0,
    ),
    blockers: [...blockers].sort(),
  };
  return {
    reviewDigest: createHash('sha256').update(JSON.stringify(dossier)).digest('hex'),
    dossier,
  };
}

/** Offline reference verification only. A matching dossier is not authentic
 * provider evidence, operator approval, live health or launch authorization. */
export function verifyLaunchReviewReference(
  value: unknown,
  command: unknown,
  now: Date,
): { reviewReferenceVerified: true; launchAuthorized: false; requiresHumanApproval: true } {
  const input = object(value);
  exact(input, ['reviewDigest', 'dossier']);
  const dossier = object(input.dossier),
    native = captureLaunchCohortCommand(command);
  exact(dossier, [
    'schemaVersion',
    'observationScope',
    'audience',
    'operatorId',
    'phase',
    'sampledAt',
    'expiresAt',
    'intentDigest',
    'nativeHealth',
    'evidence',
    'evidenceVerification',
    'requiresHumanApproval',
    'launchAuthorized',
    'historicalFindingsRequireDispositionReview',
    'blockers',
  ]);
  const scope = object(dossier.audience),
    observed = object(dossier.nativeHealth),
    observedScope = object(observed.audience);
  if (
    observed.schemaVersion !== 1 ||
    observed.observationScope !== 'native_metadata' ||
    observed.launchAuthorized !== false ||
    observed.sampledAt !== dossier.sampledAt
  )
    invalid();
  for (const key of ['sourceSha', 'environment', 'telegramBotId'] as const)
    if (scope[key] !== native[key] || observedScope[key] !== native[key]) invalid();
  const at = now.getTime(),
    expiry = Date.parse(String(dossier.expiresAt)),
    sampledAt = Date.parse(String(dossier.sampledAt));
  timestamp(dossier.sampledAt);
  timestamp(dossier.expiresAt);
  const captured = captureLaunchReviewRequest({
    operation: 'prepare-review',
    phase: dossier.phase,
    intent: native,
    evidence: dossier.evidence,
  });
  if (
    requiredEvidence(captured.phase).some(
      (role) => !captured.evidence.some((entry) => entry.role === role),
    ) ||
    captured.evidence.some(
      (entry) =>
        Date.parse(entry.observedAt) > at ||
        Date.parse(entry.expiresAt) <= at ||
        at - Date.parse(entry.observedAt) > 86400000 ||
        expiry > Date.parse(entry.expiresAt),
    ) ||
    native.mode !== 'cohort' ||
    native.expiresAt === null ||
    Date.parse(native.expiresAt) <= at ||
    expiry > Date.parse(native.expiresAt)
  )
    invalid();
  if (
    typeof input.reviewDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input.reviewDigest) ||
    input.reviewDigest !== createHash('sha256').update(JSON.stringify(dossier)).digest('hex') ||
    native.reviewDigest !== input.reviewDigest ||
    dossier.intentDigest !== launchReviewIntentDigest(native) ||
    dossier.schemaVersion !== 1 ||
    dossier.observationScope !== 'operator_review_dossier' ||
    dossier.evidenceVerification !== 'operator_supplied_bytes' ||
    dossier.requiresHumanApproval !== true ||
    dossier.launchAuthorized !== false ||
    !Array.isArray(dossier.blockers) ||
    dossier.blockers.length !== 0 ||
    !Number.isFinite(at) ||
    !Number.isFinite(expiry) ||
    !Number.isFinite(sampledAt) ||
    sampledAt > at ||
    expiry <= at ||
    at - sampledAt > 900000 ||
    expiry - sampledAt > 900000
  )
    invalid();
  return { reviewReferenceVerified: true, launchAuthorized: false, requiresHumanApproval: true };
}
