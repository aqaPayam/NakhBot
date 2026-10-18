# Runtime database purpose isolation

The original data architecture separates migration ownership from runtime access.
The M4 financial boundary also excludes provider payloads and charge identifiers
from ordinary profile/chat access. The staging baseline still injects its owner
credential into application tasks. Native role policy, provisioning and startup
proof now have service composition hooks; infrastructure adoption remains open.
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
private financial column reads, required view reads and custody-key isolation.
Production also requires TLS and actual SCRAM
authentication. Unknown billing tables/columns are private for user/scheduler
roles. Financial summaries use explicit reviewed projections. Audit/ledger proof
is append-only; migration/RBAC/catalog/report-reason seeds remain read-only.
Only fixed projections of known deletion ownership, current-life and lifecycle
proof views are readable. Full custody projection is limited to administration/
maintenance; scheduler integrity sampling receives only identifiers, hashes and
transformation metadata, excluding the private storage key. Match
writers receive one view-column UPDATE privilege to retain existing row locks;
they already have write authority on the underlying live Match table. Unknown
views remain denied, and replay clears column ACLs on views as well as tables.
Database/public grants that violate admission fail closed.

Scheduler chat/moderation reconciliation can insert its common run/anomaly
records and update run progress. Financial anomaly `safe_detail` remains
unreadable to that purpose even though it can insert its own structured finding.
The compiled scheduler check waits for its real first tick and rejects error
operations; a startup log alone is insufficient evidence.

Migration 162 supplies two bounded SQL capabilities for locking immutable seeds:
administrative permission lookup and active report-reason lookup. They preserve
the original row locks through `SECURITY DEFINER`, with a fixed `pg_catalog` search
path, fully qualified tables, bound parameters and no public execution. The role
provisioner grants them only to the relevant purposes; admission checks that
binding. Review mutations and their audits remain inside the existing native
command transaction. Runtime credentials cannot edit the seed rows themselves.

Public report creation inserts only ordinary capture fields. Administrative
assignment/decision, report closure, episode resolution and administrative actor
fields use the existing NULL defaults and receive no public INSERT privilege.
Automatic threshold processing retains its existing native checks and receives
only the needed report/episode/action/witness writes. Action and witness proof is
append-only. The SQL model marks those existing nullable defaults as optional
inserts; no table layout, foreign key or lifecycle rule changes. Deletion catalog
admission recognizes reviewed function-only migration 162 and still rejects
unknown version 163, with every existing column and foreign-key check preserved.

Native integration covers concurrent replay, actual allow/deny SQL, audit-failure
rollback, column-grant drift repair, unprivileged provisioning denial, the
migration lock race, host-pool admission and the compiled CLI. CI additionally
requires actual SCRAM authentication; local trust authentication is not represented
as password-authentication evidence. The SCRAM derivation has an independent
RFC 7677 server-signature vector test.

## Remaining adoption

The public purpose has column-scoped appeal insertion and append-only submission
proof insertion. Submission relies on the existing NULL/default review fields;
it cannot supply a decision, reviewer, note, review timestamp, submitted timestamp
or version, or update/delete the appeal. Admission checks require those grants
and reject review-field privilege drift. Native twelve-way submission proves
one exact-ban appeal and replay witness, changed-payload rejection and private
text exclusion from events. Replay repairs missing and excessive column grants.
The policy digest is version 2; deploying the changed grant policy requires a
fresh trusted provisioning command, rather than reusing a command for older
policy bytes. No table layout, migration or appeal review/unban rule changes.

The four service composition roots select purpose pools and verify them before
listening or executing jobs. API/gateway administration uses its own purpose;
Stars and funded Nakh operations use financial pools; deletion uses maintenance;
scheduler billing/Nakh reconciliation uses financial pools. Their actual native
journeys, including financial, scheduler and maintenance paths, must qualify
this adoption before production activation.
Production infrastructure must inject purpose-specific secrets instead of the
owner URL, and the release controller must provision roles after migration before
activation. Existing native store SQL using broad projections may need scoped
projections when tested under these roles. No service boundary is claimed enforced
until that adoption evidence passes. Real cloud, operator, privacy/security and
cohort/health acceptance remain required. Retained-data erasure remains disabled
pending approved periods.
