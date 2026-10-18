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

The protected production deployment workflow and production controller context
are the next integration step. The staging workflows are still staging-only and
must not be used to activate this root.
