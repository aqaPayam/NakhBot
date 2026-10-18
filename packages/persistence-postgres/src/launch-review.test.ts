import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MODERATION_RECONCILIATION_PHASES } from '@nakh/application';
import { ACCOUNT_DELETION_PHASES } from '@nakh/domain';
import { describe, expect, it } from 'vitest';
import {
  captureLaunchReviewRequest,
  launchReviewIntentDigest,
  verifyLaunchReviewReference,
  prepareLaunchReview,
  LAUNCH_REVIEW_COMMON_EVIDENCE,
  LAUNCH_REVIEW_DRILL_EVIDENCE,
} from './launch-review.js';
import { loadLaunchReviewFiles } from './launch-review-files.js';
import { launchOperatorCommandDigest } from './launch-operator-host.js';
import type { measureLaunchHealth } from './launch-health-store.js';

const now = '2030-01-01T00:00:00.000Z',
  operatorId = randomUUID();
const audience = {
  sourceSha: 'a'.repeat(40),
  environment: 'staging' as const,
  telegramBotId: '123456789',
};
const intent = {
  ...audience,
  requestId: randomUUID(),
  expectedVersion: 0,
  mode: 'cohort' as const,
  expiresAt: '2030-01-01T01:00:00.000Z',
  reviewDigest: '0'.repeat(64),
  members: [{ userId: randomUUID(), productEpoch: 0 }],
};
function health(): Awaited<ReturnType<typeof measureLaunchHealth>> {
  return {
    schemaVersion: 1,
    audience,
    observationScope: 'native_metadata',
    launchAuthorized: false,
    sampledAt: now,
    integrity: {
      sampledAt: now,
      counts: Object.fromEntries(MODERATION_RECONCILIATION_PHASES.map((p) => [p, 0])) as Awaited<
        ReturnType<typeof measureLaunchHealth>
      >['integrity']['counts'],
    },
    safety: {
      oldestPendingReportAgeSeconds: 0,
      oldestInReviewAgeSeconds: 0,
      activeReconciliationAgeSeconds: 0,
      completedReconciliationAgeSeconds: 60,
      reconciliationNeverCompleted: 0,
    },
    deletion: {
      sampledAt: now,
      phases: Object.fromEntries(
        ACCOUNT_DELETION_PHASES.map((p) => [
          p,
          {
            records: 0,
            leased: 0,
            retrying: 0,
            inconsistent: 0,
            oldestAgeSeconds: 0,
            dueAgeSeconds: 0,
          },
        ]),
      ) as Awaited<ReturnType<typeof measureLaunchHealth>>['deletion']['phases'],
    },
    reconciliation: (['billing', 'nakh', 'chat', 'moderation'] as const).map((kind) => ({
      kind,
      status: 'succeeded',
      startedAt: '2029-12-31T23:58:00.000Z',
      finishedAt: '2029-12-31T23:59:00.000Z',
      historicalFindings: 0,
    })),
  };
}
function request(): ReturnType<typeof captureLaunchReviewRequest> {
  return captureLaunchReviewRequest({
    operation: 'prepare-review',
    phase: 'cohort',
    intent,
    evidence: [...LAUNCH_REVIEW_COMMON_EVIDENCE, ...LAUNCH_REVIEW_DRILL_EVIDENCE].map((role) => ({
      role,
      sha256: 'b'.repeat(64),
      observedAt: '2029-12-31T23:59:00.000Z',
      expiresAt: '2030-01-01T01:00:00.000Z',
    })),
  });
}
function dossier(value: ReturnType<typeof prepareLaunchReview>): Record<string, unknown> {
  return value.dossier as Record<string, unknown>;
}
describe('source-bound private launch review dossier', () => {
  it('binds observed bytes, audience, operator and exact intent without claiming approval or provider authenticity', () => {
    const result = prepareLaunchReview(health(), request(), operatorId);
    expect(result.reviewDigest).toBe(
      createHash('sha256').update(JSON.stringify(result.dossier)).digest('hex'),
    );
    expect(dossier(result)).toMatchObject({
      audience,
      operatorId,
      blockers: [],
      launchAuthorized: false,
      requiresHumanApproval: true,
      evidenceVerification: 'operator_supplied_bytes',
      expiresAt: '2030-01-01T00:15:00.000Z',
    });
    expect(
      prepareLaunchReview(
        health(),
        { ...request(), evidence: [...request().evidence].reverse() },
        operatorId,
      ),
    ).toEqual(result);
    const final = { ...intent, reviewDigest: result.reviewDigest };
    expect(launchReviewIntentDigest(final)).toBe(dossier(result).intentDigest);
    expect(launchOperatorCommandDigest({ operation: 'apply', input: final })).not.toBe(
      launchOperatorCommandDigest({ operation: 'apply', input: intent }),
    );
    expect(launchReviewIntentDigest({ ...final, expectedVersion: 1 })).not.toBe(
      dossier(result).intentDigest,
    );
  });
  it('verifies only a fresh exact reference and rejects changed commands, content, blockers and stale packets', () => {
    const report = prepareLaunchReview(health(), request(), operatorId);
    const command = { ...intent, reviewDigest: report.reviewDigest };
    expect(verifyLaunchReviewReference(report, command, new Date(now))).toEqual({
      reviewReferenceVerified: true,
      launchAuthorized: false,
      requiresHumanApproval: true,
    });
    for (const changed of [
      { ...command, expectedVersion: 1 },
      { ...command, members: [{ ...intent.members[0], productEpoch: 1 }] },
      { ...command, reviewDigest: 'f'.repeat(64) },
    ])
      expect(() => verifyLaunchReviewReference(report, changed, new Date(now))).toThrow();
    expect(() =>
      verifyLaunchReviewReference(
        { ...report, dossier: { ...report.dossier, operatorId: randomUUID() } },
        command,
        new Date(now),
      ),
    ).toThrow();
    for (const time of ['2029-12-31T23:59:59.000Z', '2030-01-01T00:15:00.000Z'])
      expect(() => verifyLaunchReviewReference(report, command, new Date(time))).toThrow();
    const incomplete = { ...dossier(report), evidence: [] };
    const incompleteDigest = createHash('sha256').update(JSON.stringify(incomplete)).digest('hex');
    expect(() =>
      verifyLaunchReviewReference(
        { reviewDigest: incompleteDigest, dossier: incomplete },
        { ...command, reviewDigest: incompleteDigest },
        new Date(now),
      ),
    ).toThrow();
    const held = prepareLaunchReview(health(), { ...request(), evidence: [] }, operatorId);
    expect(() =>
      verifyLaunchReviewReference(
        held,
        { ...command, reviewDigest: held.reviewDigest },
        new Date(now),
      ),
    ).toThrow();
  });
  it('captures immutable complete metadata before waits and rejects duplicate or authority-bearing evidence', () => {
    const input = JSON.parse(JSON.stringify(request())) as ReturnType<typeof request>;
    const captured = captureLaunchReviewRequest(input);
    expect(Object.isFrozen(captured.intent.members[0])).toBe(true);
    expect(Object.isFrozen(captured.evidence[0])).toBe(true);
    for (const value of [
      { ...input, operatorId },
      { ...input, phase: 'automatic_approval' },
      { ...input, evidence: [input.evidence[0], input.evidence[0]] },
      { ...input, evidence: [{ ...input.evidence[0], sha256: 'invalid' }] },
      { ...input, evidence: [{ ...input.evidence[0], expiresAt: input.evidence[0]!.observedAt }] },
      { ...input, evidence: [{ ...input.evidence[0], observedAt: '2030-01-01' }] },
      { ...input, evidence: [{ ...input.evidence[0], providerAccepted: true }] },
    ])
      expect(() => captureLaunchReviewRequest(value)).toThrow();
  });
  it('rejects wrong native audience and binds every meaningful evidence change', () => {
    const result = prepareLaunchReview(health(), request(), operatorId);
    for (const change of [
      { sourceSha: 'c'.repeat(40) },
      { environment: 'production' },
      { telegramBotId: '987654321' },
    ])
      expect(() =>
        prepareLaunchReview(
          { ...health(), audience: { ...audience, ...change } } as ReturnType<typeof health>,
          request(),
          operatorId,
        ),
      ).toThrow();
    const input = request();
    for (const evidence of [
      input.evidence.slice(1),
      input.evidence.map((e, i) => (i ? e : { ...e, sha256: 'd'.repeat(64) })),
      input.evidence.map((e, i) => (i ? e : { ...e, expiresAt: '2030-01-01T00:30:00.000Z' })),
    ])
      expect(
        prepareLaunchReview(health(), { ...input, evidence }, operatorId).reviewDigest,
      ).not.toBe(result.reviewDigest);
    expect(prepareLaunchReview(health(), input, randomUUID()).reviewDigest).not.toBe(
      result.reviewDigest,
    );
  });
  it('keeps missing, stale and future evidence as explicit blockers', () => {
    const input = request();
    expect(
      dossier(prepareLaunchReview(health(), { ...input, evidence: [] }, operatorId)).blockers,
    ).toEqual(
      [...LAUNCH_REVIEW_COMMON_EVIDENCE, ...LAUNCH_REVIEW_DRILL_EVIDENCE]
        .map((role) => 'missing_' + role)
        .sort(),
    );
    for (const times of [
      { observedAt: '2029-12-31T22:59:00.000Z', expiresAt: now },
      { observedAt: '2030-01-01T00:00:01.000Z', expiresAt: '2030-01-01T01:00:00.000Z' },
    ]) {
      const evidence = input.evidence.map((e) => ({ ...e, ...times }));
      expect(
        (
          dossier(prepareLaunchReview(health(), { ...input, evidence }, operatorId))
            .blockers as string[]
        ).every((b) => b.startsWith('stale_')),
      ).toBe(true);
    }
  });
  it('distinguishes a synthetic-only canary plan from completed cohort/daily drills', () => {
    const input = request(),
      evidence = [
        ...input.evidence.filter((e) =>
          LAUNCH_REVIEW_COMMON_EVIDENCE.includes(
            e.role as (typeof LAUNCH_REVIEW_COMMON_EVIDENCE)[number],
          ),
        ),
        { ...input.evidence[0]!, role: 'canary_plan' },
      ];
    expect(
      dossier(prepareLaunchReview(health(), { ...input, phase: 'canary', evidence }, operatorId))
        .blockers,
    ).toEqual([]);
    for (const phase of ['cohort', 'daily'])
      expect(
        dossier(prepareLaunchReview(health(), { ...input, phase, evidence }, operatorId)).blockers,
      ).toEqual(LAUNCH_REVIEW_DRILL_EVIDENCE.map((r) => 'missing_' + r).sort());
  });
  it('blocks native integrity drift, backlog, missing scans and expired intents without mistaking historical findings for current drift', () => {
    const sample = health();
    sample.deletion.phases = {
      ...sample.deletion.phases,
      completed: {
        records: 1,
        leased: 0,
        retrying: 0,
        inconsistent: 0,
        oldestAgeSeconds: 999999,
        dueAgeSeconds: 0,
      },
    };
    sample.reconciliation = sample.reconciliation.map((run) => ({ ...run, historicalFindings: 9 }));
    expect(dossier(prepareLaunchReview(sample, request(), operatorId))).toMatchObject({
      blockers: [],
      historicalFindingsRequireDispositionReview: true,
    });
    const degraded = health();
    degraded.integrity = {
      ...degraded.integrity,
      counts: { ...degraded.integrity.counts, reports: 1 },
    };
    degraded.safety = {
      ...degraded.safety,
      reconciliationNeverCompleted: 1,
      oldestPendingReportAgeSeconds: 900,
    };
    const first = ACCOUNT_DELETION_PHASES[0];
    degraded.deletion = {
      ...degraded.deletion,
      phases: {
        ...degraded.deletion.phases,
        [first]: {
          records: 1,
          leased: 0,
          retrying: 0,
          inconsistent: 1,
          oldestAgeSeconds: 86400,
          dueAgeSeconds: 0,
        },
      },
    };
    degraded.reconciliation = degraded.reconciliation.map((run) => ({
      ...run,
      status: 'started',
      finishedAt: null,
    }));
    expect(dossier(prepareLaunchReview(degraded, request(), operatorId)).blockers).toEqual(
      expect.arrayContaining([
        'safety_integrity',
        'deletion_integrity',
        'deletion_age',
        'safety_backlog',
        'safety_scan_freshness',
        'reconciliation_billing',
      ]),
    );
    expect(
      dossier(
        prepareLaunchReview(
          health(),
          { ...request(), intent: { ...intent, expiresAt: now } },
          operatorId,
        ),
      ).blockers,
    ).toContain('intent_expiry');
  });
  it('hashes actual bounded private file bytes, captures paths before waits, and emits no paths or contents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nakh-launch-review-'));
    const path = join(directory, 'private-record.json');
    try {
      const contents = 'synthetic private evidence marker';
      await writeFile(path, contents, { mode: 0o600 });
      const input = {
        ...request(),
        evidence: [
          {
            role: 'deployment',
            path,
            observedAt: '2029-12-31T23:59:00.000Z',
            expiresAt: '2030-01-01T01:00:00.000Z',
          },
        ],
      };
      const pending = loadLaunchReviewFiles(input);
      input.evidence[0]!.path = join(directory, 'missing.json');
      const loaded = await pending;
      expect(loaded.evidence[0]!.sha256).toBe(createHash('sha256').update(contents).digest('hex'));
      expect(JSON.stringify(loaded)).not.toContain(path);
      expect(JSON.stringify(loaded)).not.toContain(contents);
      expect(await readFile(path, 'utf8')).toBe(contents);
      for (const invalid of ['relative.json', directory])
        await expect(
          loadLaunchReviewFiles({ ...input, evidence: [{ ...input.evidence[0], path: invalid }] }),
        ).rejects.toThrow();
      await writeFile(path, Buffer.alloc(1048577));
      await expect(
        loadLaunchReviewFiles({ ...input, evidence: [{ ...input.evidence[0], path }] }),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
