# M8 Execution Guide — Deletion, Retention and Production Hardening

## Current repair: native moderation reporter lives

Original-Like commit `d929914` passed the full local check (944 unit tests),
123 focused native tests and five exact-head CI jobs. The database job passed
686 native tests but failed two moderation threshold races: their fixture created
stable reporter Users without Accounts, then inserted native report-source Likes.
Migration 104 correctly rejected those missing owning lives. Performance, load
and backup gates did not run; this head is not an accepted staging candidate.
Tracked count was 192,798 lines.

The repair gives every fixture reporter its real live epoch-zero Account while
keeping optional target Profiles separate. It leaves the production Like guard,
moderation threshold logic, concurrent race assertions, timestamp boundary probes
and safety proofs unchanged. Fresh focused native validation, the complete local
check and all six exact-head CI jobs remain required before another feature.

## Current candidate: original Like lives and minimal references

Repair `fa9a240` passed the complete local check (944 unit tests), 110 focused
native tests and all six exact-head CI jobs. CI passed 678 native tests in 103
files and all 27 unchanged query-plan checks. Initial/terminal integrity snapshots
took 1220.242/1456.208 ms with both required terminal indexes; support took
80.188 ms. Load and backup/restore smoke passed. Tracked count was 191,995 lines.

Migration 104 adds original sender/receiver epochs without updating an original
Like field or version. Ambiguous legacy owners fail migration. New insertion
locks sorted stable identities then Accounts and requires exact current lives,
rechecking after waits; epochs remain immutable. The actual interaction adapter
writes the locked epochs and refuses Like facts from another life.

Minimal references are created only for Likes used by a Match or funded unlock;
they contain the original ID, participants and epochs, with native immutable and
commit proof. Unreferenced Likes are not retained here. The three existing product
source FKs remain unchanged: references grant no access or archival authority.
Required-reference loss must roll back the actual reciprocal command and permit
its original retry. Native migration, concurrency, corruption, deletion-race and
actual paid-unlock evidence, full check and six CI jobs remain required. Retained
release, whole-product completion and fresh return stay disabled.

## Previous repair: shared support closure proof

Storage verification commit `ddec00a` passed the full local check and 676 native
tests, but its database CI job failed the unchanged 1500 ms integrity snapshot
budget: initial 1550.291 ms and terminal 1867.425 ms. Five other jobs passed.
It is not an accepted staging candidate; the subsequent load and backup gates
did not run.

The support closure scalar check introduced in migration 102 repeated proof
lookups for every closed thread and disabled parallel snapshot execution.
Migration 103 exposes the identical historical proof as a shared read-only view;
the scanner evaluates actual receipts once and joins by original thread/version.
The historical helper is stable and parallel safe. Actual lease authority remains
volatile and parallel unsafe, with every native commit guard unchanged. No
transcript, audit, receipt, policy period or lifecycle phase changes.

A paired diagnostic on 20,000 closed threads returned identical flags, including
denial of all missing proofs, and reduced the support component from about
709 ms to 29 ms. This isolated Windows component measurement does not replace
the unchanged Linux full-plan gate. Native corruption, concurrency, migration
replay, full check and all six exact-head CI jobs must pass before acceptance.

The repaired focused run passed 24 native tests in four suites. A wider fresh
run passed 86 tests in seven suites, including all 50 populated migration and
bootstrap cases, original credits, deletion catalog and Match/Photo references.
The new migration-102 support upgrade initially expected migration 102 to apply
again; correcting only that expected list restored both twenty-way upgrades.
Actual historical proof, lease guards and performance budgets were unchanged.

## Previous candidate: strict storage absence verification

Support lifecycle commit `8dd6b1f` passed the complete local check (930 unit tests),
all six exact-head CI jobs and 676 native tests in 103 files. All 27 unchanged
query-plan checks passed; the terminal snapshot took 1397.105 ms with both required
indexes. Load gates and backup/restore smoke passed. Tracked source count was
191,690 lines. External provider, staging and DR acceptance remain separate.

