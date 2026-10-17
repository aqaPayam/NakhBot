import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  captureImageContext,
  prepareReleaseImages,
  verifyReleaseImages,
  type ImageCommand,
  type ReleaseImageContext,
} from './release-images.js';
const exec = promisify(execFile);
// Raw provider output is bounded and retained only in memory. Never echo AWS,
// Docker or gh errors, manifests, credentials or attestation bodies into logs.
const command: ImageCommand = async (tool, args) => {
  try {
    const result = await exec(tool, [...args], {
      timeout: tool === 'docker' ? 900000 : 120000,
      maxBuffer: 1048576,
      env: { ...process.env, AWS_PAGER: '', GH_PROMPT_DISABLED: 'true' },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error !== 'object' || error === null) return { code: 1, stdout: '', stderr: '' };
    const result = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      code: typeof result.code === 'number' ? result.code : 1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
  }
};
try {
  const [mode, ...extra] = process.argv.slice(2);
  if (!['prepare', 'verify', 'rollback'].includes(mode ?? '') || extra.length !== 0)
    throw new Error('Invalid invocation.');
  if (
    (mode === 'prepare' && !process.env.GITHUB_OUTPUT) ||
    (mode !== 'prepare' && !process.env.GITHUB_ENV)
  )
    throw new Error('Runner context unavailable.');
  const sourceSha = process.env.IMAGE_TAG ?? '';
  if (mode !== 'rollback' && sourceSha !== process.env.GITHUB_SHA)
    throw new Error('Source unavailable.');
  if (mode !== 'rollback') {
    const head = await exec('git', ['rev-parse', 'HEAD'], { timeout: 10000, maxBuffer: 65536 });
    if (head.stdout.trim() !== sourceSha) throw new Error('Checkout source unavailable.');
    await exec('git', ['diff', '--quiet', 'HEAD', '--'], { timeout: 10000, maxBuffer: 65536 });
  }
  const output = await exec(
    'terraform',
    ['-chdir=deploy/terraform/staging', 'output', '-json', 'ecr_repository_urls'],
    { timeout: 30000, maxBuffer: 65536 },
  );
  const repositories: unknown = JSON.parse(output.stdout);
  const context = captureImageContext({
    sourceSha,
    repository: process.env.GITHUB_REPOSITORY ?? '',
    accountId: process.env.RELEASE_AWS_ACCOUNT_ID ?? '',
    region: process.env.RELEASE_AWS_REGION ?? '',
    buildId: (process.env.GITHUB_RUN_ID ?? '') + '-' + (process.env.GITHUB_RUN_ATTEMPT ?? ''),
    repositories,
  } as ReleaseImageContext);
  await mkdir('artifacts', { recursive: true });
  if (mode === 'prepare') {
    const value = await prepareReleaseImages(context, command, true);
    await writeFile(
      'artifacts/release-images-prepared.json',
      JSON.stringify(value.prepared) + '\n',
      'utf8',
    );
    await writeFile('artifacts/release-image-subjects.txt', value.newSubjects, 'utf8');
    if (!process.env.GITHUB_OUTPUT) throw new Error('Runner output unavailable.');
    await appendFile(
      process.env.GITHUB_OUTPUT,
      'new_subjects=' + (value.newSubjects.length > 0 ? 'true' : 'false') + '\n',
      'utf8',
    );
    console.log(
      'Four source-bound candidate images prepared. Attestation verification is still required.',
    );
  } else {
    const prepared: unknown =
      mode === 'rollback'
        ? (await prepareReleaseImages(context, command, false)).prepared
        : JSON.parse(await readFile('artifacts/release-images-prepared.json', 'utf8'));
    const verified = await verifyReleaseImages(context, prepared, command, mode === 'verify');
    const imageDigests = Object.fromEntries(
      verified.images.map((image) => [image.service, image.digest]),
    );
    if (!process.env.GITHUB_ENV) throw new Error('Runner environment unavailable.');
    // Values are the exact four fixed service names and validated SHA-256s;
    // no provider/user strings can inject an environment-file line.
    await appendFile(
      process.env.GITHUB_ENV,
      'TF_VAR_image_digests=' + JSON.stringify(imageDigests) + '\n',
      'utf8',
    );
    await writeFile(
      'artifacts/release-images.json',
      JSON.stringify(
        { ...verified, verified: true, verifier: 'github-cli-slsa-source-workflow' },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    console.log('Four image attestations verified; Terraform image digests pinned.');
  }
} catch {
  console.error(
    'Release image verification failed. No migration, activation or rollback is authorized.',
  );
  process.exitCode = 1;
}
