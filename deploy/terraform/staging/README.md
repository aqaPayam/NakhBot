# Staging Terraform skeleton

This provider-neutral root locks the required staging capabilities without guessing the hosting provider or region. After those deployment inputs are chosen, the platform owner must add reviewed provider modules for network, managed containers, PostgreSQL, Redis, secrets/KMS, telemetry, DNS/TLS, and workload identity. Cloudflare R2 remains a separate private-media module.

The application can be implemented before that provider decision. Production infrastructure must satisfy the acceptance checklist in `docs/technical/12-deployment-and-scaling.md`.