The actual worker already uses R2 delete-and-HEAD verification. Its generic
not-found classifier also accepted arbitrary HTTP 404 errors and a `NotFound`
name without a 404 status. The candidate accepts only exact object-not-found
names with HTTP 404, then requires a fresh HTTP 200 HEAD of the same configured
bucket before returning absence. Both calls share the original deadline signal.
Bucket errors, unknown failures and malformed responses propagate without
authorizing cleanup completion; no positive bucket result is cached.

The focused run passed 34 tests across the actual R2 adapter and application
cleanup suites, including composed failed verification, partial deletion and
idempotent retry. These use an injected SDK sender, not a real provider. They do
not prove an existing but incorrectly configured bucket is the intended deployment
bucket, fence future writes, authorize held-thumbnail cleanup or complete an M8
phase. Those obligations remain open. Full check and six CI jobs are required.

## Current candidate: original-life retained support closure

Redis composition repair `e107df3` passed the full local check (930 unit tests),
all six exact-head CI jobs and 666 native tests in 102 files, including seven probes
against the actual Redis service. All 27 query-plan checks passed; the terminal
snapshot took 1419.586 ms with both required indexes. Load gates and backup/restore
smoke passed. Tracked source count was 190,748 lines.

Migration 102 preserves original support content while binding ordinary thread
access to its product epoch. A phase-3 worker closes one original open thread per
transaction with an immutable audited receipt; concurrent retries rely on committed
scope closure and never require the old transport event. Native authority is checked
at actual commit. The M7 integrity scanner recognizes the complete deletion closure
proof alongside existing administrator close proof. User requests and replay,
unanswered counts and administrator mutations stay in their original product life;
audited retained-content reads remain available through the existing M7 capability.
No message is purged, period approved, phase advanced, return granted or retained
release enabled. Focused native evidence, the full check and six CI jobs are required.

The repaired support and catalog run passed all 16 tests. The wider native run
passed 132 of 133 tests across eleven files; its only remaining failure expected
101 existing migrations after migration 102. The corrected bootstrap/replay probe
passed in a fresh isolated database. The other 48 migration cases and ten suites
passed unchanged. No database authority, rollback assertion or test limit was relaxed.
The full repository check and six exact-head CI jobs remain required.

## Current repair: actual Redis reference composition

Financial partition commit `7d9be94` passed the full local check, all six exact-head
CI jobs, 659 native tests in 101 files and all 27 unchanged query-plan checks. The
terminal snapshot took 1348.747 ms with both required indexes; load gates and
backup/restore smoke passed. Tracked source count was 190,343 lines.

Review of the actual Redis graph found its generic adapter rejected existing
24-hour support/ban/report receipt lifetimes and server-owned administrator UI
keys. A diagnostic reproduced both failures before any Redis connection. The repair
accepts only the existing exact logical key formats, preserves the original public
action namespace and hashes internal receipts into a separate namespace. Limits
remain bounded by each producer's existing lifetime and encrypted-envelope budget;
administrator UI state remains five minutes, and replay never renews Redis TTL.
Values are bounded in UTF-8 bytes and oversized external cache state fails closed.

Native Redis integration evidence must exercise actual user-bound support/ban/report
references, encrypted administrator read/reply state, concurrent Confirm/Cancel,
withdrawal, isolation, expiry and invalid keys. UI storage does not grant native
administrator permission or extend the underlying report intent. The complete check
and six exact-head jobs remain required. This transport repair does not finish
ephemeral deletion invalidation or the other remaining M8 phases; no approval,
production activation or retained-data release is inferred.

The focused local run passed 22 tests across five files, including rejection before
opening a Redis connection and the existing support/appeal/read/reply validators.
Redis and gateway type checks and focused lint passed. This Windows workspace has
no running Redis service; no local native Redis success is claimed. The seven new
integration probes require the actual Linux CI Redis service before acceptance.

## Current candidate: financial lifecycle partition

Commit `4913be9` passed the complete local check (929 unit tests), all six exact-head
CI jobs and 650 native tests in 100 files. All 27 performance plans passed; the terminal
snapshot took 931.204 ms with both required indexes. Backup/restore smoke passed.
Tracked source count was 189,343 lines. This is CI evidence, not external DR acceptance.

