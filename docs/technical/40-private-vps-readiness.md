# Private VPS readiness observations

The small private staging pilot uses the owner's existing VPS. Its read-only
readiness command does not impersonate AWS, open a cohort, approve a review,
qualify production, or replace the protected AWS launch operator. The separate
staging operator commands below preserve native review, audit and recovery
controls for a private pilot of at most ten testers.

Verified staff can request `/admin_signin` in their private bot chat even with
signup, start delivery and media ingestion disabled, or with product admission
closed. This is a first-factor entry only: an existing verified native staff
identity and active permissions are required; MFA enrollment still requires a
separate operator invitation and sign-in still requires an authenticator code.
It neither registers users nor grants roles or cohort membership. Commands
must be at most two minutes old and later than the current account-state,
identity-verification and active-role timestamps. Original product life and
session grants are checked again before handoff; retries share one native
issuance request. The browser credential is placed only in the URL fragment.
Quiet rejection and a separate five-per-minute budget protect this entry.
Ordinary product traffic continues through the existing admission gate.

The Docker build declares the application selector after common compilation,
allowing the four service images to reuse that checked workspace build. Source
labels, native-fixture source markers and non-root runtime users remain required.

The staff-entry candidate passed fourteen focused unit cases, workspace types,
lint, compilation and two selected native compiled-host cases. The latter use
five real purpose logins and test signup off and signup configured with closed
admission: concurrent retries produce one original native grant, non-staff,
stale commands and revoked roles produce no handoff, browser context accepts
the first factor, and MFA session issuance remains denied without enrollment.
The other eight cases in that file were excluded by this local focused run;
complete six-job exact-source CI is still required before deployment.

