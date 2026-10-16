import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  latestReleaseCiRun,
  readReleaseCi,
  RELEASE_CI_JOBS,
  validateReleaseCiContext,
  verifyReleaseCi,
  type ReleaseCiContext,
} from './release-ci.js';

type Row = Record<string, unknown>;
type Fixture = {
  context: ReleaseCiContext;
  input: {
    run: Row;
    finalRun: Row;
    jobs: { total_count: number; jobs: Row[] };
    artifacts: { total_count: number; artifacts: (Row & { workflow_run: Row })[] };
  };
};
function fixture(): Fixture {
  const sha = 'a'.repeat(40),
    repository = { id: 42, full_name: 'owner/repository' };
  const context = { repository: repository.full_name, sha, now: new Date('2026-10-16T09:00:00Z') };
  const run = {
    id: 123,
    run_attempt: 2,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    repository,
    head_repository: repository,
    run_started_at: '2026-10-16T08:00:00Z',
    updated_at: '2026-10-16T08:30:00Z',
  };
  const jobs = {
    total_count: 6,
    jobs: RELEASE_CI_JOBS.map((name, index) => ({
      id: index + 1,
      name,
      run_id: run.id,
      head_sha: sha,
      head_branch: 'main',
      workflow_name: 'CI',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-10-16T08:01:00Z',
      completed_at: '2026-10-16T08:20:00Z',
    })),
  };
  const artifacts = {
    total_count: 4,
    artifacts: ['postgres-integration', 'm7-performance', 'm7-telemetry', 'm8-telemetry'].map(
      (prefix, index) => ({
        id: index + 10,
        name: `${prefix}-${sha}`,
        digest: `sha256:${'b'.repeat(64)}`,
        size_in_bytes: 100,
        expired: false,
        created_at: '2026-10-16T08:21:00Z',
        expires_at: '2026-10-30T08:21:00Z',
        workflow_run: {
          id: run.id,
          repository_id: 42,
          head_repository_id: 42,
          head_branch: 'main',
          head_sha: sha,
        },
      }),
    ),
  };
  return { context, input: { run, jobs, artifacts, finalRun: structuredClone(run) } };
}
describe('exact-source release CI prerequisite', () => {
  it('projects only six job identities and four artifact digest references from the current attempt', () => {
    const f = fixture();
    const receipt = verifyReleaseCi(
      { ...f.input, run: { ...f.input.run, privateMarker: 'never-copy-provider-fields' } },
      f.context,
    );
    expect(receipt).toMatchObject({ sourceSha: f.context.sha, runId: 123, attempt: 2 });
    expect(receipt.jobs).toHaveLength(6);
    expect(receipt.artifacts).toHaveLength(4);
    expect(JSON.stringify(receipt)).not.toContain('never-copy-provider-fields');
    expect(receipt).not.toHaveProperty('launchApproved');
    expect(receipt).not.toHaveProperty('artifactContentsVerified');
  });
  it('chooses the newest matching run rather than an older green result', () => {
    const f = fixture(),
      old = { ...f.input.run, id: 122 };
    expect(latestReleaseCiRun({ workflow_runs: [old, f.input.run] }, f.context).id).toBe(123);
    for (const status of ['queued', 'in_progress', 'completed']) {
      expect(() =>
        latestReleaseCiRun(
          { workflow_runs: [old, { ...f.input.run, status, conclusion: 'failure' }] },
          f.context,
        ),
      ).toThrow('Release CI');
    }
    expect(() => latestReleaseCiRun({ workflow_runs: [] }, f.context)).toThrow('Release CI');
  });
  it('rejects foreign source, fork, repository, branch, event and workflow identities', () => {
    const f = fixture();
    for (const change of [
      { head_sha: 'b'.repeat(40) },
      { head_branch: 'feature' },
      { event: 'pull_request' },
      { name: 'Other CI' },
      { path: '.github/workflows/other.yml' },
      { head_repository: { id: 43, full_name: 'owner/repository' } },
      { repository: { id: 42, full_name: 'foreign/repository' } },
      { id: NaN },
      { run_attempt: 0 },
      { run_attempt: 1.5 },
    ])
      expect(() =>
        verifyReleaseCi({ ...f.input, run: { ...f.input.run, ...change } }, f.context),
      ).toThrow('Release CI');
  });
  it('requires every exact job once and rejects missing, duplicate, extra or failed jobs', () => {
    const f = fixture(),
      original = f.input.jobs.jobs;
    for (const jobs of [
      original.slice(1),
      [...original, original[0]!],
      original.map((j, i) => (i === 0 ? { ...j, name: original[1]!.name } : j)),
      original.map((j, i) => (i === 0 ? { ...j, id: original[1]!.id } : j)),
      original.map((j, i) => (i === 0 ? { ...j, name: 'unexpected' } : j)),
    ])
      expect(() =>
        verifyReleaseCi({ ...f.input, jobs: { total_count: jobs.length, jobs } }, f.context),
      ).toThrow('Release CI');
    for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
      const jobs = original.map((j, i) => (i === 0 ? { ...j, conclusion } : j));
      expect(() =>
        verifyReleaseCi({ ...f.input, jobs: { total_count: 6, jobs } }, f.context),
      ).toThrow('Release CI');
    }
  });
  it('rejects borrowed jobs, partial attempts, incomplete pages and inconsistent times', () => {
    const f = fixture();
    for (const change of [
      { run_id: 124 },
      { head_sha: 'b'.repeat(40) },
      { head_branch: 'other' },
      { workflow_name: 'Other' },
      { status: 'in_progress' },
      { started_at: '2026-10-16T07:00:00Z' },
      { completed_at: '2026-10-16T07:00:00Z' },
      { completed_at: '2026-10-17T08:20:00Z' },
      { started_at: 'bad' },
    ]) {
      const jobs = f.input.jobs.jobs.map((j, i) => (i === 0 ? { ...j, ...change } : j));
      expect(() =>
        verifyReleaseCi({ ...f.input, jobs: { total_count: 6, jobs } }, f.context),
      ).toThrow('Release CI');
    }
    expect(() =>
      verifyReleaseCi({ ...f.input, jobs: { ...f.input.jobs, total_count: 7 } }, f.context),
    ).toThrow('Release CI');
  });
  it('requires exactly one live artifact per kind with a valid digest and original run identity', () => {
    const f = fixture(),
      original = f.input.artifacts.artifacts;
    for (const artifacts of [
      original.slice(1),
      [...original, original[0]!],
      original.map((a, i) => (i === 0 ? { ...a, id: original[1]!.id } : a)),
    ]) {
      expect(() =>
        verifyReleaseCi(
          { ...f.input, artifacts: { total_count: artifacts.length, artifacts } },
          f.context,
        ),
      ).toThrow('Release CI');
    }
    for (const change of [
      { expired: true },
      { digest: 'sha256:bad' },
      { size_in_bytes: 0 },
      { expires_at: '2026-10-16T09:00:00Z' },
      { created_at: '2026-10-16T07:00:00Z' },
      { workflow_run: { ...original[0]!.workflow_run, id: 124 } },
      { workflow_run: { ...original[0]!.workflow_run, head_repository_id: 43 } },
      { workflow_run: { ...original[0]!.workflow_run, head_sha: 'c'.repeat(40) } },
      { workflow_run: { ...original[0]!.workflow_run, head_branch: 'other' } },
    ]) {
      const artifacts = original.map((a, i) => (i === 0 ? { ...a, ...change } : a));
      expect(() =>
        verifyReleaseCi({ ...f.input, artifacts: { total_count: 4, artifacts } }, f.context),
      ).toThrow('Release CI');
    }
    expect(() =>
      verifyReleaseCi(
        { ...f.input, artifacts: { ...f.input.artifacts, total_count: 101 } },
        f.context,
      ),
    ).toThrow('Release CI');
  });
  it('refuses an attempt or status change while evidence is being observed', () => {
    const f = fixture();
    for (const change of [
      { id: 124 },
      { run_attempt: 3 },
      { status: 'in_progress' },
      { conclusion: 'failure' },
      { updated_at: '2026-10-16T08:31:00Z' },
      { run_started_at: '2026-10-16T08:01:00Z' },
    ]) {
      expect(() =>
        verifyReleaseCi({ ...f.input, finalRun: { ...f.input.finalRun, ...change } }, f.context),
      ).toThrow('Release CI');
    }
  });
  it('rejects mutable tags, repository path injection and invalid clocks before API access', async () => {
    const f = fixture();
    for (const change of [
      { sha: 'latest' },
      { sha: 'a'.repeat(39) },
      { sha: '../bad' },
      { repository: 'owner/..' },
      { repository: 'owner/repo?token=private' },
      { repository: 'https://foreign.invalid' },
      { now: new Date(NaN) },
    ]) {
      let calls = 0;
      await expect(
        readReleaseCi({ ...f.context, ...change }, () => {
          calls++;
          return Promise.resolve({});
        }),
      ).rejects.toThrow('Release CI');
      expect(calls).toBe(0);
    }
    expect(() =>
      validateReleaseCiContext({ ...f.context, repository: 'owner/.github' }),
    ).not.toThrow();
  });
  it('reads jobs from the explicit attempt and rechecks the newest run after observing artifacts', async () => {
    const f = fixture(),
      paths: string[] = [];
    const receipt = await readReleaseCi(f.context, (path) => {
      paths.push(path);
      return Promise.resolve(
        path.includes('/attempts/2/jobs')
          ? f.input.jobs
          : path.includes('/artifacts?')
            ? f.input.artifacts
            : { workflow_runs: [f.input.run] },
      );
    });
    expect(receipt.runId).toBe(123);
    expect(paths).toHaveLength(4);
    expect(paths[0]).toContain('/workflows/ci.yml/runs?head_sha=');
    expect(paths).toContain(
      '/repos/owner/repository/actions/runs/123/attempts/2/jobs?per_page=100',
    );
    expect(paths[3]).toBe(paths[0]);
  });
  it('fails closed if a newer run appears during observation or the API is unavailable', async () => {
    const f = fixture();
    let lists = 0;
    await expect(
      readReleaseCi(f.context, (path) => {
        if (path.includes('/workflows/'))
          return Promise.resolve({
            workflow_runs: [
              ++lists === 1
                ? f.input.run
                : { ...f.input.run, id: 124, status: 'queued', conclusion: null },
            ],
          });
        return Promise.resolve(path.includes('/jobs?') ? f.input.jobs : f.input.artifacts);
      }),
    ).rejects.toThrow('Release CI');
    await expect(
      readReleaseCi(f.context, () => Promise.reject(new Error('unavailable'))),
    ).rejects.toThrow('unavailable');
  });
  it('prints only a fixed denial when malformed private input reaches the executable', () => {
    const marker = 'synthetic-private-marker';
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify-release-ci.ts'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'owner/repository',
        NAKH_RELEASE_SHA: marker,
        GITHUB_TOKEN: marker,
      },
      timeout: 15000,
    });
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr.trim()).toBe(
      'Release CI verification failed. No deployment is authorized.',
    );
  });
});
