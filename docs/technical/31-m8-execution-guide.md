# M8 Execution Guide — Deletion, Retention and Production Hardening

Start from verified M7 implementation `d9ff0e1e681108984369ce82bbae82370541ed59`.
M7 remains code complete / staging blocked; its provider/operator evidence is not invented here.
M8 owns `ACC-042..044`. M9 activation is outside this work.

## Current increment

The deletion lifecycle defines eight ordered phases: shared closure, evidence capture, ordinary
product data, media objects, ephemeral access, retention manifest, verification and completion.
Checkpoint changes cannot skip, repeat, reverse or restart completion. Fresh return requires a
deleted Account, completed purge, explicit reactivation approval and no retained safety bar.
Completion alone never grants return. GuestPreviewCounter and immutable safety history remain.

Own-account contracts require user authority, an opaque confirmation token and an exact Account
version. Clients cannot select another subject, set retention policy or receive private manifest
content/provider keys. The store now implements durable preparation/confirmation/cancellation and atomic tombstone admission.
The worker, shared closure, media fences and ingress composition remain required before activation;
no deletion route or purge worker is enabled by this increment.

Identity reads now preserve deleted-account routing after settings purge, use public default locale
and disabled visibility while deleted, and retain the original preview counter. Start replay reads
current Account state; new starts lock User then Account before touching mutable identity data so
they cannot repopulate a deleted username. Native PostgreSQL probes include twenty concurrent
starts and a start blocked behind a committing tombstone. Live accounts missing required settings
fail closed rather than attempting to register another identity. These are lifecycle prerequisites;
they do not authorize return or enable deletion ingress.

M8 prerequisite commit `27ddf1d` passed quality, all four images and 411 native tests, but its
terminal M7 integrity snapshot took 1618.507 ms against the unchanged 1500 ms budget. No disk spill
or missing parallel worker explained the failure. The repair uses a set join for exact historical
resolution candidates and evaluates the cheap resolution-existence violation first in aggregate
sampling. All owning bindings and paged diagnostic ordering remain; eleven additional single-field
corruption probes compare scanner, current metrics and health findings, then verify repair. The
candidate must pass the complete exact-head CI, including all 27 plans, before more M8 features.

Repair candidate `cc24bd3` passed all 411 native tests and five CI jobs, but the terminal snapshot
took 1772.502 ms and the free set join lost the required resolution-index path. Its replacement
keeps an episode-specific covering-index candidate boundary, validates owner/request/digest fields outside
the narrow physical-key joins, and separates administrator admission, restoration and non-account
actions into exhaustive branches with distinct exact history sets. Resolution facts preserve both
valid and invalid candidates through grouping. Episode audit/notice joins use unique references,
with every original safety predicate evaluated in its flag; this removes a repeated materialized
audit scan observed in the isolated 1,000-episode diagnostic (124 ms terminal snapshot, no
materialized rescan). That smaller probe is not production acceptance. No safety binding, historical
plan, fixture volume, repeated sample, required index or execution budget is removed. Native
account, photo, corruption, metrics and health evidence precedes another complete exact-head CI.

Repair `e8405a7` passed five jobs and every 1,500 ms execution limit (terminal snapshot
1379.550 ms), but PostgreSQL selected a full action scan/sort instead of the required resolution
index. The next candidate restores the parameterized episode lookup while retaining grouped
validation and the audit/notice scan repair. Index requirements remain unchanged.

Repair `504bc59` retained both required indexes and passed 411 native tests, but its terminal
snapshot took 1657.292 ms. The indexed resolution relation performed 20,001 administrator-log
lookups. The next candidate materializes the indexed candidates before joining attempt evidence,
so the dense batch can use its cardinality without losing the episode-specific index boundary.
The isolated 1,000-episode diagnostic retains that index, replaces repeated attempt probes with
one attempt scan and reports no repeated materialized scan; 17 focused native tests pass. The
Windows 20,000-volume diagnostic timed out on a count query without lock/constraint failure;
it is not acceptance evidence. Full Linux CI remains required.

