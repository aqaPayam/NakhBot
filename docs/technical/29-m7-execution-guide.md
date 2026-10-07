# M7 Execution Guide — Reporting, Moderation, Administration, Support, and Appeal

## Current increment: approved authenticator enrollment and recovery

Migration 83 separates a trusted operator's audited approval from the authenticated user's
authenticator confirmation. Approval assigns only the existing fixed roles, records an immutable
request digest and creates a ten-minute, user-bound invitation. Only its hash and encrypted seed
are retained. The stable invitation supports retries and retained encryption keys support rotation;
an authenticated pending enrollment can recover its secret URI without generating another seed.
Neither operator approval nor enrollment confirmation issues a session or a verification proof.

Confirmation consumes the shared durable attempt budget and atomically activates the exact approved
credential with its bound security audit. Concurrent retries return the original activation receipt.
The confirmation counter remains consumed, so sign-in requires a later admissible counter.
Expired, cancelled, borrowed, completed and permission-revoked enrollments cannot reveal the URI.
An active factor cannot be replaced through first-factor authentication. A separate trusted operator
recovery command revokes the exact factor and all current sessions with required audits before a
new approval. Old request receipts cannot revoke a replacement credential or change their subject.
The operational capability has no public HTTP or Telegram route; its operator identity is supplied
by the authenticated operator host, never by an end-user request.

Native evidence covers concurrent approval/opening/confirmation/revocation, request and actor
substitution, stable invitations across key rotation, durable limits, expiry, role revocation,
required-audit rollback and recovery. Migration evidence includes baseline-82 upgrade, preserving
existing encrypted credentials and counters without inventing operator approvals, plus bootstrap
and immutable replay. All six exact-head CI jobs remain required before this increment is verified.
Authenticated host composition, exporter/alert routing and real provider/operator staging acceptance
remain open. Ordinary startup does not install a permissive first-factor or operator fallback.

The durable-proof increment on `ca97a74` passed the full local check (882 tests), all six CI jobs,
391 native PostgreSQL tests and all 27 unchanged performance/index gates.

## Previous increment: durable authenticator proof admission

Migration 82 retains encrypted administrator credentials, immutable counter-bound verification
proofs and a durable five-attempt/five-minute window. Database time and the shared administrator
row lock serialize proof verification with session issuance and future enrollment/revocation.
The actual encrypted seed is authenticated against its administrator and credential before
the bounded authenticator comparison. Each accepted counter gets one stable proof and bound
security audit; retries cannot manufacture another proof. The enrollment-confirmation counter
has no session proof and cannot be reused. Audit failure rolls back counter consumption and proof.

Native TOTP composition requires credential provenance. Session issuance rechecks the current
credential, latest admitted counter, administrator version and exact proof times after waiting.
Physical foreign keys and insertion guards retain the same actor/credential/proof binding.
Both session lookup and native command authorization reject revoked credentials. Credential
provenance is mandatory after native TOTP opt-in, including inherited transaction policy;
later generic session composition cannot admit a legacy external grant or relax that requirement.
Credential
material and proof history cannot be rewritten or deleted; activation and revocation require
their exact bound security audits. Codes, seeds, enrollment URIs and bearer values are absent
from verification audits and proof/session records.

Native integration evidence covers twenty concurrent submissions with one session/proof/audit,
stable proof retries, borrowed identity/proof and missing native provenance, restart-safe limits,
administrator-lock revocation races, live-session revocation, tampered bindings and audit rollback.
Migration evidence adds baseline-81 upgrade, bootstrap and immutable replay. Historical external
provider sessions remain unchanged with null TOTP provenance; no factor facts are reconstructed.
The fixed three-role/fourteen-permission catalog remains unchanged. This increment is not verified
until all six exact-head CI jobs pass. Audited operator provisioning, confirmed enrollment and
authenticated host composition remain required before activating the native authenticator path.

Authenticator cryptography on `74f9493` passed the full local check (882 tests) and all six CI jobs.

## Previous increment: authenticator-app MFA cryptography

The user selected authenticator-app codes. The new application primitive uses RFC 6238
HMAC-SHA1, a random 160-bit seed, six digits and 30-second counters, with a fixed previous/
current/next counter tolerance. Verification returns the exact matched counter for native
replay control. Codes are strict ASCII and every admissible counter is compared before returning.
The enrollment URI follows the Google Authenticator key URI format; it is secret material
for an authenticated enrollment channel, never a log, audit fact or public response.

AES-256-GCM protects the seed with purpose/version, administrator, credential and encryption
key/version as authenticated bindings. A trusted key resolver permits retained-key rotation;
verification does not return plaintext. Local mutable seed/key buffers are cleared after use,
without claiming complete process-memory erasure. Unit evidence includes the published SHA1
vectors, leading zeroes, clock boundaries and rejection of substituted subjects, keys, nonce
and tag. These primitives alone grant no session: persisted enrollment confirmation, rate limits,
atomic counter consumption, revocation rechecks and audited provisioning remain the next increment.
Ordinary startup has no permissive MFA fallback. No schema or runtime composition changes yet.

The dependency repair and persisted typed-message increment are verified on `ede87c0`:
all six CI jobs passed, including all native PostgreSQL and unchanged 27 performance gates.
Both scenes retained 20,000 integrity-verified message captures, all eight rejection populations,
and the unchanged admission population. M7 completion still requires concrete enrollment/
provisioning, exporter/alert routing and real provider/operator staging acceptance.

## Previous increment: persisted M6 message captures at production query volume

Current stopping scope is M7 completion: every commit must pass the full local check,
be pushed to main and pass all six exact-head CI jobs before another increment begins.
M7 still requires concrete MFA enrollment/provisioning, exporter/alert routing and real
provider/operator staging acceptance. M8/M9 remain separate later milestones.

The repaired message-reference run on `1ae67a1` passed PostgreSQL reliability and all
four container builds, including the typed M6 capture and unchanged performance gates.
Quality passed the full local-equivalent check but failed the production dependency audit:
`sharp` 0.35.4 is affected by GHSA-wq5f-xc86-pv6w. The worker now pins the maintainer's
patched 0.35.5 release, with its matching native packages in the lockfile. Image limits,
accepted formats, audit policy and all volume/index gates remain unchanged. Existing
image/blur tests, the full check, production audit and all six CI jobs remain required.

The encrypted-capture increment is verified on `460fe26`: all six CI jobs passed,
including 382 PostgreSQL tests. Baseline/terminal combined sampling measured 992/1,268 ms
against the unchanged 1,500 ms budgets, with every required index and original population intact.

Both scenes now additionally persist 20,000 synthetic M6 message snapshots and their exact
Report/evidence subjects: 5,000 each for text, predefined question, predefined answer and system
messages. The existing M6 reader verifies each database roundtrip against its exact expected
typed content and SHA-256 capture envelope. Every stored row also requires rejection of borrowed
Report/session/message subjects, valid-shape changed content, extra content keys, changed sender,
changed timestamp and changed hash. Subjects use canonical random UUIDs; envelope field order,
Date ISO precision and system argument order follow the separate M6 capture protocol.

This is unkeyed SHA-256 integrity readback, not AES-GCM authentication or proof of provenance.
Shared SQL predicates independently require all new capture metadata intact. Historical Report
timestamps keep all added rows outside the 24-hour admission window and preserve the existing
eligible population. All original missing captures, damaged photo custody, threshold rosters,
separate unrestriction chains and reviewed appeals remain in both scenes, with their unchanged
exact sampler deltas. All 27 timing budgets and independent resolution/restoration index gates
remain mandatory. Artifact schema 13 keeps message observations separate from encrypted captures;
an empty remaining-volume list describes these synthetic capture branches only.

Trigger/FK bypass and rollback remain isolated fixture setup; native admission, permission-checked
audited evidence release and provider/operator acceptance are separate required evidence.
Rollback checks now explicitly include M6 snapshots. No migration or catalog change is introduced:
migration 81 bootstrap, upgrade and immutable replay remain required. Real MFA provider/enrollment/
provisioning, exporter/alerts, provider/operator staging and M8/M9 remain open. The typed-message
increment and dependency repair passed all six exact-head jobs on `ede87c0`.

The first message-volume run passed 381 of 382 native tests but failed fixture insertion
against `report_evidence_typed_reference_ck`, before measured plan evidence was produced.
Message evidence must contain only its message reference; its session belongs to the separate
M6 snapshot envelope. The fixture now leaves the evidence session null and retains the exact
session in the snapshot and reader subject. The physical constraint, all typed rejection cases,
original populations and performance gates remain unchanged. No next feature advances until
the repaired commit passes all six jobs.

## Previous increment: persisted encrypted captures at production query volume

Both measured scenes now retain every original fixture and add 20,000 synthetic Report/evidence
subjects with real AES-GCM envelopes: 5,000 each for profile, photo, chat and unmatched-user capture.
Canonical random UUID subjects preserve existing AAD validation. Batched database readback must
authenticate every envelope and recover its exact synthetic content. Each persisted envelope also
undergoes independent tag, Report binding, evidence binding, key-version and hash rejection checks.
The local ephemeral key is never persisted or included in artifacts; only numeric observations
escape. Shared production capture/custody predicates must identify all new rows as intact, while
three actual aggregate/health samples preserve every original drift delta. The original missing
captures, damaged photo custody, threshold witnesses, unrestriction attempts and terminal appeals
remain present; all 27 plans retain their 1,500 ms limits and independent index requirements.

Artifact schema 12 distinguishes cryptographic readback observations from SQL metadata checks.
Metadata shape does not authenticate ciphertext. Trigger/FK bypass and rollback remain isolated
synthetic setup, not native admission, permission-checked reveal or provider/operator acceptance.
Existing native audited reveal tests remain required. M6 message envelopes use their separate
storage path and are not covered by this new volume branch. No migration or catalog change is
introduced: migration 81 bootstrap, upgrade and immutable replay remain required. Real MFA
provider/enrollment/provisioning, exporter/alerts, provider/operator staging and M8/M9 remain open.

The preceding unrestriction increment is verified: all six jobs passed, including 380 PostgreSQL
tests. Baseline and terminal combined sampling measured 1,000 ms and 1,272 ms with no temporary
blocks. Both independent terminal resolution/restoration indexes were present.

The encrypted-capture run passed all 380 PostgreSQL tests and verified every 20,000-row
authentication, rejection and metadata population. Baseline sampling passed at 1,338 ms; terminal
sampling failed at 1,647 ms without spills. Diagnostics showed 35,024 repeated administrator
history probes and 40,021 repeated appeal uniqueness probes. The repair makes the unchanged admin
history predicate memoizable after its separately bound prior-state lookup, retaining every actor,
target, reason, time and state condition. Appeal uniqueness groups by the non-null exact ban event:
one row is equivalent to the previous absence of another uniquely identified Appeal. This preserves
one result per Appeal and still identifies a damaged multi-row population. Separate review and
unban checks remain unchanged. No scale, timeout, memory, migration, index requirement or 1,500 ms
budget is relaxed. The increment remains unverified until all six exact-head jobs pass.

That repair passed all 380 PostgreSQL tests but increased history work: 45,024 probes rather
than 35,024, while appeal-unban presence still made 40,021 individual probes. Baseline/terminal
sampling failed at 1,511/1,770 ms. The admin-history rewrite is reverted to its prior guarded
EXISTS. Separate unban facts now join the uniquely owned link and primary-key action/history/
attempt rows once, with all original status, actor, User, command, time and previous-state checks.
Missing links remain valid acceptance without unban; damaged links remain failures. Episode
resolution deduplicates the complete episode/actor/target/reason/time tuple after the same
successful attempt request/digest/command/subject checks, retaining one row per episode and exact
existence semantics for multiple matching resolutions. The partial covering resolution index,
all native drift/repair evidence, and unchanged scale and timing gates remain required.

The flat-join run passed 379 native tests but timed out in the existing freshly seeded drift
fixture, which does not refresh statistics. Its separately analyzed fixture completed in 4.6 s;
the actual sampler in the fresh-statistics case hit the unchanged 60 s statement/test limit.
This indicates join-plan sensitivity rather than a failed count assertion. Resolution and
uniquely owned unban facts now use materialized relations evaluated once before outer episode/
Appeal joins. Unban facts keep the same effect/history/attempt bindings, then bind accepted status
and target User to the owning Appeal; missing links stay valid, incomplete facts stay false.
No fixture ANALYZE, timeout increase or test removal conceals the regression. Both fresh and
analyzed cases, exact drift deltas, concurrency and all 27 timing/index gates must still pass.

The bounded-fact run passed all 380 native tests, including the unchanged fresh-row drift test
in 44.2 s. Baseline sampling passed at 1,250 ms, but terminal sampling remained 1,535 ms and the
bulk resolution enumeration no longer used its required covering index. Resolution facts now
perform one fully bound, limited lateral lookup per resolved episode, retaining exact attempt/
actor/target/reason/time checks before limiting. Primary-key Report joins replace repeated action
Report probes, preserving missing-row, pair-subject and photo-owner checks. Review facts group
the same actor/target/version binding and independently aggregate exact accepted/rejected audit
results; duplicate facts still produce one Appeal. All unchanged native drift/repair, fixture
populations, 1,500 ms budgets and both independent terminal indexes remain mandatory.

The indexed/grouped run passed all 380 native tests, every 1,500 ms plan budget and both terminal
indexes. Combined sampling measured 1,026/1,227 ms. Its only failure was the admission read choosing
the idempotency index on a uniformly recent population. Added encrypted-capture Reports now use
48-hour-old submission/capture times, creating a genuine current/historical admission mix while
retaining every original recent Report and every capture/custody/threshold/appeal chain. Observed
counts require all 20,000 additions outside the 24-hour admission window and the representative
reporter's eligible count unchanged before/after seeding. The same required reporter-window index
and timing gates remain mandatory; neither index alternatives nor planner settings are loosened.
Historical unmatched capture content retains its original exact 24-hour window. These remain
synthetic capture fixtures with no native admission or provider-custody claim.

The historical-window run passed all 380 tests, every required index and every observed fixture
population, including 20,000 excluded historical captures and unchanged eligible count 77/77.
Its baseline passed at 1,335 ms; terminal sampling still exceeded the limit at 1,634 ms without
spills. Episode-chain reads now use exact primary-key audit/notice joins and grouped Telegram
delivery presence, retaining all original event, actor, User, timestamp, metadata and notice
conditions. System-history lookups and expected audit metadata are memoizable on their complete
bindings. Indexed resolution candidates retain every episode/actor/target/reason/time condition;
successful attempt matching happens before grouping one existence fact per episode, so no limit
can hide a later valid candidate. Native drift/repair, unchanged populations and all timing/index
requirements remain mandatory. The increment is still unverified.

Native fifth-reporter admission additionally corrupts audit count, reason and unexpected metadata
fields independently, then Telegram admission presence. Each must produce one exact episode
finding and one episode-count increase across five concurrent samples, preserve every other
phase, and restore the full baseline after repair. This verifies exact metadata equality and
channel-specific delivery admission without claiming provider delivery success.

