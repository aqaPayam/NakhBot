import lock from '../../../deploy/telemetry/collector-image-lock.json' with { type: 'json' };
import { collectorStartupDiagnostic, pullCollectorImage } from './m7-collector-startup.js';

type Platform = keyof typeof lock.platforms;
export type CollectorImageReceipt = Readonly<{
  platform: Platform;
  expectedIndexDigest: string;
  manifestDigest: string;
  configDigest: string;
  source: 'verified_local_image' | 'official_immutable_mirror';
}>;
type Docker = (args: readonly string[]) => Promise<string>;
type Image = Readonly<{ id: string; digests: readonly string[] }>;
const digest = /^sha256:[0-9a-f]{64}$/u;
for (const platform of Object.values(lock.platforms)) Object.freeze(platform);
Object.freeze(lock.platforms);
Object.freeze(lock);

function integrityFailure(): never {
  // The existing diagnostic classifies this fixed vocabulary without process output.
  throw Object.assign(new Error('Collector image integrity verification failed.'), {
    stderr: 'digest mismatch',
  });
}
function platformFor(value: string): Platform {
  switch (value.trim()) {
    case 'linux/amd64':
    case 'linux/x86_64':
      return 'linux/amd64';
    case 'linux/arm64':
    case 'linux/aarch64':
      return 'linux/arm64';
    default:
      throw Object.assign(new Error('Collector platform unavailable.'), {
        stderr: 'no matching manifest',
      });
  }
}
async function inspect(
  docker: Docker,
  reference: string,
  allowMissing = false,
): Promise<Image | undefined> {
  let output: string;
  try {
    output = await docker([
      'image',
      'inspect',
      '--format',
      '{"id":{{json .Id}},"digests":{{json .RepoDigests}}}',
      reference,
    ]);
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error ? error.stderr : undefined;
    const diagnostic = collectorStartupDiagnostic(error);
    if (
      allowMissing &&
      diagnostic.classification === 'collector_startup_unknown' &&
      diagnostic.failureKind === 'unknown' &&
      diagnostic.exitCode === 1 &&
      !diagnostic.killed &&
      typeof stderr === 'string' &&
      /\bno such (?:image|object)\b/iu.test(stderr)
    )
      return undefined;
    throw error;
  }
  if (output.length > 32768) integrityFailure();
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return integrityFailure();
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('digests' in value) ||
    !Object.hasOwn(value, 'id') ||
    !Object.hasOwn(value, 'digests') ||
    Object.keys(value).length !== 2 ||
    typeof value.id !== 'string' ||
    !digest.test(value.id) ||
    (value.digests !== null &&
      (!Array.isArray(value.digests) ||
        value.digests.length > 128 ||
        value.digests.some((entry: unknown) => typeof entry !== 'string' || entry.length > 512)))
  )
    integrityFailure();
  return { id: value.id, digests: value.digests === null ? [] : (value.digests as string[]) };
}

/** AWS publishes byte-identical v0.49.0 manifests in both documented registries.
 * Fetch the reviewed immutable mirror instead of the throttled anonymous ECR
 * endpoint. Only verified local bits may be reused. No alternate version or
 * image, SDK/conversion assertion, retry count or security rejection is allowed.
 * Docker verifies the requested manifest/layers; inspect binds the native config
 * and repository digest before tagging the existing configured image name. */
export async function prepareCollectorImage(
  configuredImage: string,
  docker: Docker,
  wait: (milliseconds: number) => Promise<unknown>,
  random: () => number = Math.random,
): Promise<CollectorImageReceipt> {
  if (
    lock.schemaVersion !== 1 ||
    configuredImage !== lock.configuredImage ||
    !digest.test(lock.indexDigest)
  )
    integrityFailure();
  const platform = platformFor(await docker(['info', '--format', '{{.OSType}}/{{.Architecture}}']));
  const expected = lock.platforms[platform];
  if (!digest.test(expected.manifestDigest) || !digest.test(expected.configDigest))
    integrityFailure();
  const primaryRepository = configuredImage.slice(0, configuredImage.lastIndexOf(':'));
  const repositories = [
    primaryRepository,
    lock.mirrorRepository,
    lock.mirrorRepository.replace(/^docker\.io\//u, ''),
  ];
  const accepted = new Set(
    repositories.flatMap((repository) =>
      [lock.indexDigest, expected.manifestDigest].map((hash) => `${repository}@${hash}`),
    ),
  );
  const receipt = (
    image: Image,
    source: CollectorImageReceipt['source'],
  ): CollectorImageReceipt | undefined => {
    const actual = image.digests.find((value) => accepted.has(value));
    if (image.id !== expected.configDigest || actual === undefined) return undefined;
    return Object.freeze({
      platform,
      expectedIndexDigest: lock.indexDigest,
      manifestDigest: actual.slice(actual.lastIndexOf('@') + 1),
      configDigest: image.id,
      source,
    });
  };
  const cached = await inspect(docker, configuredImage, true);
  const verified = cached === undefined ? undefined : receipt(cached, 'verified_local_image');
  if (verified !== undefined) return verified;
  const immutable = `${lock.mirrorRepository}@${lock.indexDigest}`;
  let acquired: CollectorImageReceipt | undefined;
  await pullCollectorImage(
    async () => {
      await docker(['pull', '--platform', platform, immutable]);
      const image = await inspect(docker, immutable);
      if (image === undefined || receipt(image, 'official_immutable_mirror') === undefined)
        integrityFailure();
      await docker(['tag', immutable, configuredImage]);
      const tagged = await inspect(docker, configuredImage);
      acquired = tagged === undefined ? undefined : receipt(tagged, 'official_immutable_mirror');
      if (acquired === undefined) integrityFailure();
    },
    wait,
    random,
  );
  return acquired ?? integrityFailure();
}
