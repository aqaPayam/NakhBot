import { createHash } from 'node:crypto';
import { RELEASE_CI_JOBS, type ReleaseCiReceipt } from './release-ci.js';
import {
  RELEASE_SERVICES,
  captureImageContext,
  parsePreparedImages,
  type PreparedReleaseImages,
} from './release-images.js';
import { captureStagingContext, type StagingReleaseContext } from './staging-release.js';
import type { ReleaseBlobs } from './staging-release-custody.js';
import { releaseZipReports } from './release-archive-zip.js';

export const ARCHIVE_ROLES = [
  'postgres-integration',
  'm7-performance',
  'm7-telemetry',
  'm8-telemetry',
] as const;
export type ArchiveFile = Readonly<{ name: string; sha256: string; size: number }>;
export type ReleaseArchive = Readonly<{
  format: 1;
  repository: string;
  sourceSha: string;
  controllerSha: string;
  producer: Readonly<{
    runId: string;
    attempt: number;
    accountId: string;
    region: string;
    cluster: string;
  }>;
  ci: ReleaseCiReceipt;
  images: PreparedReleaseImages;
  files: readonly ArchiveFile[];
}>;
export type ArchiveScope = Pick<
  StagingReleaseContext,
  | 'repository'
  | 'sourceSha'
  | 'controllerSha'
  | 'runId'
  | 'attempt'
  | 'accountId'
  | 'region'
  | 'cluster'
>;
function denied(): never {
  throw new Error('Release archive verification failed.');
}
function obj(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}
function arr(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1000) denied();
  return value as unknown[];
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) denied();
  return Number(value);
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(value))
    denied();
  const n = Date.parse(value);
  if (!Number.isFinite(n)) denied();
  return n;
}
export function archiveSha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function archivePrefix(scope: ArchiveScope): string {
  return `archives/${scope.sourceSha}/${scope.runId}/${scope.attempt}/`;
}
export function archiveRef(ref: string, sourceSha: string): string {
  if (
    !/^[a-f0-9]{40}$/u.test(sourceSha) ||
    !new RegExp(
      '^archives/' + sourceSha + '/[1-9][0-9]{0,19}/[1-9][0-9]{0,8}/manifest\\.json$',
      'u',
    ).test(ref)
  )
    denied();
  return ref.slice(0, -'manifest.json'.length);
}
const names = [
  ...ARCHIVE_ROLES.map((r) => 'ci-' + r + '.zip'),
  ...RELEASE_SERVICES.map((n) => 'image-' + n + '.jsonl'),
  'trusted-root.jsonl',
];

