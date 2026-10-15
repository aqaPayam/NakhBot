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
import policy from '../../../deploy/telemetry/m8-collector.json' with { type: 'json' };
import m7Policy from '../../../deploy/telemetry/m7-collector.json' with { type: 'json' };
import { collectorStartupDiagnostic, pullCollectorImage } from './m7-collector-startup.js';

const execute = promisify(execFile);
let stage = 'configuration';
async function docker(args: readonly string[], timeout = 60000): Promise<string> {
  return (await execute('docker', [...args], { maxBuffer: 16 * 1024 * 1024, timeout })).stdout;
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
  let m7Preserved = false;
  for (const record of emf) {
    for (const declaration of record._aws.CloudWatchMetrics) {
      stage = 'evidence-namespace';
      assert.equal(declaration.Namespace, 'Nakh/Platform');
      for (const metric of declaration.Metrics) {
        if (metric.Name === 'nakh.m1.collector_rehearsal') {
          legacy = true;
          continue;
        }
        if (metric.Name === 'nakh.m7.reconciliation.failures') {
          assert.equal(record.OTelLib, 'nakh-m7');
          assert.deepEqual(declaration.Dimensions, [[]]);
          const value = record[metric.Name];
          assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0);
          if (value === 1) m7Preserved = true;
          continue;
        }
        stage = 'evidence-metric-name';
        assert.ok(policy.metricNames.includes(metric.Name), 'Unexpected M8 metric escaped.');
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
            'Unexpected M8 dimension escaped.',
          );
        assert.ok(declaration.Dimensions.length > 0);
        if (metric.Name === 'nakh.m8.deletion.inconsistent') {
          stage = 'evidence-current-count';
          assert.equal(declaration.Dimensions.length, 1);
          assert.deepEqual(declaration.Dimensions[0], ['phase']);
          assert.ok(policy.phases.includes(String(record.phase)));
          const values = counts.get(String(record.phase)) ?? new Set<number>();
          assert.equal(typeof record[metric.Name], 'number');
          values.add(record[metric.Name] as number);
          counts.set(String(record.phase), values);
        }
        if (metric.Name === 'nakh.m8.deletion.sampled_at') {
          stage = 'evidence-sample-time';
          assert.deepEqual(declaration.Dimensions, [[]]);
          assert.equal(typeof record[metric.Name], 'number');
          timestamps.add(record[metric.Name] as number);
        }
        if (metric.Name === 'nakh.m8.deletion.failures' && record[metric.Name] === 1)
          firstFailure = true;
      }
    }
    if (Object.keys(record).some((key) => key.startsWith('nakh.m8.'))) {
      stage = 'evidence-field-shape';
      for (const key of Object.keys(record))
        assert.ok(
          ['_aws', 'Version', 'OTelLib', 'phase', 'outcome', ...policy.metricNames].includes(key),
          'Unexpected M8 field escaped.',
        );
      assert.equal(record.Version, '1');
      stage = 'evidence-scope';
      assert.equal(record.OTelLib, 'nakh-m8');
    }
  }
  stage = 'evidence-instrument-coverage';
  assert.equal(emitted.size, policy.metricNames.length, 'A required M8 metric was lost.');
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
  assert.ok(m7Preserved, 'Existing M7 metric was lost.');
  stage = 'evidence-private-markers';
  assert.ok(
    !JSON.stringify(emf).includes('rehearsal-private'),
    'Private synthetic marker escaped.',
  );
}

