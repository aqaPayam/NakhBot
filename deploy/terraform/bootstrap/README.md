# AWS staging bootstrap

Run this root once from an MFA-protected local AWS SSO session in a dedicated staging account. It creates no application workload. It creates only:

- a private, encrypted, versioned S3 bucket for Terraform state and S3 lock files;
- the GitHub OIDC identity provider;
- a deployment role restricted to the `aqaPayam/NakhBot` repository's `main` branch.

The bootstrap role is intentionally broad because it must create the complete staging account. Never reuse it in a production account. After the first successful deployment, use IAM Access Analyzer activity to replace `AdministratorAccess` with a reviewed least-privilege policy.

Do not run this before an AWS account exists. The exact commands are in [`../staging/README.md`](../staging/README.md).
