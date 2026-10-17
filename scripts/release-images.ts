import { createHash } from 'node:crypto';
export const RELEASE_SERVICES = ['api', 'telegram-gateway', 'worker', 'scheduler'] as const;
export type ReleaseService = (typeof RELEASE_SERVICES)[number];
export type ReleaseImageContext = Readonly<{
  sourceSha: string;
  repository: string;
  accountId: string;
  region: string;
  buildId: string;
  repositories: Readonly<Record<ReleaseService, string>>;
}>;
export type ReleaseImage = Readonly<{
  service: ReleaseService;
  repositoryUri: string;
  digest: string;
}>;
export type PreparedReleaseImages = Readonly<{
  format: 1;
  sourceSha: string;
  repository: string;
  images: readonly ReleaseImage[];
}>;
export type ImageCommand = (
  tool: 'aws' | 'gh' | 'docker',
  args: readonly string[],
) => Promise<Readonly<{ code: number; stdout: string; stderr: string }>>;
function unavailable(): never {
  throw new Error('Release image verification unavailable.');
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) unavailable();
  return value as Record<string, unknown>;
}
function parse(value: string): unknown {
  if (value.length > 1048576) unavailable();
  try {
    return JSON.parse(value) as unknown;
  } catch {
    unavailable();
  }
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}
export function captureImageContext(input: ReleaseImageContext): ReleaseImageContext {
  const context = structuredClone(input);
  if (
    !/^[a-f0-9]{40}$/u.test(context.sourceSha) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(context.repository) ||
    !/^[1-9][0-9]{0,19}-[1-9][0-9]{0,8}$/u.test(context.buildId) ||
    !/^[0-9]{12}$/u.test(context.accountId) ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/u.test(context.region) ||
    Object.keys(record(context.repositories)).sort().join(',') !==
      [...RELEASE_SERVICES].sort().join(',')
  )
    unavailable();
  for (const service of RELEASE_SERVICES) {
    const uri = context.repositories[service];
    const match =
      /^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?\/([a-z0-9][a-z0-9._/-]{0,250})$/u.exec(
        uri,
      );
    if (
      match === null ||
      match[1] !== context.accountId ||
      match[2] !== context.region ||
      Boolean(match[3]) !== context.region.startsWith('cn-') ||
      !match[4]!.endsWith('/' + service) ||
      match[4]!.includes('//')
    )
      unavailable();
  }
  return context;
}
async function requireCommand(
  command: ImageCommand,
  tool: Parameters<ImageCommand>[0],
  args: readonly string[],
): Promise<string> {
  let result: Awaited<ReturnType<ImageCommand>>;
  try {
    result = await command(tool, args);
  } catch {
    unavailable();
  }
  if (result.code !== 0 || result.stdout.length > 1048576) unavailable();
  return result.stdout;
}
async function currentImage(
  context: ReleaseImageContext,
  service: ReleaseService,
  command: ImageCommand,
  selector = 'imageTag=' + context.sourceSha,
): Promise<ReleaseImage | undefined> {
  const repositoryUri = context.repositories[service],
    name = repositoryUri.slice(repositoryUri.indexOf('/') + 1);
  let result: Awaited<ReturnType<ImageCommand>>;
  try {
    result = await command('aws', [
      'ecr',
      'describe-images',
      '--region',
      context.region,
      '--registry-id',
      context.accountId,
      '--repository-name',
      name,
      '--image-ids',
      selector,
      '--output',
      'json',
    ]);
  } catch {
    unavailable();
  }
  if (result.code !== 0) {
    // Only a definite ECR ImageNotFoundException authorizes a fresh build.
    // Authentication, throttling, networking and malformed replies do not.
    if (
      result.code === 254 &&
      /^\s*An error occurred \(ImageNotFoundException\) when calling the DescribeImages operation:/u.test(
        result.stderr,
      )
    )
      return undefined;
    unavailable();
  }
  const details = record(parse(result.stdout)).imageDetails;
  if (!Array.isArray(details) || details.length !== 1) unavailable();
  const image = record(details[0]);
  if (
    !digest(image.imageDigest) ||
    !Array.isArray(image.imageTags) ||
    (selector.startsWith('imageTag=') && !image.imageTags.includes(selector.slice(9))) ||
    (selector.startsWith('imageDigest=') && image.imageDigest !== selector.slice(12))
  )
    unavailable();
  return { service, repositoryUri, digest: image.imageDigest };
}
export async function verifyImageAttestation(
  context: ReleaseImageContext,
  image: ReleaseImage,
  command: ImageCommand,
): Promise<void> {
  const output = await requireCommand(command, 'gh', [
    'attestation',
    'verify',
    'oci://' + image.repositoryUri + '@' + image.digest,
    '--repo',
    context.repository,
    '--signer-workflow',
    'github.com/' + context.repository + '/.github/workflows/deploy-staging.yml',
    '--source-ref',
    'refs/heads/main',
    '--source-digest',
    context.sourceSha,
    '--signer-digest',
    context.sourceSha,
    '--deny-self-hosted-runners',
    '--predicate-type',
    'https://slsa.dev/provenance/v1',
    '--format',
    'json',
  ]);
  const verified = parse(output);
  if (!Array.isArray(verified) || verified.length < 1 || verified.length > 30) unavailable();
  // gh performs signature/certificate/time/source/workflow verification. Inspect
  // only the verified subject here; predicate metadata alone is not authority.
  const matches = verified.some((value: unknown) => {
    const result = record(record(value).verificationResult),
      statement = record(result.statement);
    if (
      statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
      !Array.isArray(statement.subject)
    )
      return false;
    return statement.subject.some((value: unknown) => {
      const subject = record(value);
      return (
        subject.name === image.repositoryUri &&
        record(subject.digest).sha256 === image.digest.slice(7)
      );
    });
  });
  if (!matches) unavailable();
}
export async function prepareReleaseImages(
  input: ReleaseImageContext,
  command: ImageCommand,
  allowBuild: boolean,
): Promise<Readonly<{ prepared: PreparedReleaseImages; newSubjects: string }>> {
  const context = captureImageContext(input),
    images: ReleaseImage[] = [],
    subjects: string[] = [];
  for (const service of RELEASE_SERVICES) {
    let image = await currentImage(context, service, command);
    if (image !== undefined) await verifyImageAttestation(context, image, command);
    else {
      if (!allowBuild) unavailable();
      const candidateTag = 'candidate-' + context.sourceSha + '-' + context.buildId;
      const tag = context.repositories[service] + ':' + candidateTag;
      await requireCommand(command, 'docker', [
        'build',
        '--file',
        'deploy/docker/Dockerfile',
        '--build-arg',
        'APP=' + service,
        '--build-arg',
        'NAKH_RELEASE=' + context.sourceSha,
        '--build-arg',
        'NAKH_REPOSITORY=' + context.repository,
        '--tag',
        tag,
        '.',
      ]);
      const labels = record(
        parse(
          await requireCommand(command, 'docker', [
            'image',
            'inspect',
            '--format',
            '{{json .Config.Labels}}',
            tag,
          ]),
        ),
      );
      if (
        labels['org.opencontainers.image.revision'] !== context.sourceSha ||
        labels['org.opencontainers.image.source'] !== 'https://github.com/' + context.repository ||
        labels['org.opencontainers.image.title'] !== 'nakh-' + service
      )
        unavailable();
      await requireCommand(command, 'docker', ['push', tag]);
      image = await currentImage(context, service, command, 'imageTag=' + candidateTag);
      if (image === undefined) unavailable();
      subjects.push(image.digest.slice(7) + '  ' + image.repositoryUri);
    }
    images.push(image);
  }
  return {
    prepared: { format: 1, sourceSha: context.sourceSha, repository: context.repository, images },
    newSubjects: subjects.length === 0 ? '' : subjects.join('\n') + '\n',
  };
}
export function parsePreparedImages(
  context: ReleaseImageContext,
  input: unknown,
): PreparedReleaseImages {
  const value = record(input);
  if (
    Object.keys(value).sort().join(',') !== 'format,images,repository,sourceSha' ||
    value.format !== 1 ||
    value.sourceSha !== context.sourceSha ||
    value.repository !== context.repository ||
    !Array.isArray(value.images) ||
    value.images.length !== RELEASE_SERVICES.length
  )
    unavailable();
  const images = RELEASE_SERVICES.map((service) => {
    const matches = (value.images as unknown[])
      .map(record)
      .filter((image) => image.service === service);
    if (matches.length !== 1) unavailable();
    const image = matches[0]!;
    if (
      Object.keys(image).sort().join(',') !== 'digest,repositoryUri,service' ||
      image.repositoryUri !== context.repositories[service] ||
      !digest(image.digest)
    )
      unavailable();
    return { service, repositoryUri: context.repositories[service], digest: image.digest };
  });
  return { format: 1, sourceSha: context.sourceSha, repository: context.repository, images };
}
async function promoteImage(
  context: ReleaseImageContext,
  image: ReleaseImage,
  command: ImageCommand,
): Promise<void> {
  const existing = await currentImage(context, image.service, command);
  if (existing !== undefined) {
    if (existing.digest !== image.digest) unavailable();
    return;
  }
  const name = image.repositoryUri.slice(image.repositoryUri.indexOf('/') + 1);
  const payload = record(
    parse(
      await requireCommand(command, 'aws', [
        'ecr',
        'batch-get-image',
        '--region',
        context.region,
        '--registry-id',
        context.accountId,
        '--repository-name',
        name,
        '--image-ids',
        'imageDigest=' + image.digest,
        '--output',
        'json',
      ]),
    ),
  );
  if (
    !Array.isArray(payload.images) ||
    payload.images.length !== 1 ||
    !Array.isArray(payload.failures) ||
    payload.failures.length !== 0
  )
    unavailable();
  const source = record(payload.images[0]);
  if (
    record(source.imageId).imageDigest !== image.digest ||
    source.registryId !== context.accountId ||
    source.repositoryName !== name ||
    typeof source.imageManifest !== 'string' ||
    createHash('sha256').update(source.imageManifest).digest('hex') !== image.digest.slice(7) ||
    ![
      'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.v2+json',
    ].includes(String(source.imageManifestMediaType))
  )
    unavailable();
  let result: Awaited<ReturnType<ImageCommand>>;
  try {
    result = await command('aws', [
      'ecr',
      'put-image',
      '--region',
      context.region,
      '--registry-id',
      context.accountId,
      '--repository-name',
      name,
      '--image-tag',
      context.sourceSha,
      '--image-digest',
      image.digest,
      '--image-manifest',
      source.imageManifest,
      '--image-manifest-media-type',
      String(source.imageManifestMediaType),
      '--output',
      'json',
    ]);
  } catch {
    unavailable();
  }
  if (
    result.code !== 0 &&
    !(
      result.code === 254 &&
      /^\s*An error occurred \(ImageAlreadyExistsException\) when calling the PutImage operation:/u.test(
        result.stderr,
      )
    )
  )
    unavailable();
  if ((await currentImage(context, image.service, command))?.digest !== image.digest) unavailable();
}
export async function verifyReleaseImages(
  input: ReleaseImageContext,
  prepared: unknown,
  command: ImageCommand,
  promote = false,
): Promise<PreparedReleaseImages> {
  const context = captureImageContext(input),
    value = parsePreparedImages(context, structuredClone(prepared));
  for (const image of value.images) {
    const current = await currentImage(
      context,
      image.service,
      command,
      'imageDigest=' + image.digest,
    );
    if (current?.digest !== image.digest) unavailable();
    await verifyImageAttestation(context, image, command);
    if (promote) await promoteImage(context, image, command);
    else if ((await currentImage(context, image.service, command))?.digest !== image.digest)
      unavailable();
  }
  return value;
}