Migration 101 preserves original credit balances, versions, timestamps and all ledger
rows in a per-product-life namespace. A live original phase-3 deletion lease can prepare
one audited next-epoch zero projection; concurrent retries replay its immutable receipt.
The owning Account remains deleted, and neither purge completion nor return permission
is granted. Commit-time authority, audit/event rollback, expired leases, historical
preservation and unexplained legacy chain rejection require native evidence before
acceptance. Whole ordinary purge, provider absence, ephemeral invalidation, approved
retention manifests, verified fresh return and production/security/restore acceptance
remain open. Retention periods remain unapproved and release remains disabled.

The focused run passed 173 of 174 native tests across sixteen files. Its one failure
was an exact error-code assertion: the absent audit correctly failed its deferred
foreign key with `23503`, before the custom closure check could report `23514`.
The repaired financial suite passed all eight probes with the complete rollback
comparison preserved; the other fifteen suites passed unchanged. Persistence type
checking and focused lint passed. The complete repository check and all six CI jobs
are still required before this financial candidate is accepted.

## Current repair: irreversible deleted-account plan fixture

Payment-epoch commit `a16b53d` passed quality, all four container jobs and 623 native
integration tests in 96 files. Its restarted PostgreSQL job then failed in the M3
Liked By matrix: the fixture changed its receiver to deleted and subsequently
restored it to active without verified fresh-return authority. Migration 97 correctly
rejected that transition. The repair exercises deleted-receiver denial last, after
the reversible account, visibility and profile cases, and leaves the tombstone intact.
Every exclusion case, fixture population, index and timing budget remains unchanged.
The complete local check and all six exact-head CI jobs must pass before further M8
features; the failed payment-epoch head is not an accepted staging candidate.

Repair `a2f8464` passed the full local check (918 unit tests), all six exact-head CI
jobs, 623 native tests in 96 files and all 27 unchanged M7 plans. The terminal
integrity snapshot took 1429.154 ms and retained both required indexes. The complete
M3 matrix still covers all 24 cases at 5,000 rows; its deleted receiver remains deleted.
Tracked count was 186,499 lines. The Windows full-volume diagnostic also exceeded
two limits on the preceding green schema with almost identical timings; that
comparison was diagnostic only. The exact-head Linux run supplies acceptance.

## Current candidate: native signed-media source authority

Migration 98 adds opaque short-lived receipts bound to the original Photo, asset,
variant, optional original Like, actor/owner product epochs and storage environment.
Issuance locks original pair and stable identities, then checks all current source
facts and stamps database time after waits. Unexpired receipts cannot be rebound;
expired authority may be purged without inventing a retained-data period. The signed
v2 protocol includes the opaque receipt identifier and fails old signature-only
URLs closed. Original Like identifiers, participant epochs and private provider keys
never appear in the URL or API result.

The actual enabled API graph verifies both signed grant and independent audience
credential before native lookup. The actual edge graph requires its fixed HTTPS
authority endpoint before/after storage work and before/after streamed reads, returns
no-store for all delivery and cancels revoked streams. There is no positive authority
cache or signature-only fallback. Audience and grant expiry are checked again after
waits. Public administrator-only evidence grants are denied; the separate audited
M7 retained-byte path remains the owning evidence route. Activation stays disabled
by default. Full check, native migration/concurrency evidence and all six exact-head
CI jobs remain required before this candidate is verified. Provider object deletion,
whole ordinary purge, ledger epochs, ephemeral invalidation, policy manifests,
verified fresh return and production/restore/security acceptance remain open M8 work.

The resumed focused native run passed all 102 tests in six files, including the
populated upgrade/replay matrix, registry coverage, twenty-way issuance and real
API/native/edge delivery with deletion during a provider wait. Unit probes also
verify that revoked chunks are withheld and unfinished provider cleanup cannot
delay denial. The first resumed full check found three unsafe asymmetric matchers
in an existing integration assertion; explicit UUID and exact TTL checks repair
those types while preserving its complete delivery result comparison. Focused lint
and the fresh native run then passed. The complete repaired check and six exact-head
CI jobs are still required; no provider deletion or external approval is claimed.

