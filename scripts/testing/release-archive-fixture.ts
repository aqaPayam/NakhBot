import { crc32, deflateRawSync } from 'node:zlib';
import { RELEASE_CI_JOBS, type ReleaseCiReceipt } from '../release-ci.js';
import { RELEASE_SERVICES, type PreparedReleaseImages } from '../release-images.js';
import { archiveSha, ARCHIVE_ROLES } from '../release-archive.js';
import { stagingContext } from './staging-release-context.js';

/** Synthetic reports and ZIP bytes only; never provider or launch acceptance. */
export function reportZip(values: Readonly<Record<string, unknown>>): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(values)) {
    const filename = Buffer.from(name),
      body = Buffer.from(JSON.stringify(value)),
      packed = deflateRawSync(body),
      crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(filename.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(packed.length, 8);
    descriptor.writeUInt32LE(body.length, 12);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, filename, packed, descriptor);
    central.push(entry, filename);
    offset += local.length + filename.length + packed.length + descriptor.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export function archiveFixture(change?: (reports: Record<string, unknown>) => void): {
  context: ReturnType<typeof stagingContext>;
  ci: ReleaseCiReceipt;
  images: PreparedReleaseImages;
  files: Map<string, Uint8Array>;
} {
  const context = stagingContext(),
    sources = [1, 2, 3, 4].map((shard, i) => ({
      shard,
      headSha: context.sourceSha,
      runId: '12345',
      attempt: 1,
      total: i === 3 ? 453 : 300,
      passed: i === 3 ? 453 : 300,
      fileCount: i === 3 ? 41 : 40,
    }));
  const diagnostic = {
    maximumWorkersPlanned: 0,
    maximumWorkersLaunched: 0,
    tempReadBlocks: 0,
    tempWrittenBlocks: 0,
    diskSortKb: 0,
    maximumHashBatches: 1,
    jitTotalMs: 0,
    jitFunctions: 0,
    jitExpressions: false,
    jitDeforming: false,
    jitInlining: false,
    jitOptimization: false,
  };
  const plans: Record<string, unknown> = Object.fromEntries<unknown>([
    ...Array.from(
      { length: 25 },
      (_, i) => ['plan' + i, { executionMs: 1, indexNames: [] }] as const,
    ),
    [
      'terminalIntegritySnapshot',
      {
        executionMs: 1200,
        indexNames: [
          'moderation_actions_episode_resolution_idx',
          'account_history_restoration_state_idx',
        ],
        diagnostics: diagnostic,
      },
    ],
    ['terminalOperationalHealth', { executionMs: 1, indexNames: [] }],
  ]);
  const telemetry = {
    schemaVersion: 1,
    source: 'actual-otel-sdk-otlp-http-pinned-adot-awsemf-stdout',
    cloudWatchDeliveryVerified: false,
    snsRoutingVerified: false,
    imageAcquisition: {
      source: 'official_immutable_mirror',
      platform: 'linux/amd64',
      expectedIndexDigest: 'sha256:' + 'c'.repeat(64),
      manifestDigest: 'sha256:' + 'c'.repeat(64),
      configDigest: 'sha256:' + 'd'.repeat(64),
    },
    metricCount: 13,
    driftAndClearVerified: true,
    sampleFreshnessVerified: true,
    firstCounterVerified: true,
    privateMarkersAbsent: true,
    existingMetricsPreserved: true,
  };
  const reports: Record<string, unknown> = {
    'postgres-integration-shards.json': {
      schemaVersion: 1,
      scenario: 'POSTGRES-INTEGRATION-ISOLATED-SHARDS',
      executionMode: 'distributed_runners',
      fileInventorySha256: 'c'.repeat(64),
      dispatch: { durationInventorySha256: 'd'.repeat(64) },
      total: 1353,
      passed: 1353,
      testFiles: 161,
      skipped: 0,
      shards: 4,
      sources,
    },
    'm7-query-plans.json': {
      fixtureScale: 20000,
      maximumExecutionMs: 1500,
      plans,
      requiredIndexes: {},
      requiredAllIndexes: {},
    },
    'm7-load-smoke.json': { passed: true, accepted: 10, denied: 90, replayed: 100 },
    'm7-telemetry-conversion.json': { ...telemetry, phases: 10 },
    'm8-telemetry-conversion.json': { ...telemetry, phases: 8, m7MetricPreserved: true },
  };
  change?.(reports);
  const files = new Map<string, Uint8Array>();
  for (const role of ARCHIVE_ROLES) {
    const names =
      role === 'postgres-integration'
        ? ['postgres-integration-shards.json']
        : role === 'm7-performance'
          ? ['m7-query-plans.json', 'm7-load-smoke.json']
          : [role.replace('-telemetry', '-telemetry-conversion') + '.json'];
    files.set(
      'ci-' + role + '.zip',
      reportZip(Object.fromEntries(names.map((n) => [n, reports[n]]))),
    );
  }
  for (const name of RELEASE_SERVICES)
    files.set('image-' + name + '.jsonl', Buffer.from('{"fixture":"not-a-real-signature"}\n'));
  files.set('trusted-root.jsonl', Buffer.from('{"fixture":"never-trust-this-root"}\n'));
  const ci: ReleaseCiReceipt = {
    schemaVersion: 1,
    repository: context.repository,
    sourceSha: context.sourceSha,
    runId: 12345,
    attempt: 1,
    checkedAt: '2026-10-17T00:00:00.000Z',
    jobs: RELEASE_CI_JOBS.map((name, i) => ({ name, id: i + 1 })),
    artifacts: ARCHIVE_ROLES.map((r, i) => {
      const b = files.get('ci-' + r + '.zip')!;
      return {
        name: r + '-' + context.sourceSha,
        id: i + 10,
        digest: 'sha256:' + archiveSha(b),
        size: b.byteLength,
        expiresAt: '2026-10-31T00:00:00.000Z',
      };
    }),
  };
  const images: PreparedReleaseImages = {
    format: 1,
    repository: context.repository,
    sourceSha: context.sourceSha,
    images: RELEASE_SERVICES.map((service) => {
      const [repositoryUri, digest] = context.images[service].split('@');
      return { service, repositoryUri: repositoryUri!, digest: digest! };
    }),
  };
  return { context, ci, images, files };
}
