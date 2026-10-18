/** A tolerated first transport failure never waives the required source receipt.
 * The aggregate job separately authenticates its exact source, attempt and bytes. */
export function requireNativeArtifactUpload(primary: unknown, retry: unknown): void {
  const outcomes = new Set(['success', 'failure', 'cancelled', 'skipped']);
  if (
    typeof primary !== 'string' ||
    !outcomes.has(primary) ||
    typeof retry !== 'string' ||
    !outcomes.has(retry) ||
    (primary !== 'success' && retry !== 'success')
  )
    throw new Error('Native source receipt upload incomplete.');
}