Media commit `575be94` passed the full local check (929 unit tests in 218 files),
102 focused native tests and five GitHub CI jobs. The full CI native run passed
627 tests, but the Match and Photo populated-upgrade suites still expected their
migration lists to end at 97. Their setup failed when migration 98 was correctly
applied, leaving eight preservation tests skipped. The repair adds migration 98
to both exact lists without changing production code or preservation assertions.
Downstream plan/load and backup gates did not run; the repaired head must pass
the full check and all six CI jobs before any further M8 feature. Tracked count
for the media commit was 188,352 lines.

Repair `3f57a8b` passed the complete local check, all six exact-head CI jobs and
635 native tests in 98 files, including all eight previously blocked preservation
tests. All 27 unchanged M7 plans passed; the terminal snapshot took 1180.376 ms
against 1500 ms and used both required indexes. Historical plan/load gates,
migration verification and backup/restore smoke also passed. Tracked count was
188,364 lines. This is software evidence, not actual provider/staging/DR acceptance.

The next dependency increment pins transitive Handlebars 4 to published patch
4.7.10 through the existing scoped-override mechanism. Only the development
boundary-lint tooling uses it; no runtime dependency or product behavior changes.
The frozen install succeeds and the full lockfile audit reports zero critical and
zero moderate findings, removing GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f and
GHSA-xw65-4hp5-5hc7. The previously documented Braces high finding still lists no
patch; the full audit remains nonzero and that release blocker is not suppressed
or approved. Complete local validation and six exact-head CI jobs remain required.

Security patch `dd6920d` passed the complete local check (929 unit tests), all six
exact-head CI jobs, 635 integration tests in 98 files and all 27 unchanged M7 plans.
The terminal snapshot took 1360.399 ms against 1500 ms and used both required
indexes. Historical load/plan gates, migration verification and backup/restore
smoke passed. Tracked count was 188,382 lines. The full lockfile audit still reports
the one unresolved Braces high finding; no clean full-security scan is claimed.

The next financial increment records immutable original product epochs on credit
transactions and their stable current projection. It serializes generic ledger
admission with the stable User and Account before the credit projection, preserving
the existing paired writers' counter/pair/identity ordering. Native guards reject
projection deletion/rebinding and credits for an inactive or different-epoch owner,
including mismatched original payment/intent ownership, then check authority again
at deferred commit. All credit writers carry projection provenance explicitly.
A late positive credit event can only settle a same-epoch sender and pending intent;
it cannot close or spend a later product life's action. Original captured Stars
refunds remain available through their separate original-money route.

Legacy balances, versions, original references and immutable financial fields are
preserved; initial provenance is zero. This increment does not reset a balance or
partition the lifetime chain. Those operations require separate verified financial
epoch partition and fresh-return authority. Whole product purge, provider absence,
ephemeral invalidation, policy manifests and production acceptance remain required;
deletion ingress, fresh return and retained-data release remain disabled. The full
native evidence, complete repository check and six exact-head CI jobs are required
before this candidate is accepted.

Focused native verification passed all 132 tests in twelve files, including all
credit writers, original captured-money/refund processing, delayed settlement,
notification scopes, the full populated migration matrix and both original source
reference suites. Seven new probes cover twenty-way exact replay, projection and
ledger rebinding denial, real tombstone preservation and late-write denial, final
authority rollback at deferred commit, borrowed/missing source denial, an observed
real committing-tombstone wait, and twenty-way populated migration-98 upgrade with
exact preservation of every original balance/transaction field plus epoch zero.
The legacy standalone ledger fixture now creates its actual owning active Account.
Persistence type checking and focused lint passed after adding the test helper's
explicit return type; no production guard or preservation assertion was relaxed.

Financial fence `7512c24` passed the complete local check (929 unit tests), all six
exact-head CI jobs and 643 native tests in 99 files. All 27 unchanged M7 plans
passed; the terminal snapshot took 1416.855 ms against 1500 ms and retained both
required indexes. Historical load/plan gates, migration verification and
backup/restore smoke passed. Tracked count was 188,922 lines. Lifetime financial
history is preserved; this evidence does not establish balance partition or return.

