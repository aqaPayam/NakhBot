# Private VPS readiness observations

The small private staging pilot uses the owner's existing VPS. Its read-only
readiness command does not impersonate AWS, open a cohort, approve a review,
qualify production, or replace the protected AWS launch operator. Mutable VPS
launch admission still needs an independently reviewed implementation before
the private bot can admit testers.

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
suite owns one existing job by itself; the remaining files are balanced across
the other three jobs. Every report must account for every assigned file exactly
once before a source-bound shard receipt is written. All four receipts, including
the dedicated policy job, are still mandatory.
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