Repair `2b1bf48` kept both required indexes and passed the native integration suite, but the
terminal snapshot took 1584.967 ms. The four action branches repeated large audit/notice/attempt
joins. The next candidate restores the verified two actor branches from green `7a1aab7`, retaining
all exact history classes, while preserving the indexed episode candidate batch and physical
audit/notice reference repair. No performance or correctness gate is weakened.

Green repair `30151e9` passed all six CI jobs, 411 native tests and all 27 unchanged historical
plans (terminal snapshot 1408.185 ms, both required indexes present).

The next M8 admission increment stores only confirmation hashes with a five-minute database-clock
expiry. An actor/version/request-bound HMAC permits preparation replay and derive-only key rotation.
A refresh cancels old authority; confirm/cancel use one owning lock and immutable durable receipts.
Successful confirmation saves Account deleted state/history, cleared username, a private lifecycle
record with reactivation denied, required content-free audit/outbox and mandatory purge work in one
transaction. A deferred constraint requires the complete exact admission chain; missing evidence
rolls everything back. Command receipts outlive the 24-hour transport cache. Stable User locks use
NO KEY UPDATE so Account-first moderation can complete its FK KEY SHARE while a start waits.
Native evidence covers twenty-way preparation/request races, cancellation races, expiry, borrowed
proofs, changed replay, required insert failure, banned deletion, checkpoint guards and lock order.

Admission commit `97da3f9` passed all four image jobs and `pnpm check`. Its native run passed
421 tests but the pre-existing English catalog assertion still expected 582 entries instead of
585 after the three deletion errors were seeded. The repair updates that exact catalog assertion
and verifies each new message. The quality rehearsal separately failed during Docker collector
startup before any metric export; the completed job is rerun unchanged to diagnose transience.
Neither failure authorizes advancing to another M8 feature before the repair is fully green.

The unchanged quality retry for `97da3f9` passed, but `e6155de` encountered another Docker startup
failure. Startup now pulls the same versioned public collector image separately, with a bounded
three-attempt retry only for recognized transient registry/transport failures. Denied, missing,
runtime-collision and unknown failures fail closed. Each Docker command has a sixty-second bound;
container start and every SDK/conversion/privacy assertion still execute once. Fourteen unit
scenarios verify recovery, exhausted retries, permanent failures and fixed diagnostic output.
Only an allowlisted startup classification can be logged; stderr, URLs and metric payloads remain
private. Real collector conversion still requires the complete quality CI job.

The catalog repair `e6155de` passed all 422 native tests, but the terminal integrity snapshot
took 1577.896 ms against the unchanged 1500 ms limit. The aggregate now counts episodes with
invalid resolution evidence once, then evaluates the remaining complete flags and witness
aggregation only for resolution-valid episodes in the same statement snapshot. Detailed
reconciliation preserves every flag and its original scope. Fifteen focused native tests pass,
including resolution corruption and scanner/metric parity. The isolated 1000-volume probe is
diagnostic only; full-volume Linux CI must still pass every original plan and index requirement.

Repair `684870f` passed quality, all four images and all 422 native tests. Both required indexes
remained, but the terminal snapshot still took 1560.106 ms. Its action branch performed 20006
separate Report probes. The next repair removes that forced parameterized relation and lets the
primary-key join select a dense batch plan; every owning Report predicate remains unchanged.
The isolated 1000-volume diagnostic improved terminal action evaluation from 42.906 to 37.908 ms
and the snapshot from 122.696 to 112.870 ms. This is topology evidence, not full-volume acceptance.
All fifteen focused native threshold, action-corruption, scanner/metric and health tests pass.

Green repair `1cff2f8` passed all six CI jobs, 422 native tests and all 27 original plans. Its
terminal snapshot took 1236.938 ms with both required indexes present. No gate was relaxed.

