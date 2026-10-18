import manifest from '../deploy/runtime-product.json' with { type: 'json' };

function denied(): never {
  throw new Error('Product scanner composition unavailable.');
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 100) denied();
  return value.map(record);
}
/** Only this source-pinned, unprivileged, secret-free sidecar extends the fixed fleet. */
export function verifyProductScannerDefinition(
  name: string,
  containers: readonly unknown[],
): boolean {
  const definitions = containers.map(record),
    app = definitions.find((row) => row.name === name);
  if (app === undefined) denied();
  const flags = rows(app.environment).filter((row) => row.name === 'NAKH_MEDIA_INGESTION_ENABLED');
  if (
    flags.length > 1 ||
    (flags.length === 1 && !['true', 'false'].includes(String(flags[0]?.value)))
  )
    denied();
  const enabled = name === 'worker' && flags[0]?.value === 'true';
  const scanners = definitions.filter((row) => row.name === 'clamav');
  if (!enabled) {
    if (scanners.length !== 0) denied();
    return false;
  }
  if (scanners.length !== 1) denied();
  const scanner = scanners[0]!;
  const health = record(scanner.healthCheck),
    linux = record(scanner.linuxParameters),
    capabilities = record(linux.capabilities);
  if (
    scanner.image !== manifest.scanner.image ||
    scanner.user !== manifest.scanner.user ||
    scanner.essential !== true ||
    scanner.privileged === true ||
    scanner.readonlyRootFilesystem !== false ||
    JSON.stringify(scanner.entryPoint) !== JSON.stringify(manifest.scanner.entryPoint) ||
    JSON.stringify(health.command) !== JSON.stringify(manifest.scanner.healthCommand) ||
    health.interval !== 30 ||
    health.timeout !== 10 ||
    health.retries !== 10 ||
    health.startPeriod !== 300 ||
    linux.initProcessEnabled !== true ||
    JSON.stringify(capabilities.drop) !== '["ALL"]' ||
    (capabilities.add !== undefined && JSON.stringify(capabilities.add) !== '[]') ||
    JSON.stringify(scanner.environment) !==
      JSON.stringify([{ name: 'CLAMAV_NO_MILTERD', value: 'true' }]) ||
    ['secrets', 'command', 'portMappings', 'mountPoints'].some(
      (field) => scanner[field] !== undefined && JSON.stringify(scanner[field]) !== '[]',
    ) ||
    app.startTimeout !== 120 ||
    !rows(app.dependsOn).some(
      (row) => row.containerName === 'clamav' && row.condition === 'HEALTHY',
    )
  )
    denied();
  return true;
}
export function productScannerTaskHealthy(task: unknown): boolean {
  const t = record(task),
    scanners = rows(t.containers).filter((row) => row.name === 'clamav');
  const scanner = scanners[0];
  return (
    scanners.length === 1 &&
    t.healthStatus === 'HEALTHY' &&
    scanner?.lastStatus === 'RUNNING' &&
    scanner.healthStatus === 'HEALTHY' &&
    scanner.image === manifest.scanner.image &&
    scanner.imageDigest === manifest.scanner.image.split('@')[1]
  );
}