export function parseArchive(value: unknown, scope: ArchiveScope): ReleaseArchive {
  const m = obj(value),
    p = obj(m.producer),
    ci = obj(m.ci),
    images = obj(m.images);
  if (
    m.format !== 1 ||
    m.repository !== scope.repository ||
    m.sourceSha !== scope.sourceSha ||
    m.controllerSha !== scope.sourceSha ||
    p.accountId !== scope.accountId ||
    p.region !== scope.region ||
    p.cluster !== scope.cluster ||
    !/^[1-9][0-9]{0,19}$/u.test(String(p.runId)) ||
    positive(p.attempt) > 999999999 ||
    ci.schemaVersion !== 1 ||
    ci.repository !== scope.repository ||
    ci.sourceSha !== scope.sourceSha
  )
    denied();
  positive(ci.runId);
  positive(ci.attempt);
  timestamp(ci.checkedAt);
  const jobs = arr(ci.jobs).map(obj);
  if (
    jobs.length !== 6 ||
    new Set(jobs.map((j) => j.name)).size !== 6 ||
    new Set(jobs.map((j) => positive(j.id))).size !== 6 ||
    jobs.some((j) => !RELEASE_CI_JOBS.some((n) => n === j.name))
  )
    denied();
  const artifacts = arr(ci.artifacts).map(obj);
  if (artifacts.length !== 4 || new Set(artifacts.map((a) => positive(a.id))).size !== 4) denied();
  for (const role of ARCHIVE_ROLES) {
    const matches = artifacts.filter((a) => a.name === role + '-' + scope.sourceSha);
    if (matches.length !== 1) denied();
    const a = matches[0]!;
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(String(a.digest)) ||
      positive(a.size) > 16777216 ||
      timestamp(a.expiresAt) <= timestamp(ci.checkedAt)
    )
      denied();
  }
  if (
    images.format !== 1 ||
    images.repository !== scope.repository ||
    images.sourceSha !== scope.sourceSha ||
    arr(images.images).length !== 4
  )
    denied();
  const entries = arr(images.images).map(obj);

  for (const service of RELEASE_SERVICES) {
    const match = entries.filter((i) => i.service === service);
    if (match.length !== 1) denied();
    const i = match[0]!;
    if (!/^sha256:[a-f0-9]{64}$/u.test(String(i.digest))) denied();
  }
  const repositories = Object.fromEntries(
    RELEASE_SERVICES.map((service) => {
      const image = entries.find((i) => i.service === service)!;
      const uri = `${scope.accountId}.dkr.ecr.${scope.region}.amazonaws.com${scope.region.startsWith('cn-') ? '.cn' : ''}/${scope.cluster}/${service}`;
      if (image.repositoryUri !== uri) denied();
      return [service, uri];
    }),
  ) as Record<(typeof RELEASE_SERVICES)[number], string>;
  const imageContext = captureImageContext({
    ...scope,
    buildId: String(p.runId) + '-' + String(p.attempt),
    repositories,
  });
  parsePreparedImages(imageContext, m.images);
  const files = arr(m.files).map((v) => {
    const f = obj(v);
    if (
      !names.includes(String(f.name)) ||
      !/^[a-f0-9]{64}$/u.test(String(f.sha256)) ||
      positive(f.size) > 16777216
    )
      denied();
    return { name: String(f.name), sha256: String(f.sha256), size: Number(f.size) };
  });
  if (files.length !== names.length || new Set(files.map((f) => f.name)).size !== names.length)
    denied();
  for (const role of ARCHIVE_ROLES) {
    const a = artifacts.find((a) => a.name === role + '-' + scope.sourceSha)!,
      f = files.find((f) => f.name === 'ci-' + role + '.zip')!;
    if (a.digest !== 'sha256:' + f.sha256 || a.size !== f.size) denied();
  }
  return structuredClone(value) as ReleaseArchive;
}
export function archiveMatchesLatest(
  archive: ReleaseArchive,
  status: Omit<ReleaseCiReceipt, 'artifacts'>,
): void {
  const a = archive.ci;
  if (
    a.repository !== status.repository ||
    a.sourceSha !== status.sourceSha ||
    a.runId !== status.runId ||
    a.attempt !== status.attempt ||
    JSON.stringify([...a.jobs].sort((x, y) => x.name.localeCompare(y.name))) !==
      JSON.stringify([...status.jobs].sort((x, y) => x.name.localeCompare(y.name)))
  )
    denied();
}

