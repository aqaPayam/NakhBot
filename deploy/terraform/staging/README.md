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

These staging workflows currently use repository secrets and a `main`-only OIDC trust policy. They are manual-only and require the exact deployment or rollback confirmation. Configure a protected environment with required reviewers before production; the staging workflow is not production approval.

## Deployment sequence after AWS exists

1. Open Actions → **Deploy staging (creates billable AWS resources)**.
2. Select the exact default-branch commit.
3. Enter `DEPLOY-STAGING`; leave image tag empty to use that commit SHA. An explicit tag must be that same full lowercase SHA; alternate tags are rejected so the image source cannot differ from the checkout.
4. Confirm that the selected ref is `main`; the workflow and AWS trust policy reject any other branch.
5. Before AWS access, the workflow requires the selected source's newest CI run to have all six jobs green in the same attempt, with live native/performance/telemetry artifact digest references. Missing, expired or mismatched evidence blocks deployment. It repeats the check before migration and activation and retains a content-free prerequisite receipt; that receipt is not proof of deployed provider acceptance.
6. On the first deployment, the workflow creates inactive infrastructure. It builds candidate images, attests only those fresh builds, verifies the exact source/workflow and image bytes before assigning the commit tags, then pins all four task images and the API migration image by digest. It registers and runs its migration task without changing live services, then activates two replicas per service and runs safe HTTPS/webhook checks. Later deployments leave the previous release online through image preparation and migration; respect migration-specific quiescence requirements before dispatch.
7. Complete [`../../runbooks/m1-staging-acceptance.md`](../../runbooks/m1-staging-acceptance.md). Do not mark M1 accepted from deployment success alone. M9 release preparation and remaining production gates are tracked in [`../../../docs/technical/33-m9-execution-guide.md`](../../../docs/technical/33-m9-execution-guide.md).

## Rollback after AWS exists

Use Actions → **Roll back staging (uses existing AWS resources)**. Select `main`, enter an earlier full lowercase commit SHA, type `ROLLBACK-STAGING`, and check the schema-compatibility confirmation only after verifying that the older application version works with every migration already applied to the database. The workflow refuses missing or unprovenanced images, verifies their original deployment workflow/source attestations, pins their exact digests and waits for restored ECS services to become healthy. Historical images without trusted attestations cannot be qualified merely by reusing their tags. The schema checkbox remains a separate operator prerequisite; a native schema/transport compatibility gate is still required before production. It never rolls the database backward.

## Security and operational boundaries

- PostgreSQL and Redis have no public address path; only the ECS security group may connect.
- Runtime tasks cannot read arbitrary secrets. The execution role can inject only the single runtime secret.
- Terraform state contains generated database/Redis credentials, so its bucket is private, encrypted, versioned, locked, and protected from deletion.
- The bootstrap deployment role is broad only because it targets a dedicated empty staging account. Replace its managed administrator policy using IAM Access Analyzer before production.
- One NAT gateway deliberately reduces staging cost and is a staging-only failure point. Production uses independent egress per availability zone.
- R2 settings remain disabled placeholders until M2. Guest Preview candidate delivery and protected-change administration remain unavailable.
- Never run `terraform destroy` as an ordinary rollback. Roll back the immutable application image while preserving compatible database migrations.


## Image provenance and retention

Every non-bootstrap Terraform task registration requires all four reviewed image
digests, including targeted migration registration. The release CLI sets
`TF_VAR_image_digests` only after verifying all four registry subjects with the
GitHub CLI, restricted to this repository, the deployment workflow, the selected
source and signer commit, `main`, GitHub-hosted runners and SLSA v1. The bootstrap
exception stays inactive with zero application tasks. CI checks each real image's
revision, source and application labels as well as its non-root runtime.

The deploy CLI verifies the actual checkout SHA and rejects tracked source drift
before preparation or promotion. Fresh builds use `candidate-<source>-<run>-<attempt>` tags. They receive commit tags
only after attestation verification and an exact manifest-byte/hash check. An
interruption before signing leaves no unverified commit tag that a later run
would silently accept. Existing commit tags must already have their original
trusted proof; the workflow never manufactures provenance for an unknown image.
A conflicting existing tag stops the release. Rollback never builds or promotes
images. Native AWS/registry/GitHub acceptance still needs an authorized real
staging rehearsal; simulated protocol tests are not that evidence.

The ECR lifecycle policy expires only excess untagged images. Tagged current,
rollback and candidate images remain available until reviewed cleanup; do not
apply the former count-based rule to all images, because failed candidate builds
could otherwise evict an active or rollback binary. Review failed candidate tags
and storage growth operationally. The fourteen-day Actions receipt is convenient
CI evidence; copy release receipts, signed bundles and rollback/schema decisions
to approved durable release custody before relying on them beyond that interval.
Do not upload private catalog/administrator review snapshots as public artifacts.

The manual deployment can create billable AWS resources. No workflow dispatch,
Terraform apply, real bot activation or provider signing rehearsal is authorized
by a local test or by these source changes alone.
