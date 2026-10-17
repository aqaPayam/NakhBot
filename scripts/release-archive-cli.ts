import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  captureImageContext,
  parsePreparedImages,
  verifyArchiveAttestation,
  verifyReleaseImages,
  type ImageCommand,
  type ReleaseService,
  type PreparedReleaseImages,
} from './release-images.js';
import { readReleaseCi, readReleaseCiStatus } from './release-ci.js';
import { archiveGitHub } from './release-archive-github.js';
import {
  archivePrefix,
  archiveRef,
  archiveSha,
  archiveMatchesLatest,
  parseArchive,
  retainArchiveFiles,
  loadArchiveFiles,
  ARCHIVE_ROLES,
  type ReleaseArchive,
  type ArchiveVerification,
  sealArchive,
  restoreArchive,
} from './release-archive.js';
import { captureStagingContext, type StagingReleaseContext } from './staging-release.js';
import { stagingArchiveCustody } from './staging-release-custody.js';
const exec = promisify(execFile),
  directory = resolve('artifacts/release-archive');
function denied(): never {
  throw new Error('Archive operation unavailable.');
}
function obj(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}
async function command(tool: string, args: readonly string[]): Promise<string> {
  return (
    await exec(tool, [...args], {
      timeout: 120000,
      maxBuffer: 1048576,
      env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1', GH_PROMPT_DISABLED: 'true' },
    })
  ).stdout;
}
const imageCommand: ImageCommand = async (tool, args) => {
  try {
    return { code: 0, stdout: await command(tool, args), stderr: '' };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
    };
  }
};
async function local(name: string, bytes: Uint8Array): Promise<string> {
  const path = resolve(directory, name);
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      !(await readFile(path)).equals(Buffer.from(bytes))
    )
      throw error;
  }
  return path;
}
async function bounded(path: string): Promise<Buffer> {
  if ((await stat(path)).size > 1048576) denied();
  return readFile(path);
}
async function main(): Promise<void> {
  const [mode, ...extra] = process.argv.slice(2);
  if (
    !['prepare', 'seal', 'restore'].includes(mode ?? '') ||
    extra.length !== 0 ||
    !process.env.GITHUB_ENV
  )
    denied();
  const sourceSha = process.env.IMAGE_TAG ?? '',
    controllerSha = process.env.GITHUB_SHA ?? '',
    repository = process.env.GITHUB_REPOSITORY ?? '',
    runId = process.env.GITHUB_RUN_ID ?? '',
    attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (
    !/^[a-f0-9]{40}$/u.test(controllerSha) ||
    (mode !== 'restore' && sourceSha !== controllerSha) ||
    (await command('git', ['rev-parse', 'HEAD'])).trim() !== controllerSha
  )
    denied();
  await command('git', ['diff', '--quiet', 'HEAD', '--']);
  const region = process.env.RELEASE_AWS_REGION ?? '',
    accountId = process.env.RELEASE_AWS_ACCOUNT_ID ?? '';
  const outputs = obj(
      JSON.parse(
        await command('terraform', ['-chdir=deploy/terraform/staging', 'output', '-json']),
      ) as unknown,
    ),
    output = (name: string): unknown => obj(outputs[name]).value;
  if (output('aws_account_id') !== accountId || output('aws_region') !== region) denied();
  const identity = obj(
    JSON.parse(
      await command('aws', ['sts', 'get-caller-identity', '--region', region, '--output', 'json']),
    ) as unknown,
  );
  if (identity.Account !== accountId) denied();
  if (output('ecs_cluster_name') !== (process.env.TF_VAR_project_name ?? 'nakh') + '-staging')
    denied();
  const imageContext = captureImageContext({
    sourceSha,
    repository,
    accountId,
    region,
    buildId: runId + '-' + attempt,
    repositories: output('ecr_repository_urls') as Record<ReleaseService, string>,
  });
  const github = archiveGitHub(repository, process.env.GH_TOKEN ?? ''),
    scope = {
      sourceSha,
      controllerSha,
      repository,
      accountId,
      region,
      cluster: String(output('ecs_cluster_name')),
      runId,
      attempt,
    };
  await mkdir(directory, { recursive: true });
  let images: PreparedReleaseImages, prefix: string;
  const context = (prepared: PreparedReleaseImages): StagingReleaseContext =>
    captureStagingContext({
      ...scope,
      archive: null,
      images: Object.fromEntries(
        prepared.images.map((i) => [i.service, i.repositoryUri + '@' + i.digest]),
      ) as StagingReleaseContext['images'],
      defaultMin: Number(obj(output('release_default_capacity')).min),
      defaultMax: Number(obj(output('release_default_capacity')).max),
      secretArn: String(output('runtime_secret_arn')),
      subnets: output('private_subnet_ids') as string[],
      securityGroup: String(output('service_security_group_id')),
      bucket: String(output('release_evidence_bucket')),
    });
  const store = stagingArchiveCustody(
    { ...scope, bucket: String(output('release_evidence_bucket')) },
    command,
    directory,
  );
  const verifier: ArchiveVerification = {
    manifest: async (bytes, bundle) => {
      const path = await local('manifest.json', bytes),
        bundlePath = await local('manifest-bundle.jsonl', bundle);
      await verifyArchiveAttestation(
        imageContext,
        path,
        bundlePath,
        archiveSha(bytes),
        imageCommand,
      );
    },
    images: async (m, files) => {
      const prepared = parsePreparedImages(imageContext, m.images),
        paths = {} as Record<ReleaseService, string>;
      for (const image of prepared.images)
        paths[image.service] = await local(
          'image-' + image.service + '.jsonl',
          files.get('image-' + image.service + '.jsonl')!,
        );
      await verifyReleaseImages(imageContext, prepared, imageCommand, false, paths);
    },
    latest: () => readReleaseCiStatus({ repository, sha: sourceSha, now: new Date() }, github.json),
  };
  if (mode === 'prepare') {
    if (!process.env.GITHUB_OUTPUT) denied();
    const proof = obj(
      JSON.parse(
        await bounded(resolve('artifacts/release-images.json')).then((b) => b.toString('utf8')),
      ) as unknown,
    );
    if (proof.verified !== true || proof.verifier !== 'github-cli-slsa-source-workflow') denied();
    images = parsePreparedImages(imageContext, {
      format: proof.format,
      sourceSha: proof.sourceSha,
      repository: proof.repository,
      images: proof.images,
    });
    const c = context(images),
      ci = await readReleaseCi({ repository, sha: sourceSha, now: new Date() }, github.json);
    let prior: ReleaseArchive | undefined;
    try {
      prior = parseArchive(
        JSON.parse(
          (await bounded(resolve(directory, 'manifest.json'))).toString('utf8'),
        ) as unknown,
        scope,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let files: Map<string, Uint8Array>;
    const bundles = {} as Record<ReleaseService, string>;
    if (prior) {
      if (
        prior.producer.runId !== runId ||
        prior.producer.attempt !== attempt ||
        JSON.stringify(prior.images) !== JSON.stringify(images)
      )
        denied();
      archiveMatchesLatest(prior, ci);
      if (
        JSON.stringify([...prior.ci.artifacts].sort((a, b) => a.name.localeCompare(b.name))) !==
        JSON.stringify([...ci.artifacts].sort((a, b) => a.name.localeCompare(b.name)))
      )
        denied();
      files = await loadArchiveFiles(prior, archivePrefix(scope), store);
      for (const image of images.images)
        bundles[image.service] = await local(
          'image-' + image.service + '.jsonl',
          files.get('image-' + image.service + '.jsonl')!,
        );
    } else {
      files = new Map<string, Uint8Array>();
      for (const role of ARCHIVE_ROLES) {
        const artifact = ci.artifacts.find((a) => a.name === role + '-' + sourceSha);
        if (!artifact) denied();
        files.set('ci-' + role + '.zip', await github.download(artifact));
      }
      for (const image of images.images) {
        const response = obj(
          await github.json(
            `/repos/${repository}/attestations/${encodeURIComponent(image.digest)}?per_page=30`,
          ),
        );
        if (
          !Array.isArray(response.attestations) ||
          response.attestations.length < 1 ||
          response.attestations.length > 30
        )
          denied();
        const bytes = Buffer.from(
          (response.attestations as unknown[])
            .map((v) => JSON.stringify(obj(v).bundle))
            .join('\n') + '\n',
        );
        if (bytes.length > 1048576) denied();
        const name = 'image-' + image.service + '.jsonl';
        files.set(name, bytes);
        bundles[image.service] = await local(name, bytes);
      }
      const roots = Buffer.from(await command('gh', ['attestation', 'trusted-root']));
      if (roots.length < 1) denied();
      files.set('trusted-root.jsonl', roots);
    }
    await verifyReleaseImages(imageContext, images, imageCommand, false, bundles);
    const manifest = prior ?? (await retainArchiveFiles(c, ci, images, files, store));
    const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
    await local('manifest.json', bytes);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      process.env.GITHUB_OUTPUT,
      'manifest_digest=sha256:' + archiveSha(bytes) + '\n',
      'utf8',
    );
    console.log('Release archive prepared. Signed seal is required before drain.');
    return;
  }
  if (mode === 'seal') {
    const bytes = await bounded(resolve(directory, 'manifest.json'));
    const manifest = parseArchive(JSON.parse(bytes.toString('utf8')) as unknown, scope);
    images = parsePreparedImages(imageContext, manifest.images);
    if (manifest.producer.runId !== runId || manifest.producer.attempt !== attempt) denied();
    prefix = archivePrefix(scope);
    const storedManifest = await store.read(prefix + 'manifest.json');
    if (storedManifest && !storedManifest.equals(bytes)) denied();
    const existingBundle = await store.read(prefix + 'manifest-bundle.jsonl');
    if (existingBundle && !storedManifest) denied();
    const bundle = existingBundle ?? (await bounded(process.env.ARCHIVE_BUNDLE_PATH ?? ''));
    await sealArchive(scope, bytes, bundle, store, verifier);
  } else {
    prefix = archiveRef(process.env.RELEASE_ARCHIVE_REF ?? '', sourceSha);
    // Read the known manifest using current scoped output repositories; no
    // manifest-supplied network/account/secret values authorize provider access.
    const bytes = await store.read(prefix + 'manifest.json'),
      bundle = await store.read(prefix + 'manifest-bundle.jsonl');
    if (!bytes || !bundle) denied();
    const manifest = await restoreArchive(
      scope,
      process.env.RELEASE_ARCHIVE_REF!,
      bytes,
      bundle,
      store,
      verifier,
    );
    images = parsePreparedImages(imageContext, manifest.images);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      process.env.GITHUB_ENV,
      'TF_VAR_image_digests=' +
        JSON.stringify(Object.fromEntries(images.images.map((i) => [i.service, i.digest]))) +
        '\n',
      'utf8',
    );
    await writeFile(
      'artifacts/release-images.json',
      JSON.stringify({ ...images, verified: true, verifier: 'github-cli-slsa-source-workflow' }) +
        '\n',
      { mode: 0o600 },
    );
  }
  const bytes = await bounded(resolve(directory, 'manifest.json'));
  await writeFile(
    'artifacts/release-archive-verified.json',
    JSON.stringify({
      sourceSha,
      controllerSha,
      repository,
      accountId,
      region,
      cluster: scope.cluster,
      key: prefix + 'manifest.json',
      sha256: archiveSha(bytes),
      images,
    }) + '\n',
    { mode: 0o600 },
  );
  console.log(
    'Signed release archive verified and retained. This does not approve deployment or users.',
  );
}
try {
  await main();
} catch {
  console.error(
    'Release archive verification failed. No drain, migration or activation is authorized. Provider details withheld.',
  );
  process.exitCode = 1;
}