async function main(): Promise<void> {
  const directory = resolve('artifacts/m8-collector');
  await mkdir(directory, { recursive: true });
  const configPath = resolve(directory, 'config.json');
  const name = `nakh-m8-collector-${process.pid}`;
  const output = {
    output_destination: 'stdout',
    region: 'us-east-1',
    log_group_name: 'm8-rehearsal',
  };
  await writeFile(
    configPath,
    JSON.stringify({
      receivers: { otlp: { protocols: { http: { endpoint: '0.0.0.0:4318' } } } },
      processors: {
        ...m7Policy.processors,
        ...policy.processors,
        batch: { timeout: '1s' },
        memory_limiter: { check_interval: '5s', limit_mib: 192 },
      },
      exporters: {
        awsemf: { namespace: 'Nakh/Platform', ...output },
        'awsemf/m8': { ...policy.exporter, ...output },
        'awsemf/m7': { ...m7Policy.exporter, ...output },
      },
      service: {
        pipelines: {
          metrics: {
            receivers: ['otlp'],
            processors: ['memory_limiter', 'filter/non_m7', 'filter/non_m8', 'batch'],
            exporters: ['awsemf'],
          },
          'metrics/m7': {
            receivers: ['otlp'],
            processors: ['memory_limiter', 'resource/m7', 'filter/m7', 'batch'],
            exporters: ['awsemf/m7'],
          },
          'metrics/m8': {
            receivers: ['otlp'],
            processors: ['memory_limiter', 'resource/m8', 'filter/m8', 'batch'],
            exporters: ['awsemf/m8'],
          },
        },
      },
    }),
  );
  let started = false;
  let provider: MeterProvider | undefined;
  try {
    stage = 'image-pull';
    await pullCollectorImage(() => docker(['pull', policy.collectorImage]), delay);
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
      `type=bind,src=${configPath},dst=/tmp/m8.json,readonly`,
      policy.collectorImage,
      '--config=/tmp/m8.json',
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
    const { M8Metrics } = await import('./m8-metrics.js');
    const m8 = new M8Metrics();
    m8.recordBatch('failure', 'unknown', 5);
    m8.recordBatch('retry_scheduled', 'ephemeral_access', 5);
    m8.recordBatch('lease_lost', 'verification', 5);
    m8.recordHealthFailure();
    const health = (clear: boolean): Parameters<typeof m8.recordHealth>[1] =>
      Object.fromEntries(
        policy.phases.map((phase, index) => {
          const value = clear ? 0 : index + 1;
          return [
            phase,
            {
              records: value,
              leased: value,
              retrying: value,
              inconsistent: value,
              oldestAgeSeconds: value,
              dueAgeSeconds: value,
            },
          ];
        }),
      ) as Parameters<typeof m8.recordHealth>[1];
    m8.recordHealth(Date.now() - 1200000, health(false));
    const meter = metrics.getMeter('nakh-m8');
    const drift = meter.createGauge('nakh.m8.deletion.inconsistent');
    drift.record(77, { phase: 'rehearsal-private-phase' });
    drift.record(77, { phase: 'verification', user_id: 'rehearsal-private-user' });
    drift.record(77, { phase: 7 });
    drift.record(77, { phase: 'unknown' });
    drift.record(77);
    meter
      .createCounter('nakh.m8.deletion.batches')
      .add(77, { phase: 'verification', outcome: 'rehearsal-private-outcome' });
    meter.createGauge('nakh.m8.rehearsal-private-metric').record(77);
    metrics
      .getMeter('rehearsal-private-scope')
      .createGauge('nakh.m8.deletion.inconsistent')
      .record(77, { phase: 'verification' });
    metrics
      .getMeter('nakh-m8', 'rehearsal-private-version')
      .createGauge('nakh.m8.deletion.inconsistent')
      .record(77, { phase: 'verification' });
    metrics.getMeter('nakh-m7').createCounter('nakh.m7.reconciliation.failures').add(1);
    const legacy = metrics.getMeter('nakh-m1').createCounter('nakh.m1.collector_rehearsal');
    legacy.add(1);
    await provider.forceFlush();
    await delay(2000);
    m8.recordHealth(Date.now(), health(true));
    legacy.add(1);
    await provider.forceFlush();
    await delay(2000);
    const emf = records(await docker(['logs', name]));
    stage = 'evidence';
    assertEvidence(emf);
    await writeFile(
      resolve('artifacts/m8-telemetry-conversion.json'),
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
          m7MetricPreserved: true,
          cloudWatchDeliveryVerified: false,
          snsRoutingVerified: false,
        },
        null,
        2,
      ) + '\n',
    );
    console.log('M8 collector conversion verified; evidence contains fixed metadata only.');
  } finally {
    try {
      await provider?.shutdown();
    } finally {
      metrics.disable();
      if (started) await docker(['rm', '-f', name]);
    }
  }
}
await main().catch((error: unknown) => {
  // SDK/collector errors may contain payloads. Never print them or raw EMF.
  console.error(`M8 collector conversion failed at ${stage}; no metric payload was printed.`);
  if (stage === 'image-pull' || stage === 'startup')
    console.error(
      `Collector startup diagnostic: ${JSON.stringify(collectorStartupDiagnostic(error))}.`,
    );
  process.exitCode = 1;
});
