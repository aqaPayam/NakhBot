# Inactive production infrastructure

This root uses the same reviewed runtime module as staging, in a separate AWS
account, VPC, encrypted backend and resource namespace. It keeps application
services at zero by default. It does not deploy a bot or approve a launch.

Supply `expected_aws_account_id` for production and a different
`staging_aws_account_id`. The AWS provider pins the caller account; the shared
runtime also checks the observed identity. Production cannot disable database
purpose isolation, deletion protection or final snapshots. Each of the two AZs
has its own NAT gateway and private route.

`database_instance_class`, `redis_node_type` and `monthly_budget_usd` are required
owner inputs. They have no inherited staging defaults. Review measured capacity,
regional prices and a complete Terraform plan before authorizing billable
resources. The budget input configures alerts; it is not a cost estimate or
spending authorization. Do not run apply while accounts, region and costs are
unapproved. Keep state private and encrypted; it contains sensitive credentials.

The S3 backend must use production-owned custody and a separate key such as
`nakh/production/terraform.tfstate`. Do not reuse the staging deploy role,
backend, bot, provider keys or domain configuration. Provider secrets remain
references in the optional product runtime profile.

CI validates this root and runs AWS-mocked bootstrap, per-AZ routing,
targeted-registration and account/security denial cases. Local credential
generation is real; no AWS resources are created by those tests. Real provider
PITR/failover, DNS/webhook/R2, telemetry, operator, security/privacy and cohort
acceptance remain required. Retained-data erasure stays disabled pending approved
policies.

The dedicated `deploy-production.yml` and `rollback-production.yml` workflows
select this root through the existing release protocol. They share the
`production-deployment` concurrency group, use the GitHub `production`
environment, pin the production AWS account and require independent staging
account custody. Configure reviewed environment protection and a production
OIDC deployment role before using them. The staging bootstrap's
`AdministratorAccess` role is not a production deployment role; production
bootstrap IAM and its real policy qualification remain separate work.

Production image and manifest signatures must come from `deploy-production.yml`
at the exact source SHA. Staging signatures and repository namespaces cannot
satisfy production admission. Deploy seals the source-bound CI/image archive
before draining. Migration, purpose-role provisioning and compatibility run
while drained; held activation, task/image health checks and captured scaling
restoration retain the same fail-closed protocol. Failure or cancellation keeps
the fleet in maintenance. Rollback requires the protected production archive,
the selected source's current six-job CI status, explicit compatibility review
and the native schema gate. Its separate read-only role check connects with all
five selected purpose credentials and rejects drift without provisioning roles,
repairing ACLs or applying migrations. Older images without that CLI are denied.

Use `PRODUCTION_AWS_ACCOUNT_ID`, `PRODUCTION_AWS_REGION`,
`PRODUCTION_DEPLOY_ROLE_ARN`, `PRODUCTION_TF_STATE_BUCKET` and
`PRODUCTION_TF_STATE_KEY`, alongside the existing staging `AWS_ACCOUNT_ID`.
Supply `PRODUCTION_DATABASE_INSTANCE_CLASS`, `PRODUCTION_REDIS_NODE_TYPE` and
`PRODUCTION_MONTHLY_BUDGET_USD`. Product runtime, hostname, Route53 zone, alert
email and Telegram secret names use the `PRODUCTION_` prefix. Database purpose
isolation and signed archive custody are mandatory. No secret values belong in
repository variables or chat.

Production smoke checks use readiness and rejection of an invalid webhook
secret. They never send a fabricated authenticated Telegram user update.
Designated real tester journeys, bot/webhook registration, provider delivery,
policy/security/operator approval and cohort launch acceptance remain pending.
The workflows do not supply that acceptance or authorize billing by themselves.