The episode-chain run passed all 380 native tests and the new corruption/concurrency cases; the
fresh-row drift fixture improved to 30.5 s. Its private 20,000-row unrestriction validation timed
out before any EXPLAIN artifact, using cardinality statistics predating the uncommitted bulk load.
That bulk-fixture helper now refreshes the relevant table statistics after inserting its complete
chains and before evaluating the unchanged prefix-bounded production predicates. The later
performance scenes already require refreshed statistics. The separate native fresh-row scenario
still performs no ANALYZE, and no count assertion, fixture population, timeout, timing limit,
index requirement or production read is changed by this setup repair.

The refreshed-fixture run passed all 380 native tests, every capture/rejection/population check
and every required index. Baseline aggregate sampling passed at 1,288 ms; terminal sampling
still exceeded the unchanged limit at 1,673 ms without spills. Administrator action history
now groups exact User/admin/reason/time/next-state bindings once, with independent previous-state
facts for restricted and banned restoration. The unchanged latest-prior-state lookup selects the
required restored state; a uniquely grouped join preserves historical EXISTS semantics and one
row per action. Native fixture evidence keeps an invalid duplicate alongside a valid history,
detects loss of every valid previous-state match, accepts either restored valid match, and proves
duplicate valid matches do not multiply actions. System history checks, budgets, populations,
fresh-row tests and independent required indexes remain unchanged. Verification remains open.

The grouped-history run passed 379 native tests but the extended fresh-row test exceeded its
unchanged 60-second whole-test limit; no database statement timeout or count assertion failure
was reported. Its analyzed 1,000-row fixture completed in 5.3 s. The new duplicate-history case
now owns a separate fresh 1,000-row base/terminal fixture, five concurrent action samples and
every drift/recovery assertion. The original fresh-row test retains all prior checks and its
own unchanged time limit. Neither fixture performs ANALYZE; scale, statement limits, production
queries and performance budgets are unchanged. Both independent cases must pass before advancing.

Both fresh-row cases passed independently at 53.7/23.1 s, with all 381 native tests green.
Every population and index requirement passed, but terminal aggregate sampling remained 1,751 ms;
its administrator-action phase increased from 532 to 611 ms. Grouped administrator histories are
reverted to their preceding exact EXISTS predicate, retaining both duplicate-history test cases.
Action audit/notice candidates now join by primary key, and attempts by their existing unique
administrator/command key; all original actor, request, digest, result, subject, recipient, payload
and notice-type checks remain explicit in the corresponding integrity flag. Null/missing/mismatched
facts remain invalid and unique keys retain one row per action. Native audit actor, notice payload
and notice-type corruption additionally require one exact finding, five concurrent full-count
samples with only the action count increased, and restoration of the baseline. No schema, fixture
scale, budget, memory or timeout is changed. Bounded plan diagnostics retain only numeric node
ancestry/timings and allowlisted node/relation labels, never aliases, predicates or restricted data.
Verification remains open until all six exact-head jobs pass.

