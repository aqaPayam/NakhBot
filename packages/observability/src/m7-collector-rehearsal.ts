import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import policy from '../../../deploy/telemetry/m7-collector.json' with { type: 'json' };

const execute = promisify(execFile);
let stage = 'configuration';
async function docker(args: readonly string[]): Promise<string> {
  return (await execute('docker', [...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
}
type Emf = {
  _aws: {
    CloudWatchMetrics: readonly {
      Namespace: string;
      Dimensions: readonly (readonly string[])[];
      Metrics: readonly { Name: string }[];
    }[];
  };
  [key: string]: unknown;
};
function records(log: string): Emf[] {
  return log
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Emf)
    .filter((record) => record._aws?.CloudWatchMetrics !== undefined);
}
function assertEvidence(emf: readonly Emf[]): void {
  const emitted = new Set<string>();
  const counts = new Map<string, Set<number>>();
  const timestamps = new Set<number>();
  let firstFailure = false;
  let legacy = false;
  for (const record of emf) {
    for (const declaration of record._aws.CloudWatchMetrics) {
      stage = 'evidence-namespace';
      assert.equal(declaration.Namespace, 'Nakh/Platform');
      for (const metric of declaration.Metrics) {
        if (metric.Name === 'nakh.m1.collector_rehearsal') {
          legacy = true;
          continue;
        }
        stage = 'evidence-metric-name';
        assert.ok(policy.metricNames.includes(metric.Name), 'Unexpected M7 metric escaped.');
        emitted.add(metric.Name);
        const expected = policy.exporter.metric_declarations.find((item) =>
          item.metric_name_selectors.some((selector) => new RegExp(selector).test(metric.Name)),
        )!;
        stage = 'evidence-dimensions';
        for (const dimensions of declaration.Dimensions)
          assert.ok(
            expected.dimensions.some(
              (allowed) =>
                JSON.stringify([...allowed].sort()) === JSON.stringify([...dimensions].sort()),
            ),
            'Unexpected M7 dimension escaped.',
          );
        assert.ok(declaration.Dimensions.length > 0);
        if (metric.Name === 'nakh.m7.integrity.current_mismatches') {
          stage = 'evidence-current-count';
          assert.equal(declaration.Dimensions.length, 1);
          assert.deepEqual(declaration.Dimensions[0], ['phase']);
          assert.ok(policy.phases.includes(String(record.phase)));
          const values = counts.get(String(record.phase)) ?? new Set<number>();
          assert.equal(typeof record[metric.Name], 'number');
          values.add(record[metric.Name] as number);
          counts.set(String(record.phase), values);
        }
        if (metric.Name === 'nakh.m7.integrity.sampled_at') {
          stage = 'evidence-sample-time';
          assert.deepEqual(declaration.Dimensions, [[]]);
          assert.equal(typeof record[metric.Name], 'number');
          timestamps.add(record[metric.Name] as number);
        }
        if (metric.Name === 'nakh.m7.reconciliation.failures' && record[metric.Name] === 1)
          firstFailure = true;
      }
    }
    if (Object.keys(record).some((key) => key.startsWith('nakh.m7.'))) {
      stage = 'evidence-field-shape';
      for (const key of Object.keys(record))
        assert.ok(
          ['_aws', 'Version', 'OTelLib', 'phase', 'outcome', ...policy.metricNames].includes(key),
          'Unexpected M7 field escaped.',
        );
      assert.equal(record.Version, '1');
      stage = 'evidence-scope';
      assert.equal(record.OTelLib, 'nakh-m7');
    }
  }
  stage = 'evidence-instrument-coverage';
  assert.equal(emitted.size, policy.metricNames.length, 'A required M7 metric was lost.');
  stage = 'evidence-drift-and-clear';
  for (const [index, phase] of policy.phases.entries()) {
    assert.ok(counts.get(phase)?.has(index + 1), 'Drift sample was lost.');
    assert.ok(counts.get(phase)?.has(0), 'Cleared sample was lost.');
  }
  stage = 'evidence-freshness';
  assert.equal(timestamps.size, 2, 'Fresh/stale timestamp evidence was lost.');
  stage = 'evidence-first-counter';
  assert.ok(firstFailure, 'First failure counter observation was lost.');
  stage = 'evidence-legacy';
  assert.ok(legacy, 'Existing milestone metric was lost.');
  stage = 'evidence-private-markers';
  assert.ok(
    !JSON.stringify(emf).includes('rehearsal-private'),
    'Private synthetic marker escaped.',
  );
}

async function main(): Promise<void> {
  const directory = resolve('artifacts/m7-collector');
  await mkdir(directory, { recursive: true });
  const configPath = resolve(directory, 'config.json');
  const name = `nakh-m7-collector-${process.pid}`;
  const output = {
    output_destination: 'stdout',
    region: 'us-east-1',
    log_group_name: 'm7-rehearsal',
  };
  await writeFile(
    configPath,
    JSON.stringify({
      receivers: { otlp: { protocols: { http: { endpoint: '0.0.0.0:4318' } } } },
      processors: {
        ...policy.processors,
        batch: { timeout: '1s' },
        memory_limiter: { check_interval: '5s', limit_mib: 192 },
      },
      exporters: {
        awsemf: { namespace: 'Nakh/Platform', ...output },
        'awsemf/m7': { ...policy.exporter, ...output },
      },
      service: {
        pipelines: {
          metrics: {
            receivers: ['otlp'],
            processors: ['memory_limiter', 'filter/non_m7', 'batch'],
            exporters: ['awsemf'],
          },
          'metrics/m7': {
            receivers: ['otlp'],
            processors: ['memory_limiter', 'resource/m7', 'filter/m7', 'batch'],
            exporters: ['awsemf/m7'],
          },
        },
      },
    }),
  );
  let started = false;
  let provider: MeterProvider | undefined;
  try {
    stage = 'startup';
    await docker([
      'run',
      '-d',
      '--name',
      name,
      '-p',
      '127.0.0.1::4318',
      '-e',
      'AWS_EC2_METADATA_DISABLED=true',
      '--mount',
      `type=bind,src=${configPath},dst=/tmp/m7.json,readonly`,
      policy.collectorImage,
      '--config=/tmp/m7.json',
    ]);
    started = true;
    stage = 'readiness';
    const address = (await docker(['port', name, '4318/tcp'])).trim();
    assert.match(address, /^127\.0\.0\.1:\d+$/u);
    const endpoint = `http://${address}/v1/metrics`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const result = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(1000),
        });
        ready = result.ok;
      } catch {
        /* Readiness only; no provider details enter the evidence. */
      }
      if (ready) break;
      await delay(300);
    }
    if (!ready) {
      // No metrics have been sent. These are only diagnostics for the public config.
      const startup = await execute('docker', ['logs', name], { maxBuffer: 1024 * 1024 });
      console.error(startup.stderr.slice(0, 8000));
    }
    assert.ok(ready, 'Pinned collector did not become ready.');
    stage = 'sdk-export';
    provider = new MeterProvider({
      resource: resourceFromAttributes({
        'service.name': 'rehearsal-private-service',
        'private.resource': 'rehearsal-private-resource',
      }),
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: endpoint, timeoutMillis: 5000 }),
          exportIntervalMillis: 60000,
        }),
      ],
    });
    assert.ok(metrics.setGlobalMeterProvider(provider));
    const { M7Metrics } = await import('./m7-metrics.js');
    const m7 = new M7Metrics();
    m7.recordReconciliation('failure', 'appeals', 5, 10, 1);
    m7.recordOperationalHealthFailure();
    m7.recordOperationalHealth({
      oldestPendingReportAgeSeconds: 20,
      oldestInReviewAgeSeconds: 10,
      activeReconciliationAgeSeconds: 0,
      completedReconciliationAgeSeconds: 30,
      reconciliationNeverCompleted: 0,
    });
    const stale = Date.now() - 1200000;
    const counts = Object.fromEntries(policy.phases.map((phase, index) => [phase, index + 1]));
    m7.recordOperationalIntegrity(
      stale,
      counts as Parameters<typeof m7.recordOperationalIntegrity>[1],
    );
    const meter = metrics.getMeter('nakh-m7');
    const drift = meter.createGauge('nakh.m7.integrity.current_mismatches');
    drift.record(77, { phase: 'rehearsal-private-phase' });
    drift.record(77, { phase: 'appeals', user_id: 'rehearsal-private-user' });
    drift.record(77, { phase: 7 });
    drift.record(77, { phase: 'unknown' });
    drift.record(77);
    meter
      .createCounter('nakh.m7.reconciliation.batches')
      .add(77, { phase: 'appeals', outcome: 'rehearsal-private-outcome' });
    meter.createGauge('nakh.m7.rehearsal-private-metric').record(77);
    metrics
      .getMeter('rehearsal-private-scope')
      .createGauge('nakh.m7.integrity.current_mismatches')
      .record(77, { phase: 'appeals' });
    metrics
      .getMeter('nakh-m7', 'rehearsal-private-version')
      .createGauge('nakh.m7.integrity.current_mismatches')
      .record(77, { phase: 'appeals' });
    const legacy = metrics.getMeter('nakh-m1').createCounter('nakh.m1.collector_rehearsal');
    legacy.add(1);
    await provider.forceFlush();
    await delay(2000);
    m7.recordOperationalIntegrity(
      Date.now(),
      Object.fromEntries(policy.phases.map((phase) => [phase, 0])) as Parameters<
        typeof m7.recordOperationalIntegrity
      >[1],
    );
    legacy.add(1);
    await provider.forceFlush();
    await delay(2000);
    const emf = records(await docker(['logs', name]));
    stage = 'evidence';
    assertEvidence(emf);
    await writeFile(
      resolve('artifacts/m7-telemetry-conversion.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          collectorImage: policy.collectorImage,
          source: 'actual-otel-sdk-otlp-http-pinned-adot-awsemf-stdout',
          metricCount: policy.metricNames.length,
          phases: policy.phases.length,
          driftAndClearVerified: true,
          sampleFreshnessVerified: true,
          firstCounterVerified: true,
          privateMarkersAbsent: true,
          existingMetricsPreserved: true,
          cloudWatchDeliveryVerified: false,
          snsRoutingVerified: false,
        },
        null,
        2,
      ) + '\n',
    );
    console.log('M7 collector conversion verified; evidence contains fixed metadata only.');
  } finally {
    try {
      await provider?.shutdown();
    } finally {
      metrics.disable();
      if (started) await docker(['rm', '-f', name]);
    }
  }
}
await main().catch(() => {
  // SDK/collector errors may contain payloads. Never print them or raw EMF.
  console.error(`M7 collector conversion failed at ${stage}; no metric payload was printed.`);
  process.exitCode = 1;
});
