# AWS staging deployment

This root is a production-shaped but staging-sized AWS deployment. It is safe to review and validate without an AWS account. It creates nothing—and incurs no AWS charge—until an authorized operator runs Terraform against an account.

## What it provisions

- isolated VPC across two availability zones, public load-balancer subnets, private workload/data subnets, and one staging NAT gateway;
- ECS/Fargate services for API, Telegram gateway, worker, and scheduler, with two replicas when activated and target-tracking autoscaling;
- immutable, encrypted ECR repositories;
- private Multi-AZ RDS PostgreSQL 17.11 with TLS enforcement, backups, enhanced monitoring, and deletion protection;
- private two-node ElastiCache Redis OSS with TLS, authentication, encryption, automatic failover, and `noeviction`;
- Secrets Manager runtime configuration, least-purpose ECS roles, CloudWatch logs, ADOT metric/trace sidecars, alarms, SNS, a budget, WAF, ACM TLS, and Route53 DNS;
- a zero-service bootstrap state and one-off migration task so migrations run before workloads become active.

The default is `activate_services = false`, which creates zero running application tasks. The manual deployment workflow also requires typing `DEPLOY-STAGING` before it can create billable resources.

## Work that can be done before buying AWS

CI formats and validates both Terraform roots without cloud credentials. After installing Docker Desktop, run the free local rehearsal from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File deploy/scripts/local-staging-rehearsal.ps1
```

This builds the production images, starts PostgreSQL, Redis, telemetry, and every process, verifies webhook authentication/idempotency/restart behavior, then runs migration, integration, and counter-load tests. It deletes the disposable data afterward. Local success is rehearsal evidence, not real staging acceptance.

## First-time AWS bootstrap—do not run yet

Use a dedicated staging AWS account. Sign in through an MFA-protected AWS SSO profile; never use root access keys.

```sh
terraform -chdir=deploy/terraform/bootstrap init
terraform -chdir=deploy/terraform/bootstrap apply -var="aws_region=YOUR_REGION"
```

Preserve the bootstrap state securely. It contains no application secrets. Its outputs provide the S3 state bucket, account ID, and GitHub deployment-role ARN.

In the repository, open **Settings → Secrets and variables → Actions**. Add these repository variables:

| GitHub repository variable | Value |
|---|---|
| `AWS_ACCOUNT_ID` | bootstrap `aws_account_id` output |
| `AWS_REGION` | chosen staging region |
| `AWS_DEPLOY_ROLE_ARN` | bootstrap role output |
| `TF_STATE_BUCKET` | bootstrap bucket output |
| `TF_STATE_KEY` | `nakh/staging/terraform.tfstate` |
| `STAGING_HOSTNAME` | for example `staging.example.com` |
| `STAGING_ROUTE53_ZONE_ID` | Route53 zone containing that hostname |
| `STAGING_ALERT_EMAIL` | monitored operational email |

Add three repository secrets: `STAGING_TELEGRAM_BOT_TOKEN` from the separate staging bot,
`STAGING_TELEGRAM_WEBHOOK_SECRET` containing at least 32 cryptographically random characters, and
`STAGING_TELEGRAM_ACTION_TOKEN_KEY` containing an unpadded base64url-encoded random 32-byte key.
Keep the action-token key independent from the webhook secret and media signing/encryption keys. Do
not add AWS access keys: GitHub uses a short-lived OIDC role restricted to this repository and its
`main` branch.

Repository secrets are used because protected environments are unavailable for this private repository on the current GitHub plan. The workflow is manual-only, refuses non-`main` refs, requires the exact `DEPLOY-STAGING` confirmation, and the AWS trust policy independently permits only the `main` branch. Upgrade the repository plan and move these values into a required-reviewer environment before production.

## Deployment sequence after AWS exists

1. Open Actions → **Deploy staging (creates billable AWS resources)**.
2. Select the exact default-branch commit.
3. Enter `DEPLOY-STAGING`; leave image tag empty to use that commit SHA.
4. Confirm that the selected ref is `main`; the workflow and AWS trust policy reject any other branch.
5. On the first deployment, the workflow creates inactive infrastructure. It builds and pushes one immutable image release, registers and runs its migration task without changing live services, then activates two replicas per service and runs safe HTTPS/webhook checks. Later deployments leave the previous release online through image preparation and migration.
6. Complete [`../../runbooks/m1-staging-acceptance.md`](../../runbooks/m1-staging-acceptance.md). Do not mark M1 accepted from deployment success alone.

## Rollback after AWS exists

Use Actions → **Roll back staging (uses existing AWS resources)**. Select `main`, enter an earlier immutable image tag, type `ROLLBACK-STAGING`, and check the schema-compatibility confirmation only after verifying that the older application version works with every migration already applied to the database. The workflow refuses missing images and waits for the restored ECS services to become healthy. It never rolls the database backward.

## Security and operational boundaries

- PostgreSQL and Redis have no public address path; only the ECS security group may connect.
- Runtime tasks cannot read arbitrary secrets. The execution role can inject only the single runtime secret.
- Terraform state contains generated database/Redis credentials, so its bucket is private, encrypted, versioned, locked, and protected from deletion.
- The bootstrap deployment role is broad only because it targets a dedicated empty staging account. Replace its managed administrator policy using IAM Access Analyzer before production.
- One NAT gateway deliberately reduces staging cost and is a staging-only failure point. Production uses independent egress per availability zone.
- R2 settings remain disabled placeholders until M2. Guest Preview candidate delivery and protected-change administration remain unavailable.
- Never run `terraform destroy` as an ordinary rollback. Roll back the immutable application image while preserving compatible database migrations.