/** Digest-bound reports retain the original native/performance invariants. */
export function inspectArchivedReports(
  manifest: Pick<ReleaseArchive, 'sourceSha' | 'ci' | 'files'>,
  files: ReadonlyMap<string, Uint8Array>,
): void {
  const get = (role: string, expected: readonly string[]): ReadonlyMap<string, unknown> => {
    const name = 'ci-' + role + '.zip',
      bytes = files.get(name),
      entry = manifest.files.find((f) => f.name === name);
    if (!bytes || !entry || bytes.byteLength !== entry.size || archiveSha(bytes) !== entry.sha256)
      denied();
    return releaseZipReports(bytes, expected);
  };
  const n = obj(
    get('postgres-integration', ['postgres-integration-shards.json']).get(
      'postgres-integration-shards.json',
    ),
  );
  const sources = arr(n.sources).map(obj);
  if (
    n.schemaVersion !== 1 ||
    n.scenario !== 'POSTGRES-INTEGRATION-ISOLATED-SHARDS' ||
    n.executionMode !== 'distributed_runners' ||
    !/^[a-f0-9]{64}$/u.test(String(n.fileInventorySha256)) ||
    !/^[a-f0-9]{64}$/u.test(String(obj(n.dispatch).durationInventorySha256)) ||
    n.total !== n.passed ||
    positive(n.total) < 1353 ||
    positive(n.testFiles) < 161 ||
    n.skipped !== 0 ||
    n.shards !== 4 ||
    sources.length !== 4 ||
    new Set(sources.map((s) => s.shard)).size !== 4 ||
    sources.some(
      (s) =>
        ![1, 2, 3, 4].includes(Number(s.shard)) ||
        s.headSha !== manifest.sourceSha ||
        String(s.runId) !== String(manifest.ci.runId) ||
        s.attempt !== manifest.ci.attempt ||
        s.total !== s.passed ||
        positive(s.total) < 1,
    ) ||
    sources.reduce((sum, s) => sum + Number(s.total), 0) !== n.total ||
    sources.reduce((sum, s) => sum + positive(s.fileCount), 0) !== n.testFiles
  )
    denied();
  const performance = get('m7-performance', ['m7-query-plans.json', 'm7-load-smoke.json']),
    p = obj(performance.get('m7-query-plans.json')),
    plans = obj(p.plans);
  if (p.fixtureScale !== 20000 || p.maximumExecutionMs !== 1500 || Object.keys(plans).length !== 27)
    denied();
  const required = obj(p.requiredIndexes),
    all = obj(p.requiredAllIndexes);
  for (const [name, raw] of Object.entries(plans)) {
    const q = obj(raw),
      indexes = arr(q.indexNames);
    if (
      typeof q.executionMs !== 'number' ||
      !Number.isFinite(q.executionMs) ||
      q.executionMs < 0 ||
      q.executionMs > 1500 ||
      (required[name] !== undefined && !arr(required[name]).some((i) => indexes.includes(i))) ||
      (all[name] !== undefined && !arr(all[name]).every((i) => indexes.includes(i)))
    )
      denied();
  }
  const terminal = obj(plans.terminalIntegritySnapshot),
    d = obj(terminal.diagnostics);
  if (
    !['moderation_actions_episode_resolution_idx', 'account_history_restoration_state_idx'].every(
      (i) => arr(terminal.indexNames).includes(i),
    ) ||
    d.maximumWorkersPlanned !== 0 ||
    d.maximumWorkersLaunched !== 0 ||
    d.tempReadBlocks !== 0 ||
    d.tempWrittenBlocks !== 0 ||
    d.diskSortKb !== 0 ||
    !Number.isSafeInteger(d.maximumHashBatches) ||
    Number(d.maximumHashBatches) < 0 ||
    Number(d.maximumHashBatches) > 1 ||
    d.jitTotalMs !== 0 ||
    d.jitFunctions !== 0 ||
    ['jitExpressions', 'jitDeforming', 'jitInlining', 'jitOptimization'].some((k) => d[k] !== false)
  )
    denied();
  const load = obj(performance.get('m7-load-smoke.json'));
  if (load.passed !== true || load.accepted !== 10 || load.denied !== 90 || load.replayed !== 100)
    denied();
  for (const role of ['m7', 'm8']) {
    const t = obj(
      get(role + '-telemetry', [role + '-telemetry-conversion.json']).get(
        role + '-telemetry-conversion.json',
      ),
    );
    const acquisition = obj(t.imageAcquisition);
    if (
      t.schemaVersion !== 1 ||
      t.source !== 'actual-otel-sdk-otlp-http-pinned-adot-awsemf-stdout' ||
      t.cloudWatchDeliveryVerified !== false ||
      t.snsRoutingVerified !== false ||
      !['verified_local_image', 'official_immutable_mirror'].includes(String(acquisition.source)) ||
      !['linux/amd64', 'linux/arm64'].includes(String(acquisition.platform)) ||
      ['expectedIndexDigest', 'manifestDigest', 'configDigest'].some(
        (k) => !/^sha256:[a-f0-9]{64}$/u.test(String(acquisition[k])),
      )
    )
      denied();
    if (
      t.metricCount !== 13 ||
      t.phases !== (role === 'm7' ? 10 : 8) ||
      [
        'driftAndClearVerified',
        'sampleFreshnessVerified',
        'firstCounterVerified',
        'privateMarkersAbsent',
        'existingMetricsPreserved',
        ...(role === 'm8' ? ['m7MetricPreserved'] : []),
      ].some((k) => t[k] !== true)
    )
      denied();
  }
}

