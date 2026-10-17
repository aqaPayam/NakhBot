import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  captureImageContext,
  prepareReleaseImages,
  verifyReleaseImages,
  verifyArchiveAttestation,
  parsePreparedImages,
  RELEASE_SERVICES,
  type ReleaseImageContext,
  type ImageCommand,
  type ReleaseService,
} from './release-images.js';
function context(): ReleaseImageContext {
  return {
    sourceSha: 'a'.repeat(40),
    repository: 'aqaPayam/NakhBot',
    accountId: '123456789012',
    region: 'eu-west-1',
    buildId: '123-1',
    repositories: Object.fromEntries(
      RELEASE_SERVICES.map((service) => [
        service,
        '123456789012.dkr.ecr.eu-west-1.amazonaws.com/nakh-staging/' + service,
      ]),
    ) as Record<ReleaseService, string>,
  };
}
describe('signed release archive policy', () => {
  it('uses current trust and pins repository, workflow, source, runner and subject bytes', async () => {
    const ctx = context(),
      digest = 'c'.repeat(64);
    let name = 'nakh-release-archive',
      hash = digest,
      code = 0;
    const command: ImageCommand = (tool, args) => {
      expect(tool).toBe('gh');
      expect(args).toEqual([
        'attestation',
        'verify',
        '/private/manifest.json',
        '--bundle',
        '/private/bundle.jsonl',
        '--repo',
        ctx.repository,
        '--signer-workflow',
        'github.com/' + ctx.repository + '/.github/workflows/deploy-staging.yml',
        '--source-ref',
        'refs/heads/main',
        '--source-digest',
        ctx.sourceSha,
        '--signer-digest',
        ctx.sourceSha,
        '--deny-self-hosted-runners',
        '--predicate-type',
        'https://slsa.dev/provenance/v1',
        '--format',
        'json',
      ]);
      return Promise.resolve({
        code,
        stderr: '',
        stdout: JSON.stringify([
          {
            verificationResult: {
              statement: {
                predicateType: 'https://slsa.dev/provenance/v1',
                subject: [{ name, digest: { sha256: hash } }],
              },
            },
          },
        ]),
      });
    };
    const verify = (): Promise<void> =>
      verifyArchiveAttestation(
        ctx,
        '/private/manifest.json',
        '/private/bundle.jsonl',
        digest,
        command,
      );
    await expect(verify()).resolves.toBeUndefined();
    name = 'unrelated';
    await expect(verify()).rejects.toThrow();
    name = 'nakh-release-archive';
    hash = 'd'.repeat(64);
    await expect(verify()).rejects.toThrow();
    hash = digest;
    code = 1;
    await expect(verify()).rejects.toThrow();
  });
});
type Fixture = {
  ctx: ReleaseImageContext;
  calls: Array<{ tool: string; args: readonly string[] }>;
  command: ImageCommand;
  published: Set<ReleaseService>;
  qualified: Set<ReleaseService>;
  proved: Set<ReleaseService>;
  hashes: Record<ReleaseService, string>;
  setBadLabel: () => void;
  setBadSubject: () => void;
  setBadManifest: () => void;
  setAwsError: (value: string) => void;
  setGhFailure: () => void;
  setRace: () => void;
  setConflict: () => void;
};
function fixture(existing = false): Fixture {
  const ctx = context(),
    calls: Array<{ tool: string; args: readonly string[] }> = [];
  const manifests = Object.fromEntries(
    RELEASE_SERVICES.map((service) => [
      service,
      JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { digest: 'sha256:' + createHash('sha256').update(service).digest('hex') },
        layers: [],
      }),
    ]),
  ) as Record<ReleaseService, string>;
  const hashes = Object.fromEntries(
    RELEASE_SERVICES.map((service) => [
      service,
      'sha256:' + createHash('sha256').update(manifests[service]).digest('hex'),
    ]),
  ) as Record<ReleaseService, string>;
  const published = new Set<ReleaseService>(existing ? RELEASE_SERVICES : []),
    qualified = new Set(published),
    proved = new Set(published);
  let badLabel = false,
    badSubject = false,
    badManifest = false,
    awsError = '',
    ghFailure = false,
    promotionRace = false,
    conflictRace = false;
  const command: ImageCommand = async (tool, args) => {
    await Promise.resolve();
    calls.push({ tool, args: [...args] });
    const ok = (value: unknown): Awaited<ReturnType<ImageCommand>> => ({
      code: 0,
      stdout: JSON.stringify(value),
      stderr: '',
    });
    const at = (flag: string): string => args[args.indexOf(flag) + 1] ?? '';
    if (tool === 'gh') {
      if (ghFailure) return { code: 1, stdout: '', stderr: 'PRIVATE_PROVIDER_DETAIL' };
      const service = RELEASE_SERVICES.find((service) =>
        args[2]?.startsWith('oci://' + ctx.repositories[service] + '@'),
      );
      if (service === undefined || !proved.has(service))
        return { code: 1, stdout: '', stderr: 'PRIVATE_UNPROVED' };
      expect(at('--repo')).toBe(ctx.repository);
      expect(at('--source-ref')).toBe('refs/heads/main');
      expect(at('--source-digest')).toBe(ctx.sourceSha);
      expect(at('--signer-digest')).toBe(ctx.sourceSha);
      expect(at('--signer-workflow')).toBe(
        'github.com/' + ctx.repository + '/.github/workflows/deploy-staging.yml',
      );
      expect(args).toContain('--deny-self-hosted-runners');
      return ok([
        {
          verificationResult: {
            statement: {
              predicateType: 'https://slsa.dev/provenance/v1',
              subject: [
                {
                  name: badSubject ? 'other/image' : ctx.repositories[service],
                  digest: { sha256: hashes[service].slice(7) },
                },
              ],
            },
          },
        },
      ]);
    }
    if (tool === 'docker') {
      const service = RELEASE_SERVICES.find((service) =>
        args.some(
          (arg) => arg === 'APP=' + service || arg.startsWith(ctx.repositories[service] + ':'),
        ),
      );
      if (service === undefined) throw Error('Unexpected fixture command');
      if (args[0] === 'image')
        return ok({
          'org.opencontainers.image.revision': badLabel ? 'b'.repeat(40) : ctx.sourceSha,
          'org.opencontainers.image.source': 'https://github.com/' + ctx.repository,
          'org.opencontainers.image.title': 'nakh-' + service,
        });
      if (args[0] === 'push') published.add(service);
      if (args[0] === 'build') {
        expect(args).toContain('NAKH_RELEASE=' + ctx.sourceSha);
        expect(args).toContain('NAKH_REPOSITORY=' + ctx.repository);
      }
      return ok({});
    }
    const service = at('--repository-name').split('/').at(-1) as ReleaseService;
    expect(RELEASE_SERVICES).toContain(service);
    expect(at('--registry-id')).toBe(ctx.accountId);
    expect(at('--region')).toBe(ctx.region);
    if (awsError) return { code: 254, stdout: '', stderr: awsError };
    if (args[1] === 'describe-images') {
      const selector = at('--image-ids');
      if (
        (selector === 'imageTag=' + ctx.sourceSha && !qualified.has(service)) ||
        !published.has(service)
      )
        return {
          code: 254,
          stdout: '',
          stderr:
            'An error occurred (ImageNotFoundException) when calling the DescribeImages operation: missing',
        };
      return ok({
        imageDetails: [
          {
            imageDigest:
              conflictRace && qualified.has(service) ? 'sha256:' + 'f'.repeat(64) : hashes[service],
            imageTags: qualified.has(service)
              ? [ctx.sourceSha]
              : ['candidate-' + ctx.sourceSha + '-' + ctx.buildId],
          },
        ],
      });
    }
    if (args[1] === 'batch-get-image')
      return ok({
        failures: [],
        images: [
          {
            imageId: { imageDigest: hashes[service] },
            registryId: ctx.accountId,
            repositoryName: at('--repository-name'),
            imageManifest: badManifest ? '{}' : manifests[service],
            imageManifestMediaType: 'application/vnd.oci.image.manifest.v1+json',
          },
        ],
      });
    if (args[1] === 'put-image') {
      expect(proved.has(service)).toBe(true);
      expect(at('--image-digest')).toBe(hashes[service]);
      qualified.add(service);
      if (promotionRace)
        return {
          code: 254,
          stdout: '',
          stderr:
            'An error occurred (ImageAlreadyExistsException) when calling the PutImage operation: same image',
        };
      return ok({});
    }
    throw Error('Unexpected fixture command');
  };
  return {
    ctx,
    calls,
    command,
    published,
    qualified,
    proved,
    hashes,
    setBadLabel: () => {
      badLabel = true;
    },
    setBadSubject: () => {
      badSubject = true;
    },
    setBadManifest: () => {
      badManifest = true;
    },
    setAwsError: (value: string) => {
      awsError = value;
    },
    setGhFailure: () => {
      ghFailure = true;
    },
    setRace: () => {
      promotionRace = true;
    },
    setConflict: () => {
      conflictRace = true;
    },
  };
}
function writes(f: Fixture): number {
  return f.calls.filter((call) => call.tool === 'docker' || call.args[1] === 'put-image').length;
}
describe('M9 source-bound image preparation, attestation and promotion', () => {
  it('builds candidates without reserving commit tags, then promotes only after all images can be verified', async () => {
    const f = fixture(),
      value = await prepareReleaseImages(f.ctx, f.command, true);
    expect(f.qualified.size).toBe(0);
    expect(f.published.size).toBe(4);
    expect(value.newSubjects.trim().split('\n')).toHaveLength(4);
    expect(
      f.calls
        .filter((c) => c.tool === 'docker' && c.args[0] === 'push')
        .every((c) => c.args[1]?.includes(':candidate-' + f.ctx.sourceSha + '-' + f.ctx.buildId)),
    ).toBe(true);
    await expect(verifyReleaseImages(f.ctx, value.prepared, f.command, true)).rejects.toThrow(
      'Release image verification unavailable.',
    );
    expect(f.qualified.size).toBe(0);
    for (const service of RELEASE_SERVICES) f.proved.add(service);
    expect(await verifyReleaseImages(f.ctx, value.prepared, f.command, true)).toEqual(
      value.prepared,
    );
    expect(f.qualified.size).toBe(4);
    const count = writes(f);
    expect((await prepareReleaseImages(f.ctx, f.command, true)).newSubjects).toBe('');
    await verifyReleaseImages(f.ctx, value.prepared, f.command, false);
    expect(writes(f)).toBe(count);
  });
  it('reuses only previously verified images and never re-attests an existing unproved commit tag', async () => {
    const f = fixture(true);
    f.proved.delete('api');
    await expect(prepareReleaseImages(f.ctx, f.command, true)).rejects.toThrow();
    expect(writes(f)).toBe(0);
  });
  it('denies missing rollback images without attempting builds or tag writes', async () => {
    const f = fixture();
    await expect(prepareReleaseImages(f.ctx, f.command, false)).rejects.toThrow();
    expect(writes(f)).toBe(0);
  });
  it.each(['AccessDeniedException', 'ServerException', 'ThrottlingException'])(
    'does not interpret %s as a missing image',
    async (code) => {
      const f = fixture();
      f.setAwsError('An error occurred (' + code + ') PRIVATE_DETAIL');
      await expect(prepareReleaseImages(f.ctx, f.command, true)).rejects.toThrow(
        'Release image verification unavailable.',
      );
      expect(writes(f)).toBe(0);
    },
  );
  it('rejects foreign accounts, regions, services and invalid release identities before provider access', () => {
    const original = context();
    for (const value of [
      { ...original, sourceSha: 'latest' },
      { ...original, buildId: '123\nINJECTED=1' },
      { ...original, accountId: '999999999999' },
      { ...original, region: 'us-east-1' },
      { ...original, repositories: { ...original.repositories, extra: 'private' } },
      {
        ...original,
        repositories: { ...original.repositories, api: original.repositories.worker },
      },
    ])
      expect(() => captureImageContext(value)).toThrow();
  });
  it('does not push an image whose actual build labels differ from the selected source', async () => {
    const f = fixture();
    f.setBadLabel();
    await expect(prepareReleaseImages(f.ctx, f.command, true)).rejects.toThrow();
    expect(f.calls.some((c) => c.tool === 'docker' && c.args[0] === 'push')).toBe(false);
  });
  it('requires a verified attestation subject as well as a successful verifier process', async () => {
    const f = fixture(true);
    f.setBadSubject();
    await expect(prepareReleaseImages(f.ctx, f.command, true)).rejects.toThrow();
    expect(writes(f)).toBe(0);
    const g = fixture(true);
    g.setGhFailure();
    await expect(prepareReleaseImages(g.ctx, g.command, true)).rejects.toThrow(
      'Release image verification unavailable.',
    );
  });
  it('rejects mismatched receipt source, services, repositories, digests and extra fields', async () => {
    const f = fixture(true),
      { prepared } = await prepareReleaseImages(f.ctx, f.command, false);
    for (const value of [
      { ...prepared, sourceSha: 'b'.repeat(40) },
      { ...prepared, extra: true },
      { ...prepared, images: prepared.images.slice(1) },
      { ...prepared, images: [prepared.images[0], ...prepared.images.slice(0, 3)] },
      { ...prepared, images: prepared.images.map((image) => ({ ...image, digest: 'bad' })) },
      {
        ...prepared,
        images: prepared.images.map((image) => ({
          ...image,
          repositoryUri: f.ctx.repositories.worker,
        })),
      },
    ])
      expect(() => parsePreparedImages(f.ctx, value)).toThrow();
  });
  it('validates the exact manifest bytes before promotion and treats only an exact existing-image race as idempotent', async () => {
    const f = fixture(),
      value = await prepareReleaseImages(f.ctx, f.command, true);
    for (const service of RELEASE_SERVICES) f.proved.add(service);
    f.setBadManifest();
    await expect(verifyReleaseImages(f.ctx, value.prepared, f.command, true)).rejects.toThrow();
    expect(f.qualified.size).toBe(0);
    const g = fixture(),
      other = await prepareReleaseImages(g.ctx, g.command, true);
    for (const service of RELEASE_SERVICES) g.proved.add(service);
    g.setRace();
    await expect(verifyReleaseImages(g.ctx, other.prepared, g.command, true)).resolves.toEqual(
      other.prepared,
    );
    const h = fixture(),
      last = await prepareReleaseImages(h.ctx, h.command, true);
    for (const service of RELEASE_SERVICES) h.proved.add(service);
    h.setRace();
    h.setConflict();
    await expect(verifyReleaseImages(h.ctx, last.prepared, h.command, true)).rejects.toThrow();
  });
  it('captures context and prepared receipts before provider waits', async () => {
    const f = fixture(true),
      input = structuredClone(f.ctx),
      { prepared } = await prepareReleaseImages(f.ctx, f.command, false);
    const changed = structuredClone(prepared);
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    let once = false;
    const command: ImageCommand = async (tool, args) => {
      await Promise.resolve();
      if (!once) {
        once = true;
        entered();
        await gate;
      }
      return f.command(tool, args);
    };
    const result = verifyReleaseImages(input, changed, command, false);
    await ready;
    (input as { sourceSha: string }).sourceSha = 'b'.repeat(40);
    (changed.images[0] as { digest: string }).digest = 'sha256:' + 'f'.repeat(64);
    release();
    expect((await result).sourceSha).toBe(f.ctx.sourceSha);
  });
});
