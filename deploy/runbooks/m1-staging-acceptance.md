# M1 staging acceptance record

Complete this record against the exact default-branch commit that passed CI. Attach protected log/query screenshots or run links; never paste secrets or User/Profile content.

The free local rehearsal prepares this procedure but cannot close any cloud observation. Billable application infrastructure remains absent until the guarded manual deployment workflow is explicitly run.

## Release identity

- Commit: _pending_
- CI run: _pending_
- Staging release/deployment: _pending_
- Operator and UTC time: _pending_

## Required observations

- [ ] Telegram webhook rejects an invalid secret and accepts the configured secret.
- [ ] Duplicate Telegram `/start` delivery produces one User aggregate and the same replayed result.
- [ ] A process restart during signup resumes the exact persisted step and version.
- [ ] Concurrent first-start and Guest Preview final-slot scenarios match CI evidence.
- [ ] Injected confirmation failure rolls back Profile, Account transition, audit, and outbox together.
- [ ] Outbox replay produces no duplicate downstream effect.
- [ ] Representative private fields are absent from structured logs; redaction markers are present.
- [ ] M1 metrics and alerts are visible with only bounded labels.
- [ ] Migration status and verification pass on the restored staging database.
- [ ] Backup/restore smoke passes with PostgreSQL 17 client/server compatibility.
- [ ] Protected-change production resolution and Guest Preview candidate delivery routes remain unavailable.

## Defect decision

- Critical/High defects: _must be zero_
- Medium defects, owner, and release decision: _pending_
- Final M1 acceptance: _pending_

## Pre-deployment readiness

- [ ] `deploy/terraform/bootstrap` and `deploy/terraform/staging` pass formatting and validation in CI.
- [ ] The local staging rehearsal passes on the exact release commit.
- [ ] A dedicated, MFA-protected staging AWS account exists.
- [ ] GitHub Actions repository variables/secrets, the main-branch-restricted OIDC role, remote state bucket, DNS zone, alert email, and webhook secret are configured.
- [ ] The monthly budget was reviewed before entering `DEPLOY-STAGING`.
- [ ] The rollback workflow was inspected, a known-good immutable image tag was recorded, and its compatibility with the current forward-only schema was confirmed.