The next increment binds the deletion root itself to its original product epoch.
Native admission stamps the epoch from the locked owning Account; callers cannot
forge another owner, epoch or version. The binding is immutable and unique per
user/product life. Deferred checks cover both deletion records and Account changes,
so a pending owner cannot change version and invalidate its work at commit. Legacy
roots retain every field and gain zero; unexplained provenance fails migration
without inventing a life or partially applying the schema. Verified-return lookup
uses the exact original epoch while preserving every existing completion, approval
and safety gate. Return, later-phase completion and retained-data release remain
disabled. Native concurrency, populated upgrade/replay, full repository validation
and all six exact-head jobs are required before this candidate is accepted.

Focused native verification passed 140 tests in eleven files, including six new
deletion-life probes, twenty-way work acquisition and populated migration-99
upgrade replay. Forged owner/epoch/version admission, immutable-root mutation,
actual-commit owner divergence and unverified return fail closed. An isolated
unexplained legacy epoch rejects upgrade with no applied migration or new column;
valid legacy roots, owning Accounts and pending work preserve every original field.
The complete populated migration matrix, both Match/Photo original-reference
upgrades, credit provenance, deletion admission, shared/evidence checkpoints,
bounded purge and registry coverage also pass. Persistence types and focused lint
pass. Full repository validation and all six exact-head CI jobs remain required.

The first complete check passed formatting, full lint and all workspace types,
then the cross-package architecture scan exceeded its unchanged 5-second deadline
while reading source files serially; the other 928 unit tests passed. The repair
reads bounded batches of 32 files with every original file, import predicate,
assertion and deadline retained. Lint discovery also excludes the already ignored,
untracked `artifacts/` directory, which contains local test databases and outputs;
every tracked source and test remains covered. Native lifecycle code is unchanged.
A fresh complete check and all six exact-head jobs are required before committing.

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

Match-reference commit `fe672b1` passed all six CI jobs, 526 native tests in 92 files and all 27
historical plans (terminal snapshot 1411.752 ms, both required indexes present).

The next Match archival increment removes one closed source and its participants under the
existing pair lock and evidence-phase lease. It requires complete Chat archival/current capture
proof and no active grant. Immutable receipts preserve exact status/time and original Nakh source
identity for funding and Unmatch consistency; revoked grants and both participants' money remain.
Post-unmatch report admission keeps the original actor/pair/deadline rules after Match removal,
including late capture obligations. New grants still require a live Match. Native probes cover
concurrent archival/replay, required-write suppression, borrowed/stale workers, commit-time expiry,
late survivor reporting and accepted Nakh/revoked paid access without balance or ledger changes.
Photo archival, the full evidence checkpoint and subsequent purge/return phases remain required.
The catalog covers 124 tables, 1,124 columns and 226 FKs; retained-data release remains disabled.

Match archival commit `8dbc16b` passed all six exact-head CI jobs, 538 native tests in 92 files
and all 27 historical plans (terminal snapshot 1190.829 ms, both required indexes present).

The next increment archives owning live Photo sources behind immutable original Photo/Profile/asset
references and exact evidence-phase lease/capture receipts. It preserves held evidence and media
objects, moderation history and permission-checked audited reveals after Profile/Photo removal.
The catalog covers 126 tables, 1,136 columns and 230 FKs. Native probes cover concurrent archival,
replay, bounded batches, unrelated owners, required-write suppression, commit-time expiry and a
populated concurrent migration-93 upgrade including an already-deleted owner. All 121 focused
native tests in ten files passed. The full evidence checkpoint, provider proofs and remaining purge/return phases remain
required; deletion ingress and retention-based release remain disabled.

Photo archival commit `361ffd9` passed quality, all four images and all 548 native tests in 93
files. M3 fixture setup then attempted to physically delete assigned Photos for its photo-missing
negative case; migration 94 correctly denied removal without verified owning archival. The repair
leaves those sources unassigned from the outset, preserving the same final absent-photo case and
all original 24 actionability cases, 5,000 candidates, queries, index requirements and budgets.
No production safeguard is relaxed. Full exact-head CI remains required before another feature.

