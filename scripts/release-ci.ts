/** GitHub CI metadata is a release prerequisite, not production acceptance.
 * Native artifact contents remain verified by the required reliability job. */
export const RELEASE_CI_JOBS = [
  'quality',
  'postgres-reliability',
  'container-build (api)',
  'container-build (telegram-gateway)',
  'container-build (worker)',
  'container-build (scheduler)',
] as const;
const ARTIFACTS = [
  'postgres-integration',
  'm7-performance',
  'm7-telemetry',
  'm8-telemetry',
] as const;
export type ReleaseCiContext = Readonly<{ repository: string; sha: string; now: Date }>;
export type ReleaseCiReceipt = Readonly<{
  schemaVersion: 1;
  repository: string;
  sourceSha: string;
  runId: number;
  attempt: number;
  checkedAt: string;
  jobs: readonly { name: string; id: number }[];
  artifacts: readonly { name: string; id: number; digest: string; expiresAt: string }[];
}>;
function invalid(): never {
  throw new Error('Release CI evidence is incomplete, stale or invalid.');
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}
function time(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(value))
    invalid();
  const result = Date.parse(value);
  if (!Number.isFinite(result)) invalid();
  return result;
}
export function validateReleaseCiContext(context: ReleaseCiContext): void {
  if (
    !/^[a-f0-9]{40}$/u.test(context.sha) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/u.test(context.repository) ||
    ['.', '..'].includes(context.repository.split('/')[1]!) ||
    !Number.isFinite(context.now.getTime())
  )
    invalid();
}
function sourceRun(value: unknown, context: ReleaseCiContext): Record<string, unknown> {
  const run = object(value),
    repository = object(run.repository),
    head = object(run.head_repository);
  if (
    run.head_sha !== context.sha ||
    run.head_branch !== 'main' ||
    run.event !== 'push' ||
    run.name !== 'CI' ||
    typeof run.path !== 'string' ||
    ![
      '.github/workflows/ci.yml',
      '.github/workflows/ci.yml@main',
      '.github/workflows/ci.yml@refs/heads/main',
    ].includes(run.path) ||
    typeof repository.full_name !== 'string' ||
    repository.full_name.toLowerCase() !== context.repository.toLowerCase() ||
    typeof head.full_name !== 'string' ||
    head.full_name.toLowerCase() !== context.repository.toLowerCase() ||
    id(repository.id) !== id(head.id)
  )
    invalid();
  id(run.id);
  id(run.run_attempt);
  return run;
}
/** Never fall back to an older green run when the newest run is red or pending. */
export function latestReleaseCiRun(
  value: unknown,
  context: ReleaseCiContext,
): Record<string, unknown> {
  validateReleaseCiContext(context);
  const envelope = object(value);
  if (
    !Array.isArray(envelope.workflow_runs) ||
    envelope.workflow_runs.length === 0 ||
    envelope.workflow_runs.length > 100
  )
    invalid();
  const runs = envelope.workflow_runs.map((run: unknown) => sourceRun(run, context));
  if (new Set(runs.map((run) => id(run.id))).size !== runs.length) invalid();
  const latest = runs.reduce((a, b) => (id(a.id) > id(b.id) ? a : b));
  if (latest.status !== 'completed' || latest.conclusion !== 'success') invalid();
  return latest;
}
function collection(value: unknown, key: 'jobs' | 'artifacts'): unknown[] {
  const envelope = object(value),
    values = envelope[key];
  // A truncated response must not hide duplicate names or additional jobs.
  if (!Array.isArray(values) || values.length > 100 || envelope.total_count !== values.length)
    invalid();
  return values as unknown[];
}
export function verifyReleaseCi(
  input: Readonly<{ run: unknown; jobs: unknown; artifacts: unknown; finalRun: unknown }>,
  context: ReleaseCiContext,
): ReleaseCiReceipt {
  validateReleaseCiContext(context);
  const run = sourceRun(input.run, context),
    finalRun = sourceRun(input.finalRun, context);
  const runId = id(run.id),
    attempt = id(run.run_attempt),
    startedAt = time(run.run_started_at);
  const updatedAt = time(run.updated_at);
  if (
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    finalRun.id !== runId ||
    finalRun.run_attempt !== attempt ||
    finalRun.status !== 'completed' ||
    finalRun.conclusion !== 'success' ||
    finalRun.updated_at !== run.updated_at ||
    finalRun.run_started_at !== run.run_started_at ||
    startedAt > context.now.getTime() ||
    updatedAt < startedAt ||
    updatedAt > context.now.getTime()
  )
    invalid();
  const jobs = collection(input.jobs, 'jobs').map((value) => {
    const job = object(value);
    if (
      job.run_id !== runId ||
      job.head_sha !== context.sha ||
      job.head_branch !== 'main' ||
      job.workflow_name !== 'CI' ||
      job.status !== 'completed' ||
      job.conclusion !== 'success' ||
      typeof job.name !== 'string' ||
      !RELEASE_CI_JOBS.some((name) => name === job.name) ||
      time(job.started_at) < startedAt ||
      time(job.completed_at) < time(job.started_at) ||
      time(job.completed_at) > context.now.getTime()
    )
      invalid();
    return { name: job.name, id: id(job.id) };
  });
  if (
    jobs.length !== RELEASE_CI_JOBS.length ||
    new Set(jobs.map((job) => job.name)).size !== jobs.length ||
    new Set(jobs.map((job) => job.id)).size !== jobs.length
  )
    invalid();
  const available = collection(input.artifacts, 'artifacts').map(object);
  const artifacts = ARTIFACTS.map((prefix) => {
    const name = `${prefix}-${context.sha}`,
      matches = available.filter((artifact) => artifact.name === name);
    if (matches.length !== 1) invalid();
    const artifact = matches[0]!,
      owner = object(artifact.workflow_run),
      repository = object(run.repository);
    if (
      artifact.expired !== false ||
      time(artifact.expires_at) <= context.now.getTime() ||
      time(artifact.created_at) < startedAt ||
      time(artifact.created_at) > context.now.getTime() ||
      owner.id !== runId ||
      owner.head_sha !== context.sha ||
      owner.head_branch !== 'main' ||
      owner.repository_id !== repository.id ||
      owner.head_repository_id !== repository.id ||
      typeof artifact.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest) ||
      typeof artifact.size_in_bytes !== 'number' ||
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes < 1
    )
      invalid();
    return {
      name,
      id: id(artifact.id),
      digest: artifact.digest,
      expiresAt: new Date(time(artifact.expires_at)).toISOString(),
    };
  });
  if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length) invalid();
  return {
    schemaVersion: 1,
    repository: context.repository,
    sourceSha: context.sha,
    runId,
    attempt,
    checkedAt: context.now.toISOString(),
    jobs,
    artifacts,
  };
}
export async function readReleaseCi(
  context: ReleaseCiContext,
  readJson: (path: string) => Promise<unknown>,
): Promise<ReleaseCiReceipt> {
  validateReleaseCiContext(context);
  const base = `/repos/${context.repository}/actions`;
  const listPath = `${base}/workflows/ci.yml/runs?head_sha=${context.sha}&branch=main&event=push&per_page=100`;
  const run = latestReleaseCiRun(await readJson(listPath), context);
  const runId = id(run.id),
    attempt = id(run.run_attempt);
  const [jobs, artifacts] = await Promise.all([
    readJson(`${base}/runs/${runId}/attempts/${attempt}/jobs?per_page=100`),
    readJson(`${base}/runs/${runId}/artifacts?per_page=100`),
  ]);
  const finalRun = latestReleaseCiRun(await readJson(listPath), context);
  return verifyReleaseCi({ run, jobs, artifacts, finalRun }, context);
}