Separately, accepted source `a1ff3e3` passed all six jobs in
[run 41825728870](https://github.com/aqaPayam/NakhBot/actions/runs/41825728870),
including 1,503 native cases across 174 files with zero skips. Its four images
were deployed to the private VPS with original protections and transport hold.
The native closed-policy stop drill produced one immutable audit receipt and
recovered the same result on replay, with owner admission false. Private health
transition alerts were explicitly approved; Telegram accepted the test and
recovery messages. These observations do not claim human message receipt,
authenticator enrollment, provider webhook delivery or an opened cohort.

Run the compiled `packages/persistence-postgres/dist/cli/vps-launch-readiness.js`
as Linux root on the reviewed private operator host, with two absolute paths:
the protected binding JSON and a new private receipt file. The command emits
only a fixed completion message. It reserves the receipt exclusively and writes
its contents privately. Keep inputs and receipts outside Git and public logs.

The binding contains exactly `version: 1`, `environment: "staging"`,
`sourceSha`, `telegramBotId`, `machineId`, `databaseHost`, `databaseName`,
`databaseUser`, and `databaseSecretPath`. Review the actual deployed full source
SHA, bot ID, host `/etc/machine-id`, and owner database identity. The separate
secret JSON contains only `NAKH_DATABASE_URL`. Never put that URL in arguments,
the binding, or source control. Verified database TLS is mandatory, including
the exact hostname, database and original owner login; only an absolute optional
CA path may accompany `sslmode=verify-full`.

The CLI requires root-owned regular private input files, rejects hard links,
symlinks and oversized data, and rejects writable-by-others parent directories.
It rechecks the exact Linux/root/machine identity before secret access, after
secret capture and after the native owner/migration check. The native observer
reuses the existing read-only repeatable launch-health snapshot. Output always
states `launchAuthorized: false` and `productionQualified: false`.

Native tests exercise concurrent observations, unchanged audit/cohort authority,
wrong original database login and host drift. Their injected host/TLS fixtures
do not qualify real host ownership, private-file permissions or deployed TLS.
Each of the four native CI jobs uses at most two concurrent child runs, with
independent PostgreSQL clusters and Redis servers. The CPU-heavy retention-policy
suite shares one serial execution lane with ordinary suites; no sibling process
competes with it. The other three jobs each run two independent children. Every
report must account for every assigned file exactly once before a source-bound
shard receipt is written. All four receipts remain mandatory.
Failed, skipped, missing or duplicate coverage denies that receipt. Database
admission requires `fsync`, `synchronous_commit` and `full_page_writes` to be on.
All database fixtures use disk storage; the six jobs, original time limits,
query-plan budgets and backup/restore checks remain required.

The worker repair addresses a native twenty-retry retention lock timeout. Each
retry previously held the same identity lock while projecting the entire
code-owned schema catalog. Retention now captures its lease before asynchronous
work and performs that read-only projection before the identity lock, within the
same transaction. Exact migration-version checks bracket the native write; the
native function retains its independent live catalog, lease and required-audit
guards. Finish still performs its own independent verification. The original
twenty-way race and fifteen-second lock timeout remain unchanged. Native cases
also change the live catalog and migration ledger while a request waits for its
identity lock, and mutate the caller's lease after capture.
Only PostgreSQL lock-timeout errors receive a bounded retry: at most three
complete transactions, each with fresh schema, ownership and expiry checks for
the originally captured lease. Aborted inventory and audit writes roll back
together. Native integrity/ownership failures are not retried. Fault-injection
cases verify recovery after two lock failures, exhaustion after three attempts,
immediate conflict rejection and exact inventory/audit counts.
The final isolated candidate passed all 24 retention cases with zero skips in
619,721 ms of suite time on a disk-backed PostgreSQL fixture with synchronous
WAL, full-page protection and the original fifteen-second lock timeout. Its
observed duration updates dispatch weights only. This is candidate database
evidence, not complete source CI or provider/launch acceptance.

Candidate `02c576f` passed quality and three application jobs, but its API job
failed two sixty-second multi-Root retention-policy cases and the ten-way
composed signup replay. Isolated signup reproduction identified PostgreSQL
`55P03` at the per-viewer candidate advisory lock under the actual runtime's
unchanged one-second lock wait. Reservation now retries at most three fully
rolled-back lock-timeout transactions with the original captured input/effects;
current grants and candidate eligibility are checked again on each attempt.
Native fault cases verify rollback of a partially inserted reservation, exact
outbox/idempotency effects, bounded exhaustion and immediate integrity rejection.
The policy job changes dispatch only; all original cases, sixty-second
case deadlines, twenty-minute jobs and independent acceptance gates remain.
Qualification passed all 14 signup and six candidate cases using isolated real
PostgreSQL/Redis services on the VPS, and all 24 policy cases in the existing
local PostgreSQL fixture with durable writes enabled. A one-CPU VPS policy
diagnostic missed case deadlines and is not acceptance evidence. Complete
exact-source CI must still pass before any deployment or launch progression.

Candidate `94101d7` passed quality, the dedicated policy job and two other
application jobs. Scheduler reached the unchanged twenty-minute limit without
a completed test failure: migrations took 540,320 ms against a 226,376 ms
estimate, and final deletion took 322,846 ms against 156,021 ms. Dispatch now
uses the maximum of prior estimates and all 157 completed passing suite timings
from that run; 16 unfinished suites retain their earlier weights. These partial
observations affect routing only and cannot satisfy complete native acceptance.
All 173 files, four source receipts, six jobs and original limits remain required.

An isolated private candidate probe also passed eight checks on the actual VPS:
the real host and verified database TLS, non-root denial, production-binding
denial, wrong machine identity, symlink and hard-link denial, non-private secret
denial, and writable-parent denial. The candidate bundle SHA256 is
`4db77bde90cc6bab6e385e2958c50d5cd7aef88befb400bb9e1599e1c263165e`;
its receipt remains private. This used the accepted staging image as an isolated
diagnostic carrier, not a new application release. Local validation passed
`pnpm check` with 1,498 unit tests and three focused native tests. The complete
six-job exact-source CI result remains required before release acceptance.

Use a short-lived private operator container with dropped capabilities, no new
privileges, a read-only root filesystem and only the internal database network.
Mount the reviewed host machine ID, binding, separate database secret and CA
read-only, plus a separate root-private writable receipt directory. Application
containers stay non-root and do not receive these operator credentials. No
Docker socket, SSH key or whole-host filesystem mount is needed.

All original canary, cohort approval, safety, privacy and retention conditions
remain in force; retained erasure and support-body release remain disabled.

## Private staging admission and administrator provisioning

`vps-launch-operator.js` and `vps-admin-totp-operator.js` run under the same
qualified Linux root, machine identity, verified database TLS and original
database-owner checks. These are separate short-lived operator containers;
application containers remain non-root. They accept three absolute paths:
protected binding, protected request and a new private receipt. Files must be
root-owned, single-linked regular files with no group/other permissions.
Every ancestor must be a root-owned directory without group/other write access.
Symlinks, writable parents, oversized JSON and existing output files are denied.
Outputs use exclusive creation with mode 0600. JSON input is limited to 16 KiB;
review evidence files are independently limited to 1 MiB.

The launch binding extends the nine-field readiness binding with `operatorId`
(UUID) and `approvedCommandDigest` (SHA256 hex or null). Keep approval null
during preparation. The native requests support `health`, `resolve-member`,
`inspect`, `prepare-review`, `receipt`, and policy application. Preparation
hashes the actual protected evidence files; hashes bind contents and do not
certify their origin or the reviewer's acceptance. Audience must match the
protected source, staging environment and bot ID; at most ten original-life
members may be named. A plain `apply` cannot open a cohort.

For opening, prepare the existing native review dossier, show the exact cohort
and current blockers to the reviewer, and obtain explicit approval. The
`apply-reviewed` request has exactly `operation`, `input` and an absolute
`reviewPath` to the protected dossier receipt. Running either CLI with
`--digest REQUEST NEW_RECEIPT` computes the canonical command digest without
granting authority. Only after approval may that exact digest be installed in
the protected binding. Opening verifies the matching operator, fresh dossier
and digest before secret access, and verifies expiry again inside the native
policy lock. Existing lifecycle, version, idempotency and audit guards apply.
Independent `apply` of a closed policy and immutable receipt recovery do not
require the opening digest. Review evidence and a digest are not human approval.

The MFA binding adds `totpSecretPath`, `keyId` and positive `keyVersion`.
The protected key file uses the existing report-snapshot key-ring array format;
it is separate from the database secret. Approval requests use the existing
native `approve` shape and require the exact protected command digest before
any secret access. The reviewer must approve the named account and staff roles.
Historical enrollment and credential ciphertext custody is checked, including
revoked credentials, before another invitation is created. The enrollment
invitation is written only to the private receipt; it is never printed.
Credential revocation remains independent of an opening approval and invalidates
native session authority. The owner completes authenticator enrollment in the
existing administrator interface; these tools do not perform that human step.

Qualification added 10 unit and 12 native integration cases. They exercise
twenty concurrent openings, eight concurrent MFA approvals, mutation during
secret access, native-lock expiry, original-owner rejection, historical key
custody, real credential/session revocation and immutable recovery. Native
host/TLS observations in those tests are explicitly injected fixtures.
Separately, the actual private VPS passed 12 isolated compiled-command checks:
real Linux root/machine/native-owner/TLS health, private MFA digest, non-root,
production, wrong-machine, symlink, hard-link, writable-parent, oversized input,
existing-output preservation, non-private copied secret and unapproved MFA.
The candidate bundle SHA256 was
`c54a3bfd9ceab5480768ee02ab8c2a614d8bbeea832e211ab73da57c25bbb688`.
The permission-negative probe changed only a private copy of the database
secret. It used the accepted `8bc89ad` image as a diagnostic carrier, performed
no cohort/role grants, and did not deploy the candidate application or register
a webhook. Its private receipt explicitly denies launch and production
qualification. Complete exact-source six-job CI remains required.

Candidate `6f036b1` passed all 1,513 unit cases and all completed native
assertions, but its Telegram job reached the unchanged twenty-minute cap just
after reporting 543 passed native cases. Cancellation prevented receipt upload
and the final reliability gate, so this is not complete source acceptance.
All 174 completed suite timings from that run update routing estimates only.
Scheduling now uses seven weighted execution lanes across the same four native
jobs: one serial lane containing retention policy plus ordinary suites that
fit its spare capacity, and two independent parallel children on each other
job. Policy never shares its job's CPU with a second test process. Four exact
source receipts, strict child coverage for parallel jobs, native durability,
sixty-second case deadlines, six jobs and twenty-minute job caps remain intact.
