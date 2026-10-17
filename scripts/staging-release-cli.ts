import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { archiveSha, archiveRef } from './release-archive.js';
import { setTimeout as delay } from 'node:timers/promises';
import { captureImageContext, parsePreparedImages, type ReleaseService } from './release-images.js';
import {
  StagingRelease,
  stagingBootstrapAdmission,
  type AwsReleaseCall,
  type StagingReleaseContext,
} from './staging-release.js';
import { stagingReleaseCustody } from './staging-release-custody.js';

const exec = promisify(execFile);
function denied(): never {
  throw new Error('Release operation unavailable.');
}
async function command(tool: string, args: readonly string[]): Promise<string> {
  const result = await exec(tool, [...args], {
    timeout: 120000,
    maxBuffer: 1048576,
    env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1' },
  });
  return result.stdout;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}
async function main(): Promise<void> {
  const [mode, ...extra] = process.argv.slice(2);
  if (
    ![
      'bootstrap',
      'drain',
      'migrate',
      'schema',
      'admission',
      'healthy',
      'complete',
      'maintain',
    ].includes(mode ?? '') ||
    extra.length !== 0 ||
    !process.env.GITHUB_ENV
  )
    denied();
  const accountId = process.env.RELEASE_AWS_ACCOUNT_ID ?? '',
    region = process.env.RELEASE_AWS_REGION ?? '',
    project = process.env.TF_VAR_project_name ?? 'nakh';
  if (
    !/^[0-9]{12}$/u.test(accountId) ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/u.test(region) ||
    !/^[a-z][a-z0-9-]{1,19}$/u.test(project)
  )
    denied();
  const awsJson = async (
    service: string,
    operation: string,
    input: Record<string, unknown>,
  ): Promise<unknown> =>
    JSON.parse(
      await command('aws', [
        service,
        operation,
        '--region',
        region,
        '--no-paginate',
        '--cli-input-json',
        JSON.stringify(input),
        '--output',
        'json',
      ]),
    ) as unknown;
  const identity = object(await awsJson('sts', 'get-caller-identity', {}));
  if (identity.Account !== accountId) denied();
  const outputs = object(
    JSON.parse(
      await command('terraform', ['-chdir=deploy/terraform/staging', 'output', '-json']),
    ) as unknown,
  );
  const output = (name: string): unknown => object(outputs[name]).value;
  if (mode === 'bootstrap') {
    const initialize = process.env.RELEASE_INITIALIZE === 'true';
    const stateNames = initialize
      ? await command('terraform', ['-chdir=deploy/terraform/staging', 'state', 'list'])
      : '';
    const clusters = initialize
      ? await awsJson('ecs', 'describe-clusters', { clusters: [project + '-staging'] })
      : undefined;
    stagingBootstrapAdmission({
      initialize,
      project,
      accountId,
      region,
      outputs,
      stateNames,
      clusters,
    });
    if (!process.env.GITHUB_OUTPUT) denied();
    await appendFile(
      process.env.GITHUB_OUTPUT,
      'bootstrap_required=' + String(initialize) + '\n',
      'utf8',
    );
    return;
  }
  if (
    output('aws_account_id') !== accountId ||
    output('aws_region') !== region ||
    output('ecs_cluster_name') !== project + '-staging'
  )
    denied();
  const sourceSha = process.env.IMAGE_TAG ?? '',
    runId = process.env.GITHUB_RUN_ID ?? '',
    attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (
    !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? '') ||
    (await command('git', ['rev-parse', 'HEAD'])).trim() !== process.env.GITHUB_SHA
  )
    denied();
  await command('git', ['diff', '--quiet', 'HEAD', '--']);
  const imageContext = captureImageContext({
    sourceSha,
    repository: process.env.GITHUB_REPOSITORY ?? '',
    accountId,
    region,
    buildId: runId + '-' + attempt,
    repositories: output('ecr_repository_urls') as Record<ReleaseService, string>,
  });
  const proof = object(
    JSON.parse(await readFile('artifacts/release-images.json', 'utf8')) as unknown,
  );
  if (proof.verified !== true || proof.verifier !== 'github-cli-slsa-source-workflow') denied();
  const images = parsePreparedImages(imageContext, {
    format: proof.format,
    sourceSha: proof.sourceSha,
    repository: proof.repository,
    images: proof.images,
  });
  const defaults = object(output('release_default_capacity'));
  const context: StagingReleaseContext = {
    sourceSha,
    controllerSha: process.env.GITHUB_SHA,
    archive: null,
    repository: imageContext.repository,
    accountId,
    region,
    cluster: project + '-staging',
    runId,
    attempt,
    images: Object.fromEntries(
      images.images.map((i) => [i.service, i.repositoryUri + '@' + i.digest]),
    ) as StagingReleaseContext['images'],
    defaultMin: Number(defaults.min),
    defaultMax: Number(defaults.max),
    secretArn: String(output('runtime_secret_arn')),
    subnets: output('private_subnet_ids') as string[],
    securityGroup: String(output('service_security_group_id')),
    bucket: String(output('release_evidence_bucket')),
  };
  await mkdir('artifacts', { recursive: true });
  if (process.env.RELEASE_ARCHIVE_REQUIRED === 'true') {
    const proofPath = resolve('artifacts/release-archive-verified.json');
    if ((await stat(proofPath)).size > 262144) denied();
    const archived = object(JSON.parse(await readFile(proofPath, 'utf8')) as unknown);
    if (
      archived.sourceSha !== sourceSha ||
      archived.controllerSha !== context.controllerSha ||
      archived.repository !== context.repository ||
      archived.accountId !== accountId ||
      archived.region !== region ||
      archived.cluster !== context.cluster ||
      JSON.stringify(parsePreparedImages(imageContext, archived.images)) !==
        JSON.stringify(images) ||
      typeof archived.key !== 'string' ||
      typeof archived.sha256 !== 'string'
    )
      denied();
    archiveRef(archived.key, sourceSha);
    if (
      mode !== 'maintain' &&
      archiveSha(await readFile(resolve('artifacts/release-archive/manifest.json'))) !==
        archived.sha256
    )
      denied();
    (context as { archive: StagingReleaseContext['archive'] }).archive = {
      key: archived.key,
      sha256: archived.sha256,
    };
  }
  const protectedCustody = stagingReleaseCustody(context, command, 'artifacts');
  const intentKey = `releases/${sourceSha}/${runId}/${attempt}/intent.json`;
  const cache = resolve('artifacts', `release-intent-${sourceSha}-${runId}-${attempt}.json`);
  const custody = {
    put: protectedCustody.put,
    read: async (key: string): Promise<string | undefined> => {
      if (mode === 'maintain' && key === intentKey) {
        try {
          return await readFile(cache, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      let body: string | undefined;
      try {
        body = await protectedCustody.read(key);
      } catch (error) {
        // A verified local intent may only keep this owned fleet OFF during a
        // custody outage. Admission and recovery never use a cached cloud read.
        if (mode === 'maintain' && key === intentKey) return readFile(cache, 'utf8');
        throw error;
      }
      if (key === intentKey && body !== undefined) {
        try {
          await writeFile(cache, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            (await readFile(cache, 'utf8')) !== body
          )
            throw error;
        }
      }
      return body;
    },
  };
  const call: AwsReleaseCall = (service, operation, input) =>
    awsJson(service, operation, { ...input });
  const release = new StagingRelease(context, call, custody, () => delay(5000));
  if (mode === 'drain') await release.drain(process.env.RELEASE_RECOVERY_INTENT || undefined);
  else if (mode === 'migrate') {
    await release.task('migration', String(output('migration_task_definition_arn')));
    await release.task('compatibility', String(output('migration_task_definition_arn')));
  } else if (mode === 'schema')
    await release.task('compatibility', String(output('migration_task_definition_arn')));
  else if (mode === 'admission')
    await appendFile(
      process.env.GITHUB_ENV,
      'TF_VAR_release_capacity=' + JSON.stringify(await release.admission()) + '\n',
      'utf8',
    );
  else if (mode === 'healthy') await release.healthy();
  else if (mode === 'complete') await release.healthy(true);
  else await release.maintain();
  console.log(
    'Staging release phase verified: ' +
      mode +
      '. Private observations retained in release custody.',
  );
}
try {
  await main();
} catch {
  console.error(
    'Staging release stopped. Keep services in maintenance and inspect protected release evidence; provider details withheld.',
  );
  process.exitCode = 1;
}
