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

/** Docker startup precedes all metric export. Return a fixed allowlist, never
 * stderr, provider endpoints, credentials, configuration or payload fragments. */
export function classifyCollectorStartupFailure(error: unknown): CollectorStartupFailure {
  const failure =
    typeof error === 'object' && error !== null ? (error as Readonly<Record<string, unknown>>) : {};
  const diagnostic = typeof failure.stderr === 'string' ? failure.stderr : '';
  if (
    failure.code === 'ENOENT' ||
    failure.code === 'EACCES' ||
    /cannot connect to the docker daemon/iu.test(diagnostic)
  )
    return { code: 'collector_runtime_unavailable', retryable: false };
  if (/already in use|port is already allocated/iu.test(diagnostic))
    return { code: 'collector_runtime_collision', retryable: false };
  if (/unauthorized|authentication required|access denied|\b40[13]\b/iu.test(diagnostic))
    return { code: 'collector_registry_denied', retryable: false };
  if (/manifest unknown|manifest.*not found|\b404\b/iu.test(diagnostic))
    return { code: 'collector_image_missing', retryable: false };
  if (
    failure.killed === true ||
    /\b(?:429|502|503|504)\b|too many requests|connection reset|tls handshake timeout|i\/o timeout|temporary failure in name resolution|context deadline exceeded|unexpected eof/iu.test(
      diagnostic,
    )
  )
    return { code: 'collector_registry_transient', retryable: true };
  return { code: 'collector_startup_unknown', retryable: false };
}

/** Retry only recognized transient public-image pulls. Container startup and
 * all SDK/conversion/privacy assertions still execute once and fail closed. */
export async function pullCollectorImage(
  pull: () => Promise<unknown>,
  wait: (milliseconds: number) => Promise<unknown>,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pull();
      return;
    } catch (error) {
      if (attempt === 2 || !classifyCollectorStartupFailure(error).retryable) throw error;
      await wait(1000 * 2 ** attempt);
    }
  }
}
