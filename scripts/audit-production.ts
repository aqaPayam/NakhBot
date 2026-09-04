import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

type PackageCoordinate = Readonly<{ name: string; version: string }>;
type Finding = Readonly<{ package: PackageCoordinate; id: string; severity: string }>;

const NETWORK_FAILURE =
  /TimeoutError|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|ERR_PNPM_META_FETCH_FAIL|error \(23\)|operation was aborted/i;

function extractPackages(lockfile: string): PackageCoordinate[] {
  const packagesStart = lockfile.indexOf('\npackages:\n');
  const snapshotsStart = lockfile.indexOf('\nsnapshots:\n');
  if (packagesStart < 0 || snapshotsStart <= packagesStart) {
    throw new Error('Unable to locate packages and snapshots sections in pnpm-lock.yaml.');
  }

  const packageSection = lockfile.slice(packagesStart, snapshotsStart);
  const entries = packageSection.matchAll(/^ {2}('?)([^'\r\n]+)\1:\r?$/gm);
  const coordinates = new Map<string, PackageCoordinate>();

  for (const entry of entries) {
    const key = entry[2];
    if (key === undefined) continue;
    const versionSeparator = key.lastIndexOf('@');
    if (versionSeparator <= 0) continue;

    const name = key.slice(0, versionSeparator);
    const version = key.slice(versionSeparator + 1).split('(', 1)[0];
    if (version === undefined || version === '' || name.startsWith('@nakh/')) continue;

    coordinates.set(`${name}@${version}`, { name, version });
  }

  if (coordinates.size === 0) {
    throw new Error('No registry packages were extracted from pnpm-lock.yaml.');
  }
  return [...coordinates.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function vulnerabilitySeverity(vulnerability: Record<string, unknown>): string {
  const databaseSpecific = vulnerability['database_specific'];
  if (isRecord(databaseSpecific) && typeof databaseSpecific['severity'] === 'string') {
    return databaseSpecific['severity'].toUpperCase();
  }
  return 'UNKNOWN';
}

function collectFindings(body: unknown, packages: readonly PackageCoordinate[]): Finding[] {
  if (!isRecord(body) || !Array.isArray(body['results'])) {
    throw new Error('OSV returned an unexpected response.');
  }

  const findings: Finding[] = [];
  body['results'].forEach((result: unknown, index: number) => {
    if (!isRecord(result) || !Array.isArray(result['vulns'])) return;
    const packageCoordinate = packages[index];
    if (packageCoordinate === undefined) return;

    for (const vulnerability of result['vulns']) {
      if (!isRecord(vulnerability) || typeof vulnerability['id'] !== 'string') continue;
      findings.push({
        package: packageCoordinate,
        id: vulnerability['id'],
        severity: vulnerabilitySeverity(vulnerability),
      });
    }
  });
  return findings;
}

async function resolveMissingSeverities(findings: readonly Finding[]): Promise<Finding[]> {
  const unknownIds = [
    ...new Set(
      findings.filter((finding) => finding.severity === 'UNKNOWN').map((finding) => finding.id),
    ),
  ];
  const severities = new Map<string, string>();

  await Promise.all(
    unknownIds.map(async (id) => {
      const response = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`OSV vulnerability lookup failed with HTTP ${String(response.status)}.`);
      }
      const vulnerability: unknown = await response.json();
      if (!isRecord(vulnerability)) {
        throw new Error('OSV returned an unexpected vulnerability response.');
      }
      severities.set(id, vulnerabilitySeverity(vulnerability));
    }),
  );

  return findings.map((finding) => ({
    ...finding,
    severity: severities.get(finding.id) ?? finding.severity,
  }));
}

async function auditWithOsv(): Promise<void> {
  const packages = extractPackages(await readFile('pnpm-lock.yaml', 'utf8'));
  process.stdout.write(
    `npm advisory service unavailable; checking ${String(packages.length)} locked packages with OSV.\n`,
  );

  const response = await fetch('https://api.osv.dev/v1/querybatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      queries: packages.map((item) => ({
        package: { ecosystem: 'npm', name: item.name },
        version: item.version,
      })),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`OSV audit failed with HTTP ${String(response.status)}.`);
  }

  const findings = await resolveMissingSeverities(collectFindings(await response.json(), packages));
  const blockingFindings = findings.filter((finding) =>
    ['HIGH', 'CRITICAL', 'UNKNOWN'].includes(finding.severity),
  );
  if (blockingFindings.length > 0) {
    for (const finding of blockingFindings) {
      process.stderr.write(
        `${finding.id} (${finding.severity}): ${finding.package.name}@${finding.package.version}\n`,
      );
    }
    throw new Error(
      `OSV found ${String(blockingFindings.length)} high, critical, or unclassified vulnerable locked package entries.`,
    );
  }

  process.stdout.write(
    `OSV found no high or critical vulnerabilities; ${String(findings.length)} lower-severity finding(s) were reported.\n`,
  );
}

const pnpmCli = process.env['npm_execpath'];
const auditCommand = pnpmCli === undefined ? 'pnpm' : process.execPath;
const auditArguments = [
  ...(pnpmCli === undefined ? [] : [pnpmCli]),
  'audit',
  '--prod',
  '--audit-level',
  'high',
  '--fetch-retries=0',
  '--fetch-timeout=30000',
];
const audit = spawnSync(auditCommand, auditArguments, {
  encoding: 'utf8',
  timeout: 45_000,
  env: {
    ...process.env,
    npm_config_fetch_retries: '1',
    npm_config_fetch_retry_maxtimeout: '10_000',
    npm_config_fetch_timeout: '30_000',
  },
});
const auditOutput = `${audit.stdout ?? ''}${audit.stderr ?? ''}`;
process.stdout.write(auditOutput);

const auditTimedOut = isRecord(audit.error) && audit.error['code'] === 'ETIMEDOUT';
if (audit.error !== undefined && !auditTimedOut) throw audit.error;
if (audit.status === 0) {
  process.stdout.write('pnpm production dependency audit passed.\n');
} else if (auditTimedOut || NETWORK_FAILURE.test(auditOutput)) {
  await auditWithOsv();
} else {
  process.exitCode = audit.status ?? 1;
}