export async function retainArchiveFiles(
  context: StagingReleaseContext,
  ci: ReleaseCiReceipt,
  images: PreparedReleaseImages,
  inputFiles: ReadonlyMap<string, Uint8Array>,
  store: ReleaseBlobs,
): Promise<ReleaseArchive> {
  const c = captureStagingContext(context);
  if (c.controllerSha !== c.sourceSha) denied();
  const files = new Map([...inputFiles].map(([n, b]) => [n, Buffer.from(b)]));
  const manifest = parseArchive(
    {
      format: 1,
      repository: c.repository,
      sourceSha: c.sourceSha,
      controllerSha: c.controllerSha,
      producer: {
        runId: c.runId,
        attempt: c.attempt,
        accountId: c.accountId,
        region: c.region,
        cluster: c.cluster,
      },
      ci,
      images,
      files: [...files].map(([name, bytes]) => ({
        name,
        sha256: archiveSha(bytes),
        size: bytes.length,
      })),
    },
    c,
  );
  inspectArchivedReports(manifest, files);
  for (const entry of manifest.files) {
    const bytes = files.get(entry.name)!,
      key = archivePrefix(c) + 'files/' + entry.sha256 + '.bin';
    await store.put(key, bytes);
    const observed = await store.read(key);
    if (!observed || !observed.equals(bytes)) denied();
  }
  return manifest;
}
export async function loadArchiveFiles(
  manifest: ReleaseArchive,
  prefix: string,
  store: ReleaseBlobs,
): Promise<Map<string, Buffer>> {
  const expected = `archives/${manifest.sourceSha}/${manifest.producer.runId}/${manifest.producer.attempt}/`;
  if (prefix !== expected) denied();
  const files = new Map<string, Buffer>();
  for (const entry of manifest.files) {
    const bytes = await store.read(prefix + 'files/' + entry.sha256 + '.bin');
    if (!bytes || bytes.length !== entry.size || archiveSha(bytes) !== entry.sha256) denied();
    files.set(entry.name, bytes);
  }
  inspectArchivedReports(manifest, files);
  return files;
}

export type ArchiveVerification = Readonly<{
  manifest: (bytes: Buffer, bundle: Buffer) => Promise<void>;
  images: (manifest: ReleaseArchive, files: ReadonlyMap<string, Buffer>) => Promise<void>;
  latest: () => Promise<Omit<ReleaseCiReceipt, 'artifacts'>>;
}>;
export async function sealArchive(
  scope: ArchiveScope,
  input: Uint8Array,
  inputBundle: Uint8Array,
  store: ReleaseBlobs,
  verify: ArchiveVerification,
): Promise<ReleaseArchive> {
  const bytes = Buffer.from(input),
    bundle = Buffer.from(inputBundle),
    captured = structuredClone(scope);
  if (bytes.length > 262144 || bundle.length < 1 || bundle.length > 1048576) denied();
  const manifest = parseArchive(JSON.parse(bytes.toString('utf8')) as unknown, captured);
  if (
    manifest.controllerSha !== captured.controllerSha ||
    manifest.producer.runId !== captured.runId ||
    manifest.producer.attempt !== captured.attempt
  )
    denied();
  const prefix = archivePrefix(captured),
    files = await loadArchiveFiles(manifest, prefix, store);
  await verify.manifest(bytes, bundle);
  await verify.images(manifest, files);
  archiveMatchesLatest(manifest, await verify.latest());
  for (const [key, body] of [
    [prefix + 'manifest.json', bytes],
    [prefix + 'manifest-bundle.jsonl', bundle],
    [prefix + 'complete.json', Buffer.from(JSON.stringify({ manifestSha256: archiveSha(bytes) }))],
  ] as const) {
    await store.put(key, body);
    const observed = await store.read(key);
    if (!observed || !observed.equals(body)) denied();
  }
  return manifest;
}
export async function restoreArchive(
  scope: ArchiveScope,
  ref: string,
  input: Uint8Array,
  inputBundle: Uint8Array,
  store: ReleaseBlobs,
  verify: ArchiveVerification,
): Promise<ReleaseArchive> {
  const bytes = Buffer.from(input),
    bundle = Buffer.from(inputBundle),
    captured = structuredClone(scope),
    prefix = archiveRef(ref, captured.sourceSha);
  if (bytes.length > 262144 || bundle.length < 1 || bundle.length > 1048576) denied();
  // Signature policy comes from current trusted code/TUF, never from the stored root blob.
  await verify.manifest(bytes, bundle);
  const manifest = parseArchive(JSON.parse(bytes.toString('utf8')) as unknown, captured);
  const complete = await store.read(prefix + 'complete.json');
  if (
    !complete ||
    obj(JSON.parse(complete.toString('utf8')) as unknown).manifestSha256 !== archiveSha(bytes)
  )
    denied();
  const files = await loadArchiveFiles(manifest, prefix, store);
  await verify.images(manifest, files);
  archiveMatchesLatest(manifest, await verify.latest());
  return manifest;
}