Mandatory deletion work now has bounded SKIP LOCKED claiming and monotonic generation fences.
The same returning worker ID receives a new generation after expiry. Database-only batches lock
User, Account, deletion record and work in that order, validate exact phase/version/owner/generation
and Account tombstone, then recheck database-clock expiry before commit. Failed or expired batches
roll back; renewal never shortens authority, and release/retry atomically clear the owner with a
fixed error code and database-clock scheduling. Durable work is independent of outbox/cache loss.
Migration 86 preserves pending deletion evidence and adds lease mutation and deferred record/work
consistency guards. Leasing cannot authorize phase advancement: verified phase executors and
receipts are still required before that transition or the actual purge worker can be enabled.
Native evidence includes ten work scenarios covering twenty-way ownership, renew/release races,
SKIP LOCKED progress, same-worker expiry recovery, blocked-lock expiry, transaction rollback,
expired-batch rollback, required settlement failure, transport loss and forged/raw progress denial.
The 53-test admission/work/migration run passed; the final guard also passed all twenty focused
admission/work tests. Migration 85 pending record/work rows survive upgrade unchanged except
the new generation-zero field. Direct SQL cannot renew expired authority without a new generation.

## Execution sequence

Green shared-closure commit `75fc59b` passed all six CI jobs, 443 native tests and all 27 historical
plans. The terminal snapshot took 1487.074 ms against the unchanged 1500 ms limit, with both
required indexes present. Local final checks passed 908 unit tests and 32 focused native scenarios.

The next backend increment closes one normalized shared pair per fenced transaction. It rescans
remaining active facts after interruption instead of trusting outbox delivery or a transport cursor.
It cancels active Likes, closes Match/Chat scopes, revokes grants (including grants on already-closed
Likes/Matches), cancels unpaid pending Nakh intents with one sender-counter decrement, and closes
sent/seen Nakh with append-only history. Blocked pair state, Report sources/snapshots and all credit
ledger/provider evidence remain unchanged. Paid or failed pending fulfillment requires a separate
financial closure path and currently fails the batch; it never becomes a falsely cancelled payment.
Each changed pair requires a content-free audit and closure event in the same transaction, plus a
deduplicated localized chat-closure notice when the surviving participant has a closed chat scope.
Deletion of both participants suppresses product notification delivery to the deleted counterpart.
Pair batches take sorted sender counters, the normalized pair and sorted identity locks before the
work fence. Chat/unmatch use the same pair-before-Account order. Chat capability and the actual
history read reject a deleted counterpart immediately; read/mute receipts cannot bypass that check.
Normal unmatch also rejects a deleted counterpart. This does not complete the shared phase:
verified phase receipts, all remaining ingress/delivery guards and the actual purge worker are pending.

Native shared-closure scenarios cover twenty-way retries, one-pair restart after outbox loss,
required audit/event/notice rollback, encrypted Report evidence and ledger preservation, immediate
chat tombstones, pending/delivered Nakh reconciliation, ordinary unmatch races, expiry while waiting
for a pair lock, and preservation of a blocked pair while closing an orphan active chat/grant.

Migration 87 adds immutable, content-free phase receipts. The shared checkpoint locks the owning
User, Account, deletion record and mandatory work, verifies the exact live lease and every active
shared scope, and atomically saves its receipt, required audit/event and both phase/version updates.
The lease is checked again at transaction commit. Only shared closure to evidence capture is
enabled; missing/altered evidence, invented milestones and later phase advances fail closed.
An exact owning worker replay uses the durable receipt after transport loss; a borrowed identity,
owner or generation cannot reuse it. A newly claimed evidence-capture lease has a new generation.
Existing pending/claimed work survives upgrade without invented progress; unexplained legacy
milestones fail the migration. Receipts cannot grant return or authorize retained-data release.
Native checkpoint scenarios exercise twenty-way completion/replay, each of the eight shared scope
classes, missing required writes, altered audit/event/lease bindings, commit/lock-wait expiry,
immutable receipts, denied future-phase advances and a missing pending-counter foundation.
Migration 87 must be deployed before the checkpoint store; ingress and the full purge worker remain
disabled until the remaining verifiers and product/media/evidence/retention work are implemented.