The unique-key run passed all 381 native tests, including the added actor/payload/type drift,
and all population/index requirements. Base sampling passed at 1,421 ms; terminal sampling
remained 1,738 ms. Its bounded tree identified 35,024 administrator-history index probes and
20,012 episode-history probes. These predicates now use uncorrelated exact tuple membership:
administrator tuples bind User/admin/reason/time/next state and an independent prior-state class;
episode tuples bind User/time after every original system actor, previous/next-state and reason
condition. The separately indexed latest-prior-state restoration lookup remains unchanged.
Duplicate facts retain existence semantics, and null comparisons are explicitly false. The
duplicate-history scenario additionally denies a valid previous-state fact from another admin.
This follows PostgreSQL's [row membership semantics](https://www.postgresql.org/docs/17/functions-subquery.html)
and [independent hashed-subplan eligibility](https://www.postgresql.org/docs/17/using-explain.html);
actual execution, fresh-row/concurrency/count evidence and all original limits remain mandatory.
No migration, memory, scale, index requirement or timeout is relaxed. Verification remains open.

The tuple-history run passed all 381 native tests and every population/index requirement.
It removed the repeated history probes: baseline sampling passed at 1,291 ms, while terminal
sampling remained 1,608 ms. Support integrity now groups unanswered messages by User against
the same latest `(created_at,id)` administrator-reply boundary as native admission, including
replies on closed threads. Reply attempts bind through the existing administrator/command
unique key and retain every request, digest, command, target, result and version check; closed
thread attempts retain their exact target/version existence semantics. Grouping preserves one
row per thread, including threads with no messages. Native evidence compares five concurrent
samples with the original predicates after independent attempt damage and cross-thread reply
ordering changes, then restores the original facts. Review state checks join their Report by
primary key, and action audit candidates filter the constant actor branch before hashing while
retaining the original flags. No population, budget, timeout, memory or index gate changes.
This repair remains unverified until all six exact-head jobs pass.

## Previous increment: separate unrestriction commands at production query volume

Both M7 performance scenes now include 20,000 separate episode-bound unrestriction command chains,
each with its own admin attempt, action, state history, audit and notice. Half have exact digest
bindings; half deliberately mismatch the successful attempt's digest. The shared action, episode
and admin-log predicates must identify the exact bound and damaged populations while retaining
every original threshold chain and admission roster. These synthetic histories restore active
state; existing native state-restoration tests remain the functional evidence.

Three actual aggregate and operational-health samples require exact deltas: bound resolutions
clear episode mismatches, damaged attempts add action and admin-log mismatches, and unrelated
counts remain unchanged. Terminal appeal/unban sampling must preserve the same baseline. Artifact
schema 11 records observed unrestriction counts alongside the unchanged 20,000 photo chains and
100,000 admission witnesses. All 27 plans retain 1,500 ms limits and the exact resolution index
requirements. Isolated trigger/FK bypass and rollback are synthetic metadata setup only, without
claims of native admission, permission checks, provider delivery or operator acceptance.

Native separately confirmed unrestriction followed by a later ban also tests digest drift across
resolution, action and audit-log reconciliation, concurrent sampling, and repair. Migration 80
bootstrap, upgrade and unchanged replay remain required; no schema or catalog change is introduced.
Encrypted-capture integrity, real MFA provider/enrollment/provisioning, exporter/alerts,
provider/operator staging and M8/M9 acceptance remain open.

The first volume run passed all 379 PostgreSQL tests and every exact fixture/count assertion,
but combined sampling took 2,331 ms baseline and 6,194 ms terminal. Bounded node diagnostics
localized the regression to repeated prior-state history scans and sorts, reaching 4,384 ms
inclusive in the terminal scene. Migration 81 adds a non-unique B-tree keyed by User, next state,
descending change time and identity, with previous state included. The existing exact restoration
predicate, latest-row ordering and exclusion of banned prior states for unrestriction remain
unchanged. The verifier checks relation, access method, readiness, validity, key/include layout
and absence of expressions or filtering. Empty bootstrap, upgrade from 80 and immutable replay
are required. Both action and combined plan scenes must use the new index; all fixture sizes
and 1,500 ms budgets remain unchanged. This repair is unverified until all six CI jobs pass.

The index run passed all 380 PostgreSQL tests and its required index checks. Prior-state scans
became bounded and baseline sampling passed at 1,463 ms, but terminal sampling remained 1,862 ms.
The next repair joins the uniquely bound admin attempt once, retaining every request, digest,
result, command and subject predicate, and moves the unchanged latest prior-state lookup into
a cardinality-preserving lateral relation. Repeated User/action/time restoration bindings can
then be memoized independently of each actor-bound effect history. Missing rows remain false;
the separate appeal-unban link and pair-subject audit checks remain mandatory. Native drift/repair
and all unchanged performance gates must pass before the increment is counted.

That run passed all 380 PostgreSQL tests, including the seven new independent attempt-binding
corruptions, but timed out in the fixture's cross-phase validation join before any measured plan
was retained. The fixture now materializes each exact prefix-bounded production phase once before
joining its action/episode/attempt facts. Every per-chain flag and observed-count assertion stays
the same; no production sampler, fixture scale, statement timeout or plan budget is changed.
The volume gate still must complete and verify all measured plans before this repair is green.

The materialized validation run passed all 380 tests and its exact populations, with no setup
timeout. Baseline sampling passed at 1,444 ms; terminal sampling remained 1,815 ms. The action
branch retained 3,237 temporary blocks and 65,058 repeated relation loops. The next repair separates
system and admin actions into exhaustive, disjoint branches using the persisted non-null actor
CHECK. System restrictions keep all history, Report, audit and notice bindings but never join an
administrator attempt or restoration lookup. Admin actions retain those exact checks and separate
appeal-unban bindings. Explicit null/system and exact/admin audit bindings preserve prior semantics.
Native threshold audit request drift must still produce one action finding across concurrent
samples, then return every phase to baseline after repair. The terminal sampler additionally
requires both resolution and restoration indexes, preserving the original resolution requirement
instead of treating these independent bindings as index alternatives. No migration, memory setting,
fixture scale or timing budget changes are introduced; all six jobs remain required.

The actor-partition run passed all 380 PostgreSQL tests, including native system-action audit
request drift and repair, but terminal sampling remained 1,801 ms. It still spilled 1,525
temporary blocks and repeated system-history probes; the appeal and blocked-pair phases added
215 ms and 156 ms respectively. The next repair makes only system history lookups memoizable,
preserving every actor/target/reason/time/state condition. Exact ban matching joins the history
primary key, and review facts are deduplicated on the complete actor/target/version/result tuple
after the same audit event, subject, request and command checks. Matching duplicates retain one
Appeal; acceptance still supplies no unban, and separate restoration checks remain unchanged.
Blocked-pair closure groups the same four open Match/Chat, Like and unlock facts by normalized pair
before joining them once; absent facts remain closed. All exact phase deltas and native lifecycle
tests remain required.

Integrity reads and their EXPLAIN context now use a transaction-local 16 MiB per-node work budget
alongside disabled JIT. This is not a total process or connection memory cap; production capacity
planning must account for concurrent nodes and connections. No pooled-session or database setting
changes. Successful fixture rollback and failed reads verify restoration of both original settings.
Duplicate review-audit metadata must preserve every aggregate count under five concurrent samples.
No migration, fixture scale, statement timeout or 1,500 ms performance limit is changed. The repair
is unverified until the exact-head six-job run passes.

## Previous increment: retained-photo custody at production query volume

The M7 plan gate now adds 20,000 photo evidence chains to both baseline and terminal scenes.
Each has an exact hold, source photo, thumbnail variant, asset and shape-valid snapshot envelope.
Source photos are hidden or deleted, so retention is checked independently of current presentation.
Half retain matching hashes and storage; one quarter has a mismatched held hash and one quarter
has deleted storage, split between independent asset and variant deletion. The production evidence
predicates must identify every intact and damaged chain. Three actual aggregate samples require the exact custody-drift delta and no
change to other phases; operational health must preserve its narrower capture-shape count.

Artifact schema 8 records aggregate observed photo counts and 27 populated fixture tables.
All 27 existing query plans retain the 1,500 ms budget, including the complete sampler and health
in both scenes. Caller-owned isolated trigger/FK bypass and rollback remain limited to synthetic
metadata. Snapshot bytes are shape-valid placeholders, not cryptographic proof; no objects are
uploaded and this does not prove provider retention, native admission or live operator acceptance.
The existing native photo capture, retention, cleanup and reveal integration suites remain required.
The catalog is unchanged; the performance repair below introduces migration 80. Encrypted-capture integrity, unrestriction volume,
concrete MFA provider/enrollment/provisioning, exporter/alerts, provider/operator staging and M8/M9
acceptance remain open.

The first CI run passed all 375 PostgreSQL tests and the exact photo-fixture assertions, but
the terminal combined sampler took 1,773 ms. The diagnosed repair replaces per-evidence capture
and custody probes with cardinality-preserving joins through the existing unique snapshot/hold
keys and variant/asset primary keys. All identity, type, schema, hash and storage predicates remain
identical; absent related rows are explicitly false. Fixture scale and the 1,500 ms budget remain
unchanged. Native custody corruption and repair evidence checks the shared paged/aggregate paths.
The repair's first integration run caught a test setup that changed a variant's asset without its
immutable storage path. That existing constraint remained enabled. The corrected fixture changes
the held asset reference to another native asset, exercising the same variant/held-asset mismatch
without weakening storage-path constraints; the production query repair remains unchanged.
The next run passed all 376 PostgreSQL tests but the combined plans still exceeded budget
(1,887 ms baseline and 2,213 ms terminal). The next repair partitions evidence into disjoint
photo/non-photo branches, retaining every capture and custody check while avoiding custody joins
for ordinary evidence. Artifact schema 9 adds numeric temporary-block, hash-batch, disk-sort and
loop diagnostics only; predicates, identifiers, keys and payloads remain excluded. The same
native binding cases, fixture counts and unchanged 1,500 ms limits remain required.
That run again passed 376 PostgreSQL tests. Diagnostics excluded disk spill: no temporary blocks
or disk sorts, with one hash batch. The baseline combined sampler passed at 1,397 ms, while
terminal sampling remained 1,696 ms and the action phase reached 45,058 repeated probe loops.
The next repair joins action audit and notice facts through their primary keys with identical
actor, command/request, recipient, empty-payload and type predicates. Missing bound rows remain
false, unrelated action notices remain exempt, and the independent pair-subject attempt check
is preserved. Native confirmed restriction drift/repair evidence and every existing gate remain required.
That run passed all 377 PostgreSQL tests but terminal sampling remained 1,743 ms. The regression
remains open. Schema 10 diagnostics retain up to 24 slow nodes using only fixed node-type/relation
allowlists, numeric inclusive timing/loops, worker counts and JIT time. Inclusive node times must
not be added together; repeated probes and startup can now be localized without predicates or
private data. This instrumentation does not itself claim a performance fix or change any budget.
The detailed run localized the costly shape filter to the photo snapshot scan: 477 ms standalone
and 185 ms in the terminal combined query, with no JIT, workers or spill. Migration 80 stores the
identical schema/key-version/nonce/ciphertext/hash-format predicate as a generated boolean. Every
input write, including test-only privileged trigger bypass, recomputes it; callers cannot supply
validity. Reads retain exact Report/evidence/type bindings and photo custody checks. The verifier
requires a stored, non-null generated column and compares PostgreSQL's canonical expression to
the exact original predicate. Recovery fixtures select writable inputs and let generation run.
Native evidence rejects direct validity writes, detects schema drift through concurrent aggregate
and health reads, and restores the baseline after repair. Empty bootstrap, upgrade from 79 and
unchanged migration replay are required. This remains shape evidence, not cryptographic validity;
fixture scale and all budgets remain unchanged.

## Previous increment: immutable original threshold admission witnesses

Migration 79 captures one original Report per distinct reporter when a new restriction episode is
inserted. The database selects the roster in the admission transaction using the same precise
episode time, unresolved statuses and strict thirty-day window. Reporter/target/Report identity and
submission time are checked at insertion, with unique reporter and Report keys. The stored top-level
transaction ID and nested parent-trigger capture prevent later transactions from appending, including
simulated transaction-ID reuse after logical restore. A deferred episode check verifies the
complete cardinality once at commit; capture or cardinality failure rolls back the whole admission.
Witnesses and their capture mode are immutable, and ordinary deletion is forbidden.

Historical episodes receive an explicit unverified mode and no fabricated roster. New admissions
cannot opt into that mode. Reconciliation, aggregate sampling and operational health share roster
cardinality and immutable Report binding/window checks; legacy episodes produce an admission-
unverified finding and damaged new rosters produce a witness-invalid finding. Reporter identities
and Report bodies never leave these metadata checks. Original rosters remain valid after later
backdated commits, terminal Report decisions and authorized episode resolution; today's unresolved
Report count is never substituted for original admission visibility.

PostgreSQL evidence covers the original five-member roster under twenty concurrent candidate
Reports, later backdated admission evaluation without roster growth, separately confirmed native
Report dismissal, immutable update/delete/mode guards, missing/malformed-witness corruption and repair,
required-capture rollback/retry, and upgrade from 78 preserving unverified history. Bootstrap,
schema/guard verification and unchanged replay remain required. Retention ownership includes this
restricted history; controlled M8 release is still required before deletion.
The first CI run passed all new native witness cases but exposed one legacy-upgrade fixture error:
disabled triggers had skipped required M5 counters for its synthetic Users. The repair preserves
ordinary User creation and narrows test-only bypass to the historical Report/episode; native
witness guards, earlier verifiers and the performance budget remain unchanged.

The unchanged 27 plan gates now include 100,000 synthetic witness bindings across 20,000 episode
chains. Artifact schema 7 records 22 populated tables and witness count; synthetic historical
bindings do not claim native admission or provider evidence. The 1,500 ms budgets remain unchanged.
The catalog is unchanged. Concrete MFA provider/enrollment/provisioning, encrypted-capture integrity,
remaining retained-photo/unrestriction volume branches, exporter/alert routing, real provider/
operator staging and M8/M9 acceptance remain open.

## Previous increment: historical threshold restriction chain integrity

Threshold reconciliation, live aggregate sampling and operational health now share checks for the
original system restriction chain. Besides its source Report and one correctly bound system
action, an episode requires matching eligible-prior-state restriction history, its exact security
audit with count/reason and command/request bindings, and the correct deduplicated critical notice
with a Telegram Delivery fact. The episode's precise admission time is compared to the owning
action's persisted millisecond time. Missing action evidence is reported once without cascading
dependent history/audit/notice findings. No prose, reporter identity or notification payload leaves
the predicates; findings retain only their fixed code and opaque episode identity.

A resolved episode also requires its separately successful, actor-bound native unrestriction
attempt and matching resolution action/reason/time. Later bans, restoration, role revocation and
Report decisions do not invalidate the original historical chain. Current Account state is not
used as a substitute for its original AccountStateHistory. Delivery admission is checked, not
provider success; transient outbox facts may expire and are not required forever by this scan.

PostgreSQL evidence creates actual threshold restrictions, detects and repairs history, audit,
notice and missing Delivery drift consistently across paged scan, concurrent aggregate sampling
and health, and validates native unrestriction followed by a separate ban. Corrupting the successful
resolution attempt produces a distinct finding. Test-only corruption restores ordinary pooled
guards. Existing twenty-candidate concurrency evidence continues to require one full restriction.
All 27 plan gates now exercise 20,000 synthetic system restriction chains with intentionally invalid
resolutions; artifact schema 6 records this scope and 21 populated tables, without identities or
restricted data. These fixtures prove query coverage, not native admission or provider delivery.

The first CI run passed 370 PostgreSQL tests but exposed a terminal-population planner regression:
the combined integrity sample took 4,665 ms and health 3,940 ms, exceeding the unchanged 1,500 ms
budget while the standalone episode query passed. Migration 78 adds a partial covering index for
episode-bound admin unrestrictions before joining their attempts. Both terminal plans must use this
index and retain the same budget. The first indexed run reduced terminal health to 656 ms and the
combined sample to 1,629 ms, still above budget. A second repair removes redundant per-episode
aggregation: the verified partial unique system-action index already guarantees at most one
restriction, allowing a direct cardinality-preserving join with the identical dependent checks.
Empty bootstrap, upgrade from 77, index verification and unchanged
replay are required; earlier migrations and catalog remain unchanged. Exact historical distinct-reporter cardinality
still needs admission-time evidence: recomputing from today's Reports can include transactions
that were not committed when the episode began. This increment does not claim that proof. Concrete
MFA provider/enrollment and audited provisioning, encrypted-capture integrity, retained-photo and
unrestriction volume branches, exporter/alert routing, provider/operator staging and M8/M9 remain open.

## Previous increment: native session authority across command waits

The native session factory and explicit HTTP session host now impose a monotonic native-session
requirement on their trusted database owner. Native authorization facts require current MFA before
and after permission lookup. Command transactions inherit that policy; transport claims cannot
turn it off. Existing separately composed external-verifier database owners retain their contract.
The session issuer authenticates first-factor identity and verified proof in its own transaction,
without requiring a previous session to establish the first grant.

Each native command pins the current grant after locking its verified AdminUser and required
permission. It checks that same grant with `clock_timestamp()` after the effect and after required
audit work. Expiry during either wait rolls back business writes and any provisional success/audit,
then commits one sanitized forbidden attempt. No private value is returned. The audit callback is
a transactional writer and may run again for the final rejected outcome after its provisional
writes roll back; external delivery must not occur there. Required audit failure aborts the whole
transaction. Revocation and supersession use the same AdminUser lock, so they serialize with an
admitted command; independent wall-clock expiry still invalidates the waiting effect.

Replays require current native MFA, preserve the original outcome, and never repeat its effect or
release its private value. A fresh grant does not turn a previously rejected command into success;
a separately confirmed new command is required. Existing external photo revocation is idempotent
but cannot be undone by a database rollback. This change introduces no schema or catalog revision:
migration 77 bootstrap, upgrade and immutable replay evidence remain required.

PostgreSQL evidence covers missing grants, twenty concurrent retries, revoked-grant replay denial,
fresh-clock expiry during an effect and audit, atomic required-audit failure, and actual confirmed
Account restriction after logout followed by a separately confirmed successful command. Concrete
factor/enrollment/provider and audited operator provisioning, deeper integrity coverage, remaining
volume branches, exporter/alert routing, provider/operator staging and M8/M9 acceptance remain open.

## Previous increment: native durable admin session lifecycle

`AdminSessionService` now consumes a trusted server MFA proof bound to the authenticated first-factor
User and verified Telegram identity. The factor provider must verify the factor and return the same
one-use proof ID on repeated assertion validation; client identity, expiry and MFA claims cannot
authorize a session. Factor assertions/secrets and bearer plaintext are never persisted. The native
store admits one proof once, creates a random 256-bit opaque bearer, and retains only its SHA-256
hash. Database time limits the session to fifteen minutes and current MFA to five minutes from the
verified factor. Every session lookup checks both deadlines, current verified identity, active admin/version
and at least one active explicit role permission. Individual commands still check their own permission.

Issuance serializes on the owning AdminUser, supersedes its previous grant, and records immutable,
content-free security audits in the same transaction. Required audit failure rolls back proof
consumption, the new grant, previous revocation and supersession audit. Owner revocation is idempotent;
cross-owner requests have no effect. Disabled or re-enabled AdminUser versions invalidate old grants.
Revoked roles and expired MFA deny both bearer and Telegram lookup. A revoked latest grant cannot
fall back to an earlier session. Migration 77 forbids ordinary deletion, extension and resurrection,
enforces one current grant and global proof uniqueness, and retains history for controlled M8 release.

`createM7SessionHostOptions` explicitly composes the native service into every shared HTTP admin
route. It delegates only user-audience requests to the configured user authenticator, with no admin
fallback. The returned service also satisfies the existing Telegram session-verifier contract.
Issuance is server-internal and requires authenticated first-factor context and a trusted MFA
provider. No unauthenticated login endpoint, enabled operator, factor enrollment, secret provider,
MFA bypass or default-startup activation is introduced. Real factor-provider/enrollment and audited
operator provisioning remain required before production activation.

Evidence covers concurrent one-use admission/revocation, supersession, immutable guards, independent
MFA expiry, role/admin-version invalidation, required-audit rollback and native-session HTTP health
preparation/read/logout. Migration evidence covers empty bootstrap, upgrade from 76 and unchanged
replay; retention registry includes the new security history. Catalog remains unchanged. Concrete
factor/provider/operator staging, native-command MFA handoff across long waits, deeper integrity coverage, remaining volume branches, exporter/
alert routing and M8/M9 acceptance remain open; session infrastructure alone does not complete M7.

## Previous increment: authenticated operational health API

The explicit shared M7 HTTP host now composes native health preparation and sampling handlers.
POST `/v1/admin/moderation/operational-health/prepare` accepts the admin actor and request ID;
POST `/v1/admin/moderation/operational-health` additionally requires the returned opaque action token.
Both routes require the injected current admin-session/MFA verifier before and after awaited work,
strict request/response schemas, and no-store responses. They remain absent from ordinary startup.
The global view requires all three existing permissions: `view_reports`, `review_support`, and
`review_appeals`. Role names grant no independent authority. Native signed, expiring capabilities
bind the actor, verified identity, command and global target; current permissions are checked
before and after issue/sample. Disabled admins, revoked roles, expired/lost tokens, borrowed actors,
target-specific capabilities and sessions revoked during sampling receive no health data.

One PostgreSQL statement returns database sample time, whole-second pending/in-review ages and
five fixed counts, under the existing scoped integrity-read transaction. The narrow fields mean:

| Contract field | Current authoritative metadata predicate |
| --- | --- |
| `thresholdMismatchCount` | Restriction episode source/system-action flags |
| `adminLogMismatchCount` | Admin log access/action flags |
| `snapshotIntegrityFailureCount` | Evidence capture-shape flag only |
| `supportLimitMismatchCount` | Open-thread unanswered-limit flag only |
| `appealUniquenessMismatchCount` | Exact-ban uniqueness flag only |

These counters do not substitute whole reconciliation phase totals. Capture shape does not decrypt
or authenticate retained content; this view does not validate historical threshold distinctness or
the complete Account/action/Notification relationship. Retained-photo custody, support attempts,
appeal decisions/unbans and other phase findings remain visible in the broader integrity sampler.
Only fixed aggregates/time leave the store; malformed or expanded samples and source failures are
sanitized at the boundary. Reads allocate no mutation, access-content audit or reconciliation run.

Evidence includes concurrent reads, permission/session revocation during sampling, opaque-token
scope/expiry/cache loss, strict output rejection, native PostgreSQL role/disable checks and repaired
capture metadata. Both baseline and terminal-appeal volume scenes measure the actual health query
alongside the existing plans; all 27 plans retain the 1,500 ms budget. Three terminal health samples
must preserve the five baseline mismatch counts. Aggregate artifact schema 5 adds these two plans
and the fixed repeat count, retaining its privacy restrictions. No migration or catalog change is
needed beyond migration 76. Exporter/alert routing, concrete session/MFA, deeper integrity coverage,
remaining volume branches, provider/operator staging and M8/M9 acceptance remain open.

## Previous increment: reviewed appeal and separate unban volume evidence

The M7 performance gate now adds a second measured population after its submitted-appeal baseline:
20,000 reviewed appeals, including 10,000 rejected, 5,000 accepted without unban, and 5,000 accepted
with a separately recorded unban command, attempt, action, Account history, notification and audit.
Restoration covers guest, incomplete, active and restricted states from the exact prior ban event.
Each terminal appeal has its own review attempt/version and matching decision audit. Acceptance
alone has no unban relationship or Account action. Existing native permission, confirmation, exact
ban/version, replay and concurrency command evidence remains required; synthetic fixtures bypass
owning triggers only inside the isolated rollback session and do not prove command admission.

Six new plans measure the actual accepted/rejected metadata queues, current appeal/action/admin-log
aggregates, and the combined production sampler over both populations. All retain the 1,500 ms
budget. Three repeated terminal-population samples must preserve every baseline mismatch count;
PostgreSQL-derived aggregate fixture counts prevent empty decision/restoration branches. Artifact
schema 4 contains only fixed scope labels, aggregate counts, timings, row counts and index names.
No subject IDs, prose, private notes, payloads, keys, raw predicates or SQL are retained.

PostgreSQL integration evidence checks reviewed/accepted-without-unban cardinality, healthy shared
predicates, missing accepted/rejected decision audits, a substituted unban attempt target, incorrect
restoration and wrong ban owner. Restoring exact fixture metadata clears the current mismatches;
rollback removes all appeal/action/audit/history/notice fixtures and restores pooled safeguards.
No migration or catalog change is required beyond migration 76. Retained photo/encrypted captures
and unrestriction volume cases, health API composition, exporter/alert routing, concrete session/MFA,
provider/operator staging and M8/M9 acceptance remain open.

## Previous increment: production-volume integrity plan evidence

The M7 performance gate now measures each of the ten actual integrity phase statements and the
combined production sampler alongside the eight existing queue/admission/age queries. The default
fixture populates at least 20,000 entities per integrity phase, across nineteen seeded tables, with
verified administrator identity metadata, account-action audit/attempt/history/notice joins, profile
capture drift, submitted appeals, and blocked pairs with a mix of active and revoked chat/like unlocks.
Three repeated production samples must detect the seeded capture, episode and blocked-pair drift.
Every query, including the combined snapshot, retains the existing 1,500 ms execution budget.
Initial CI diagnosed action/support counts over budget and a 6.46-second combined sample. Integrity
reads now disable JIT compilation locally in their transaction, including the measured production
statements; commit/rollback restores pooled-session settings. The numeric budget is unchanged.
The first repair reduced the combined sample to 3.35 seconds, but support remained at 1.91 seconds
and actions at 1.16 seconds. Support now uses a parameterized lateral limit check to allow per-user
memoization across threads. Account history checks split null/exact administrator bindings and use
migration 76's composite actor/history index. The predicates, restoration checks, trigger safeguards
and numeric budget remain unchanged; bootstrap, upgrade from 75, verifier and replay are covered.
Whole-phase aggregates may use sequential scans; queue/admission index requirements remain intact.

The blocked-pair predicate follows indexed match/like relations to unlocks instead of scanning all
active unlocks per pair. Both the bounded scanner and the sampler use this same predicate. Fixture
writes use the existing isolated synthetic session, always roll back, and restore trigger enforcement
on success and failure. PostgreSQL integration evidence checks both cleanup paths. Plan artifacts
export only allowlisted timing, row counts and index names; no predicates, bound identities, private
prose, ciphertext, object references, keys or raw SQL enter the retained evidence.

This is metadata-volume evidence, not proof of every branch or native command admission. Separate
volume scenarios for retained photo/encrypted captures and terminal appeal/unban history remain open,
along with real exporter/alert routing, authenticated health API composition,
concrete session/MFA bootstrap, provider/operator staging, and M8/M9 acceptance.

## Previous increment: live aggregate integrity sampling with shared reconciliation predicates

The scheduler now samples current violating entities in all ten moderation integrity phases every
thirty seconds. One PostgreSQL statement gives the counts a shared database snapshot and sample
time. Only fixed phases, nonnegative integer counts and freshness reach the metric boundary; no
entity identity, prose, ciphertext, snapshot body, object key, token or diagnostic SQL is returned.
Shared metadata predicates govern both the paged reconciliation scanner and the live sampler.
Each violating entity counts once in its phase even when more than one predicate fails.
Duplicate exact-ban appeals are checked independently of retained historical findings.

The action source-Report predicate preserves dismissal's exact reported-user binding and verifies
both exact normalized participants for Report-linked internal blocks. Valid native create/remove/dismiss
commands are not quarantined as target mismatches. Existing audit, successful-attempt, Account
history, notification, review and retained-capture checks remain mandatory.

`nakh.m7.integrity.current_mismatches` uses only the ten fixed phase labels;
`nakh.m7.integrity.sampled_at` identifies freshness. Failed measurement increments the existing
safe health-failure metric and advances neither the integrity counts nor their sample time.
Historical reconciliation findings remain immutable and can remain present after current counts
return to zero. These checks validate authoritative metadata relationships and capture/storage
shape; they do not decrypt content or claim cryptographic authentication of retained snapshots.

Unit evidence rejects incomplete, extra-label, fractional, negative and non-finite metric samples
before emission. Actual PostgreSQL evidence covers twelve concurrent samples, all ten empty/healthy
phases, missing capture then repair with preserved historical quarantine, privacy, and separately
confirmed native Report block/removal/dismissal without false findings. No schema or catalog change
is needed; migration 75 bootstrap/upgrade/replay gates remain required. Authenticated operational
health API composition, broader production-volume integrity-query plans, real exporter/alert routing,
concrete session/MFA and provider/operator acceptance remain open; M7 is not complete.

## Previous increment: private Report internal-block reason and confirmation controls

The private Report menu now offers create/remove only after current native pair eligibility and
`manage_internal_blocks` checks. These controls use the exact Report selection, independently of
Review assignment. The block-only reason prompt retains the first action and Report reference in
an encrypted, actor-bound five-minute cache purpose. Assignment, decision, Account, photo and
evidence-read handlers cannot consume that reply. The trusted adapter derives the pair grant and
version through selected-Report preparation and saves a native reason-bound command behind a
separate encrypted block mutation reference. Provider messages contain localized effects, the
operator's reason and opaque callbacks; pair, user, Report and command identities stay internal.

Protected private Confirm/Cancel callbacks use one first-write UI decision. Cancellation executes
no native command. Confirmation checks current session/MFA around waits and executes the saved
native command; current permission, exact Report participants, native pair version and immutable
attempt/action audits remain owned by the native boundary. Retries produce one pair effect and
audit. Creation stays silent and closes interactions; removal and old-command replay never reopen
them. Account state, Report status and Review assignment are unchanged.

Forward-only migration 75 adds four English fallback labels. Bootstrap, upgrade from migration 74,
verification and unchanged replay cover the 582-key catalog without rewriting older migrations.
Unit evidence covers owned replies, purpose substitution, exact action/version/reason retries,
cancellation, cache/session expiry and protected callback transport. Actual PostgreSQL/private
ingress evidence covers create/remove and old-confirmation replay under twelve concurrent retries,
cancelled/revoked/stale/expired decisions, no user notifications or identity disclosure, and unchanged
Accounts/Report/Review. Concrete session/MFA composition, integrity telemetry and real provider/
operator staging acceptance remain open; these controls alone do not complete M7.

## Previous increment: Report-derived internal-block preparation and audit scope

Authenticated no-store `POST /v1/admin/moderation/reports/internal-block-selection` now derives
the normalized pair from the exact selected Report. A current metadata-root grant, verified admin
identity and `view_reports` authority govern selection; issuing the native action requires current
`manage_internal_blocks` before state eligibility is disclosed. The request accepts no client pair,
pair version, reporter/target identity or source Report override. The response contains only the
opaque action token and native pair version (one for absent pair state). Preparation rechecks Report
version/status, pair/version and current authority after waits; it reveals no content, mutates no
state and creates no attempted-command or evidence-access audit.

The separate reason/confirmation boundary binds the Report context inside native server-owned
claims and command digests. Confirmed execution rechecks current specific permission and pair
version, verifies the Report's exact immutable participants inside the owning pair transaction,
and records one Report-linked moderation action with its successful attempted-command audit.
Internal blocks are permitted from submitted and terminal Report context with their specific
permission; they do not require or assign a Review. Creation stays silent, closes active Match/chat/
Likes/scoped access and changes only the normalized pair. Removal and command replay never reopen
old product state, and neither operation changes Account state or reveals evidence.

Forward-only migration 74 extends the existing Report scope/deferred attempt guards for exact pair
actions and adds a canonical pair-target function matching the application SHA-256/UUID binding.
Existing Account/photo assigned-review guards, unlinked native block commands, immutable historical
actions and the 578-key localization catalog are preserved. Bootstrap, upgrade from migration 73,
verification and unchanged replay remain mandatory.
Unit and actual PostgreSQL HTTP evidence cover strict contracts, actor/root substitution, stale
selection, permission revocation and view-only roles, concurrent preparation and confirmation,
one action/audit, source-pair substitution, SQL successful-attempt enforcement and canonical target
agreement, silent closure and no reopening after removal/replay. Private Telegram internal-block
reason/confirmation controls, concrete session/MFA composition and real provider/operator staging
acceptance remain open; this preparation bridge alone does not complete M7.

## Previous increment: exact audited retained photo byte delivery

The explicitly composed private evidence delivery now resolves the captured thumbnail through its
media-owned Report hold. It requires the exact successful reveal command/log and committed revealed
access audit, the verified current admin/Telegram binding and current `view_reports` permission.
Successful audit authority expires after five minutes; a mismatched actor, recipient, command,
log, evidence reference or digest cannot resolve storage. Logical photo/variant/asset deletion
preserves safety access; physically deleted storage and cleanup leases deny it.

The trusted object reader uses the existing R2 streaming capability. The application bounds the
thumbnail at two MiB and twenty seconds, checks the captured SHA-256 and WebP container, then
rechecks current authorization and the same hold after storage waits. The Telegram adapter checks
current actor-bound session/MFA before reading and again immediately before the protected upload.
The fixed Bot API receives only private chat identity and verified multipart image bytes, a generic
filename and `protect_content=true`; no caption, storage key, object reference, public URL or
provider file cache enters the request. A bounded acknowledgement is required. No storage or
provider retry occurs; fresh native execution is the only caller, and native replays never read
or send bytes again, including after an ambiguous provider failure.

Unit evidence covers malformed authority, bounded/corrupt/truncated/non-WebP streams, changed holds,
revocation during storage, actor/session substitution and protected provider failure handling.
Actual PostgreSQL/Telegram boundary evidence covers concurrent native retries, logical deletion,
revoked permission, expired sessions, digest failure and ambiguous upload failure with one native
attempt/access audit and no redelivery. Byte fixtures are synthetic and captured with their digest
before immutable retention; tests never rewrite held digests or storage identity.
No persistence shape or catalog change is introduced; migration 73 bootstrap/upgrade/replay gates
remain mandatory. Real R2/Telegram/operator staging acceptance, concrete session/MFA composition
and internal-block controls remain open. Ordinary startup does not enable an unconfigured or no-op
retained byte provider.

## Previous increment: private Telegram evidence reason and confirmation

The selected evidence UI now offers **View selected evidence** only when the configured native
reader supports that exact item. The owned private bot prompt binds its opaque evidence choice
in a separate encrypted five-minute purpose; the operator's full normalized reason is checked
against the 1024 Unicode scalar limit before native preparation. Existing photo controls remain
available independently. The content-free selection is rechecked before the reason prompt and
again before preparation. Clients supply no Report/evidence identity, version or permission in
callback payloads.

`m7W` starts the owned reason prompt. Stable provider operation identities converge on one
actor-bound encrypted native evidence command, binding Report/version, evidence identity/type/schema
and normalized reason. `m7K` Confirm and `m7Q` Cancel share one first-write-wins decision. The
native reader resolves only after Confirm wins; it rechecks current permission and commits both
attempt and access audits before delivering content. Session/MFA is rechecked before presentation,
execution and every evidence delivery, including after the outcome notice or between text chunks. Replays never send content, including after ambiguous provider failure;
a new view requires a new reason/confirmation and audited command. Cancel executes no native read
and never reverses a prior Confirm.

Trusted ingress enables this flow only with explicitly injected snapshot readers and evidence
delivery. Reader support is derived from those same readers. Retained photos use the explicit
retained-photo delivery port with the native evidence reference and digest; URLs and object
references never become message text. The UI encryption key is never used as a retained snapshot
key. Without the capability, metadata browsing and existing photo controls keep working.

PostgreSQL integration evidence captures all five evidence types through their owning report
services, selects each through actual private Telegram ingress, concurrently prepares and confirms
it, and verifies one access/attempt audit and no content redelivery. Cancellation, revoked native
permission and provider failure retain their separate native outcomes. Unit evidence also covers
cross-purpose substitution, changed selections/reasons, owned bot replies, expiry/cache loss,
private sessions/MFA and simultaneous photo/read availability. Migration 73 adds four English
labels (578 total catalog keys); bootstrap, upgrade from migration 72 and unchanged replay are
required. Real retained-byte provider delivery, concrete session/MFA, internal-block controls and
staging operator acceptance remain open.

## Previous increment: selected Report evidence reveal preparation

The authenticated `POST /v1/admin/moderation/reports/evidence-reveal-selection` bridge accepts
only the actor, request, queue metadata token, selected Report/version and exact evidence ID.
It derives report-scoped metadata authority through the existing native boundary, checks current
admin identity and Report stability before returning the owning evidence action token, and denies
borrowed evidence, unsupported readers and snapshot schemas other than version 1. All five valid
Report statuses remain browsable without a Review assignment. The response contains only one
opaque token and has no-store/no-cache headers; preparation reads no content and creates no
evidence-access audit. Host composition shares the existing evidence actions capability rather
than advertising independently configured reader support.

The separate native reveal preparation still requires the operator's reason and binds immutable
evidence version 1 internally. Confirmed execution rechecks current permission and commits both
the attempted-command and access audits before returning content. Concurrent execution retries
return content only on the first successful execution, never on replay. Unit and PostgreSQL HTTP
evidence cover concurrent selection, exact source binding, stale Reports, cross-admin reuse,
missing reader support, permission revocation, and one audited content-bearing execution.

This increment introduces no durable schema or catalog changes, so migration 72 remains current.
Existing migration bootstrap, upgrade and replay gates remain required. Telegram content reveal,
retained-photo byte delivery, internal-block controls, concrete session/MFA, and real staging
provider/operator acceptance remain open; this bridge alone does not complete M7.

Status: approved implementation guide for M7. This guide converts the canonical reporting,
restriction, review, admin, internal-block, support, appeal, privacy, and acceptance rules into an
ordered backend plan.

## 1. Authority and boundary

1. The domain documents remain authoritative for product behavior.
2. Existing identity, Profile, media, interaction, Match/chat, payment, notification, security,
   localization, retention, testing, and deployment rules remain mandatory.
3. This guide owns M7 sequencing, report reasons, evidence authorization, immutable snapshots,
   distinct-reporter threshold restriction, moderation review/actions, internal blocks, admin RBAC
   and attempted-command logs, support limits, ban appeals, and evidence for `ACC-039..041`.
4. M7 reuses Account/AccountStateHistory, UserPairState, Match/chat closure, photo moderation,
   Notification/Delivery, M6 ChatMessageSnapshot, durable rate-limit records, audit, inbox, and
   outbox models. It must not create alternate Account, pair, media, notification, or chat state.
5. Provider-neutral application and persistence evidence may complete before infrastructure exists.
   Real Telegram admin/moderation/support behavior remains a staging gate.

M7 delivers confidential reporting with immutable evidence, race-safe five-distinct-reporter
restriction, explicit human review, authorized moderation actions, internal safety blocks, complete
admin attempt logging, bounded support, and one appeal per ban event. A Report alone never bans.

## 2. Non-goals

Do not add user-visible blocking, automated banning, ML content moderation, face/age verification,
public moderation reasons, reporter disclosure, unrestricted operator search, bulk report export,
arbitrary chat browsing, manual business-table edits, user-created admin accounts, multi-tenant
roles, legal retention-duration decisions, account deletion, or production activation. M8 owns the
deletion/retention purge saga. M9 owns production activation.

M7 does not reopen M2 photo lifecycle, M3/M5 interaction state, M6 Unmatch/report window or message
retention. It calls their public ports under one coordinator and preserves their invariants.

## 3. Required ownership

```text
packages/domain/src/moderation/          # pure reason, text, threshold, review and appeal policies
packages/contracts/src/m7.ts             # strict user/admin/support channel-neutral contracts
packages/application/src/moderation/     # report, threshold, review, action and evidence ports
packages/application/src/administration/ # RBAC and attempted-command execution boundary
packages/application/src/support/        # support and appeal handlers/ports
packages/persistence-postgres/src/       # M7 repositories and cross-module coordinator stores
packages/telegram/src/                   # signed user/admin actions and localized presentation
apps/api/src/                            # provider-neutral authenticated M7 endpoints
apps/telegram-gateway/src/               # user report/support and admin command ingress
apps/scheduler/src/                      # bounded reconciliation/health sampling only
migrations/000046..                      # forward-only M7 schema, seeds and hardening
```

Moderation owns Report, evidence, snapshot, review, action, threshold, and appeal decisions.
Administration owns admin identity, RBAC, and attempted-command logging. Support owns support
threads/messages. Other modules remain the only writers of their Account, photo, pair, Match/chat,
and Notification state.

## 4. Locked decisions and constants

- Reporter and target are resolved server-side and must differ. Commands never accept an effective
  reporter, target, admin identity, Account state, or permission from client data.
- User reports use one active seeded reason and optional NFC-normalized, outer-trimmed text of at
  most 1024 Unicode scalar values. Empty normalized optional text becomes absent.
- A user may submit at most 10 committed Reports in the rolling prior 24 hours using database time.
  A Report at the exact 24-hour boundary no longer counts. Replays do not consume another slot.
  System/admin safety work does not consume this user limit.
- Evidence types are exactly `profile`, `photo`, `chat`, `message`, and `unmatched_user`. Each
  evidence row has exactly one matching reference. Catalog codes are stable and rows are
  deactivated, never deleted.
- A Nakh receiver's Report action authorizes a target-Profile report through the authoritative Nakh
  relationship; Nakh is not a sixth evidence type and its text is not copied into Report metadata.
- Client evidence references are short-lived, opaque, actor-bound intents. PostgreSQL remains the
  permission source and rechecks the underlying relationship at commit time.
- Mutable evidence is snapshotted in the Report transaction. Snapshot payloads are versioned,
  minimally scoped, application-encrypted, hash-protected, immutable, and readable only through an
  audited safety-review capability.
- Message evidence uses the existing M6 `chat.chat_message_snapshots`; M7 adds its Report foreign
  key. Other mutable evidence uses `moderation.report_snapshots`. A Report never stores content in
  outbox, queue, log, metric, audit metadata, admin log metadata, or Notification payload JSON.
- The automatic threshold is at least 5 distinct reporters with unresolved `submitted` or
  `pending_review` Reports in the rolling prior 30 days, across every evidence type at target-User
  level. Multiple Reports from one reporter count once.
- Threshold evaluation uses database time and a target-User advisory lock. One active threshold
  episode creates at most one system restriction action and at most one Account transition.
- Threshold restriction is not a ban, does not expire automatically, and remains until an
  authorized admin decision. An already restricted target is prioritized without another state
  transition. Banned/deleted targets retain prioritized reports without an illegal transition.
- An individual report is confidential and creates no target notice. The threshold Account
  restriction creates one non-mutable safety Notification without reporter/evidence identity.
- Only an active AdminUser with the exact required permission may view restricted evidence or run a
  mutation. Role names alone never authorize a command.
- Every state-changing admin attempt requires explicit target confirmation and bounded reason, and
  commits exactly one `succeeded`, `rejected`, or `failed` AdminActionLog. Sensitive views create a
  separate append-only access audit.
- Admin mutation reasons are required and limited to 1024 normalized Unicode scalar values. Review
  decision notes and appeal admin notes are optional and limited to 2000 after normalization.
- Internal block is moderation-only, silent to both users, normalized and symmetric. It closes
  active pair state through the existing lifecycle coordinator. Removing it restores no prior
  Match, Like, Nakh, Chat, FeatureUnlock, or Explore eligibility/consumption.
- Non-banned users use Support; banned users use UserAppeal. Support allows at most two unanswered
  user messages across open threads. One appeal is allowed per AccountStateHistory ban event.
- Support and appeal text is required, normalized, non-empty, and at most 2000 Unicode scalar
  values. It is restricted content and never general telemetry.

## 5. Forward-only migration sequence

1. `000046_m7_reports.sql` — moderation schema, seeded reasons, Report, durable user report window,
   replay binding, lifecycle/index/immutability guards, and least-privilege grants.
2. `000047_m7_report_evidence.sql` — typed evidence, encrypted/versioned ReportSnapshot,
   M6 ChatMessageSnapshot Report foreign key, content hashes, access audit, and retention indexes.
3. `000048_m7_threshold_reviews_actions.sql` — target lock support, restriction episode identity,
   ModerationReview, append-only ModerationAction, threshold/review indexes, and safety audit links.
4. `000049_m7_review_consistency_fix.sql` — forward-only row-shape-safe deferred consistency fix
   for Report and ModerationReview trigger sources.
5. `000050_m7_administration.sql` — AdminUser, role/permission catalogs and joins, attempted-command
   log, evidence-access log, bootstrap constraints, and immutable RBAC seed codes.
6. `000051_m7_support_appeals.sql` — SupportThread/SupportMessage, per-ban UserAppeal uniqueness,
   unanswered-count support, lifecycle guards, and restricted-text grants.
7. `000052_m7_appeal_admission.sql` — exact current-ban ownership, immutable submission replay,
   and appeal deletion guards.
8. `000053_m7_appeal_unban.sql` — immutable accepted-appeal, Account transition, moderation action,
   and successful admin-attempt evidence.
9. `000054_m7_localization.sql` — report reasons/surfaces, safe restriction/ban notices, admin
   outcomes, support, appeal, stale-action, rate-limit, and generic authorization/error keys.
10. `000055_m7_review_decisions.sql` — explicit dismissal action shape and terminal-review guard.
11. `000056_m7_action_report_scope.sql` — report-linked admin target/assignment and successful-attempt guards.
12. `000057_m7_evidence_access_identity.sql` — admin-bound evidence access command identity, preserving existing audit rows.
13. `000058_m7_unmatch_report_deadline.sql` — post-lock database-time enforcement of the immutable unmatch report window at evidence insertion.
14. `000059_m7_photo_evidence_holds.sql` — exact retained photo variant and content binding.
15. `000060_m7_photo_evidence_cleanup.sql` — hold-aware storage cleanup guards.
16. `000061_m7_photo_capture_complete.sql` — complete capture/hold requirement at commit.
17. `000062_m7_reconciliation.sql` — moderation run/anomaly types in the shared reconciliation
   registry, support/appeal status keyset indexes, and immutable subject-bound support/appeal access
   audits linked to exact admin attempts.
18. `000063_m7_operational_indexes.sql` — queue ages, all-status support admission and latest
   completed moderation scan indexes, verified on empty bootstrap and every recorded upgrade baseline.

Every migration must bootstrap from empty, upgrade from `000045`, replay unchanged, and have
matching verification SQL. Applied migrations are immutable. No migration seeds an enabled admin
identity or real Telegram ID. Roles/permissions are code-owned seeds; operator assignments require
an explicit audited bootstrap command after staging identities exist.

## 6. Persistence invariants

### 6.1 Reports, limits, and replay

`moderation.reports` stores reporter, target, active reason, normalized optional text, status,
database lifecycle times, version, and request identity. Checks reject self-report and invalid
status/timestamp shapes. One request digest binds reporter, target, reason, text, ordered evidence,
and source relationship; identical replay returns the same Report, changed replay rejects.

The daily limit is admitted under a reporter advisory lock from committed Reports in the exact
rolling 24-hour window. The limit and Report commit together. Target threshold evaluation occurs
under a separate target lock after the Report/evidence/snapshots exist in the same transaction.

### 6.2 Evidence and snapshots

`moderation.report_evidence` enforces exactly one typed reference, unique typed references within a
Report, and at least one evidence row before the Report transaction can commit. Live foreign keys
use restricted deletion behavior until their immutable snapshot exists; ordinary cleanup cannot
remove required evidence first. Authorization is type-specific:

- `profile`: an actor-bound recent product relationship resolved from authoritative history;
- `photo`: same relationship plus the target's referenced ProfilePhoto;
- `chat`: reporter is a stored participant in that Match/Chat relationship;
- `message`: reporter is a participant and the message belongs to that ChatSession;
- `unmatched_user`: reporter is either participant and database time is before the exact M6
  `report_window_expires_at` boundary.

Profile/photo/chat/unmatch snapshots contain only the minimum reviewed schema fields. Media
snapshots retain a restricted object/evidence reference and digest rather than embedding image
bytes. Message capture calls the M6 internal snapshot port in the Report transaction. Snapshot
ciphertext records key ID/version, nonce, schema version, hash, and creation time; plaintext never
crosses the repository boundary except through an authorized audited review projection.

### 6.3 Threshold restriction

The threshold query uses `(target_user_id, reporter_user_id)` distinctness, unresolved statuses,
and `submitted_at > database_now - interval '30 days'`; a Report at the exact boundary is expired.
Under the target lock, a crossing creates
or replays one threshold episode, system ModerationAction, AccountStateHistory restriction, safety
audit, safety Notification, Delivery/outbox fact, and priority review state.

Unrestricting closes the active episode but does not dismiss Reports. A later episode is possible
only after an authorized resolution and a new threshold evaluation; it has a new stable episode ID.
No threshold path contains a ban transition.

### 6.4 Reviews and moderation actions

One ModerationReview belongs to one Report. Assignment and state/version transitions are explicit:
`pending -> in_review -> dismissed|actioned`. Report status changes separately and must agree with
the final review outcome. Decision notes/reasons are bounded restricted text.

ModerationAction is append-only. System may only create `restrict_user` for a threshold episode.
Authorized admins may dismiss, keep/unrestrict/restrict, ban/unban, hide/restore/delete a photo,
create/remove an internal pair block, and review change requests through named commands. Each action
stores the exact target and source Report when applicable, never a free-form metadata copy of
evidence.

### 6.5 Admin authorization and logging

AdminUser maps one internal User and verified Telegram identity snapshot. Disabled admins, inactive
roles, or missing permissions deny before evidence reveal or mutation. Super-admin is a seeded role,
not a bypass in code; it receives explicit permission rows.

A state-changing admin command has one unique actor-bound command ID and request digest; identical
replay returns the recorded outcome and changed replay is rejected without repeating an effect. It
runs in an outer transaction with a savepoint around its business effect. Expected
authorization/domain rejection rolls back to the savepoint, inserts one immutable
`rejected` AdminActionLog, and commits no business mutation. Unexpected safe failure rolls back to
the savepoint and records `failed`. Success records `succeeded` in the same outer transaction as the
effect. Connection/transaction loss commits neither effect nor log and the durable command inbox
retries. Logs contain command code, opaque target type/ID, result, correlation, finite safe code,
and time—never report/support/chat text, decrypted snapshots, Telegram IDs, or secrets.

### 6.6 Support and appeal

Support admission locks the User's open threads, counts user messages after the newest admin/support
reply, and atomically rejects a third unanswered message. A reply starts a new count segment. Banned
users cannot open/send Support messages.

Appeal admission locks the exact AccountStateHistory ban event and enforces one UserAppeal by unique
foreign key. Only the currently affected User may appeal. Accepted appeal authorizes a separate
admin unban command; rejection is terminal for that ban event. Appeal status alone never mutates
Account state.

## 7. Lock order and transaction boundaries

Use database time and preserve the global order:

1. authenticated actor User/Account or AdminUser/RBAC rows;
2. reporter/source relationship rows;
3. target-User advisory lock, target Account and AccountStateHistory;
4. normalized pair advisory lock, UserPairState, Match/Chat when an action affects a pair;
5. Profile/ProfilePhoto/MediaAsset for photo actions;
6. Report, evidence, snapshots, review, action, support, or appeal rows;
7. Notification, safety/access/admin audit, outbox, inbox, and idempotency facts.

Report creation locks reporter admission before target threshold state. Two reciprocal reports
therefore lock reporter IDs and target IDs independently, never two User rows in command order.
Cross-user moderation uses normalized UUID order where both Accounts are required.

External Telegram, object storage, KMS, and telemetry calls never occur in a business transaction.
Versioned envelope keys are loaded before entering a transaction. Bounded local snapshot encryption
captures the locked source inside the short commit; only ciphertext/digests persist. Photo object retention/cleanup uses
existing outbox workers after the database decision.

## 8. Canonical use cases

### 8.1 Prepare and submit a Report

The presentation adapter asks the application for an actor-bound evidence intent based on the
current rendered surface. Submission resolves that intent, validates active reason/text, rechecks
the relationship, admits the durable limit, writes Report/evidence/snapshots, evaluates the target
threshold, and creates any one restriction episode atomically. Response exposes only the Report's
opaque ID, safe status, and localized acknowledgement.

### 8.2 Review a Report and reveal evidence

Queue queries are keyset-only and return metadata before content: reason code, evidence types,
status, age, priority, and aggregate prior-report context without reporter identity. Evidence reveal
requires `view_reports` plus target-scoped confirmation, decrypts only the selected snapshot, and
writes an access audit whether reveal succeeds or is rejected. No bulk export exists.

### 8.3 Apply an Account or photo action

Resolve the signed admin command to one AdminUser and required permission. Recheck target/version,
require explicit confirmation/reason, then call the owning module's public command. Account
restrict/ban/unrestrict/unban writes AccountStateHistory and critical Notification. Photo actions use
the M2 moderation path, revoke delivery before hide/delete becomes visible, and re-evaluate Profile
completion/primary photo. The admin wrapper records the attempt result as defined above.

### 8.4 Create or remove an internal block

Require `manage_internal_blocks`, normalized pair identity, reason, and confirmation. Creation uses
the Match lifecycle coordinator to set `blocked`, close active Match/chat/Likes and scoped access,
and suppress user notification. Removal deletes/ends only the block state; the pair returns to no
stored pair state and old product state remains closed.

### 8.5 Support and appeal

Support commands authorize a non-banned User and enforce the two-unanswered limit before committing
restricted text. Admin replies require `review_support` and are attempted-command logged. A banned
User is routed only to one appeal for the current ban history. Appeal review requires
`review_appeals`; acceptance then invokes the separately permissioned unban command.

## 9. Contracts and presentation

M7 contracts include prepare/submit Report, report metadata page, claim/assign/review, evidence
reveal, Account/photo/internal-block actions, support open/send/reply/close, appeal submit/review,
admin bootstrap/disable/role assignment, reconciliation, and operational-health queries.

Every user mutation carries actor and request/command IDs plus strict typed data. Every admin
mutation also carries expected target version, permission-specific signed action, confirmation,
bounded reason, and correlation. Results expose opaque IDs, status/version/times, finite codes, and
localized presentation references. They never expose reporter identity to the target, decrypted
evidence in list views, RBAC internals to users, Telegram identity, or raw failure data.

Telegram callbacks are short-lived and actor/admin-bound. Lost Redis/menu state is recovered from
signed opaque context plus PostgreSQL authorization. Stale buttons, cross-admin actions, disabled
admins, changed targets, missing permissions, and changed replays return localized safe errors and
still satisfy admin attempt logging where a mutation was attempted.

## 10. Security, observability, reconciliation, and retention

- Report, support, appeal, review-note, and snapshot content is restricted. Never place it in logs,
  traces, metrics, queues, outbox payloads, Notifications, admin metadata, or acceptance artifacts.
- Metrics use finite labels for report outcome/evidence type, limit denial, threshold outcome,
  review age/outcome, moderation action/result, admin denial/result, support/appeal outcome, and
  reconciliation phase. IDs, reason text, catalog reason code, locale, and content are forbidden
  labels.
- Alert on report/review backlog age, fifth-report restriction failure, Account/action mismatch,
  unlogged admin mutation attempt, evidence-decrypt/hash failure, snapshot cardinality drift,
  expired review lease, and reconciliation/health-sampling failure.
- Reconciliation verifies Report/evidence/snapshot shape, M6 message snapshot FK/cardinality,
  threshold distinctness/episode/Account/action/Notification agreement, review/report state,
  action/owning-module state, internal-block closures, RBAC/log integrity, support unanswered count,
  and appeal/ban-history uniqueness.
- Safe repairs use reviewed idempotent commands. Missing/invalid evidence, contradictory Account or
  photo state, unlogged mutation, or snapshot-integrity failure is quarantined; reconciliation never
  invents evidence, reporter identity, admin authorization, decision, block, or appeal outcome.
- Update `17-data-retention-registry.md` in the schema checkpoint for Reports, evidence/snapshots,
  reviews/actions, admin/access logs, support, and appeals. M8 must enumerate each in deletion and
  retained-safety verification.

## 11. Acceptance and fault matrix

- `ACC-039`: five Reports from one reporter do not restrict; five distinct unresolved reporters in
  the rolling 30-day window restrict once; dismissed/actioned/closed and boundary-expired Reports do
  not count;
- `ACC-040`: 20 concurrent candidate fifth Reports create one threshold episode, one system
  restriction action, one Account transition/history, one safety Notification/delivery intent, no
  automatic ban, and no duplicate reporter contribution;
- `ACC-041`: every admin mutation permission combination is tested; success, domain rejection,
  missing permission, stale target, injected failure, replay, and worker crash produce the required
  business state and exactly one immutable attempt result;
- self-report, forged/expired/cross-user evidence, over-limit report, changed replay, post-Unmatch
  exact deadline, and deleted evidence fail without partial Report/snapshot/threshold state;
- snapshot encryption/hash tamper, missing key version, M6 capture failure, photo retention failure,
  and transaction rollback never expose or lose required evidence;
- report dismissal racing fifth submission yields one serializable threshold/review outcome;
- internal block racing Match/chat/send closes safely and removal restores no old product state;
- support third-unanswered-message races admit none beyond two, and one ban event admits one appeal
  across concurrent distinct commands;
- migration bootstrap/upgrade/replay, immutable guards, RBAC seeds, localization completeness,
  retention registry, backup/restore, reconciliation faults, and production-volume report/review
  query plans pass.

Tests assert committed PostgreSQL facts, not only DTOs. Concurrency uses independent connections and
barriers. Fake clocks/keys/providers are deterministic. Real Telegram/admin behavior is claimed only
in staging.

## 12. Delivery checkpoints

1. execution guide, M7 contracts, and pure report/text/threshold/RBAC/support/appeal policies;
2. Report reason/schema, durable user limit, replay, evidence authorization, encrypted snapshots,
   M6 message-snapshot FK, and retention registry;
3. distinct-reporter threshold transaction, restriction episode, Account/safety
   Notification/audit integration, and `ACC-039..040` races;
4. AdminUser/RBAC seeds, signed admin identity, permission matrix, savepoint attempt logging, and
   evidence-access audit;
5. review workflow plus Account/photo moderation actions and their lifecycle coordinator effects;
6. internal block creation/removal and Match/chat/interaction closure races;
7. support and appeal persistence, limits, review commands, and concurrency evidence;
8. Telegram/API presentation, complete localization, privacy/adversarial tests, and static prose
   gate;
9. reconciliation, production query-plan/load gates, finite metrics, alarms, runbook, and acceptance
   ledger;
10. real Telegram moderation/admin/support/appeal staging evidence.

After every checkpoint run formatting, lint, type checking, unit tests, build, migration
bootstrap/upgrade/replay, relevant integration/fault tests, and GitHub CI. Push one locally green
checkpoint and wait for that exact commit to turn green before advancing.

## 13. Definition of done

### Current implementation evidence (2026-10-04)

Support and exact-ban appeal persistence, audited terminal reviews, and a separate permission-checked
unban command are implemented. The presentation work includes seeded English fallback keys and
privacy-safe notices; appeal review/unban confirmation tokens bind the authenticated admin, exact
command, target version, reason, and payload. Confirmation does not replace the transaction's RBAC
check or immutable attempted-command log.

The Telegram webhook now supports `/support [text]` and `/appeal [text]` behind
`NAKH_TELEGRAM_SUPPORT_APPEAL_ENABLED=false`. Enable it only for controlled staging with the bot token
and canonical 32-byte action-token key configured. Provider authentication precedes handling;
private-chat sender identity is resolved server-side. A stable bot/user/update command ID preserves
transactional replay across webhook retries. Restricted text is passed directly to its owning store,
never queued or interpolated in notices. Status lookup selects only the current exact ban's appeal
status. Banned support users receive an appeal prompt, and accepted appeals still require a separate
authorized unban.

Unit evidence covers routing, forged/group/bot updates, unsafe identifiers, rate denial, stable replay
identity, privacy, activation, and delivery failure. PostgreSQL integration evidence covers exact-ban
status projection and transactional submissions alongside the existing concurrency and migration
matrix. Replies use localized plain text after business commit; provider retries can duplicate a
notice but cannot duplicate the business write. No real Telegram delivery is claimed.

Support administration, account/photo actions, internal blocks, review assignment, and terminal
review decisions now have explicit confirmation boundaries. Current PostgreSQL permissions remain
authoritative. Photo delivery revocation failures are sanitized and recorded as failed attempts.
Review decisions use the target threshold lock, preserve assignee/version checks, and atomically
write matching Report/Review statuses, audit, and a content-free event. Dismissal writes its own
append-only ModerationAction under migration `000055`; actioned outcomes require a pre-existing
admin action linked to that Report and never execute another account/photo/pair action. Account and
photo confirmations now retain an opaque source Report context. Commit-time checks require the
matching target, unresolved Report and current assigned reviewer. Migration `000056` also enforces
linked action scope and deferred successful admin-attempt evidence. Finalizing a review never repeats
the underlying account/photo action.

Optional report review notes are normalized and encrypted before the transaction with a fresh
AES-GCM nonce and review/key-version associated data. The write capability exposes no reveal path.
Evidence covers ciphertext substitution/tampering, Unicode limits, concurrent retries, competing
confirmed decisions, changed replay, disabled admins, encryption failure, and partial-write rollback.
Migration evidence covers bootstrap, upgrades from `000045` and `000051`, and unchanged replay.

The provider-neutral report metadata handler authenticates queue-scoped admin actions, rechecks
current PostgreSQL permissions, and returns at most 50 metadata items. The default status is
`pending_review`; pages order threshold priority first, then submission time and report ID. Opaque
five-minute cursors bind admin/actor/status and preserve PostgreSQL microseconds. Lists include only
the contract's report ID, reason code, evidence types, status, priority, submission time, prior report
count and version. They expose neither reporter/target identity nor restricted content. Tests cover
pagination ties, forged/cross-scope/expired cursors, bounded reads, and disabled-admin access.

Profile-only report preparation and submission now support authoritative received-Like, received-Nakh
and successfully delivered discovery-card relationships, plus active matches. Match sources resolve
only the opposite stored participant and must remain active at submission; closed/unmatched handling
remains a separate pending flow. Reserved/failed deliveries and other viewers
cannot establish report evidence. Five-minute signed opaque references bind the reporter and retain source,
target and evidence IDs server-side. Preparation and commit recheck current account eligibility;
active and restricted users may report valid evidence, while guest/incomplete/banned/deleted routes
cannot submit a new report. Visibility is not used to retract an existing evidence relationship.
Other evidence selections fail explicitly. Nakh text is neither selected nor copied into evidence.

Submission locks reporter admission and target threshold state, reauthorizes the source, and captures
the locked Profile in the same transaction as the Report, typed evidence, pending review and safe
outbox event. AES-GCM snapshots bind report/evidence IDs, schema/type, key identity/version and content
hash; the write capability exposes no decryption method. The daily ten-report limit admits committed
reports only. Durable command/idempotency replay precedes expiring token resolution, returns the
original submission receipt and rejects changed data. Threshold evaluation captures one post-lock
database instant with microsecond precision, so transactions that started earlier count later commits.

Unit evidence covers token actor/purpose/expiry, typed encryption/tampering and authenticated replay.
PostgreSQL evidence covers real received-Nakh creation through the existing funded flow, unauthorized
sources, post-preparation bans, simultaneous duplicate submissions, ten-of-twelve admission, five
distinct reporters producing one restriction, older transaction start ordering, snapshot failure
rollback and content-free report events. Schema bootstrap/upgrade/replay evidence remains part of CI.
Report adapters remain disabled in ordinary startup; no real report delivery is claimed.

An internal profile reveal store now checks current permissions and decrypts the captured snapshot
inside the admin command transaction. A required actor-bound evidence access audit commits with the
sanitized admin outcome before plaintext can be returned. Missing keys, invalid snapshots and denied
permissions release no content; audit failures abort the whole attempt. Concurrent retries return
one content result and one audit. Replays never decrypt or reload content. Keys must be preloaded;
the transaction performs bounded local cryptography only. The confirmed reveal service binds actor,
command, opaque evidence target, selected evidence ID and normalized reason. Evidence uses immutable
version 1; client IDs cannot override opaque targets. Commit-time permission checks reject revoked
roles even after confirmation. Transport integration remains outstanding.

Selected-report evidence metadata is bounded to five entries and scoped by a current report-version
action token. It returns only report/evidence IDs, evidence types and snapshot schema versions;
queries do not select content, ciphertext, key metadata or user identities. Stale report menus,
cross-actor requests and disabled admins cannot use this read path.
The evidence selection service issues actor-bound opaque reveal actions only for supported profile
schema 1 snapshots. It reloads verified admin identity and current permission when issuing each
action; token storage runs outside SQL transactions. Integration evidence connects the report menu,
metadata selection, opaque action, exact confirmation, historical snapshot and committed access audit.

The authenticated report-reason catalog returns at most 50 active codes and localization keys in
configured display order, without database IDs. Current account eligibility is checked under a shared
lock; active and restricted users can read it, while banned or missing accounts cannot. Submission
still rechecks reason activation independently, so a cached menu never authorizes a disabled reason.

The internal chat snapshot codec now encrypts only the session ID and lifecycle state, with strict
schema/lifecycle validation, fresh nonces and report/evidence/type/key/hash binding. Its reader rejects
message text, participant identities, extra fields, unsupported envelopes and tampering. Chat-only preparation resolves a signed
match context through current account eligibility, active Match/ChatSession state and stored chat
participation. Either participant can receive a typed opaque intent for the opposite participant;
outsiders, unrelated sources, mixed evidence selections and closed contexts are rejected.
Chat submission now uses the shared report transaction for durable replay, rolling admission,
encrypted capture, review/outbox creation and distinct-reporter threshold evaluation. The locked
session must still be active and belong to the same exact prepared relationship. Existing profile
entry points retain their original replay digest namespace. Integration evidence covers simultaneous
retries, token loss, changed replay, closed-session denial, snapshot rollback, ten-of-twelve admission
and five distinct chat reporters causing one restriction. Confirmed chat reveal now shares the
current-permission admin transaction and required access audit. A trusted reader registry limits
supported evidence types; chat content must match the immutable evidence session reference.
Concurrent confirmed retries release one captured result, even after the live session closes, and
never decrypt on replay. Invalid references fail with a sanitized outcome and rejected access audit.

Post-unmatch preparation now accepts a separate actor-bound opaque context for either stored
participant. It checks the immutable M6 deadline with PostgreSQL precision, including a fresh
clock check after source locks. Integration evidence covers real Unmatch, outsiders, expired
windows and lock waits crossing expiry. The internal unmatch snapshot codec encrypts only the
unmatch time and exact 24-hour deadline. Strict validation rejects extra identity/reason fields,
invalid dates and altered intervals; typed authenticated encryption rejects substitution and
tampering without leaking key-provider diagnostics. Post-unmatch submission now uses the shared
atomic admission, capture, review, outbox and threshold transaction. Migration `000058` checks the
post-lock database clock again at evidence insertion, rejecting expiry during later lock waits.
Tests cover duplicate races, ten-report admission, five-reporter restriction, encryption rollback,
expiry after capture and durable replay after the window closes. Bootstrap, upgrades through
`000057` and unchanged replay cover the new guard. Confirmed audited unmatch reveal now verifies
the captured dates against the immutable source record, remains available after the reporting
window closes, and releases content only after its access audit commits. Integration evidence
covers opaque selection, concurrent confirmed retries, corrupted reference dates and permission
revocation after confirmation. No decrypted content is returned on rejected or replayed attempts.

A provider-neutral service factory now composes profile, chat and post-unmatch preparation,
submission, evidence actions and confirmed reveal from one trusted capability configuration.
Disabled types cannot prepare or submit new reports and receive no reveal action. Each request
still selects exactly one evidence type. Integration evidence covers all three complete internal
flows, legacy profile receipts, token-loss replay and one shared ten-report limit under mixed-type
concurrency. Transport authentication and presentation remain separate pending work.

The internal photo snapshot codec now encrypts only a restricted opaque evidence-object reference,
the reviewed content digest and the captured primary flag. It rejects raw storage keys, URLs, image
bytes, identities and extra fields. Typed authenticated encryption binds the report/evidence/key
identity and rejects substitution, malformed content and tampering with sanitized failures. Photo
preparation now binds the selected photo to the existing authoritative product relationship and
target ownership. Active validated media with an available thumbnail is required. Integration
evidence covers substituted photos, outsiders, absent selections and unavailable media.
Migration `000059` adds immutable media-owned holds for the exact served thumbnail and digest.
The internal retention port uses only the caller's database transaction; deferred binding requires
the matching photo evidence and governing target before commit. Bootstrap, upgrade and rollback
evidence cover this schema. Migration `000060` guards retained assets and thumbnail variants against
physical purge and new cleanup claims. Existing media cleanup skips held assets while own-photo
soft deletion still succeeds; integration evidence verifies no object deletion for retained evidence,
rejected bypass attempts and unchanged ordinary cleanup. Photo submission now reauthorizes the locked selected photo and commits the hold, encrypted
snapshot, Report, review, outbox and threshold effects in one shared transaction. Migration `000061`
requires every new photo evidence row to have both retained media and encrypted capture at commit.
Concurrent replay, token loss, changed payloads, unavailable sources, admission limits, threshold
restriction and encryption rollback have integration coverage. Confirmed photo reveal now rechecks current admin permission and verifies the captured opaque
reference, digest and primary flag against its immutable media hold. Hidden source photos remain
reviewable; concurrent confirmed retries decrypt once and access audits must commit before any
content is returned. Mismatched references return no content and commit a rejected access audit.
The provider-neutral service factory now configures photo preparation, atomic submission,
evidence actions and confirmed reveal together with profile/chat/unmatch capabilities. Disabled
photo capability denies new intents and submissions and issues no reveal actions; durable receipts
remain replayable. Integration flows exercise all four types and their shared ten-report admission
under mixed-type concurrency. Object delivery and transport presentation remain pending.

Message preparation now uses a separate actor-bound opaque source for one exact live message.
Only stored Match/ChatSession participants may resolve it; preparation selects identity references
without reading content. Source locks follow Match, session and message order to agree with M6
lifecycle closure and cleanup. Tests cover either participant, outsiders, unrelated messages, mixed
evidence, purged sources and closed sessions with retained live evidence. M6 owns live retention;
message preparation does not reopen chat access or invent a separate expiry window.

Message submission now reauthorizes the exact participant-bound source and calls the extracted
M6 in-transaction capture port after writing its governing Report/evidence. M6 remains the sole
message-snapshot writer, preserving its content schema, digest, PostgreSQL timestamp precision,
request markers and newest-50 cleanup behavior. Report, snapshot, review, content-free outbox and
threshold effects commit atomically. The original M6 entry point delegates to the same port and
keeps its existing replay behavior, including legacy pending snapshot requests. Tests cover retry
races, failure after snapshot writes, durable replay after live purge/token loss, report-versus-cleanup
races, ten-report admission and one restriction for five distinct message reporters.
Message review now verifies the existing M6 digest and exact report/message binding before
projecting content without sender identity. Confirmed reveal uses the shared current-permission,
immutable admin-attempt and required evidence-access audit transaction; concurrent identical
commands release content once, and recorded replay never reloads plaintext. Metadata selects only
evidence IDs, types and schema versions, including retained M6 snapshots after live cleanup.
The shared capability factory now governs preparation, capture, metadata actions and readers for
all five evidence types. Integration tests cover enabled/disabled capabilities, durable replay after
token loss or capability removal, and one concurrent ten-report limit across mixed evidence types.
The provider-neutral API now implements authenticated reason lookup, evidence preparation and
report submission. A trusted host must explicitly supply an audience-verifying authenticator and
preloaded evidence capabilities; ordinary startup registers no report routes. Strict contracts bind
the request actor to verified identity and preserve command/idempotency IDs. Responses are validated,
never cached, and errors discard restricted text/details. HTTP-to-PostgreSQL tests cover concurrent
retries, token-loss replay, changed replay, durable admission, all five evidence types, M6 capture
and photo holds. A single host composition uses the shared capability factory for these endpoints.
Concrete web/admin session infrastructure, actual report delivery and object delivery remain staging work.

Authenticated admin report metadata, evidence selection, confirmation and reveal now have strict,
non-cacheable HTTP boundaries. One host configuration governs all five evidence capabilities across
user preparation/submission and admin selection/reveal. Authenticated early execution failures use
an immutable failure-only journal; matching retries recover receipts without effects. Public admin
receipts use finite codes and discard internal values. Only the process committing a fresh successful
reveal can return content, after both admin-attempt and access audits commit. PostgreSQL HTTP tests
cover all five types, concurrent reveal retries, cross-admin token reuse and permission revocation
between preparation and execution. These use synthetic fixtures and an injected test authenticator,
not real admin MFA/session infrastructure or actual Telegram/object delivery.

The shared M7 HTTP host now composes reporting, audited account/photo/internal-block actions,
review claims/assignments/decisions, user support and appeals, confirmed support reply/close,
appeal review and separate permission-checked unban. User support and appeal receipts omit raw
thread/appeal identities; opaque references remain actor-bound. Photo mutation routes are absent
without an explicitly supplied delivery revoker. Review notes require a preloaded protector.
HTTP-to-PostgreSQL evidence covers retry races, limits, exact-ban admission, role revocation and
acceptance without automatic unban. All five report/reveal flows run through the same host.
This remains explicit host registration with an injected verifier, not real session/MFA or delivery.

Support metadata can now prepare a separate confirmed content read for the selected current thread,
including retained closed threads. The read returns at most the newest 50 messages, without sender
identities, only after the admin attempt and immutable support access audit commit. Concurrent retries
return content once; later permission revocation produces a content-free rejected access audit.
Integration evidence includes bounded history and complete rollback on required-audit failure.

Appeal content now has a separate `review_appeals` capability and confirmed audited read. It can
inspect retained terminal/historical text and decision notes without granting a review or unban
command; those commands still require the exact current ban and their own permissions. Only fresh
successful reads return content, after the exact admin-attempt/access-audit commit; retries, stale
versions and revoked permissions return no text or raw user/ban/workforce identity.

Moderation reconciliation now resumes one shared run and commits bounded Report/evidence keyset
scans, cursor progress, counters and deduplicated quarantined findings atomically. It checks missing
evidence, capture shape/binding and retained photo bytes without fetching text, snapshot payloads or
keys. It does not cryptographically verify encrypted hashes; that remains the audited reader's job.
The additional historical and safety phases, scheduler cadence and aggregate liveness sampling are
implemented below; cryptographic integrity verification still belongs to the audited readers.

Review/action/episode reconciliation now checks report-state agreement, terminal decision evidence,
exact successful command and platform audit links, historical Account transitions, durable notices,
source ownership and one system restriction action per episode. Later Account changes or terminal
review states do not invalidate earlier effects; rolling reporter totals are not incorrectly
recomputed as historical episode totals. Findings remain quarantined with no automatic mutation.

Safety reconciliation now checks the shared unanswered support limit and recorded admin replies/
closures, exact appeal-ban ownership and review/unban evidence, active workforce identity, required
access audits and successful action records. Blocked-pair scans use a composite keyset cursor and
detect active Match/chat/Like/unlock state without copying either user's identity into findings.
The admin command transaction now locks and rechecks the matching verified Telegram identity as
well as current permissions, so a previously prepared token cannot authorize execution after that
identity binding disappears. Historical roles and terminal appeals remain valid retained history.

Checkpoint 8 remains partial. Telegram reporting and admin evidence now have explicit gateway
ports after webhook authentication. All five source buttons carry only opaque native source tokens;
reporter identity is resolved server-side. A user-bound first-write-wins selection receipt supports
stable callback retries and `/report <reference> <reason> [text]` submission. Its 24-hour cache does
not extend the native intent grant; the native store owns replay, current source authorization,
limits and capture. Notices omit Report prose and raw Report IDs.

Admin evidence callbacks resolve an actor-bound already-confirmed command through a server-owned
port. A current Telegram-bound admin session and unexpired MFA are required before execution and
checked again before delivery. Only fresh successful native reads can deliver content after both
required audits commit. Replayed/rejected outcomes remain content-free, even if an incorrect port
supplies a value. Text preserves Unicode boundaries, uses bounded plain chunks and requires link
previews disabled; message/chat/evidence identities are excluded from the projection. Retained
photos require an explicit authorized object-delivery port and never render object references as
text. If delivery fails after the audit commit, retry does not re-expose content; use a fresh explicit
confirmed read. These are injected interfaces and synthetic adapter tests, not a concrete MFA/session
service, command-selection UI, real Telegram/object delivery, or deployment evidence. Ordinary startup
does not automatically enable either port. Remaining account/review/support/appeal admin presentation
and concrete session/delivery composition are still pending.

Confirmed support-thread and appeal reads now have an explicit Telegram gateway port. Actor-bound
short callbacks resolve only already-confirmed native reads, never review or unban mutations.
Current Telegram-bound admin session/MFA is checked before execution and before every outgoing
plain-text chunk. Only fresh successful audited reads deliver restricted content; replayed,
rejected and failed receipts remain content-free even if a faulty port returns a value. Support
history retains its 50-message ceiling; appeal text and retained notes omit user/ban identities.
Session revocation during delivery stops remaining chunks, and provider failures are sanitized.
Synthetic adapter tests cover these boundaries. Concrete confirmation menus, session/MFA service
and real deployed delivery remain outstanding; ordinary startup does not enable this port.

The concrete admin text sender uses the fixed Telegram Bot API `sendMessage` method with plain
text, `link_preview_options.is_disabled` and `protect_content`, as defined by the
[Bot API](https://core.telegram.org/bots/api#sendmessage). It sends each bounded chunk once,
uses a request deadline and bounds/cancels the provider response stream. Malformed, rejected,
oversized and ambiguous responses expose only the finite internal-error notice, never provider
diagnostics or token-bearing URLs. Synthetic HTTP tests verify the wire contract; this is not
evidence of real Telegram delivery, and retained-photo delivery remains a separate capability.

Support/appeal confirmation references now have a concrete encrypted Redis vault. Only the two
native read command shapes can be stored; each requires an actor-bound action and confirmation.
Separate keys protect AES-GCM command state and opaque HMAC callback references. Actor/reference/
purpose binding prevents substitution. Concurrent allocations retain the first command for five
minutes, changed payloads reject, cache loss fails closed and reads enforce expiry independently
of cache TTL. Native permission, confirmation expiry, auditing and replay remain authoritative.
Restricted reasons, identities and native tokens never appear in plaintext cache values or callback
data. The vault is not a session/MFA service, mutation capability or evidence of a deployed menu.

Owned support/appeal confirmation references can be withdrawn through private `m7c:` callbacks.
Cancellation checks the current verified admin session and cryptographic ownership, writes only a
five-minute content-free cache marker and invokes neither native reader nor mutation. Duplicate
cancellation keeps the first marker. Read delivery re-resolves the exact stored command before
each outgoing chunk, so cancellation/cache loss during a database wait or between sends stops
remaining content. Already-sent messages and committed access audits are not undone. This closes
pending UI state without replacing the native permission/audit boundary; a fresh read needs a new
explicit confirmation reference. Synthetic tests cover withdrawal, expiry and delivery races.

Pending support/appeal reads now have a concrete localized confirmation menu presenter and a
protected Bot API inline-keyboard sender. In the selected-target UI context, the menu presents the
operator's own normalized reason and Confirm/Cancel buttons containing only the opaque vault
reference. It fetches no support/appeal text and executes no native read. Session/MFA and the exact
pending command are checked again before delivery. Both buttons must reference the same pending
read; the sender disallows arbitrary callback actions. Synthetic wire tests cover both read kinds,
revocation, withdrawal/cache loss and callback substitution. Target selection and native draft
preparation still need gateway composition; real Telegram menu/session acceptance remains pending.

An explicit gateway composition now shares native PostgreSQL support/appeal preparation and read
handlers, one encrypted vault, menu presenter, protected sender and read/cancel adapter. Selected
targets and stable command/operation IDs are supplied by the trusted UI boundary. Every preparation
rechecks native permission. Concurrent preparations may issue different valid confirmation tokens;
the vault retains the first for the same exact draft, rejects other payload changes and never
extends its expiry or replaces withdrawn state. Menus fetch no user prose. PostgreSQL composition
evidence connects repeated preparation and callback races to one fresh content delivery and one
required access/admin audit, with permission-revoked preparation denied. Selected-target ingress,
concrete session/MFA and real provider staging evidence remain pending; ordinary startup is disabled.

The explicit read composition also accepts a trusted metadata target selection. It invokes the
native queue-authorized support/appeal reveal-action preparation, then the existing confirmed-read
preparation. The host supplies a stable operation identity and authenticated provider timestamp;
the service derives actor-bound command IDs and accepts no caller-selected actor or permission.
Concurrent native target preparations retain the first opaque action in a five-minute content-free
receipt. Keyed bindings reject changed target, version, reason, timestamp or queue authority without
overwriting that receipt. Cached selection never bypasses native permission/version checks or
extends expiry. No read or mutation executes until the existing confirmation callback. Target queue
presentation, reason-entry ingress and concrete sessions remain pending acceptance work.

The explicit Telegram read ingress now handles `/admin_support` and `/admin_appeals` with their
native status filters, ten metadata rows per page and opaque next-page/target buttons. Encrypted
five-minute UI state binds each selection to its admin and purpose; callbacks expose no target,
queue action or cursor. Native permissions and exact versions are checked before a protected reason
prompt. Only a reply to that admin's exact bot prompt can prepare the read; actor, operation identity
and timestamp come from the authenticated private update. Confirmation and cancellation still use
the existing encrypted read vault. Browsing, choosing and entering a reason disclose no user prose.
Migration 64 seeds twelve English fallback labels with empty variables and bootstrap/upgrade/replay
verification. Deploy it before enabling the injected ingress. Concrete session/MFA, real Telegram
acceptance and the separate mutation/support-reply/appeal-review/unban UI remain pending.

The composed read ingress now acknowledges expected invalid, unauthorized, stale and rate-limited
UI requests. Fixed localized rejection feedback is sent only to a current Telegram-bound private
admin session with valid MFA, rechecked against the original actor before delivery. Invalid or
expired sessions receive no message. No reason, target, token or exception is interpolated. Native
handlers run before notice deduplication; a content-free 30-second claim serializes notice sends
and a 24-hour successful-delivery receipt suppresses repeats. Pending/ambiguous delivery and cache
failures remain sanitized failures, rather than false successful acknowledgements; retry after the
claim expires can repeat only fixed rejection prose. Native confirmation, attempts, access audits
and fresh-only content delivery remain authoritative. Real provider/session acceptance is pending.

The scheduler executes at most 100 metadata rows per moderation batch, continues incomplete runs on
subsequent ticks, waits 15 minutes after completion, and retries failure after one minute. PostgreSQL
owns durable restart recovery, batch serialization and finding deduplication. Only fixed phase/outcome
and aggregate counts leave the scheduler boundary; raw database errors and run/entity identifiers are
discarded. Redis provides best-effort leadership; database guards remain authoritative if its lease
expires mid-batch. Ten integrity phases are implemented without automatic domain mutation.

M7 aggregate queue/scan ages and finite-phase metrics have dashboard/runbook contracts and staging
alarms. Historical quarantines are not mislabeled as current integrity counts. The broader operational
health API contract still needs a current integrity-count sampler. Broader production-shaped scanner
plans, ingress/action telemetry, real exporter/alert routing, session/MFA and Telegram/object delivery
acceptance remain pending. M7 is still implementation in progress, not declared code-complete or live.

Migration 63 adds aggregate-age indexes and all-status support ownership/sender-time indexes.
The M7 CI plan gate runs eight reads against 20,000 synthetic rows per table (six tables), using
the same support/appeal queue and unanswered-count statements as production. Fixture writes stay
in an isolated trigger-bypass transaction and roll back; no synthetic captures become retained
production history. Exported plans contain only execution time, actual row count and index names,
never predicates or bound values. The 1,500 ms gate is a CI envelope, not a staging latency claim.
The load smoke sends 20 concurrent support opens for each of five users, requires exactly two
accepted writes per user, and verifies 20 concurrent replays create no duplicate messages.
Report threshold/admission, appeal uniqueness and separate unban races remain covered by the
existing native/HTTP PostgreSQL integration suites. The six-job workflow retains aggregate M7
performance evidence; actual staging traffic and broader production-shaped reconciliation plans
remain acceptance work.

M7 is code-complete only when `ACC-039..041`, authorization/privacy/snapshot tests, threshold/admin/
internal-block/support/appeal races, reconciliation, retention, production-shaped plans, operations
docs, and CI are green. It is production-ready only after the same immutable release passes real
Telegram evidence reveal, admin permission/failure logging, fifth-report restriction, photo action,
internal-block, support/appeal, rollback, alert, and privacy drills with named backend, product,
operations, moderation, and security sign-off. Without infrastructure it may be called **code
complete / staging blocked**, never live.

### Confirmed support mutation UI evidence

The explicit authenticated Telegram admin ingress now composes native support replies and closure
from the metadata picker. Selecting an open thread offers Read, Reply and Close; closed threads offer
Read. Reply entry binds the first-line review reason and remaining support text to the exact owned
private prompt. Normalized drafts use encrypted actor-bound five-minute UI state with separate
confirmation callbacks; full 2000-scalar replies are previewed in protected bounded chunks.
Native queue selection, confirmed-command authorization, current permission/version checks and
transactional attempted-command audit remain authoritative. Concurrent preparations retain one
exact draft; native execution retries use the same command, yielding one effect and one audit.
A first-write-wins UI Confirm/Cancel decision prevents cancellation from reversing a confirmation.
No historical user content is fetched by this mutation flow. Draft reasons/replies never enter
plain Redis values, callback handles, admin log metadata or operational telemetry.
Migration 65 adds seven English fallback labels; apply and verify it before enabling this ingress.
Unit evidence covers encrypted state, cross-actor/tampered/expired handles, mixed decision races,
payload substitution, full emoji limits and session/cache loss during preview. PostgreSQL ingress
evidence exercises actual picker/prompt/confirmation replies, closure, cancellation and permission
revocation under concurrent confirmation retries. This is implementation evidence; concrete admin
session/MFA composition and real Telegram/provider staging acceptance remain open gates.

### Confirmed appeal review UI evidence

The explicit private admin queue now offers Read, Accept and Reject for submitted/in-review
appeals; terminal appeals retain only Read at this stage. The selected decision and exact target
are bound to the owned bot prompt. Its first line is the bounded review reason, with an optional
private note on remaining lines. Native review access checks current permission, appeal version
and exact current ban before preparation. An encrypted actor/purpose-bound five-minute draft
binds every header, selected-target binding, decision and normalized note to native confirmation.
Protected preview handles the full 2000-scalar note limit; current session/MFA and pending state
are rechecked before each send. Confirm and Cancel have distinct review callbacks and a single
first-write-wins UI decision. Support storage reuses the common validated encryption mechanism
with its own namespace and strict native-command allowlist. Review storage cannot accept unban.
Native PostgreSQL execution and immutable audit remain authoritative for permission, exact ban,
version, idempotency and concurrency. Acceptance/rejection never calls unban and never changes
Account state/history. A separate permission-checked unban UI remains the next implementation.
Migration 66 adds seven English fallback labels and requires bootstrap, upgrade and replay
verification before ingress activation. Unit and PostgreSQL ingress evidence covers payload and
decision substitution, purpose isolation, expiry/cache/session loss, bounded Unicode preview,
concurrent confirmations, cancelled/revoked attempts, and a new ban after draft preparation.
This remains implementation evidence; concrete MFA/session and live provider acceptance are open.

### Separately confirmed accepted-appeal unban UI evidence

Accepted appeals now offer Restore access only after native preparation checks current
`unban_user` permission, the exact accepted appeal and its current ban. A separate owned reason
prompt and protected Confirm/Cancel menu bind a native `moderation.unban-appeal` command.
The encrypted five-minute unban draft has its own actor/purpose namespace and callback pair;
support/review drafts cannot substitute for it. Both appeal and account versions come from native
preparation and are bound to confirmation, including concurrent preparation retries.
Acceptance alone still leaves Account banned. Confirmation uses the owning native account command
and its transactional audit, immutable unban proof, state history, moderation action, notification
and outbox. Cancel cannot undo Confirm, and native idempotency owns repeated confirmations.
Migration 67 adds four English fallback labels; apply and verify before ingress activation.
Unit evidence covers version/payload substitution, purpose isolation, encrypted expiry, permission
availability, session/cache loss and decision races. PostgreSQL ingress evidence covers accepted,
rejected and pending appeals, review-only operators, cancellation, permission revocation, stale
account versions and a later ban, plus one effect/audit/notification under concurrent retries.
Concrete admin session/MFA composition and real Telegram/provider staging acceptance remain open.

### Queue-selected report review preparation evidence

Report queue selection now has a native preparation port that resolves a selected Report and its
expected version to the governing ModerationReview and current review version. Own-assignment uses
the verified current admin identity; the selection contract accepts no review or assignee identity.
The existing review preparation still checks queue authority, terminal state, assigned reviewer,
decision-specific permission and a prior moderation action before actioned closure. Preparation
neither assigns nor reveals evidence. Separate native confirmation binds the derived review target,
version, reason and assignee/decision before execution; idempotency and immutable attempt logging
remain authoritative under concurrent retries, permission revocation or competing assignment.
Strict contracts reject extra identities/content.
The authenticated `POST /v1/admin/moderation/reports/review-selection` route composes this native
port, denies mismatched actors and client authority fields, disables caching and validates the
result before exposing it. The route is absent when its trusted capability is not configured.
Unit evidence covers forged direct inputs, actor/root mismatch, stale report and mid-preparation
review change. PostgreSQL evidence starts from
the actual metadata queue and proves one confirmed assignment and one confirmed dismissal audit,
plus rejection after revocation, reassignment or confirmation-payload substitution. Test fixtures
run in an isolated migrated database. The concrete report queue/review Telegram UI is the next
presentation step; this port provides no deployment or live operator acceptance evidence.

### Confirmed own-review assignment Telegram UI evidence

The explicit private admin ingress now handles `/admin_reports [status]` with native metadata-only
keyset pages of ten. Opaque encrypted five-minute report selections, cursor state and owned bot
prompts have a separate purpose from support/appeal queues. Selecting a report checks native
authority before asking for the assignment reason; it never changes ownership or reveals evidence.
The exact owned reply prepares a native `moderation.assign-review` command with server-derived
review/version and the current operator as assignee. Its encrypted assignment-only vault binds the
target, assignee, headers and normalized reason; support/review/unban drafts cannot substitute.
Protected Confirm/Cancel callbacks have one first-write winner. Current Telegram-bound session/MFA
is rechecked before outgoing messages and native execution; PostgreSQL owns permission/version
checks, one assignment effect and one immutable attempt audit under confirmation retries.
Migration 68 adds eight English fallback labels and status buttons; apply and verify before enabling
the injected ingress. Unit evidence covers queue pagination, prompt ownership, purpose isolation,
full reason limits, cancellation races, cache/session loss and strict protected delivery.
Actual PostgreSQL ingress evidence covers concurrent preparations/confirmations, cancellation,
revocation, competing assignment and terminal dismissal, with no evidence access, account change,
notification or identity disclosure. Decision/action UI, concrete session/MFA and provider staging
acceptance remain separate open work.

### Assigned report decision Telegram UI evidence

The private report picker offers Dismiss and Complete after moderation action only after native
preparation checks current permissions, assigned ownership and the prior action required for
completion. Each action binds an owned reason/optional note prompt to the exact selected report.
A separate report-decision encrypted five-minute vault binds the native review target/version,
normalized reason/note and stable provider operation headers. Protected Confirm/Cancel callbacks
have one first-write winner; native idempotency and attempted-command audit own retries.
The ingress activates these decisions only with an explicitly injected long-term ReviewNoteProtector.
Temporary UI encryption keys are never implicitly used for retained domain notes.
Migration 69 adds seven English fallback labels; apply and verify before activation.
Unit evidence covers note/payload substitution, purpose isolation, cancellation, concurrent
preparation/confirmation and session/cache loss. PostgreSQL ingress evidence covers dismissal,
completion after a separately confirmed native account action, cancellation and permission
revocation, with encrypted notes and no additional account/notification or evidence effects.
Account/photo action UI, concrete MFA/session composition and live operator/provider acceptance
remain open. Completion does not perform an account/photo action itself.

### Queue-selected report Account preparation evidence

A strict native preparation contract now accepts a metadata-root token, selected Report/version
and one of restrict/unrestrict/ban/unban. The governing review and its version come from the
server; native report Account preparation checks assigned ownership and the action permission,
resolves Account/version and binds the source report. A second report/review read rejects changes
during preparation. The result contains only an opaque action token and Account version.
The authenticated no-store `POST /v1/admin/moderation/reports/account-selection` route composes
this port in production and is absent without its trusted capability. Client account/review
identities, reason, prose and version authority are rejected by the strict contract.
Preparation performs no mutation, evidence read or attempted-command audit. Separate native
confirmation still binds the reason, action and Account version; owning-module execution locks
and rechecks current report state, assigned ownership, permission and Account version.
Unit evidence covers scoped/cross-actor roots, invalid selection, changed governing report/review
and strict ingress/result validation. PostgreSQL evidence covers all four separately confirmed
Account actions with one effect/audit/notification under retries, payload substitution and
revocation/reassignment/terminal review after preparation. HTTP integration exercises actual
selected Report preparation before a separately confirmed account action. Report Account Telegram
controls and concrete MFA/session/provider acceptance remain open; this native port grants no
UI or deployment authority by itself. No persistence shape changes are required.

### Separately confirmed report Account Telegram UI evidence

The private report picker now offers restrict, unrestrict, ban and unban according to current
native permission, assigned ownership and Account-state eligibility. Preparation and execution
share the same eligibility rule; restoration still requires immutable state-history resolution.
Account controls work independently of retained review-note capability. Selecting an action
checks native authority before an owned bounded-reason prompt; the exact prompt retains its
first selected action and cannot be rebound by another callback. Native selected-report preparation
derives the governing review and Account/version. A separate encrypted five-minute report-account
vault binds the action, target selection, version, reason and stable provider operation headers.
Protected Account-only Confirm/Cancel callbacks have one first-write winner. Native execution
rechecks permissions, report ownership/status, Account state/version and confirmation, with one
Account effect, immutable audit, state history, moderation action and notification under retries.
It never closes the review, reveals evidence or accepts an appeal; accepted-appeal restoration
continues to use its distinct exact-ban command. Migration 70 supplies six English fallback labels
and must pass bootstrap/upgrade/replay verification before ingress activation.
Unit evidence covers eligibility, action/payload/version substitution, purpose separation, owned
prompts, session/cache expiry, cancellation and protected transport. Actual PostgreSQL ingress
evidence covers all four actions, cancellation, revocation, reassignment, stale Account state and
closed review, with concurrent preparations/confirmations and no identity disclosure.
Concrete session/MFA composition, report photo/internal-block/evidence UI and real operator/provider
staging acceptance remain open.

### Separately confirmed report photo Telegram UI evidence

With an explicitly injected trusted PhotoDeliveryRevocation capability, the private evidence picker
offers only native-eligible hide/restore/delete actions for the exact selected reported photo.
Metadata browsing remains available without that capability, for other evidence types and when no
photo action is authorized. The UI accepts no client photo identity or version authority.
Each action checks native permission, assigned review ownership and live photo state before its
owned bounded-reason prompt. A separate photo-prompt cache purpose retains the first exact evidence
reference/action; assignment, decision and Account handlers cannot consume that reply.
Native selected-report preparation derives the photo target/version. A photo-only encrypted
five-minute mutation vault binds action, evidence selection, reason and stable operation headers.
Protected photo Confirm/Cancel callbacks have one first-write winner; native execution owns current
permission/report ownership, photo-version rejection, one immutable attempt audit and one effect.
Delivery revocation remains idempotent and required before hide/delete can commit. Logical photo
deletion preserves the Report evidence hold, encrypted snapshot and retained physical media.
No evidence content is opened, no Account is changed and the review is not closed by a photo action.
Migration 72 supplies six English fallback labels with baseline-71 upgrade, bootstrap, verification
and immutable replay checks. Unit evidence covers native action eligibility, purpose separation,
stable preparations, payload/version/reason substitution, cancellation, session/cache expiry,
owned prompt isolation and protected transport. Actual PostgreSQL ingress evidence covers all three
actions and concurrent confirmations plus cancellation, revoked permission, reassigned/closed
review and stale photo, with retained evidence and no restricted identities in provider messages.
Evidence content reveal, internal-block controls, concrete session/MFA and real provider/operator
staging acceptance remain open. Ordinary startup does not inject a no-op revocation provider.

### Queue-selected report evidence and photo preparation evidence

Strict selected-Report contracts now list bounded evidence metadata and prepare hide/restore/delete
photo actions using a metadata-root token and expected Report version. Metadata grants no content
reveal; photo preparation resolves the governing review/version and delegates evidence-to-photo
ownership and current permission checks to the native port. It accepts no client photo identity
or photo version. Photo preparation rechecks Report/review stability; metadata rechecks Report version/status and
remains available for submitted and terminal reports without requiring an assigned review.
Authenticated no-store `POST /v1/admin/moderation/reports/evidence-selection` and `photo-selection`
routes compose these ports in production and are absent without their trusted capabilities.
Photo preparation returns only the opaque action token and native photo version. No mutation or
evidence-access/attempted-command audit occurs before a separately confirmed native command.
Unit evidence covers actor/root/selection substitution, strict ingress/result contracts, changes
during preparation and cross-report metadata. PostgreSQL evidence starts with native metadata and
confirmed review assignment, denies borrowed evidence and proves one hide/restore/delete effect and
audit under retries, while preserving the evidence hold, encrypted snapshot and retained media.
Rejected confirmations are audited under separate command identities; revocation, reassignment
and terminal reviews after preparation produce no photo effect. HTTP integration retains legacy
route coverage and executes actual selected-Report photo actions with independent confirmation.
Photo/evidence Telegram controls, concrete session/MFA composition and provider/operator staging
acceptance remain open. No new persistence shape or migration is required.

### Shared photo-state preparation eligibility evidence

Report photo preparation now reads the live owning-module photo status and uses the same pure
eligibility policy as the M2 moderation lifecycle: hide requires visible, restore requires hidden,
and delete permits visible or hidden. Deleted and unknown states produce no prepared result.
Current action permission is checked before a state-specific eligibility rejection. Status stays
internal; preparation still returns only the opaque action token and photo version.
The owning lifecycle preserves its version checks, terminal deletion, primary-photo replacement
and profile-completion behavior. Previously prepared confirmations remain version-bound.
Unit evidence compares all nine valid-state/action combinations with actual lifecycle behavior
and denies unknown states and revoked authority. PostgreSQL evidence verifies fresh preparation
after each hide/restore/delete effect and one audited stale rejection under concurrent retries
after another separately confirmed command wins. Retained evidence remains intact and no evidence
content is revealed. This requires no schema migration; current migration 70 bootstrap, upgrade
and replay checks remain mandatory. Photo/evidence Telegram UI and provider staging remain open.

### Private report evidence metadata picker evidence

The private report menu now offers a bounded evidence metadata picker independently of review
assignment eligibility and retained-note capabilities. Submitted and terminal reports remain
browsable with current `view_reports` authority; evidence metadata does not require a review.
Each item has an encrypted five-minute actor/purpose-bound reference to its exact report selection,
evidence identity/type and snapshot schema version. Provider messages contain only localized type
labels and opaque references. Native metadata is rechecked on every selection, including retries;
current session/MFA and both cache records are checked again after native work waits.
No content reveal, mutation or evidence-access audit occurs. Trusted downstream preparation can
resolve a selection only through the same fresh native checks. Photo action and content reveal
commands still require their separate permissions, reasons and confirmations.
Migration 71 adds eleven English fallback labels, with baseline-70 upgrade, bootstrap, verification
and immutable replay evidence. Existing localization migrations and verifiers remain unchanged.
Unit evidence covers all five types, bounded/strict metadata, stable concurrent choices, actor and
purpose substitution, cache loss/expiry, stale metadata, revoked session/permission and protected
plain delivery. Actual PostgreSQL ingress evidence covers metadata-only operators, submitted and
dismissed reports, retries, borrowed actor, stale Report version and revoked permission, with no
account/photo effects, content access or identity disclosure and intact retained evidence.
Confirmed photo controls, evidence content reveal, concrete session/MFA and provider/operator
staging acceptance remain open.
