import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { releaseEnvironment, releaseTarget, clusterEnvironment } from './release-target.js';
import {
  RELEASE_SERVICES,
  captureImageContext,
  verifyImageAttestation,
  verifyArchiveAttestation,
  type ImageCommand,
  type ReleaseImageContext,
} from './release-images.js';
const production = {
  RELEASE_ENVIRONMENT: 'production',
  RELEASE_AWS_ACCOUNT_ID: '210987654321',
  TF_VAR_expected_aws_account_id: '210987654321',
  TF_VAR_staging_aws_account_id: '123456789012',
  TF_VAR_database_role_isolation_enabled: 'true',
  RELEASE_ARCHIVE_REQUIRED: 'true',
};
function images(): ReleaseImageContext {
  return {
    environment: 'production',
    sourceSha: 'a'.repeat(40),
    repository: 'aqaPayam/NakhBot',
    accountId: production.RELEASE_AWS_ACCOUNT_ID,
    region: 'eu-west-1',
    buildId: '123-1',
    repositories: Object.fromEntries(
      RELEASE_SERVICES.map((service) => [
        service,
        `210987654321.dkr.ecr.eu-west-1.amazonaws.com/nakh-production/${service}`,
      ]),
    ) as Record<(typeof RELEASE_SERVICES)[number], string>,
  };
}
describe('explicit production release boundary', () => {
  it('preserves staging defaults and rejects unknown environment and cluster spellings', () => {
    expect(releaseTarget({})).toEqual({
      environment: 'staging',
      terraformDirectory: 'deploy/terraform/staging',
      imageScope: {},
    });
    expect(releaseTarget(production)).toEqual({
      environment: 'production',
      terraformDirectory: 'deploy/terraform/production',
      imageScope: { environment: 'production' },
    });
    for (const value of ['', 'prod', 'Production', null])
      expect(() => releaseEnvironment(value)).toThrow();
    expect(clusterEnvironment('nakh-production')).toBe('production');
    for (const value of ['nakh-prod', 'nakh-staging/production', 'nakh-production-other'])
      expect(() => clusterEnvironment(value)).toThrow();
  });
  it.each([
    'RELEASE_AWS_ACCOUNT_ID',
    'TF_VAR_expected_aws_account_id',
    'TF_VAR_staging_aws_account_id',
    'TF_VAR_database_role_isolation_enabled',
    'RELEASE_ARCHIVE_REQUIRED',
  ] as const)('denies missing production prerequisite %s', (key) => {
    const env: Record<string, string | undefined> = { ...production };
    delete env[key];
    expect(() => releaseTarget(env)).toThrow();
  });
  it('denies account reuse, isolation fallback and missing archive custody', () => {
    expect(() =>
      releaseTarget({
        ...production,
        TF_VAR_staging_aws_account_id: production.RELEASE_AWS_ACCOUNT_ID,
      }),
    ).toThrow();
    expect(() =>
      releaseTarget({ ...production, TF_VAR_expected_aws_account_id: '123456789012' }),
    ).toThrow();
    expect(() =>
      releaseTarget({ ...production, TF_VAR_database_role_isolation_enabled: 'false' }),
    ).toThrow();
    expect(() => releaseTarget({ ...production, RELEASE_ARCHIVE_REQUIRED: 'false' })).toThrow();
  });
  it('rejects staging or mixed repository namespaces in production image context', () => {
    const context = images();
    expect(captureImageContext(context)).toEqual(context);
    for (const uri of [
      '210987654321.dkr.ecr.eu-west-1.amazonaws.com/nakh-staging/api',
      '210987654321.dkr.ecr.eu-west-1.amazonaws.com/other-production/api',
    ]) {
      expect(() =>
        captureImageContext({ ...context, repositories: { ...context.repositories, api: uri } }),
      ).toThrow();
    }
  });
  it('pins image and archive signature verification to the production workflow and exact source', async () => {
    const context = images(),
      digest = 'b'.repeat(64);
    const commands: string[][] = [];
    const command: ImageCommand = (tool, args) => {
      expect(tool).toBe('gh');
      commands.push([...args]);
      const name = args[2]!.startsWith('oci://')
        ? context.repositories.api
        : 'nakh-release-archive';
      return Promise.resolve({
        code: 0,
        stderr: '',
        stdout: JSON.stringify([
          {
            verificationResult: {
              statement: {
                predicateType: 'https://slsa.dev/provenance/v1',
                subject: [{ name, digest: { sha256: digest } }],
              },
            },
          },
        ]),
      });
    };
    await verifyImageAttestation(
      context,
      { service: 'api', repositoryUri: context.repositories.api, digest: 'sha256:' + digest },
      command,
    );
    await verifyArchiveAttestation(
      context,
      '/private/manifest.json',
      '/private/bundle.jsonl',
      digest,
      command,
    );
    expect(commands).toHaveLength(2);
    for (const args of commands) {
      expect(args[args.indexOf('--signer-workflow') + 1]).toBe(
        'github.com/aqaPayam/NakhBot/.github/workflows/deploy-production.yml',
      );
      expect(args[args.indexOf('--source-digest') + 1]).toBe(context.sourceSha);
      expect(args[args.indexOf('--signer-digest') + 1]).toBe(context.sourceSha);
      expect(args).toContain('--deny-self-hosted-runners');
    }
  });
  it('binds production workflows to reviewed environment, separate custody and drained controls', () => {
    for (const mode of ['deploy', 'rollback']) {
      const workflow = readFileSync(`.github/workflows/${mode}-production.yml`, 'utf8');
      expect(workflow).toContain('environment: production');
      expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
      expect(workflow).toContain('group: production-deployment');
      expect(workflow).toContain('RELEASE_ENVIRONMENT: production');
      expect(workflow).toContain("RELEASE_ARCHIVE_REQUIRED: 'true'");
      expect(workflow).toContain("TF_VAR_database_role_isolation_enabled: 'true'");
      expect(workflow).toContain('allowed-account-ids: ${{ vars.PRODUCTION_AWS_ACCOUNT_ID }}');
      expect(workflow).toContain('PRODUCTION_TF_STATE_BUCKET');
      expect(workflow).toContain("-target='module.runtime.aws_s3_bucket_policy.release_evidence'");
      expect(workflow).toContain("-target='module.runtime.aws_ecs_task_definition.migration'");
      for (const operation of ['drain', 'admission', 'healthy', 'complete', 'maintain'])
        expect(workflow).toContain('scripts/staging-release-cli.ts ' + operation);
      expect(workflow).not.toContain('deploy/terraform/staging');
      expect(workflow).not.toContain('\n          valid_status=');
    }
    const rollback = readFileSync('.github/workflows/rollback-production.yml', 'utf8');
    expect(rollback).toContain('test -n "$RELEASE_ARCHIVE_REF"');
    expect(rollback).toContain('scripts/staging-release-cli.ts schema');
    expect(rollback).not.toContain('scripts/staging-release-cli.ts migrate');
  });
});