Checkpoint commit `536e320` passed quality, four images and all 466 native tests, but the M7
encrypted-evidence fixture count timed out at 60 seconds before any performance artifact could be
saved. The repair refreshes statistics for bulk uncommitted evidence before verification and
materializes complete production integrity-source flags once before filtering verification counts.
Every capture/custody/threshold binding, cardinality and admission-window assertion remains. The
20,000-volume Windows diagnostic now completes all verification and measures all plans, authenticates
20,000 encrypted captures and verifies 20,000 typed-message captures, with exact matching metadata
counts and both required terminal indexes. Its terminal snapshot is 2547.125 ms; this diagnostic is
not production acceptance. Linux CI must still pass all original 27 plans and the unchanged 1500 ms
limit before more M8 features. No fixture volume, repeated sample, index or safety gate is removed.
Native corruption fixtures also refresh the same table statistics before sampling newly seeded
uncommitted scenes; all wrong-review, wrong-target, restoration, duplicate and cleanup assertions
remain, with their original 60-second test limit.

Repair commit `918b457` passed all six exact-head CI jobs, including all 466 native tests and
27 original query plans. The Linux terminal snapshot was 964.198 ms against the unchanged
1500 ms limit, with both required indexes. This resolves the preceding fixture timeout before
further M8 implementation.

