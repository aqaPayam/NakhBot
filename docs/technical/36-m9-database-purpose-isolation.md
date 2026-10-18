# Runtime database purpose isolation

The original data architecture separates migration ownership from runtime access.
The M4 financial boundary also excludes provider payloads and charge identifiers
from ordinary profile/chat access. The staging baseline still injects its owner
credential into application tasks. This foundation supplies native role policy,
provisioning and startup proof; service and infrastructure adoption remain open.
It does not constitute a production deployment or permission to launch.

## Trusted provisioning

After migration, the trusted migration host can run the compiled
`node_modules/@nakh/persistence-postgres/dist/cli/provision-runtime-roles.js`
with a new UUID command ID and selected 40-character source SHA. `NAKH_RELEASE`
must match that SHA. `pnpm db:provision-roles` invokes the source equivalent.

Only the migration host receives owner `NAKH_DATABASE_URL` plus these protected
environment values:

| Value | Fixed login |
| --- | --- |
| `NAKH_USER_DATABASE_URL` | `nakh_user` |
| `NAKH_FINANCIAL_DATABASE_URL` | `nakh_financial` |
| `NAKH_ADMIN_DATABASE_URL` | `nakh_administration` |
| `NAKH_MAINTENANCE_DATABASE_URL` | `nakh_maintenance` |
| `NAKH_SCHEDULER_DATABASE_URL` | `nakh_scheduler` |

All connections must target the same host, port, database and transport query.
Passwords must be distinct canonical base64url encodings of 32 random bytes.
Do not put them in arguments, source, Terraform outputs or chat. PostgreSQL
receives SCRAM verifiers instead of clear passwords in DDL. Role names are
cluster-wide, so use dedicated environment clusters. Existing unsafe roles or
roles outside the provisioning actor's native management authority are denied.

The command checks the exact bundled migration inventory after taking the
migrator's shared lock, then serializes role changes under a second lock. Grants,
password changes and the audit receipt commit together. Replaying the same command
reapplies policy, including removal of table and column ACL drift, and keeps one
audit receipt. A changed request with that command ID fails. An audit record never
authorizes provisioning or skips native effects. Output contains status, replay,
role count and policy digest; errors omit credentials and native error bodies.

## Runtime admission

`RuntimeDatabases` captures configuration and purpose secrets before startup.
Enabled API pools admit user/administration purposes; gateway admits
user/financial/administration; worker admits user/financial/maintenance; scheduler
admits scheduler/financial. Their combined maximum stays within the existing host
pool budget. After verification, no additional purpose can be opened. Shutdown
closes all pools and prevents reuse.

`NAKH_DATABASE_ROLE_ISOLATION_ENABLED=true` selects this mode. Ordinary base URLs
must use the user login, or scheduler login for that host. Additional URLs resolve
through `NAKH_FINANCIAL_DATABASE_URL_REF`, `NAKH_ADMIN_DATABASE_URL_REF` and
`NAKH_MAINTENANCE_DATABASE_URL_REF`. Non-production legacy composition retains one
pool until adoption. Production construction requires isolation.

Admission checks native session/current identity, unsafe attributes, memberships,
ownership, CREATE rights, append-only proof mutation, seeded catalog mutation and
private financial column reads. Production also requires TLS and actual SCRAM
authentication. Unknown billing tables/columns are private for user/scheduler
roles. Financial summaries use explicit reviewed projections. Audit/ledger proof
is append-only; migration/RBAC/catalog seeds remain read-only. Views receive no
explicit grants. Database/public grants that violate admission fail closed.

Native integration covers concurrent replay, actual allow/deny SQL, audit-failure
rollback, column-grant drift repair, unprivileged provisioning denial, the
migration lock race, host-pool admission and the compiled CLI. CI additionally
requires actual SCRAM authentication; local trust authentication is not represented
as password-authentication evidence. The SCRAM derivation has an independent
RFC 7677 server-signature vector test.

## Remaining adoption

The four service composition roots must select the correct purpose before
listening or executing jobs, and existing journeys must run under those logins.
Production infrastructure must inject purpose-specific secrets instead of the
owner URL, and the release controller must provision roles after migration before
activation. Existing native store SQL using broad projections may need scoped
projections when tested under these roles. No service boundary is claimed enforced
until that adoption evidence passes. Real cloud, operator, privacy/security and
cohort/health acceptance remain required. Retained-data erasure remains disabled
pending approved periods.
