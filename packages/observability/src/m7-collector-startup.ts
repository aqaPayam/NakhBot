export type CollectorStartupFailure = Readonly<{
  code:
    | 'collector_registry_transient'
    | 'collector_registry_denied'
    | 'collector_image_missing'
    | 'collector_runtime_unavailable'
    | 'collector_runtime_collision'
    | 'collector_startup_unknown';
  retryable: boolean;
}>;

type StartupFailureKind =
  | 'registry_denied'
  | 'image_missing'
  | 'image_platform_unsupported'
  | 'runtime_storage_exhausted'
  | 'tls_verification_failed'
  | 'registry_server_error'
  | 'registry_rate_limited'
  | 'registry_dns_unavailable'
  | 'image_integrity_failed'
  | 'runtime_credentials_failed'
  | 'network_interrupted'
  | 'unknown';

/** A finite diagnostic vocabulary; never echo even pre-export process output. */
function startupFailureKind(diagnostic: string): StartupFailureKind {
  if (/unauthorized|authentication required|access denied|\bdenied\b|\b40[13]\b/iu.test(diagnostic))
    return 'registry_denied';
  if (/no matching manifest/iu.test(diagnostic)) return 'image_platform_unsupported';
  if (/manifest unknown|manifest.*not found|\b404\b/iu.test(diagnostic)) return 'image_missing';
  if (/no space left on device|disk quota exceeded/iu.test(diagnostic))
    return 'runtime_storage_exhausted';
  if (/x509:|certificate.*(?:expired|not trusted|unknown authority)/iu.test(diagnostic))
    return 'tls_verification_failed';
  if (/digest mismatch|checksum mismatch|filesystem layer verification failed/iu.test(diagnostic))
    return 'image_integrity_failed';
  if (/error (?:getting|saving|storing) credentials|credentials store.*error/iu.test(diagnostic))
    return 'runtime_credentials_failed';
  if (/\b429\b|too\s*many\s*requests|\brate exceeded\b/iu.test(diagnostic))
    return 'registry_rate_limited';
  if (/\b(?:500|502|503|504)\b/iu.test(diagnostic)) return 'registry_server_error';
  if (/no such host|server misbehaving|temporary failure in name resolution/iu.test(diagnostic))
    return 'registry_dns_unavailable';
  if (
    /connection reset|connection refused|connection aborted|network is unreachable|tls handshake timeout|i\/o timeout|(?:connection|operation) timed out|timeout awaiting response headers|context deadline exceeded|request canceled|\beof\b/iu.test(
      diagnostic,
    )
  )
    return 'network_interrupted';
  return 'unknown';
}

/** Docker startup precedes all metric export. Return a fixed allowlist, never
 * stderr, provider endpoints, credentials, configuration or payload fragments. */
export function classifyCollectorStartupFailure(error: unknown): CollectorStartupFailure {
  const failure =
    typeof error === 'object' && error !== null ? (error as Readonly<Record<string, unknown>>) : {};
  const diagnostic = [failure.stderr, failure.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  if (
    failure.code === 'ENOENT' ||
    failure.code === 'EACCES' ||
    /cannot connect to the docker daemon/iu.test(diagnostic)
  )
    return { code: 'collector_runtime_unavailable', retryable: false };
  if (/already in use|port is already allocated/iu.test(diagnostic))
    return { code: 'collector_runtime_collision', retryable: false };
  const kind = startupFailureKind(diagnostic);
  if (kind === 'registry_denied') return { code: 'collector_registry_denied', retryable: false };
  if (kind === 'image_missing' || kind === 'image_platform_unsupported')
    return { code: 'collector_image_missing', retryable: false };
  if (
    kind === 'runtime_storage_exhausted' ||
    kind === 'tls_verification_failed' ||
    kind === 'image_integrity_failed' ||
    kind === 'runtime_credentials_failed'
  )
    return { code: 'collector_startup_unknown', retryable: false };
  if (
    failure.killed === true ||
    kind === 'registry_server_error' ||
    kind === 'registry_rate_limited' ||
    kind === 'registry_dns_unavailable' ||
    kind === 'network_interrupted'
  )
    return { code: 'collector_registry_transient', retryable: true };
  return { code: 'collector_startup_unknown', retryable: false };
}

/** Only fixed fields from process metadata leave the pre-export startup path. */
export function collectorStartupDiagnostic(error: unknown): Readonly<{
  classification: CollectorStartupFailure['code'];
  retryable: boolean;
  exitCode: number | null;
  killed: boolean;
  stdoutPresent: boolean;
  stderrPresent: boolean;
  failureKind: StartupFailureKind;
  /** Fixed lexical indicators help diagnose an otherwise unknown pre-export
   * pull failure without retaining any process text, endpoint or credential. */
  indicators: readonly string[];
}> {
  const failure =
    typeof error === 'object' && error !== null ? (error as Readonly<Record<string, unknown>>) : {};
  const classified = classifyCollectorStartupFailure(error);
  return {
    classification: classified.code,
    retryable: classified.retryable,
    exitCode:
      typeof failure.code === 'number' &&
      Number.isInteger(failure.code) &&
      failure.code >= 0 &&
      failure.code <= 255
        ? failure.code
        : null,
    killed: failure.killed === true,
    stdoutPresent: typeof failure.stdout === 'string' && failure.stdout.length > 0,
    stderrPresent: typeof failure.stderr === 'string' && failure.stderr.length > 0,
    failureKind: startupFailureKind(
      [failure.stderr, failure.stdout]
        .filter((value): value is string => typeof value === 'string')
        .join('\n'),
    ),
    indicators: startupIndicators(failure),
  };
}

const STARTUP_INDICATORS = [
  ['resolve_reference', /failed to resolve (?:reference|source metadata)/iu],
  ['anonymous_token', /failed to fetch anonymous token/iu],
  ['unexpected_status', /unexpected (?:http )?status/iu],
  ['daemon_response', /error response from daemon/iu],
  ['layer_registration', /failed to (?:register|extract) layer/iu],
  ['media_type', /unsupported media type|unexpected media type/iu],
  ['proxy', /proxyconnect|proxy error/iu],
  ['tls_internal', /tls: internal error|tls: handshake failure/iu],
] as const;
function startupIndicators(failure: Readonly<Record<string, unknown>>): readonly string[] {
  const text = [failure.stderr, failure.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return STARTUP_INDICATORS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/** Retry only recognized transient public-image pulls. Container startup and
 * all SDK/conversion/privacy assertions still execute once and fail closed. */
export async function pullCollectorImage(
  pull: () => Promise<unknown>,
  wait: (milliseconds: number) => Promise<unknown>,
  random: () => number = Math.random,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pull();
      return;
    } catch (error) {
      if (attempt === 2 || !classifyCollectorStartupFailure(error).retryable) throw error;
      if (collectorStartupDiagnostic(error).failureKind === 'registry_rate_limited') {
        // Shared public-registry quotas need time to refill. Add a bounded
        // spread so simultaneous runners do not all retry together. Still
        // exactly three pulls; startup and conversion assertions run once.
        const sample = random();
        if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw error;
        await wait(60000 * 2 ** attempt + Math.floor(sample * 15000));
      } else {
        await wait(1000 * 2 ** attempt);
      }
    }
  }
}