Fixture repair `06cc5a9` passed all six exact-head CI jobs, 548 native tests in 93 files and all
27 M7 plans (terminal integrity snapshot 1460.162 ms, both required indexes present). M3 retains
all 24 actionability cases and 5,000 candidates. This verifies Photo archival with the repaired
absent-source fixture; retained-data release and deletion ingress remain disabled.

The next increment fences Nakh delivery reads and command receipts immediately after either
participant becomes deleted. Lists/counts share the same live Profile/non-deleted counterparty
predicate; details independently require both non-deleted Accounts. Direct creation, receiver
view, acceptance and rejection take the pair, sorted stable identity and Account locks before
consulting transport receipts. Existing command capability and terminal-state policies remain.
Native probes use real sender/receiver deletion admission with product rows and durable receipts
still present, twenty concurrent direct/action replays, unchanged financial ledger/balances and
unrelated live content. A worker blocked behind a committing tombstone cannot return its old
receipt or create another Nakh. All 73 focused native tests in four files passed. This does not
complete Nakh product purge, old-life financial fencing, the evidence checkpoint or deletion.

Nakh delivery access commit `e2df5f4` passed all six exact-head CI jobs, 551 native tests in 93
files and all 27 M7 plans (terminal snapshot 1409.186 ms, both required indexes present).

Pending Nakh content/counts now use the same live Profile/non-deleted target scope. Pending
creation, editing and cancellation check the owning pair's current Accounts before transport
receipt replay, preserving sender-counter-before-pair lock order. Like and Not Interested replay
also requires both non-deleted Accounts under sorted stable identity/Account locks. Other existing
capability, financial, terminal and lifetime-interaction rules remain with their executors.
Real sender/receiver and actor/target deletion probes retain the original product rows/receipts,
exercise twenty-way replay and new writes, and verify unchanged payment intents, money, counters,
interaction facts and consumption history plus unaffected unrelated users. All 63 focused native
tests in six files passed. Delayed media/notification fences, source-phase completion, product
purge, provider proofs, financial epochs, manifests, safe return and hardening remain required.
Retention release and deletion ingress remain disabled.

Pending Nakh/interaction commit `1e5de72` passed all six exact-head CI jobs, 555 native tests in
93 files and all 27 M7 plans (terminal snapshot 1228.29 ms, both required indexes present).

Media ingestion/validation claims and completed-upload replay now require the original asset
owner's current Account under stable identity-before-Account-before-asset locks. Transport
decryption runs outside those locks, then rechecks Account and exact unexpired ingestion lease
before returning private transport material. Upload publication also requires current authority
and an unexpired lease; cleanup/release remains available. Six new native scenarios cover four
ingestion stages, twenty concurrent post-deletion attempts, actual deletion during decryption,
and expired-lease publication. All 43 focused native tests in two files passed. This increment
does not prove provider-object absence, revoke already-issued delivery grants, or enable deletion
ingress/retained-data release. Those obligations and the complete remaining M8 phases still apply.

Media-worker commit `ff0a71b` passed all six exact-head CI jobs, 561 native tests in 93 files and
all 27 M7 plans (terminal snapshot 1170.753 ms, both required indexes present).

Notification rendering and provider-call admission now check the recipient's current Account;
chat-message notices also require the exact existing message/recipient scope and a non-deleted
sender. Stable identities and Accounts are locked in sorted order before delivery mutation, and
the exact lease is checked again at mutation. Known provider outcomes still settle under their
original fence, including outcomes of calls admitted before deletion. Four new native scenarios
cover twenty concurrent post-deletion requests, retained messages after actual sender/recipient
deletion, and a provider admission blocked behind a committing tombstone. All 22 focused native
tests in two files passed in a fresh isolated database. The first local run's accumulated service
queue exceeded the existing bounded claim lookup; isolation resolved those fixture failures
without increasing the production claim limit or weakening assertions. Other linked product
notification scopes, provider/media proofs, source-phase completion, purge, financial epochs,
manifests, safe return and production hardening remain; deletion ingress and retention release
remain disabled.

