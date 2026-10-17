import { createHash } from 'node:crypto';
import { RELEASE_SERVICES } from '../release-images.js';
import type { StagingReleaseContext } from '../staging-release.js';
export function stagingContext(): StagingReleaseContext {
  const cluster = 'nakh-staging',
    accountId = '123456789012',
    region = 'eu-west-1';
  return {
    sourceSha: 'a'.repeat(40),
    controllerSha: 'a'.repeat(40),
    archive: null,
    repository: 'aqaPayam/NakhBot',
    accountId,
    region,
    cluster,
    runId: '123',
    attempt: 1,
    images: Object.fromEntries(
      RELEASE_SERVICES.map((n) => [
        n,
        `${accountId}.dkr.ecr.${region}.amazonaws.com/${cluster}/${n}@sha256:${createHash('sha256').update(n).digest('hex')}`,
      ]),
    ) as StagingReleaseContext['images'],
    defaultMin: 2,
    defaultMax: 6,
    secretArn: `arn:aws:secretsmanager:${region}:${accountId}:secret:${cluster}/runtime-AbCd12`,
    subnets: ['subnet-11111111', 'subnet-22222222'],
    securityGroup: 'sg-11111111',
    bucket:
      cluster +
      '-release-' +
      createHash('sha256')
        .update(accountId + ':' + region)
        .digest('hex')
        .slice(0, 16),
  };
}
