import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(path: string): Promise<string> {
  return readFile(join(process.cwd(), path), 'utf8');
}

describe('staging deployment readiness', () => {
  it('keeps billable workloads default-off behind an explicit release gate', async () => {
    const variables = await source('deploy/terraform/staging/variables.tf');
    const compute = await source('deploy/terraform/staging/compute.tf');
    const workflow = await source('.github/workflows/deploy-staging.yml');
    const rollback = await source('.github/workflows/rollback-staging.yml');

    expect(variables).toMatch(/variable "activate_services"[\s\S]*?default\s*=\s*false/u);
    expect(compute).toContain('var.activate_services ? var.service_min_replicas : 0');
    expect(workflow).toContain('DEPLOY-STAGING');
    expect(workflow).toContain('DEPLOY_CONFIRMATION: ${{ inputs.confirmation }}');
    expect(workflow).not.toContain('test "${{ inputs.confirmation }}"');
    expect(workflow).toContain('leaving it online while the new release is prepared');
    expect(workflow).toContain("-target='aws_ecs_task_definition.migration'");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(workflow).not.toContain('environment: staging');
    expect(workflow).not.toMatch(/AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/u);
    expect(rollback).toContain('ROLLBACK-STAGING');
    expect(rollback).toContain('SCHEMA_COMPATIBLE');
    expect(rollback).toContain('describe-images');
    expect(rollback).not.toMatch(/AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/u);
    expect(compute).toContain(
      '{ name = "NAKH_TELEGRAM_BOT_TOKEN_REF", value = "NAKH_TELEGRAM_BOT_TOKEN" }',
    );
    expect(compute).toContain(
      'valueFrom = "${aws_secretsmanager_secret.runtime.arn}:NAKH_TELEGRAM_BOT_TOKEN::"',
    );
    expect(compute).not.toContain('aws-secretsmanager://');
  });

  it('keeps data private, encrypted, recoverable, and highly available', async () => {
    const network = await source('deploy/terraform/staging/network.tf');
    const data = await source('deploy/terraform/staging/data.tf');

    expect(data).toContain('publicly_accessible         = false');
    expect(data).toContain('storage_encrypted           = true');
    expect(data).toContain('multi_az                    = true');
    expect(data).toContain('backup_retention_period = 7');
    expect(data).toContain('transit_encryption_enabled = true');
    expect(data).toContain('at_rest_encryption_enabled = true');
    expect(data).toContain('automatic_failover_enabled = true');
    expect(data).toContain('value = "noeviction"');
    expect(network).not.toMatch(/database[\s\S]{0,400}cidr_ipv4\s*=\s*"0\.0\.0\.0\/0"/u);
    expect(network).not.toMatch(/redis[\s\S]{0,400}cidr_ipv4\s*=\s*"0\.0\.0\.0\/0"/u);
  });

  it('uses branch-restricted OIDC deployment access and reproducible providers', async () => {
    const bootstrap = await source('deploy/terraform/bootstrap/main.tf');
    const bootstrapVersions = await source('deploy/terraform/bootstrap/versions.tf');
    const stagingVersions = await source('deploy/terraform/staging/versions.tf');

    expect(bootstrap).toContain('token.actions.githubusercontent.com:sub');
    expect(bootstrap).toContain('repo:${var.github_repository}:ref:refs/heads/main');
    expect(bootstrap).toContain('prevent_destroy = true');
    expect(bootstrapVersions).toContain('version = "6.61.0"');
    expect(stagingVersions).toContain('version = "6.61.0"');
    expect(stagingVersions).toContain('use_lockfile = true');
  });

  it('packages migrations and rehearses production containers as non-root read-only services', async () => {
    const dockerfile = await source('deploy/docker/Dockerfile');
    const compose = await source('deploy/docker/compose.staging.yml');

    expect(dockerfile).toContain('/workspace/migrations ./migrations');
    expect(dockerfile).toContain('USER nakh');
    expect(compose).toContain('condition: service_completed_successfully');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('cap_drop:');
  });
});