Notification-account commit `fedf344` passed all six exact-head CI jobs, 565 native tests in 93
files and all 27 M7 plans (terminal snapshot 1217.83 ms, both required indexes present).

Product notification authority now resolves the exact owning Like, delivered/pending Nakh, Match
or paid unlock before sorted identity/Account locks, then resolves again before rendering or
provider admission. Closed, expired, revoked, missing, malformed or borrowed scopes cannot
authorize those notices. Chat unlock safety warnings share the exact grant; generic critical
safety notices keep their existing policy. A closure notice requires the recipient's own terminal
Match fact, including a verified archival receipt, and deliberately permits delivery to the survivor
after counterpart deletion; it grants no product access. Existing provider settlement fencing remains.
Eighteen new native scenarios cover seven product scopes with actual counterpart deletion,
twenty-way requests, unchanged money/grants/product rows, borrowed recipients, malformed references,
normal unmatch between rendering and provider admission, and the survivor closure exception.
All 40 focused native tests in three files passed in isolated databases. Source-phase completion,
signed delivery revocation, ordinary purge, provider proofs, ephemeral invalidation, financial epochs,
manifests, safe return and production hardening remain required. Ingress and retention release stay off.

Exact notification-scope commit `f7b7e97` passed all six CI jobs, 583 native tests in 94 files
and all 27 unchanged M7 plans (terminal snapshot 1083.293 ms, both required indexes present).
The first quality job failed during public collector image pull before SDK export with an unknown
startup classification. One unchanged completed-job diagnostic rerun passed all checks, including
real collector conversion/privacy and infrastructure validation. The original pull cause remains
unidentified; no assertion or policy was bypassed.

Migration 95 permits only verified evidence-capture checkpoint 2 to ordinary-product checkpoint 3.
The executor takes the stable User, Account, root and work locks, checks exact current lease authority,
and requires every current relevant capture to match its authenticated immutable receipt. Owning
Profile and Photo sources require their exact root receipts and absence. Shared Chat and Match
sources require original verified archival receipts and absence; a second participant deletion
recognizes the same original shared proof and verifies its own capture obligations. All original
Unmatch reporting windows must have elapsed; waiting never creates a completion receipt or shortens
that window. Required content-free audit/event, both checkpoint writes and immutable phase receipt
are checked at commit, including renewed capture/source checks and database-clock lease expiry.
The previous shared receipt remains replayable under its original authority after the next phase.
Neither product_purged_at, completion nor reactivation is set. Provider bytes/absence, ordinary purge,
ephemeral invalidation, financial epochs, policy manifests, safe return and hardening remain required;
deletion ingress and retained-data release remain disabled.

All 94 final focused native tests in four checkpoint/capture/registry files passed. The populated
migration-upgrade suite also passed, including preservation of pending migration-94 deletion rows.
The initial new race probe paused before the original post-lock evidence deadline and was correctly
rejected; its corrected barrier pauses after authorized capture, proves the checkpoint waits on the
Account, then observes and requires that late-committing capture after expiry. No deadline guard was
weakened. A filtered diagnostic skipped all tests and supplied no acceptance evidence; the final
unfiltered suites passed. Native tests also cover required-write rollback, commit/lock-wait expiry,
twenty-way idempotency, forged authority, original shared receipt replay and dual-participant proof reuse.

Evidence-checkpoint commit `9cdb3cc` passed local quality, GitHub quality and all four image jobs.
The full native CI passed 591 tests; two legacy Match/Photo upgrade setup assertions still expected
the migration list to end at 94, preventing eight preservation tests from running. The repair adds
migration 95 to both exact upgrade expectations without weakening any preservation assertion or
production guard. Downstream plan/load gates did not run and remain required on the repaired head.
All 17 focused native tests in the two repaired reference suites and the evidence-checkpoint suite
passed, including the eight previously blocked preservation tests. The production checkpoint and
its reporting-window, capture, source, audit and lease guards remain unchanged by this repair.

