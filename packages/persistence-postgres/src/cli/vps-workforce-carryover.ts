import { isAbsolute, resolve } from 'node:path';
import { resolveSecretReference } from '@nakh/config';
import { createDatabase, type NakhDatabase } from '../database.js';
import { sourceMigrationDigests } from '../migrations.js';
import {
  PostgresWorkforceCarryover,
  type WorkforceCarryoverRequest,
} from '../workforce-carryover-store.js';
import {
  readVpsPrivateJson,
  reserveVpsPrivateOutput,
  requireVpsRoot,
} from '../vps-private-files.js';

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}
/** A stopped-source maintenance step, never a web endpoint. The host separately
 * records fleet quiescence, backup custody and the source-floor recheck, and
 * must keep the source stopped before it admits any target traffic. */
async function main(): Promise<void> {
  requireVpsRoot();
  const paths = process.argv.slice(2);
  if (paths.length !== 3 || !paths.every(isAbsolute) || new Set(paths).size !== 3)
    throw new Error();
  const input = record(await readVpsPrivateJson(paths[0]!, 262144));
  const accepted = record(await readVpsPrivateJson(paths[1]!));
  const expected = [
    'version',
    'commandId',
    'operatorId',
    'sourceSha',
    'targetSha',
    'adminIds',
    'sourceMigrations',
    'targetMigrations',
    'sourceUrlRef',
    'targetUrlRef',
  ].sort();
  if (
    Object.keys(input).sort().join(',') !== expected.join(',') ||
    typeof input.sourceUrlRef !== 'string' ||
    typeof input.targetUrlRef !== 'string' ||
    input.sourceUrlRef === input.targetUrlRef ||
    typeof input.targetSha !== 'string' ||
    process.env.NAKH_RELEASE !== input.targetSha ||
    accepted.sourceSha !== input.targetSha ||
    accepted.allSixJobsPassed !== true ||
    !Array.isArray(accepted.artifacts) ||
    accepted.artifacts.length !== 10
  )
    throw new Error();
  const { sourceUrlRef, targetUrlRef, ...body } = input;
  const request = body as WorkforceCarryoverRequest;
  if (
    JSON.stringify(request.targetMigrations?.map(({ name, sha256 }) => ({ name, sha256 }))) !==
    JSON.stringify(await sourceMigrationDigests(resolve('migrations')))
  )
    throw new Error();
  const output = await reserveVpsPrivateOutput(paths[2]!);
  let source: NakhDatabase | undefined, target: NakhDatabase | undefined;
  try {
    source = createDatabase({
      url: resolveSecretReference(sourceUrlRef),
      poolMax: 2,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    target = createDatabase({
      url: resolveSecretReference(targetUrlRef),
      poolMax: 2,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    const result = await new PostgresWorkforceCarryover(source, target).execute(request);
    await output.writeFile(
      JSON.stringify({
        schemaVersion: 1,
        operatorSourceSha: request.targetSha,
        sourceApplicationSha: request.sourceSha,
        ...result,
      }) + '\n',
    );
    await output.sync();
  } finally {
    await output.close();
    await source?.destroy();
    await target?.destroy();
  }
  process.stdout.write('Workforce carryover recorded.\n');
}
main().catch(() => {
  process.stderr.write('Workforce carryover operator unavailable.\n');
  process.exitCode = 1;
});
