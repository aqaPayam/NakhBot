# Production bootstrap custody

Run this root only from a reviewed, MFA-protected local AWS SSO session in the
separate production account. It creates the private encrypted/versioned state
bucket, GitHub OIDC provider and a production deployment role. It creates no
application workloads. Do not apply before account, region, costs and security
approval exist. Preserve its initial local state in protected custody, then move
it to the production-owned encrypted backend under a separate bootstrap key.
Do not overwrite the runtime state key or reuse staging bootstrap state.

Required inputs are `expected_aws_account_id`, a different
`staging_aws_account_id`, `aws_region`, `github_oidc_subject` and
`reviewed_deployment_policies`. There is no default production permission set.
The provider pins the production account, and the role checks observed identity.
The staging bootstrap's `AdministratorAccess` attachment is never copied here.

`reviewed_deployment_policies` maps one to five existing customer-managed IAM
policy ARNs in the production account to reviewed canonical document digests.
Compute each digest with `sha256(jsonencode(jsondecode(policy_document)))` in
Terraform console against the exact policy version being reviewed. This root
reads the policies and rejects account/partition mismatches, changed document
bytes, blanket `*` or `service:*` Allow actions and Allow NotAction/NotResource.
It attaches only that exact policy set. Canonical whitespace/key-order changes
do not invalidate an otherwise identical document.

These checks do not establish least privilege or grant security approval.
Use observed staging activity and IAM Access Analyzer to prepare the production
policy set, then review it against all production resource names and required
release operations. Scope IAM role creation/policy changes and `iam:PassRole` to
the intended ECS roles, require their reviewed permissions boundaries, and prevent
the deployment role from modifying its own authority, OIDC trust or bootstrap
custody. Include required Terraform state locking, source-image builds, immutable
archive reads/writes, drained tasks, secret references, maintenance recovery and
schema-aware rollback. Validate the complete policy set with real AWS before
launch. Do not replace missing permissions with AdministratorAccess or an
unreviewed wildcard policy. Permission qualification cannot be completed before
the owner has accounts and actual service observations.

Existing managed policy documents remain mutable by their owners. Reconcile
canonical hashes and review policy versions/attachments before every real release;
a bootstrap plan is not ongoing IAM drift monitoring. Keep full policy documents,
provider observations and review evidence in protected operator custody. Outputs
contain only the role/state identity, exact OIDC subject and document hashes.

Configure the GitHub `production` environment with required reviewers, prevention
of self-review and deployment branches restricted to `main` before trusting it.
The production workflows select that environment and also check `main`. The
trust document pins the exact supplied subject and `sts.amazonaws.com` audience.
Environment jobs use an environment subject rather than the staging branch
subject. GitHub may include immutable owner/repository IDs; confirm the observed
format and supply exactly one subject. Never paste a JWT or credentials into chat.
Both documented subject formats are supported, without wildcard or alternate
repository/environment fallback. See GitHub's [AWS OIDC guide](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
and [OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).

CI uses mocked AWS responses to exercise policy/identity denial and exact trust
rendering. The tiny read-only test policy is a fixture and cannot deploy NakhBot.
Mock success does not verify AWS permissions, environment protection, credential
custody, provider delivery or launch acceptance. No real resources have been
created. Retained-data erasure remains disabled pending approved policy periods.
