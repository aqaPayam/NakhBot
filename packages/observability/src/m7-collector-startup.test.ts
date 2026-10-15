import { describe, expect, it } from 'vitest';
import {
  classifyCollectorStartupFailure,
  collectorStartupDiagnostic,
  pullCollectorImage,
} from './m7-collector-startup.js';

describe('privacy-safe bounded collector image startup', () => {
  it('preserves the original throttle and stops immediately when a retry sampler is invalid', async () => {
    for (const sample of [-1, 1, NaN, Infinity]) {
      const failure = Object.assign(new Error('fixture'), { stderr: '429 Too Many Requests' }),
        waits: number[] = [];
      let attempts = 0;
      await expect(
        pullCollectorImage(
          () => {
            attempts++;
            return Promise.reject(failure);
          },
          (ms) => {
            waits.push(ms);
            return Promise.resolve();
          },
          () => sample,
        ),
      ).rejects.toBe(failure);
      expect(attempts).toBe(1);
      expect(waits).toEqual([]);
    }
  });
  it('gives a confirmed registry throttle time to refill while retaining exactly three attempts', async () => {
    let attempts = 0;
    const waits: number[] = [];
    await pullCollectorImage(
      () =>
        ++attempts < 3
          ? Promise.reject(
              Object.assign(new Error('fixture'), { stderr: 'toomanyrequests: Rate exceeded' }),
            )
          : Promise.resolve(),
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      () => 0,
    );
    expect(attempts).toBe(3);
    expect(waits).toEqual([15000, 30000]);
  });
  it('bounds throttle jitter and still fails after three persistent throttles without retrying conversion', async () => {
    const failure = Object.assign(new Error('fixture'), { stderr: '429 toomanyrequests; 503' }),
      waits: number[] = [];
    let attempts = 0;
    await expect(
      pullCollectorImage(
        () => {
          attempts++;
          return Promise.reject(failure);
        },
        (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
        () => 0.9999,
      ),
    ).rejects.toBe(failure);
    expect(attempts).toBe(3);
    expect(waits).toEqual([19999, 34999]);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(55000);
  });
  it.each([
    ['toomanyrequests: Rate exceeded', 'collector_registry_transient', true],
    ['Rate exceeded', 'collector_registry_transient', true],
    ['lookup registry: no such host', 'collector_registry_transient', true],
    ['lookup registry: server misbehaving', 'collector_registry_transient', true],
    ['connection timed out', 'collector_registry_transient', true],
    ['digest mismatch; 503', 'collector_startup_unknown', false],
    ['error getting credentials; 503', 'collector_startup_unknown', false],
    ['503 Service Unavailable', 'collector_registry_transient', true],
    ['500 Internal Server Error', 'collector_registry_transient', true],
    ['net/http: request canceled', 'collector_registry_transient', true],
    ['timeout awaiting response headers', 'collector_registry_transient', true],
    ['network is unreachable', 'collector_registry_transient', true],
    ['connection refused', 'collector_registry_transient', true],
    ['connection aborted', 'collector_registry_transient', true],
    ['operation timed out', 'collector_registry_transient', true],
    ['read: EOF', 'collector_registry_transient', true],
    ['no matching manifest for linux/amd64', 'collector_image_missing', false],
    ['denied: invalid authorization token; 500', 'collector_registry_denied', false],
    ['no space left on device; 503', 'collector_startup_unknown', false],
    ['x509: certificate signed by unknown authority; timeout', 'collector_startup_unknown', false],
    ['429 Too Many Requests', 'collector_registry_transient', true],
    ['TLS handshake timeout', 'collector_registry_transient', true],
    ['read: connection reset by peer', 'collector_registry_transient', true],
    ['manifest unknown', 'collector_image_missing', false],
    ['401 unauthorized', 'collector_registry_denied', false],
    ['403 access denied after connection reset', 'collector_registry_denied', false],
    ['port is already allocated', 'collector_runtime_collision', false],
    ['Cannot connect to the Docker daemon', 'collector_runtime_unavailable', false],
    ['unrecognized private diagnostic', 'collector_startup_unknown', false],
  ])('classifies %s without copying diagnostics', (diagnostic, code, retryable) => {
    const result = classifyCollectorStartupFailure({
      stderr: `${diagnostic}; private-marker Authorization=private-bearer`,
      stdout: 'private-payload',
    });
    expect(result).toEqual({ code, retryable });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('recognizes executable and timeout failures using fixed metadata', () => {
    expect(classifyCollectorStartupFailure({ code: 'ENOENT', stderr: 'private' })).toEqual({
      code: 'collector_runtime_unavailable',
      retryable: false,
    });
    expect(classifyCollectorStartupFailure({ killed: true, stderr: 'private' })).toEqual({
      code: 'collector_registry_transient',
      retryable: true,
    });
    expect(classifyCollectorStartupFailure('private')).toEqual({
      code: 'collector_startup_unknown',
      retryable: false,
    });
  });
  it('classifies stdout-only pull failures while preserving denial precedence', () => {
    expect(
      classifyCollectorStartupFailure({
        stdout: '503 Service Unavailable; Authorization=private-marker',
        stderr: '',
      }),
    ).toEqual({ code: 'collector_registry_transient', retryable: true });
    expect(
      classifyCollectorStartupFailure({
        stdout: 'connection reset',
        stderr: '403 access denied; private-marker',
      }),
    ).toEqual({ code: 'collector_registry_denied', retryable: false });
    expect(
      classifyCollectorStartupFailure({
        stdout: 'manifest unknown; private-marker',
        stderr: '503 Service Unavailable',
      }),
    ).toEqual({ code: 'collector_image_missing', retryable: false });
  });
  it('reports only bounded exit metadata and channel presence for unknown failures', () => {
    const diagnostic = collectorStartupDiagnostic({
      code: 1,
      killed: false,
      stdout: 'private-payload',
      stderr: 'private-bearer',
      message: 'private-stack',
      cmd: 'private-command',
      endpoint: 'private-endpoint',
    });
    expect(diagnostic).toEqual({
      classification: 'collector_startup_unknown',
      retryable: false,
      exitCode: 1,
      killed: false,
      stdoutPresent: true,
      stderrPresent: true,
      failureKind: 'unknown',
      indicators: [],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private');
    for (const code of [-1, 256, 1.5, Infinity, 'private-code', undefined])
      expect(collectorStartupDiagnostic({ code }).exitCode).toBeNull();
    expect(collectorStartupDiagnostic('private-error')).toEqual({
      classification: 'collector_startup_unknown',
      retryable: false,
      exitCode: null,
      killed: false,
      stdoutPresent: false,
      stderrPresent: false,
      failureKind: 'unknown',
      indicators: [],
    });
  });
  it.each([
    ['toomanyrequests: Rate exceeded', 'registry_rate_limited'],
    ['lookup registry: server misbehaving', 'registry_dns_unavailable'],
    ['digest mismatch; 503', 'image_integrity_failed'],
    ['error storing credentials; 503', 'runtime_credentials_failed'],
    ['500 Internal Server Error', 'registry_server_error'],
    ['request canceled', 'network_interrupted'],
    ['no space left on device', 'runtime_storage_exhausted'],
    ['x509: certificate signed by unknown authority', 'tls_verification_failed'],
    ['no matching manifest for linux/amd64', 'image_platform_unsupported'],
  ])('exposes only a fixed failure kind for %s', (stderr, failureKind) => {
    const result = collectorStartupDiagnostic({
      code: 1,
      stderr: `${stderr}; private-token=https://private-endpoint`,
      stdout: 'private-payload',
    });
    expect(result.failureKind).toBe(failureKind);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('reports only finite indicators while unknown failures still stop after one attempt', async () => {
    const failure = Object.assign(new Error('startup fixture'), {
      code: 1,
      stdout: 'private-output',
      stderr:
        'Error response from daemon: failed to resolve reference: failed to fetch anonymous token: unexpected status; ' +
        'failed to register layer; unsupported media type; proxyconnect; tls: internal error; ' +
        'Authorization=private-bearer https://private-endpoint/user-body',
    });
    const result = collectorStartupDiagnostic(failure);
    expect(result).toMatchObject({
      classification: 'collector_startup_unknown',
      retryable: false,
      failureKind: 'unknown',
      indicators: [
        'resolve_reference',
        'anonymous_token',
        'unexpected_status',
        'daemon_response',
        'layer_registration',
        'media_type',
        'proxy',
        'tls_internal',
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/private|Authorization|https/u);
    let attempts = 0;
    await expect(
      pullCollectorImage(
        () => {
          attempts++;
          return Promise.reject(failure);
        },
        () => Promise.reject(new Error('must not retry')),
      ),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
  it('preserves a denial anywhere in buffered process output before retryable transport text', () => {
    expect(
      classifyCollectorStartupFailure({
        stderr: `403 access denied ${'private-marker '.repeat(2000)}`,
        stdout: '503 Service Unavailable',
      }),
    ).toEqual({ code: 'collector_registry_denied', retryable: false });
  });
  it.each(['503 Service Unavailable', '500 Internal Server Error', 'request canceled'])(
    'recovers %s with at most three attempts',
    async (stderr) => {
      let attempts = 0;
      const waits: number[] = [];
      await pullCollectorImage(
        () => {
          if (++attempts < 3)
            return Promise.reject(
              Object.assign(new Error('Collector startup fixture'), {
                stderr,
              }),
            );
          return Promise.resolve();
        },
        (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      );
      expect(attempts).toBe(3);
      expect(waits).toEqual([1000, 2000]);
    },
  );
  it('fails closed immediately for denied, missing and unknown images', async () => {
    for (const stderr of ['403 access denied', 'manifest unknown', 'private unknown diagnostic']) {
      let attempts = 0;
      const failure = Object.assign(new Error('Collector startup fixture'), { stderr }),
        waits: number[] = [];
      await expect(
        pullCollectorImage(
          () => {
            attempts++;
            return Promise.reject(failure);
          },
          (ms) => {
            waits.push(ms);
            return Promise.resolve();
          },
        ),
      ).rejects.toBe(failure);
      expect(attempts).toBe(1);
      expect(waits).toEqual([]);
    }
  });
  it('stops after three transient failures instead of hiding a broken dependency', async () => {
    let attempts = 0;
    const failure = Object.assign(new Error('Collector startup fixture'), {
        stderr: 'connection reset',
      }),
      waits: number[] = [];
    await expect(
      pullCollectorImage(
        () => {
          attempts++;
          return Promise.reject(failure);
        },
        (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      ),
    ).rejects.toBe(failure);
    expect(attempts).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });
});