Repair `9c27389` passed all six exact-head CI jobs, all 599 native tests in 95 files and all 27
unchanged M7 plans. The terminal snapshot took 1380.32 ms against 1500 ms and used both required
indexes. Local quality passed all 917 unit tests in 216 files and the full build. The previous
eight blocked upgrade-preservation tests ran successfully; no production guard was weakened.

The next internal ordinary-product sweep runs only under phase 3 and removes at most 100 rows per
transaction from eight code-owned resource groups: signup drafts/progress, filters with required
gender selections, candidate deliveries, consumptions, NotInterested, notification preferences and
settings. Large filter groups leave a required selection until the final children and parent are
removed together, preserving the existing required-selection invariant in every bounded batch.
Migration 96 requires each nonempty batch's exact content-free audit/event and live
owning lease at commit; the worker also rechecks authority after Account lock waits and batch work.
Empty retries produce no audit/event. Restart uses actual committed absence, not transport receipts.
This sweep leaves all retained safety/financial/workforce facts and stable identity/preview state
untouched. Its local `hasMore` describes these resources only. Financial epochs, Nakh/Like/unlock and
typed notification/operational dependencies, provider verification, ephemeral invalidation, policy
manifests, safe return and hardening remain required. Product completion, deletion ingress and
retained-data release remain disabled; no retention period or external approval is invented.

Native verification passed 71 tests in five files, including the full populated-upgrade matrix and
exact live phase-3 lease preservation from migration 95. Its initial run diagnosed an outdated
`95 - baseline` count in 41 upgrade cases; updating the count to 96 and adding the migration-95
baseline restored every preservation assertion without weakening production guards. The final
bounded-filter implementation then passed all 21 purge/registry tests in two files, including
103 selections split while preserving the required-selection invariant and 205 delivery rows
removed in 100/100/5 batches. Probes cover twenty-way idempotency, counterpart preservation,
required-write suppression/type/payload corruption, database-clock expiry during delete and at
deferred commit, expiry behind the Account lock, schema drift and restart after transport loss.
No full M8 completion, retained-data approval or external staging/security evidence is claimed.

Ordinary-product commit `952120b` passed the full local check (917 unit tests in 216 files), all six
exact-head CI jobs, 614 native tests in 96 files and all 27 unchanged plans. The terminal integrity
snapshot took 846.69 ms against 1500 ms and retained both required indexes. Tracked source count
was 185,490 lines. This verifies the bounded sweep only, not whole-product deletion.

The next payment increment adds explicit immutable intent epochs and a current Account fence to
package fulfillment, funding admission and invoice/checkout replay. Existing Account and intent
rows remain epoch zero without changing prior payment or captured receipt facts. A deleted or
different-epoch payer cannot receive a new package credit grant. One original-payment refund and
correction event are committed instead, under the original payer, charge and Stars amount. The
worker reports correction rather than claiming successful credit fulfillment. Deferred guards
require actual purchase/events or original refund/event facts and an unexpired worker generation
at commit; current time is rechecked after canonical Account lock waits. Captured money remains
recordable after deletion and original refund processing remains available.

Migration 97 prevents arbitrary epoch changes, stable Account deletion/reinsertion and unverified
deleted-to-guest return. Return remains disabled. Full credit-ledger epoch partition, a new empty
product life, whole-product purge, provider/ephemeral/retention verification and worker/ingress
composition remain required. No retention periods have been approved; retained-data release stays
disabled. No external staging, restore/DR, security review or operator acceptance is claimed.

Native verification passed 90 tests across the seven focused suites; the one remaining populated
migration-96 case initially lacked historical CreditAccount timestamps and notification preferences.
Its corrected case then passed independently, preserving exact original payment and receipt bytes,
adding only epoch zero to its intent and successfully fulfilling through the upgraded worker. The
eight new package probes cover late captured money, twenty-way correction/replay and original
refund completion, cached checkout/invoice denial, epoch/return forgery, a real committing-tombstone
lock race, current-clock lease expiry after a payer lock wait, expiry at deferred commit and required
refund/event suppression rollback. The worker's eight unit tests and persistence type check passed.
The complete local check and all six exact-head CI jobs remain required for this candidate.
