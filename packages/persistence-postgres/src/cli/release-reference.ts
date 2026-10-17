import { execFileSync } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from '@nakh/config';
import { createDatabase, type NakhDatabase } from '../database.js';
import {
  PostgresReleaseReferenceStore,
  sourceMigrationDigests,
  referenceDigest,
  canonicalReference,
  compareReleaseReference,
} from '../release-reference.js';

let database: NakhDatabase | undefined;
try {
  const [action, file, ...extra] = process.argv.slice(2);
  if (
    (action !== '--capture' && action !== '--verify') ||
    file === undefined ||
    !isAbsolute(file) ||
    extra.length !== 0
  )
    throw new Error('Invalid invocation.');
  const config = loadConfig();
  if (config.environment !== 'staging' && config.environment !== 'production')
    throw new Error('Release environment required.');
  if (!['api', 'telegram-gateway', 'worker', 'scheduler'].includes(config.serviceName))
    throw new Error('Release service required.');
  // Run from a clean source checkout after pnpm build. Image/deployment
  // provenance and human approval are separate release conditions.
  if (
    execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() !== config.release ||
    execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() !== ''
  )
    throw new Error('Source unavailable.');
  // Validate the expected file before opening any database connection.
  if (action === '--verify' && (await stat(file)).size > 16 * 1024 * 1024)
    throw new Error('Reference too large.');
  const expected: unknown =
    action === '--verify' ? JSON.parse(await readFile(file, 'utf8')) : undefined;
  if (action === '--verify') referenceDigest(expected);
  const migrations = await sourceMigrationDigests(resolve('migrations'));
  const trackedMigrations = execFileSync('git', ['ls-files', '-z', '--', 'migrations'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter((name) => /^migrations\/\d{6}_[a-z0-9_]+\.sql$/u.test(name))
    .map((name) => name.slice('migrations/'.length))
    .sort();
  if (
    canonicalReference(trackedMigrations) !==
    canonicalReference(migrations.map((row) => row.name).sort())
  )
    throw new Error('Source migration inventory unavailable.');
  database = createDatabase(config.database);
  const snapshot = await new PostgresReleaseReferenceStore(database).capture(config, migrations);
  if (action === '--capture') {
    // This contains administrator bindings: keep it in protected operator
    // custody. Never upload it as a public CI artifact or overwrite approval.
    const body = JSON.stringify(snapshot, null, 2) + '\n';
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error('Reference too large.');
    await writeFile(file, body, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        captured: true,
        sourceSha: snapshot.sourceSha,
        environment: snapshot.environment,
        service: snapshot.service,
        digest: referenceDigest(snapshot),
        tables: Object.keys(snapshot.native).length,
      }),
    );
  } else {
    const receipt = compareReleaseReference(snapshot, expected);
    console.log(
      JSON.stringify({
        ...receipt,
        sourceSha: snapshot.sourceSha,
        environment: snapshot.environment,
        service: snapshot.service,
      }),
    );
    if (!receipt.matches) process.exitCode = 1;
  }
} catch {
  console.error('Release reference verification failed. No activation or approval is authorized.');
  process.exitCode = 1;
} finally {
  await database?.destroy().catch(() => {
    process.exitCode = 1;
  });
}