The M8 dependency review updates published patches for Undici 8, source-map-js 1, both
brace-expansion branches, both fast-uri branches, Fastify 5 (including Nest's dependency) and
esbuild 0.27 consumers. The esbuild override crosses a minor version and requires the full
build/test checks and all four image builds. The audit policy is unchanged. A full dependency
audit still reports the development-only `braces` stack-exhaustion finding through
`eslint-plugin-boundaries` / `@boundaries/elements` / `micromatch`. Registry verification found
no published `braces@3.0.4`; the [upstream advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
lists no patched release. Do not invent a patch pin, suppress the finding, or treat a production-only
audit pass as a clean full dependency scan. The unresolved high finding remains a launch blocker
until a verified remediation or explicit, owned, expiring risk approval exists. No exception is
approved by this change, and the fallback security audit continues to inspect the complete lockfile.

1. Implement durable actor/version-bound confirmation and atomic Account tombstone, history,
   deletion record, audit/outbox and mandatory purge work. Prove twenty-way races, replay, changed
   payload denial and required-audit rollback. Banned-account deletion remains available.
2. Close every shared Like/Match/Chat/Nakh/unlock scope in bounded resumable batches; race normal
   commands and prevent deleted content/access from reaching the other participant.
3. Secure required Report snapshots before ordinary purge; preserve exact private evidence holds.
4. Purge ordinary data by a machine-readable entity registry, including dependent references,
   notifications, support, signup, discovery, interactions and product financial projections.
   Never rewrite financial history or delete the other participant's financial ledger.
5. Revoke media delivery immediately; delete and verify ordinary objects, fence retries and preserve
   only explicitly retained private evidence. Invalidate ephemeral caches/sessions/projections.
6. Produce a content-free retained-data manifest with policy owner/purpose/access/review rules.
   Approved retention periods are an external input. Implement policy-controlled release and
   dependency handling; keep retained-data purge disabled until approval is supplied.
7. Verify the entire deletion registry and allow only approved fresh return: same stable identity,
   unchanged preview counter, zero balance and no restored old product data or safety evasion.
8. Complete localization/static checks, bounded worker scheduling, aggregate telemetry, alarms,
   load/failure/security tests, backup/PITR/restore/DR procedures and acceptance documentation.

Each necessary commit passes `pnpm check`, is pushed to `main`, and must pass all six exact-head
CI jobs before the next feature. Diagnose and repair failures first; preserve privacy-safe native,
migration, concurrency, plan/load and recovery evidence. Count tracked lines with
`git ls-files -z | xargs -0 wc -l`. Historical production queries and limits remain authoritative.

## Acceptance boundary

Migration 89 adds bounded, resumable verification receipts for existing Report evidence belonging
to the deleted reporter or target. The same internal reader authenticates administrator reveals
and deletion verification: encrypted captures require exact AEAD/AAD/key-version/content-hash
validation, typed message captures require their complete integrity digest, and photo/unmatch
references retain their exact bindings. Administrator authorization and reveal/access audits remain
at the administrator boundary. Deletion discards decrypted content and requires its exact live work
fence, content-free audit/event and immutable receipt; verification is checked again at commit.
Receipts bind the complete persisted capture fingerprint and never depend on an expired outbox
event for replay. Missing captures wait, missing keys or invalid captures fail closed, and previously
verified captures cannot silently change. Photo verification here covers the capture and held
metadata; provider bytes and absence are still separate media obligations. No phase advance or
source deletion is enabled: controlled source archival and the complete evidence-phase verifier
remain required. Deploy migration 89 before the new verification store. Retained-data release
remains disabled without approved policy. The schema inventory currently has 117 tables and 210
foreign keys before migration 89; complete registry coverage must follow actual catalog state.

The machine-readable deletion registry now covers migration 89's actual 118 tables, 1,081 columns
and 213 fully qualified foreign keys. Native probes compare the complete current catalog, execute
every linked selector under an owning deletion fence and reject table/column/dependency drift.
One-resource observations are bounded, content-free and repeatable; forged subjects, unknown
resource indices and stale generations cannot inspect another scope. Columns inherit a reviewed
table action, without an unknown-table default. Required financial/safety/workforce policies remain
distinct from ordinary product purge. Global typed operational obligations return unknown rather
than a false absence. This registry is a prerequisite for the full purge/verification executor;
linked observations do not resolve all polymorphic references, authorize purge, complete evidence
capture, verify provider objects or cover Redis invalidation. Retention release remains disabled.

Migration 90 creates minimal original Profile reference anchors (Profile ID and owner ID only),
backfilled from live source identities without copying product content or inventing Report captures.
Profile evidence and photo associations keep their original IDs and ownership after source removal.
Historical photo-action reconciliation follows that same immutable owner reference; new Report
admission still requires a live authorized source. Profile identity/owner reassignment, unaudited
source deletion and deleted-account Profile reconstruction are denied. The fenced archive executor
checks the complete schema registry and every linked Profile/photo capture receipt, then atomically
records its required content-free audit/event/receipt and deletes the owning Profile plus cascading
ordinary details. Missing captures wait; required-write failure or commit-time expiry rolls back the
source deletion. Receipts replay independently of transport expiry and new worker generations.
The registry now covers 120 tables, 1,092 columns and 217 foreign keys; photo ownership selectors
follow the minimal anchor after source removal. Native probes include twenty-way archival, preserved
audited evidence reveals, exact private photo holds and ownership observations. No media object,
retained capture, ledger or counterpart Profile is released. Chat/unmatch/photo source archival,
provider checks and the full evidence-phase checkpoint remain required; this source-specific receipt
does not mark product purge complete or authorize return. Deploy migration 90 before these stores.

Profile archival commit `3edd7b8` passed quality and all four images. Its full native CI run passed
482 tests and failed 17 in two legacy administrative/review fixtures that created a Profile without
an Account foundation. The new source-reference guard correctly denied those fixtures. The repair
creates the active Account with each fixture User, removes redundant later Account inserts and
passes all 20 affected native tests. Production guards and every original assertion remain unchanged.
The complete exact-head CI, including the unexecuted performance/load/restore gates, must pass before
more M8 features.

Fixture repair `a0098b3` passed all 499 native tests. Its M3 performance setup then failed because
the deleted-account negative case marked the Account deleted before creating its historical Profile.
The next repair creates that source while active and applies the original deleted state after source
creation. All 24 final actionability cases, original 5,000 candidates, queries, index requirements and
budgets remain unchanged. A fresh isolated Windows diagnostic passes the complete M3 gate (pool
3.604 ms, count 4.680 ms, page 5.875 ms; required indexes present). The reused local database selected
a count scan and failed its index assertion; that diagnostic is not Linux acceptance. Full exact-head
Linux CI remains required. The independent collector job failed during public image pull before
startup/export with a fixed unknown classification, then passed one unchanged completed-job retry,
including the real SDK/conversion/privacy assertions. No collector, privacy or safety gate was relaxed.

Migration 88 binds shared closure to financial correction evidence. Paid pending delivery batches
roll back and return a bounded financial-resolution wait while the existing fenced billing worker
creates the exact target-unavailable refund obligation. Deletion never cancels a captured payment
or calls a provider while identity/pair locks are held. Failed unpaid intents may close without
changing financial history. Closed rows cannot conceal missing or mismatched receipt/refund
authority: the native checkpoint checks all eight active scope classes plus terminal financial
bindings, including its deferred commit check. Reconciliation uses the same financial predicate.
Previously advanced deletion records with unproven financial closure reject upgrade instead of
inventing progress. Existing verified receipts and work are preserved. A durable pending refund is
an outstanding billing obligation, not proof that a provider refunded money; billing records remain
retained. Future product purge must preserve that obligation and prevent late old-life fulfillment
from crediting a fresh return. Retained-data release and deletion ingress remain disabled.

Automated evidence must cover interruption at every checkpoint, replay/concurrent deletion,
pending evidence, provider absence verification, complete entity classification and delete/return
without restored product content. The full registry follows
[the retention registry](17-data-retention-registry.md) and
[testing strategy](11-testing-strategy.md).

Real staging/DR, approved retention periods, external security review and named operational sign-off
remain separate release requirements. Never label synthetic CI, a local restore or disabled policy
controls as those approvals. Stop when independent M8 implementation is finished and report exact
external blockers; do not begin M9.

Fixture-order repair `3be0702` passed all six exact-head CI jobs, 499 native tests in 91 files,
all 27 unchanged M7 plans (terminal snapshot 909.170 ms, both required indexes), the real collector
privacy/conversion rehearsal and migration/restore checks. This verifies the profile archival
implementation together with its repaired fixtures; synthetic CI is not staging or operator approval.

The next M8 media increment checks current Account capability under the stable User then Account
locks before upload/photo command receipts, own-photo reads and delayed validation/blur publication.
User locks use NO KEY UPDATE so Account-first moderation can acquire its FK KEY SHARE without a
lock cycle. Blur preparation also rejects a deleted owner before returning ready or pending paths.
Existing signup/restricted photo capability remains. Native probes use real deletion admission,
twenty-way old receipt/publication attempts and a worker observed waiting on a database lock before
a tombstone commits. This fences these PostgreSQL publication paths only: ingestion claims, provider
object cleanup/absence, issued edge grants and full deletion-phase completion still require their
separate M8 work. No retained capture, safety source or financial record is purged. Retained-data
release remains disabled because retention periods have not been approved.

The media candidate passes the full local quality check (917 unit tests) and five new native
deletion probes among 27 focused media tests. The reused local full-suite database had 330 due
notification deliveries, overflowing the unchanged tests' 100-row claims and causing two missing
fixture-claim failures. A fresh isolated full-suite replay passes 500 tests; four Redis probes are
skipped locally and require Linux CI. No notification implementation, batch or assertion was changed.
Initial test field/lock-probe mistakes and two lint assertions were corrected before commitment.

Media fence commit `3877710` passed all six exact-head CI jobs, 504 native tests in 91 files,
all 27 M7 plans (terminal snapshot 1046.464 ms, both required indexes), collector privacy and
migration/restore checks. No retained-data release or full M8 completion is claimed.

Migration 91 adds exact two-ID Chat/Match anchors and immutable bounded chat archival receipts.
The evidence-phase worker locks both relationship participants in the existing pair order, checks
the full schema registry and every linked chat/message/unmatch capture plus pending message marker,
then removes at most 500 oldest live messages. Each batch requires its exact content-free audit,
event, lease and original-message roster; the final batch also removes live Chat preferences,
cleanup progress and the ChatSession. Deferred guards recheck capture integrity, actual removal and
the original lease at commit. Ordinary M6 cleanup remains available for live accounts; deletion
cannot use it to bypass capture receipts. The original Unmatch consistency predicates remain and
use the verified terminal chat receipt after source removal. New post-unmatch report admission uses
the immutable Unmatch deadline, exact original Match participants and either live Chat membership
or the verified terminal unmatch Chat receipt; a reference anchor alone grants no authority.
Deleted-participant Chat reconstruction, raw
source deletion and anchor mutation are denied. Historical snapshots, capture markers and immutable
Unmatch records remain exact and require approved policy for release. The registry now records
122 tables, 1108 columns and 221 foreign keys. Match/photo archival, provider proofs and the complete
evidence checkpoint remain required; no phase advances, return authority or deletion ingress is enabled.

The chat candidate passes 111 focused native tests in eight files, including 38 migration
upgrade/replay cases, unchanged chat cleanup/report authorization, a 501-message resumable purge,
twenty-way source archival, preserved audited reveals, pending capture recovery and mandatory-write/
commit-time lease rollback. The initial pending-marker fixture correctly failed the existing typed
message authorization guard and was replaced by an authorized uncaptured request. A Windows fork
exit had no diagnostic exception code; the complete focused retry passed. The helper return type
and a formatter second-pass layout were corrected before commitment. Full exact-head CI is required.

A full local check passed formatting, lint, types and all 917 unit tests, then the application
build process exited with a Windows breakpoint exception (0x80000003) without a source diagnostic.
The unchanged isolated application build passed, including declarations. This classifies the observed
process exit, not its underlying cause; a complete successful check retry is still mandatory.

Report-window repair `049d594` preserves survivor preparation and idempotent submission after
verified chat archival, denies outsiders/deleted actors and rechecks the immutable deadline after
source-lock waits. Late Report captures remain discoverable by the evidence verifier. Quality and
all 518 Linux native tests passed, but the terminal integrity snapshot took 1578.327 ms against the
unchanged 1500 ms budget. Both required indexes were present; no disk spill, hash batching or
missing parallel worker explained the failure. The repair replaces grouped terminal-review outcomes
with exact tuple membership and binds unban candidates by immutable primary keys, validating every
original owner/history/command predicate in the resulting fact. Duplicate valid/invalid audits keep
existence semantics. Full-volume Windows diagnostics remove the review sort and preserve both
required indexes; their timings do not constitute Linux production acceptance. No fixture volume,
repeated sample, safety predicate, execution budget or index requirement is reduced.

Repair `98ed670` passed all six exact-head CI jobs, 520 native tests and all 27 unchanged
historical plans (terminal snapshot 1413.674 ms, both required indexes present). Its predecessor
`43c3bad` passed the native suite but exhausted container shared memory during the plan gate;
there was no completed M7 performance artifact or timing on that failed run. The repair retains
transaction-scoped planner settings, respects a lower operator parallel-worker limit and raises
parallel setup cost to avoid excessive shared hash arenas. No volume, index, execution budget,
safety predicate or container memory setting changed.

The next increment establishes minimal immutable original Match references and migrates retained
Chat/Unmatch identity FKs to them. A mandatory deferred check rolls back source creation if its
reference is suppressed, and a source deletion guard preserves the former live-FK protection.
Populated migration-91 upgrade probes include an already-deleted participant, twenty concurrent
migration attempts, unchanged product/Unmatch rows, new reference creation, reassignment/orphan
rejection and preserved survivor-only reporting. The catalog now covers 123 tables, 1,111 columns
and 223 FKs. Anchors alone grant no report or archival authority. Verified Match archival, photo
archival and the complete evidence checkpoint are still required; deletion ingress remains off.
