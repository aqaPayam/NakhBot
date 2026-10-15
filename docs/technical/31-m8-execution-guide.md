# M8 Execution Guide â€” Deletion, Retention and Production Hardening





## Current repair: cold source native execution within unchanged CI caps

Feature `2aa4ce1` passed `pnpm check` and both local three-case native runs, but
exact-head run `38733318635` did not pass. GitHub annotations confirm scheduler
and worker exceeded the unchanged 20-minute caps. API passed all 323 cases in
50 files. Scheduler printed 512 passed cases in 51 files and uploaded its receipt,
but the job was cancelled; worker completed 29 files before cancellation. Neither
an unfinished run nor an uploaded receipt overrides a failed job. Preserve all
three logs, timeout annotations, final metadata and four verified ZIPs (two source
receipts, both collector rehearsals). Full native/performance/recovery acceptance
remains unproven on this failed head. No unchanged rerun authorizes progress.

Logs show the native command rebuilt the entire host workspace after its Docker
image had already built the same workspace, spending 43-59 seconds before native
execution. Remove that duplicate build from `test:integration:ci`; keep the full
quality build, all four Docker builds and the reliability job's full build.
Every source is still compiled/tested; the six jobs and 20-minute caps are intact.
No native case, 1,245-case/153-file floor, receipt binding, 27 query plans,
20,000-scale/1,500 ms gate, collector, load or recovery check is removed.

Both Vitest configurations now share one complete code-owned alias map for every
workspace runtime export, including media-delivery edge/worker before the package
prefix. This also closes integration aliases that previously fell back to built
config/queue/media/testkit artifacts. A manifest-derived test checks every real
export's declared existing source and first-prefix resolution; new exports cannot
silently escape to dist. Native bootstrap's actual source imports resolve without
built artifacts; the diagnostic deliberately rejects an unsupported mode and is
not native acceptance.

A reversible cold proof hid all 17 workspace dist directories, checked bootstrap
imports, passed all three actual native TOTP/Return approval cases and all 20
resolver/shard/receipt tests, then restored every directory in a finally block.
No backup directory remained. Inspection found no direct dist imports in native
suite files. This validates cold startup and focused cases only; CI must execute
the entire inventory against actual PostgreSQL/Redis with zero skips.

Refresh scheduling weights from the 130 completed suite observations, retaining
the maximum old/measured duration for established suites and every unmeasured
estimate. Replace only the new provisional Return-approval estimate with its
actual passed 49,576 ms observation. Prior provenance stays intact; the new batch
is explicitly failed/incomplete and scheduling-only. Build/test workload and
production safety behavior remain unchanged. The refreshed conservative estimates
are 1,012,192 / 1,012,257 / 1,012,228 ms across three 51-file groups. Those are
scheduling evidence only, not a promise of runtime or completed native coverage.
The full `pnpm check` passed formatting, lint, all workspace types, 1,173 unit
cases across 242 files and every build. All six changed-head jobs, complete
1,245-case native coverage without skips, both actual collector rehearsals,
performance/load and backup/restore remain required before advancing.
M8 remains active; no M9.

## Historical increment: confirmed administrator Return approval in the protected host

Accepted `2420b89` passed all six exact-head jobs on attempt 1 of run
`38727587448`: 1,242 native cases in 152 files, zero skips, three matching source
receipts and all four ZIP digests verified. Both actual M7/M8 collector rehearsals,
support load and backup/restore passed. All 27 plans passed at 20,000 scale;
terminal snapshot 1,480.492 ms against 1,500 ms, zero workers/spill, both required
administrator indexes. The diagnosed failed feature run remains preserved.
Tracked lines were 244,265 across four wc totals. CloudWatch/SNS acceptance remains
external. No staging, actual provider drain, PITR/DR or security sign-off is inferred.

Review found the existing native Return approval workflow had no administrator
host ingress. Add strict administrator-only Root selection, opaque target action,
separate command confirmation and audited execution at `/v1/admin/account-returns`.
Selection requires the exact original Root/version, completed verified deletion,
no retained safety bar and current `approve_account_return` permission. It captures
actor/target/version before waits, rechecks Root and native authorization, and
returns only opaque action metadata. Preparation binds command identity, actor,
Root/version and reason digest through the existing confirmation boundary.

Execution uses the existing current-native-MFA/RBAC command transaction and
immutable approval audit. Malformed authenticated attempts must be journalled;
missing audit authority fails closed. Public results discard internal approval
identity/epoch and contain only the existing finite administrator receipt.
Approval alone keeps the account deleted and changes no original Root, manifest,
phase receipt or financial closure. Only the separate authenticated owner Return
command can start the new empty life; approval is never a product credential,
namespace activation or unban.

`accountReturnApprovalEnabled` defaults absent/OFF in both protected native-session
host factories. An explicit opt-in composes the same authenticator and opaque
stores with the new module. The ordinary host remains without these routes.
Authenticator-app TOTP remains the concrete operator path. No SQL migration,
permission seed, registry descriptor, persisted entity or UI prose changes.

Three native HTTP cases passed with actual TOTP enrollment/next-counter login,
twenty confirmation retries producing one approval, exact original proof
preservation, a separate actual owner Return, foreign references, raw-target
injection/rejection journalling, revoked MFA, stale/incomplete/safety-barred Roots
and revoked permissions. Native opaque stores are in-memory fixtures; no actual
Redis/provider/operator approval is inferred. All three native cases passed again
after the final handler snapshot/recheck changes. Fourteen focused unit cases
passed; initial focused types/lint found test-fixture literal typing, unsafe-output
construction and unused bindings, which were corrected without changing gates. The new native file's 150-second scheduling
estimate is provisional. Inventory becomes 1,245 native cases/153 files; every
older case and all gates/caps remain mandatory.

The complete `pnpm check` passed formatting, lint, all workspace types, 1,172
unit cases across 241 files and all builds. Both local native runs passed all
three new cases; the final run follows the snapshot/authority-order edits.
GitHub main was rechecked against the accepted starting SHA before commit.
All six exact-head CI jobs, 1,245 native cases with zero skips, all unchanged
performance/load/recovery gates and both actual collector rehearsals remain
required before advancing.
M8 remains active: controlled retained-data release, final original-requirements
entry review and load/failure/recovery/security acceptance remain open. No actual
retention periods have been approved; purging remains disabled. No M9.

## Historical repair: bounded public collector startup diagnostics

Feature `63f67d6` passed local project checks and 85 native cases, but exact-head
run `38724551143` failed the M7 collector rehearsal at `image-pull`, before
container startup or metric export. The preserved quality log reports exit 1,
stdout/stderr present and an unknown nonretryable startup failure. The original
Docker response was deliberately not logged, so its exact cause is unavailable;
no registry throttle or DNS failure is claimed as established fact. A later
anonymous public-registry probe returned token/manifest HTTP 200 for the same
v0.49.0 image, which confirms current metadata availability, not the failed pull.
The failed run and logs remain preserved; no unchanged rerun authorizes progress.

The shared M7/M8 startup helper now recognizes compact `TOOMANYREQUESTS`, explicit
rate-exceeded, DNS-resolution and connection-timeout variants. Only recognized
transient public-image failures retain the existing three attempts and 1/2-second
waits. Image-integrity failures and credential-helper errors are explicitly
nonretryable even when other text contains a server-error code. Authentication,
missing image, TLS verification, storage failures and unknown failures still stop.

Unknown startup diagnostics now include at most eight fixed lexical indicators
for reference resolution, anonymous-token acquisition, unexpected status, daemon
response, layer registration, media type, proxy and TLS-internal errors. No error
text, endpoint, credential, metric payload or user-derived value is returned.
Unknown failures still execute once; this closes an observability gap without
pretending to reconstruct the lost response. A fresh changed-head CI run must
complete both actual collector rehearsals, all native cases, performance gates,
recovery checks and all six jobs. Further startup failure must be diagnosed using
that run's finite evidence; no image/version/gate/job cap is changed.

The same failed run's worker shard independently exposed an omitted app-level
upgrade expectation: the schema-142 Telegram Return case expected migrations
143/144, while the actual upgrade correctly also applied 145. The initial update
covered persistence tests but missed this app test. Its exact expected list now
includes 145; all original Root, manifest and proof-preservation assertions remain.
The failed shard passed 336 other cases. No test is removed or weakened.

GitHub's API-job annotation confirms the unchanged 20-minute job cap cancelled
its incomplete native shard. Worker completed in 633,638 ms of suite time while
API had already spent 1,021,287 ms with files remaining; scheduler completed
956,441 ms. The failure is a dispatch imbalance, not authorization to extend
the cap or remove tests. Refresh scheduling weights from all 139 completed suite
lines in these three exact-run logs, stripping ANSI controls; retain the 13
unmeasured estimates and every prior provenance record. One measured suite failed
its upgrade expectation, and the overall source run is explicitly failed and
incomplete: elapsed measurements are scheduling evidence only. The native floor
remains 1,242 cases/152 files, with three disjoint complete receipts and zero skips
required on a subsequent accepted head. Both actual collector rehearsals and
all 27 unchanged 20,000-scale/1,500 ms plans remain mandatory.

All 48 focused startup cases passed, including private-marker rejection, bounded
known-transient retries, precedence and fail-closed unknown diagnostics. Docker
is unavailable locally, so no local pull/conversion success is claimed. Full
project check passed formatting, lint, all workspace types, 1,164 unit tests in
239 files and every build. An initial lint-only fixture rejection was corrected
to reject an Error before the successful full rerun. The corrected Telegram
upgrade case passed; four other cases were deliberately excluded by the focused
filter and remain mandatory in CI. All 67 focused startup/shard/receipt cases
passed after refreshing dispatch data. Estimates are now 875,701 / 875,653 /
875,686 ms across 50/51/51 files; those are scheduling estimates, not acceptance.
Final failed-run metadata, API timeout annotations and all diagnostic logs are
preserved, along with the successful shard-3 ZIP whose digest matches GitHub.
No later performance/recovery or full native acceptance is claimed for that run.
M8 stays active; all six changed-head CI successes remain required. No M9.

## Historical increment: original-deletion retention policy attestations

Accepted `5aa4116` passed all six exact-head jobs on attempt 1 of run
`38718515594`: 1,233 native cases in 151 files without skips and three matching
source receipts. All 27 plans passed at 20,000 scale; terminal snapshot 976.103 ms
against the unchanged 1,500 ms limit, zero workers/spill and both required indexes.
Support load, backup/restore, actual M7 and actual M8 collector checks passed.
All four downloaded artifact ZIP digests match GitHub. CloudWatch/SNS acceptance
remains external. Tracked lines: 243,099, summed across four wc totals.

Migration 145 adds no table, column, foreign key or retention descriptor. It adds
one super-administrator permission and immutable approval/revocation audits, with
native reciprocal command proof and original Root/manifest binding. Schema 144
Roots, phase receipts, financial closures and registry hashes must survive exactly.
All older explicit migration expectations and the baseline upgrade matrix advance.

The trusted workflow requires an explicit resource, integer period, completion-time
basis, approval-evidence digest and expected policy revision. There is no default
period or seeded approval. A fixed tuple digest binds every input to the command;
PostgreSQL recomputes it. Native ownership locks serialize competing reviews.
An active approval must be revoked before replacement; history is append-only.
Identical retries return the recorded outcome; changed payloads cannot borrow it.

Both audit and successful-command commits require reciprocal proof. Current native
MFA, verified administrator identity, active role and credential remain mandatory
through commit. Historical proof remains valid after session revocation. Policies
bind the original deletion and resource, including after a separately approved
Return, without updating that Root, its manifest or a later Account life. Only
valid policy audits are exempted as lifecycle facts in operational verification.

This increment records policy attestations only. Physical release remains disabled;
the manifest update/delete guard is unchanged. Exact original-row ownership,
dependency/proof preservation, current unrevoked policy and an independently
permission-checked executor remain prerequisites. No actual retention periods have
been approved. Synthetic one-second test periods are fixtures. Full M8 remains
active; ordinary/product-entry review, Return operator composition and final
load/failure/recovery/security acceptance remain open. No M9.

Validation covers original-Root preservation, twenty identical retries, twenty
competing reviews, revoke/replace/replay, denied MFA/roles/stale versions/reference
resources/foreign revocations, forged audits, missing mandatory audit rollback,
post-session historical validity, separately approved Return, schema-144 upgrade
and MFA expiry at deferred commit. Native inventory rises to 1,242 cases in 152
files; no older case is removed. The new suite's 240-second dispatch estimate is
provisional. Full project and all six exact-head CI jobs remain required.

Local validation passed all eight new native cases, including real native
completion/Return, deferred MFA expiry with an execution witness and schema-144
upgrade preservation. The complete migration matrix plus administrator schema
suite passed 77 cases across two files, for 85 distinct local native cases.
Three focused digest/boundary unit cases passed. The initial native setup failure
was an exact permission-count verifier that still expected the prior catalog;
that verifier and authorization assertions now require the added permission.
A synchronous-input rejection assertion was corrected. Focused persistence types
passed. The complete `pnpm check` then passed formatting, lint, all workspace
types, 1,152 unit tests in 239 files and all builds. All six exact-head CI jobs
remain required before advancing.

## Historical increment: native deletion health, worker telemetry and operations

Accepted `6cbf1a8` passed all six exact-head jobs on attempt 1 of run
`38701132953`: all 1,228 native cases in 150 files, no skips, including the new
actual Redis/Webhook activation and response-loss cases. All three source receipts
match the SHA/run/attempt. All 27 plans passed at 20,000 scale; the terminal
snapshot took 1,449.073 ms against 1,500 ms, zero workers/spill, both required
administrator indexes. Support load, backup/restore and actual M7 collector
privacy/freshness checks passed. All three downloaded ZIP digests match GitHub.
No external provider or CloudWatch/SNS acceptance is inferred.

The original M8 plan requires deletion dashboards, alerts and operations evidence.
Inspection found only bounded worker logs and M7-specific metrics. This increment
adds a native read-only health sample, worker observations, a dedicated strict
collector route, a gated Terraform dashboard/alarms and an operational runbook.
No schema, migration, retained-data descriptor, product authority or deletion
checkpoint is changed.

One native-clock/MVCC statement returns exactly eight finite phases with six
counts/ages each: durable records, current leases, persisted retry indications,
queue alignment inconsistencies, total pending age and overdue unleased work age.
A full Root/work join exposes either missing side. Active work must match the
original Root phase/checkpoint and current deleted Account/version/epoch. Completed
Roots check completion/work alignment while allowing a subsequent approved Return;
these observations do not replace native proof verification or authorize anything.
Only aggregate values and the sample time leave PostgreSQL.

The enabled worker observes bounded poll outcomes and samples health every 30
seconds. Reads do not overlap; shutdown drains the current read before database
and exporter close. A failed sample increments a finite failure counter without
refreshing the last timestamp. Exporter failure preserves a committed native
result. No raw exception, failure code, owner, Root, provider or key becomes a
metric label or new diagnostic field.

All 13 M8 instruments use only fixed phase/outcome labels, with a strict whole-
sample check before any fresh timestamp. The pinned ADOT M8 route strips resource
attributes and rejects unknown names, types, scopes/versions/attributes and label
shapes. Legacy export excludes M8 names, preventing rejected points from escaping
through a fallback. Existing M7 policy remains independent. The actual collector
rehearsal requires all instruments, eight drift/clear phases, stale/fresh samples,
first failure counter, private-marker rejection and preservation of M1/M7 output.
CI adds this step and its privacy-safe artifact inside the existing quality job;
there remain exactly six jobs and all existing gates/caps are unchanged.

Terraform monitoring defaults OFF until the enabled producer, actual CloudWatch
delivery and SNS routing are accepted externally. Queue age thresholds are bounded
operational settings, not retention periods or release approval. Missing samples
breach the freshness alarm only when monitoring is enabled. Dashboard gauges use
Maximum rather than summing replicated global samples. The runbook distinguishes
lease expiry, response loss, native resumption and observations from authorization;
retained-data release remains OFF pending approved periods.

Seven focused unit cases passed, including exporter/database outage and close/
nonoverlap behavior. Five native cases passed: empty sample/privacy, native lease
expiry/reclaim/retry, missing/orphan work under explicit corruption rollback,
actual completed deletion followed by separately approved Return, and 20,000
synthetic metadata rows across all eight phases with a 1,500 ms query budget,
three repeated samples and complete rollback. Metadata load does not claim mass
cleanup. Focused lint and worker/observability/persistence types passed. Initial
checks found a test-parenthesis typo, test helper types and stale built-package
test resolution; these were corrected. Unit/native test configurations now resolve
current observability source just like the other workspace adapters. The complete
native health suite passed again after the privileged corruption fixture was
expressed as explicit SQL. Staging Terraform validation passed with no warnings.
The new native file's 90-second dispatch estimate is provisional. Inventory rises
to 1,233 native cases in 151 files; no older case or workload is removed.

Full project and all six exact-head CI jobs, including the actual pinned collector
conversion, remain required. Docker is unavailable locally; no local collector
success is fabricated. Remaining ordinary/product-entry review, Return operator
composition, policy-controlled release OFF until actual period approval and final
M8 load/failure/recovery/security acceptance remain open. No M9.

The first full project run stopped at formatting of the new dashboard document;
that document was formatted and the complete project check rerun passed all
formatting, lint, workspace types, 1,149 unit cases in 238 files and builds.
Review also corrected the M7 preservation canary to require its initial event
while allowing later zero deltas; final focused collector lint/types and formatting
passed. Exporter-selector checks cover exactly 13 names/eight phases and reject
unknown names. Final Terraform formatting and staging validation passed with zero
warnings. These static checks do not substitute for the mandatory actual collector
rehearsal, all 1,233 native cases without skips and all six exact-head CI jobs.

## Historical increment: authenticated primary-entry confirmation and opaque activation

Accepted `e0206ae` passed all six exact-head jobs on attempt 1 of run
`38694780666`: all 1,222 native cases in 149 files, no skips, with all three
source receipts bound to the same SHA/run/attempt. All 27 plans passed at 20,000
scale. The terminal snapshot took 1,412.264 ms against the unchanged 1,500 ms
limit, with zero workers/spill and both required administrator indexes. Support
load, backup/restore and actual collector privacy/freshness checks passed. All
three artifact ZIP digests match GitHub metadata. The failed feature run remains
preserved; acceptance follows the diagnosed repair, never an unchanged rerun.

The authenticated webhook now offers returned nonzero-life owners a separate
private `/start` confirmation before generic first-start handling. An old or
unprocessed primary text can only prepare a challenge; it never activates the
namespace. Initial registration and deleted-account routing retain their existing
paths. The limited grant is issued for the captured current life, with an origin
ID that omits epoch. Native global per-User request identity prevents a previously
issued origin from minting replacement-life control authority.

A purpose-separated 128-bit MAC binds the actual bot, sender's stable User,
action and canonical opaque 128-bit grant reference. Callback data is 51 bytes;
no User, epoch, Root, old data, product token or provider key is exposed. Callback
handling only reads the original current-life grant; it never issues another one.
Old Return scope, retired epochs, foreign/tampered callbacks, expired/revoked
grants and mismatched verified namespaces cannot authorize activation. Not now
sends no activation and makes no undo/revocation claim.

Confirmation composes the current-control native authority with the bounded real
Redis activation adapter. Native User/Account locks span Return/namespace proof
and the monotonic blocked-predecessor CAS; expiry/revocation are rechecked after
the effect. An active current marker permits exact retry, while a later blocked
marker wins. No body is copied, TTL extended, profile restored, credit supplied
or lifetime preview allowance reset. Provider response loss is an unknown outcome,
not invented completion. Delivery rechecks actual nondeleted owner/epoch and
current grant before send and again after callback acknowledgement. The stable
per-User admission budget does not reset with product epoch.

`NAKH_FRESH_ENTRY_TELEGRAM_ENABLED=false` keeps this composition off by default
and requires Return Telegram readiness. Migration 144 adds five active English
texts without changing tables, retention descriptors or another locale. Complete
English catalog inventory becomes 607 and explicitly includes all new entries.
All older populated-upgrade lists remain, with schema 143 added to the matrix;
the completed schema-142 Root upgrade now also traverses migration 144.

Seven unit cases cover explicit confirmation, initial/deleted routing, twenty
retries, short opaque owner/purpose binding, stale-origin/life denial, captured
input and rate limits, and sanitized activation failures. One configuration case
locks the default-off/readiness dependency. Native Telegram coverage adds five
cases, including twenty confirmations and intact original financial/counter/Root
facts, wrong namespace and revocation, a real later tombstone during ACK, actual
authenticated webhook/Redis CAS/budget, lost actual Redis response and a synthetic
later marker. The latter two real Redis cases are mandatory CI coverage; local
availability is reported explicitly. Native inventory rises to 1,228 cases in 150
files; the new file's 180-second dispatch estimate is provisional, not acceptance.
No workload, index, timeout or acceptance gate is reduced.

Focused unit verification passed 27 cases in four files. Focused gateway types
passed; initial lint caught missing integration helper return types/mock imports,
which were repaired before the focused lint passed. Full populated-migration,
native Telegram, project and exact-head CI verification remain required.

Product-session/ordinary ingress gating, remaining Return administration
composition, controlled retained-data release OFF pending actual period approval,
M8 telemetry/runbooks and final failure/recovery acceptance remain required.
This composition issues no product session and does not by itself complete full
primary/product admission. No external Telegram send/ACK, protected MFA/drain,
CloudWatch/SNS, staging/PITR/DR or security/operator sign-off is fabricated. No M9.

The first combined native run passed the exact catalog and both Telegram suites
but found a stale matrix assertion still expecting `143 - baseline` applied files.
All 73 upgrade cases therefore reported one extra applied migration (for example,
99 instead of 98 from schema 45); the bootstrap case passed. That failure log is
preserved. The assertion was corrected to the exact `144 - baseline`, without
removing any original upgrade/provenance checks, and the complete matrix rerun
passed all 74 cases. Native verification in total passed 90 distinct cases; three
Redis cases were unavailable locally (two new, one original Return) and remain
mandatory CI coverage. The full project check passed formatting, lint, all
workspace types, all 1,142 unit tests in 236 files and all builds. All six
exact-head CI jobs remain required before another feature.

## Historical repair: one-pass episode resolution metadata in the integrity snapshot

Feature `5af605e` is not accepted green. Exact-head run `38690525678` passed
quality and all four image/native jobs. All 1,222 native cases in 149 files passed
without skips, and all three source receipts match the SHA/run/attempt. Reliability
failed its terminal integrity snapshot at 1,578.685 ms against the unchanged
1,500 ms limit. The other 26 plans passed. Both required administrator indexes
were present; there were zero workers, one hash batch and no temp/disk spill.
The original failure log, source receipts, plan artifact and metadata are retained;
all three downloaded ZIP digests match GitHub. Later load/backup acceptance is
not claimed for this failed run. No unchanged rerun or feature advance.

The terminal plan spends 398.618 ms in its episode phase. Its resolution facts
scan the owners, then scan/join the same owners again to recover metadata already
available during validation. The repair carries those fields through one owning
scan and reuses the identical indexed resolution-existence predicate in the full
scanner and aggregate. Open episodes explicitly bypass resolution probing; resolved
episodes still require every original action/actor/owner/reason/time and successful
administrator command/request/digest/target binding. Duplicate attempts retain
existence semantics. Remaining witness, Report, history, audit and notice checks
are unchanged; every episode still contributes at most one violating count.

A same-fixture local comparison at the full 20,000 scale measured the failed-head
control at 2,895.412 ms and the candidate at 2,596.651 ms. Both required indexes
remain, with zero workers and no temp spill. This approximately 10% improvement
is comparative Windows evidence, not a claim to satisfy the 1,500 ms acceptance
gate. The actual production sampler, all 27 plans, all repeated/damaged fixtures,
required indexes, 20,000 workload, memory budget and 20-minute CI caps are retained.
The complete native integrity suites and full project check must pass before the
repair is committed. All six new exact-head CI jobs must pass before another
feature; full M8 remains open, with no M9 or production switch enabled.

Both complete native integrity suites passed all 17 cases, including the added
open-episode/scanner/aggregate equivalence checks and every original corruption,
duplicate and pooled-setting restoration case. The full local project check
passed formatting, lint, all workspace types, all 1,134 unit tests in 235 files
and all builds. Exact-head CI remains required; no local timing is substituted
for the unchanged production-shaped gate.

## Historical increment: current-life primary authority for opaque activation

Accepted `b4f717f` passed all six exact-head jobs on attempt 1 of run
`38670185035`: 1,217 native cases in 149 files, no failures or skips, with all
three source receipts bound to the same SHA/run/attempt. All 27 plans passed at
20,000 scale; terminal integrity took 1,465.564 ms against the unchanged 1,500 ms
limit, with zero workers, both required administrator indexes, one hash batch
and no spill. Support load, backup/restore and actual collector privacy/freshness
checks passed. All three artifact ZIP digests match GitHub metadata. No external
CloudWatch/SNS delivery or operator acceptance is inferred.

`PostgresFreshEntryActivationAuthority` requires a distinct, current-life limited
account-control grant before activating the verified opaque namespace. The old
control that authorized Return, a Return-only actor, a foreign owner, an unknown
grant or an expired/revoked grant cannot authorize this operation. Authority is
captured at construction, checked under canonical User/Account locks and checked
again after the provider effect. Actual Return proof and the exact verified
namespace remain mandatory. No product credential, old body, balance or preview
allowance is issued or restored by this adapter.

Both activation authorities reuse an existing owning transaction when composed.
This avoids opening a second transaction against locks already held by primary
entry. An independently opened transaction is still used by standalone callers.
Provider effects remain subject to the existing Redis deadline and monotonic CAS;
an unknown external outcome is not interpreted as native product admission.

Five additional native cases cover twenty concurrent confirmations, original/
foreign/unknown/wrong-scope grant denial, captured-input mutation and wrong
namespace denial, revocation and real expiry during the effect, and owning-
transaction rollback/retry. The existing real next-deletion lock race now uses
fresh primary authority and denies it after the next tombstone. Both complete
native lifecycles and original financial proof assertions remain. Native coverage
rises to 1,222 cases in the same 149 files; no workload or time limit is reduced.

This is the native primary-authority boundary. Authenticated primary callback/
HTTP composition and product-admission gating remain required; this adapter alone
does not make primary entry complete. Full M8 scope, controlled retention release
OFF pending approved periods, telemetry/runbooks and final recovery acceptance
remain open. No production switch is enabled and no M9 work is started.

The final focused native run passed all ten cases in an isolated database, including
expiry after a provider wait, composed rollback and the fresh-authority deletion
race. Focused lint/types and the complete project check passed: formatting, lint,
all workspace types, all 1,134 unit cases in 235 files and all builds. Initial local
validation found a test-parenthesis typo and a sandbox process-start restriction;
the typo was fixed and the same native suite then ran with required process access.
All six exact-head CI jobs remain required before another feature.

## Historical repair: synchronize the complete English catalog assertion

Feature `33b72a8` is not accepted green. Run `38667036381` passed quality,
Telegram build and the API/scheduler native jobs. The worker partition ran 455
cases: 454 passed and one failed, across 50 files (49 passed, one failed).
The failure is the older identity catalog assertion expecting 595 English entries;
migration 143 deliberately adds seven Return entries, making the exact total 602.
Reliability was skipped, so no later performance/load/backup acceptance is claimed.
Original worker logs and exact-run metadata are preserved. No unchanged replay.

The repair updates that exact complete catalog count to 602 and explicitly requires
all seven Return keys, retaining the locked active/inactive locales, fallback,
existing deletion catalog and every original identity assertion. Production code,
UI text, migration checksums, native inventory, timeouts, workloads and all
acceptance gates remain unchanged. The complete identity/localization native suite
and the full project check must pass before the repair is committed; all six
exact-head CI jobs are then required before another feature. Full M8 scope remains
open as recorded below. No M9.

The complete native identity/localization suite passed all nine cases in an
isolated database, preserving the shared base database. The full local project
check passed formatting, lint, all workspace types, all 1,134 unit tests in 235
files and all builds. All six exact-head CI jobs remain required for acceptance.

## Historical increment: authenticated Telegram Return and catalog presentation

Accepted `2798a72` passed all six exact-head jobs on attempt 1 of run
`38661990188`: 1,211 native cases in 148 files, no failures/skips, all three
source receipts bound to the same SHA/run. All 27 plans passed at 20,000 scale;
terminal integrity was 1,217.686 ms against 1,500 ms, zero workers, both required
administrator proof indexes, one hash batch and no spill. Support load,
backup/restore and actual collector/privacy rehearsal passed. All artifact ZIP
digests match GitHub. No gate, workload, index or time limit was weakened.

The limited private `/return` path prepares short authenticated callback buttons.
The opaque reference names one random native grant, with a 128-bit HMAC binding
bot, actual sender's stable User, action and expected version. Canonical encoding,
integer bounds, private human sender/chat equality and the configured bot's callback
message are required. Callback data is at most 59 bytes; no User, product epoch,
Root, approval, retained data, product credential or provider key is exposed.
The random grant lookup reference alone is not bearer authority.

Native grant facts supply the original epoch. Callback retries do not issue a new
grant or re-resolve a replacement product life: they execute the same permanently
idempotent Return command with the original version. The primary prompt's origin
ID deliberately omits epoch, so replaying an old text update cannot mint a new-life
grant. The native command still requires the separately approved completed Root,
its exact original owner/version and current unrevoked/unexpired grant. Ordinary
control/product authority remains retired; Return neither restores old data nor
resets the lifetime GuestPreviewCounter. "Not now" only dismisses presentation
and sends no Return command; it cannot undo a committed Return.

The production webhook controller authenticates Telegram before the composed
Return/deletion ingress. Delivery renders catalog intents only, checks the actual
sender's native original-grant/Return proof before sending, and checks again after
callback acknowledgment. A later tombstone, expiry, revocation or changed owner
blocks delivery. Lost provider acknowledgment can be retried against the same
native receipt. Return's shared per-User Redis admission budget does not reset
when the product epoch changes. Private provider errors never escape the boundary.

`NAKH_RETURN_TELEGRAM_ENABLED=false` keeps this path off by default. It requires
configured limited deletion Telegram/worker readiness. Migration 143 adds seven
English catalog entries (the current active default), without enabling another
locale or changing a schema/retention descriptor. All older populated-upgrade
baselines remain; schema 142 is additionally covered, and exact applied lists now
include migration 143. Coverage rises to 1,217 native cases in 149 files; the new
native file's dispatch estimate is provisional. No external provider/MFA/drain,
staging/PITR/DR or operator acceptance is claimed by synthetic fixtures.

Focused verification passed 29 unit cases in four files, lint and gateway type
checks. Native Telegram verification passed four cases, including the completed
schema-142 approved Root upgrade, twenty simultaneous confirmations, original-grant
next-life replay, foreign/tampered callbacks, independent approval denial, lost
provider response recovery and an actual next-life tombstone during callback
acknowledgment. That later deletion is an admission/tombstone observation only;
no second provider cleanup is claimed. All 73 populated-migration cases passed,
including the newly added schema-142 baseline. The real Redis authenticated webhook
and persistent admission-budget case is unavailable locally and remains mandatory
CI coverage; no synthetic Redis success or external send/ack is claimed. Initial
style/type checks identified type-import syntax and the missing dedicated rate-scope
enum; both were corrected before these passing checks. Full project and exact-head
CI verification remain required.

The full local project check passed formatting, lint, all workspace types,
all 1,134 unit tests in 235 files and all builds. Exact-head CI must still pass
all six jobs, including the real Redis webhook case with no native skips.

Fresh primary activation/product ingress, remaining Return administration
composition, controlled retention release (OFF until actual periods are approved),
M8 telemetry/runbooks and full interruption/load/failure/recovery acceptance remain
required. Full project checks and all six exact-head jobs are required before
acceptance. No M9.

## Historical increment: original-grant own Return HTTP composition

Accepted `cde4e3a` passed all six exact-head jobs on attempt 1 of run
`38657341922`: 1,208 native cases in 147 files, no failures/skips; all 27 plans
at 20,000 scale. Terminal integrity was 1,450.626 ms against the unchanged 1,500 ms
limit, with zero workers, both administrator proof indexes, one hash batch and no
spill. Support load, backup/restore and actual collector/privacy rehearsal passed.
All three artifact ZIP digests match GitHub. Failed `7eb48cb` evidence remains
preserved; no acceptance limit or workload was weakened to obtain this result.

`POST /v1/account/return/confirm` accepts only the caller's command envelope and
expected Account version. Identity comes from the original opaque limited-control
credential; actor, epoch, grant, Root, approval and channel selectors are rejected.
The dedicated `account_return` actor can attempt/replay this native command only.
Ordinary control authentication still rejects the old epoch after Return, and this
scope cannot authenticate a product session or authorize deletion. The native
Return function independently requires the original unexpired/unrevoked grant,
separate approved completed Root, exact owner/epoch/version and permanent command
and idempotency bindings under canonical locks and at commit.

Return-only authentication accepts a deleted original life, or the one immediately
following nondeleted life with this exact grant's independently verified Return
receipt. It never retags an old credential to the new epoch. The boundary freezes
the original actor and captures the input before native waits, then rechecks the
same grant after execution. Expiry, revocation, substitution and a later tombstone
fail closed; changed replay input remains a native idempotency conflict. The safe
receipt has only returned/version/replayed fields and no credential. Unexpected
response fields and private failure details are rejected before serialization.
HTTP has no credential issuer. Redis activation and fresh product entry remain
separate authenticated primary-composition work.

`NAKH_RETURN_API_ENABLED=false` keeps the new route absent by default. Enabling it
requires the existing configured deletion API/worker readiness and uses the
existing control key; it neither approves Return nor enables retained-data release.
Deploy schema 142 before enabling this adapter. There is no migration, new table,
retention descriptor or provider claim. The new native HTTP file raises coverage
to 1,211 cases in 148 files; its scheduling estimate is provisional only.

Focused verification passed 29 unit cases in four files, all three native HTTP
cases, lint and API type checks. Native evidence includes twenty concurrent exact
retries, one audit/transition, unchanged lifetime preview facts and original financial
proof, ordinary-control retirement, actual product-token denial, modified replay
conflicts, independent approval admission, native revocation/expiry, different-grant
receipt denial and rejection after a later own tombstone. The first native attempt
identified fixture work from that deliberately pending tombstone being claimed by
the next case; isolating its availability restored all cases without changing the
production worker or claiming a completed second cleanup. Provider/factor/drain
observations in these HTTP fixtures remain synthetic; actual Redis/worker Return
cycles were accepted separately at `cde4e3a`. Versions are bounded to the native
signed-integer range before execution. Full project and exact-head CI checks remain
required for this candidate.

The full local project check passed formatting, lint, all workspace types,
all 1,125 unit tests in 233 files and all builds. Exact-head CI remains required
before accepting this candidate or advancing another feature.

Public Telegram/localized Return, fresh primary activation/product ingress, controlled
retention release (OFF until real periods are approved), M8 telemetry/runbooks and
remaining interruption/load/failure/recovery evidence remain required. Actual
producer drain/provider/staging/PITR/DR, security review and operator sign-offs
remain external. No M9. Full checks and all six exact-head jobs remain required.

## Historical repair: avoid repeated worker launches in the combined integrity snapshot

Feature `7eb48cb` is not accepted green. Run `38650762285` passed quality and
all four container/native jobs: 1,207 native cases in 147 files, no failures or
skips, with all three receipts bound to that exact head/run. The reliability job
failed only the terminal integrity snapshot: 1,549.745 ms against the unchanged
1,500 ms limit at 20,000 scale. Both administrator proof indexes were present,
with one worker, one hash batch and no spill. Support load and backup/restore were
skipped after that failure. Original logs and ZIP digests are preserved/verified;
no unchanged replay or later acceptance is claimed.

Two larger history rewrites were slower and rejected; exact-existence/JSON
predicate experiments also timed out under the existing native statement bound
and were removed. The repair preserves the original complete SQL predicates.
A same-fixture diagnostic alternated zero and one worker three times at the full
20,000 scale: zero-worker samples were 2,534.528/2,551.809/2,551.508 ms; one-worker
samples were 2,727.304/2,624.995/2,762.882 ms. Every sample retained the required
indexes and had no spill. These slower Windows measurements establish the paired
comparison only; they do not satisfy the Linux CI performance acceptance gate.

Only the combined ten-phase integrity snapshot now requests zero read workers,
avoiding repeated launches for its short membership scans. Individual phase and
operational-health reads retain their prior one-worker cap. Production sampling
and both baseline/terminal EXPLAIN scenes use the same bounded read setting.
The maximum is transaction-local, never exceeds an operator's lower limit, and
must restore pooled settings after success and actual native query failure.
All flags, one-entity counts, original proof/history predicates, 27 plans, repeated
samples, 20,000-row workload, required indexes, 1,500 ms limit, memory budget and
20-minute CI bounds remain unchanged. The additional native settings case raises
the inventory floor to 1,208 cases in 147 files. No migration or retained-data
policy change. Full checks and all six exact-head jobs remain required.

Focused lint and PostgreSQL type checks passed. Both native integrity suites
passed all 17 cases, including the new serial setting under operator limits 0/1/8,
restoration after success and actual division-by-zero failure, concurrent ten-phase
sampling, exact current drift counts, duplicate-history/restoration bindings and
remaining scanner/aggregate consistency probes. No query-predicate experiment is
included in the repair. Full project and exact-head CI checks remain required.

The complete local project check passed formatting, lint, all workspace types,
all 1,117 unit tests in 232 files and all builds. All six exact-head CI jobs remain
required before accepting the repaired head or starting the next feature.

The full M8 scope remains open: public API/Telegram/localized Return composition,
controlled retention release (OFF until actual periods are approved), telemetry,
runbooks and remaining interruption/load/failure/recovery evidence. Actual provider,
staging/PITR/DR, security review and operator sign-offs remain external. No M9.

## Historical increment: native-bound monotonic Redis activation after Return

Accepted `192f64c` passed all six exact-head jobs on attempt 1 of run
`38644167739`: 1,193 native cases in 146 files, no skips; all 27 plans at 20,000
scale, terminal integrity 1,498.487 ms against 1,500 ms with both required indexes,
one worker and no spill; support load, backup/restore and actual collector/privacy
rehearsal passed. Native, performance and telemetry ZIP digests match GitHub.
The original failed `004ee29` run remains preserved. The performance limit is
unchanged; the measured terminal sample leaves little margin.

The native activation authority locks the stable User and current Account, then
derives one immutable actual Return receipt for exactly the requested product life.
It independently validates the receipt, its original provider reconciliation and
the exact Redis namespace verified by deletion. Caller-selected proof IDs, epochs
or namespaces never authorize activation. The bounded provider callback receives
frozen native facts; the owning Account remains locked throughout and is rechecked
after the callback. Deleted, initial, stale, future or unverified lives fail closed.
This internal system port must receive a life frozen by authenticated primary
composition, never an HTTP body or previously authenticated old-life actor.

Redis performs one atomic `blocked:previous -> active:current` transition. The
predecessor marker must be permanent, its reverse index empty, and the new index
absent. Replaying the same already-active life is idempotent and does not copy,
replace or extend any value. Missing, expiring, malformed, blocked-current or later
markers fail closed. Physical absence remains proven by the original independent
provider passes; a reverse index alone is not such proof. No raw identity or native
proof ID is added to Redis keys, marker values or public results.

Activation waits at most five seconds for the shared Redis client, so its native
Account lock cannot be held indefinitely by BullMQ's unlimited connection retries.
Timeout is an unknown provider outcome: a delayed command may still execute. The
atomic predecessor condition prevents it from reopening a later tombstone or
changing a newer life. An owning deletion worker can advance only the permanent
immediate-predecessor tombstone when a returned life is deleted before activation.
It still cannot initialize an unknown nonzero life, move a marker backward or
remove another life's values. Redis failure does not roll back the already-audited
native Return; unchanged activation retry recovers safely from lost acknowledgment.

This increment adds no migration, table, retention descriptor or public Return
flag. API/Telegram/localization Return composition, controlled retention release,
M8 telemetry/runbooks and the remaining full interruption/load/failure/recovery
matrix remain required. Retained-data release stays OFF until real periods are
approved. Actual provider/staging/PITR/DR, security review and operator sign-offs
remain external. No M9. Full local checks and all six exact-head CI jobs remain
required before acceptance.

The full local check passed all 1,117 unit tests in 232 files, formatting, lint,
workspace type checks and builds. Five focused native activation cases passed,
including canonical lock serialization and an actual second deletion/Return cycle
with original financial/Return proof preserved. Queue, worker and PostgreSQL
focused type checks passed. Real Redis script tests and the complete worker/provider
cycles remain mandatory CI evidence; no local Redis or synthetic absence is claimed.
The native inventory floor increases to 1,207 cases in 147 files. The new native
file and expanded worker suite have provisional scheduling estimates only; no
acceptance threshold, workload, timeout or existing case is reduced.

## Historical repair: Return event parity across native and application policy

Feature `004ee29` is not accepted green. Run `38639158989` passed quality and
three container/native jobs, but the API native partition failed one exact policy
parity assertion. Across all three partitions the inventory remained 1,193 cases
in 146 files: 1,192 passed, one failed, no skips. All twelve new actual Return cases
passed in the worker partition. The reliability job was skipped, so later plan,
load and backup/restore acceptance was not reached on this failed head. Original
native logs and final status are preserved; no control replay was requested.

Migration 142 correctly adds the exact content-free `account.returned.v1` native
shape (`userId accountVersion`), but its reviewed TypeScript policy omitted that
same entry. The repair adds the identical entry and keeps the complete native
policy/catalog equality assertion. A focused boundary case rejects private fields,
approval/epoch additions, malformed identifiers/versions and other schema versions.
This classification authorizes neither restoration nor event admission. It keeps
the existing account-lifecycle proof class; transport publication/expiry and the
immutable native Return receipt remain separate concerns.
No migration checksum, original proof guard, test volume or acceptance limit changes.

The full local check passed all 1,112 unit tests in 231 files and all workspace
lint/types/builds. All 22 native operational-policy cases passed, preserving the
exact complete policy/catalog comparison and cancellation failures/races. The
focused policy unit suite passed all 32 cases. Its first new positive expectation
incorrectly used the ordinary-product transport class; correcting that test to the
existing account-lifecycle class preserved production semantics before commit.

The new Return suite's measured 308,739 ms replaces its provisional scheduling
estimate, retaining explicit failed-overall provenance. All existing accepted-file
measurements remain bound to the prior green run. Full project checks and all six
exact-head jobs remain required on the repair before another feature. The full M8
implementation scope and external approvals below remain unchanged.

## Historical increment: separate native approved fresh Return (migration 142)

Accepted `8148703` passed all six exact-head CI jobs on attempt 1 of run
`38630480765`: 1,180 native cases in 145 files, no failures/skips; all 27 plans
at 20,000 scale, terminal integrity 1,215.438 ms with both required indexes;
support load, backup/restore and the actual collector/privacy rehearsal passed.
All three evidence ZIP hashes match GitHub metadata. Current scheduling now uses
the complete measured file inventory from that accepted run; the new native suite
has a provisional scheduling estimate only. No case, workload or limit is reduced.

`identity.return_account` performs a separate own-account command under the stable
User/Account/original Root locks. It requires one validated immutable administrator
approval and a current, original-life limited account-control grant. An approval
alone cannot change an Account. The exact Return command has permanent user-bound
idempotency proof; retrying a committed command can read its own original receipt
without acquiring product authority or crossing another life. Changed input,
borrowed grants, stale epochs/versions, missing approval and retained safety bars
fail closed. Transport timestamps never grant authority; the native clock is
checked after lock waits and again at deferred commit.

Only the completed Root's `reactivation_allowed` bit may change, once, in the
same transaction as its audited deleted-to-guest transition and next epoch/version.
Every other original Root field remains unchanged. Required immutable history,
audit and event facts bind the approval, original limited grant and transaction.
Settings and notification preferences start from public defaults; Profile/signup
and ordinary product selectors must be empty. The existing verified financial
cutover supplies the zero-credit next-life projection; Return neither reconstructs
nor resets any ledger. A native hash proves the lifetime GuestPreviewCounter did
not change. Suppressed writes or altered defaults/counter must roll back the whole
Return at commit. No product credential is returned.

Historical financial verification retains the original closed epoch and its exact
audit/closure facts. Only a valid actual Return receipt permits subsequent changes
to the next epoch's balance/ledger; that exception never modifies original money
facts. Retention descriptors/proofs, original provider reconciliation and approval
history remain independently verifiable after actual Return and new-life activity.
The Return event has an exact content-free transport shape, and only fully proven
Return audit facts are classified as immutable lifecycle proof. The migration adds
no tables, columns, foreign keys or retention descriptors and refuses unexplained
legacy Return facts. Previous admission/checkpoint guards remain intact around the
one narrowly authorized transition.

Local native evidence covers twelve Return cases: twenty-way exact command
replay; missing approval and retained-ban denial; owner/epoch/version/digest
binding; actual Return followed by fresh preview/signup/credit activity with old
financial/retention/provider/approval proofs still valid; seven required-write
suppression/recovery paths; deferred counter/default/ordinary-signup corruption;
real Account-lock expiry and deferred-commit expiry with a nontransactional
execution witness; and a populated approved schema-141 upgrade. The original
eleven cases passed together; the added signup fence and bounded-setup expiry
case passed independently. The thirteen existing credit/deletion lifecycle cases
and three focused pending/completed upgrade cases passed too. Synthetic provider
and protected-factor observations do not certify real Redis absence, producer
drain or external MFA delivery. Post-Return ledger activity uses a privileged
activation fixture; it is not complete signup/Photo moderation evidence.

The full local check passed all 1,111 unit tests in 231 files and all workspace
lint/types/builds. Formatting, a test-only untyped rejection value and missing
counter-fixture contract references were diagnosed and repaired before commit;
the corrected historical activity case passed again. No production proof guard,
case timeout, asserted workload or CI limit was relaxed.

This increment is the native command, not public Return activation. Own status
continues to report reactivation denied until Return ingress is composed. Monotonic
later-life Redis activation, API/Telegram/localization Return composition, controlled
retention release, M8 telemetry/runbooks and the remaining full interruption/load/
failure/recovery matrix remain required. Retained-data release stays OFF until
real periods are approved. Actual provider/staging/PITR/DR, security review and
operator sign-offs remain external. No M9. Full local checks and all six exact-head
CI jobs remain required before acceptance.

## Historical increment: separate audited Return approval (migration 141)

Accepted `1a37e60` passed all six exact-head jobs on attempt 1 of run
`38624307758`. The three independent native runners covered all 1,170 cases in
144 files with zero skips; their source-bound aggregate was accepted before the
unchanged later gates. All 27 M7 plans passed at 20,000 scale; terminal integrity
was 1,304.75 ms against 1,500 ms with both required admin-proof indexes, one
worker, one hash batch and no temporary/disk spill. Support load, backup/restore
and actual collector/privacy rehearsal passed. Native, performance and telemetry
ZIP digests match GitHub metadata. The original failed runs remain preserved.

The next native increment records a separate immutable `account.return-approved.v1`
fact for one completed deletion and its original account version/product epoch.
The dedicated `approve_account_return` permission is seeded only to `super_admin`.
The existing administrator command boundary records successful, rejected and
failed reviews. A current native MFA session is mandatory; host TOTP requirements
remain monotonic. Original User, Account and Root locks serialize concurrent
reviewers; exact command replay retains one outcome, while distinct reviews can
share the single Root approval and retain their individual audit attempts.

The native deferred proof binds the approval to its exact successful command log,
original Root, administrator, session and transaction. It rechecks the native
clock, active identity/permission, original account, completed checkpoint chain,
retained safety bar and independent deletion verifier. Suppressed or forged proof
must not commit success. No private reason text or provider data is copied into
the approval fact. Migration upgrades preserve original history and add no tables,
columns, foreign keys or retention descriptors; the exact permission inventory
now distinguishes historical schema 50 from schema 141.

This approval does not execute Return or set `reactivation_allowed`; completed
Roots remain byte-for-byte unchanged and the existing native Return prohibition
remains in force. Own status continues to report reactivation denied until the
separate safe Return command and ingress composition are implemented. Approved
fresh GUEST Return, monotonic later-life Redis activation, historical proof after
actual Return, executable controlled retention release, M8 telemetry/runbooks and
the full interruption/load/failure/recovery matrix remain required. Retained-data
release stays OFF until real periods are approved. Actual provider/staging/PITR/DR,
security review and operator sign-offs remain external. No M9 is included.

Local verification passed all nine native approval cases, including twenty-way
same-command replay, distinct reviews with identical-command retry after native
transaction conflicts, missing/forged audit denial, native MFA absence/expiry,
expiry after an actual Account lock wait, deferred-commit expiry with a
nontransactional execution witness, unchanged completed Root/phase bytes and
both populated schema-140 upgrade paths. The separate schema-140 pending upgrade
and permission-seed checks passed too. Initial local failures identified the old
exact permission verifier, an unclassified new audit fact and fixture ordering;
all were diagnosed and repaired before commit. The validated approval is now
explicitly classified as immutable lifecycle proof; malformed facts still block
verification. Synthetic protected-factor fixtures do not certify external MFA
provider delivery. The full local check passed 1,110 unit tests and all workspace
types/builds, with final lint/format checks on the added evidence.

Full project checks and all six exact-head jobs are required before acceptance.

## Historical repair: independent native runners with source-bound coverage handoff

Repair `9477961` is not accepted green. Run `38616974877` passed every native
case: 1,170 in 144 files, zero failed or skipped. Its English catalog check passed.
The three native contexts took 918.99, 1,028.86 and 1,062.32 seconds on one runner;
the job reached its unchanged 20-minute cap during later plan gates. Full M7
plan/load/restore acceptance was not reached. Quality independently failed before
collector startup at image pull with the cause classified unknown. Both original
logs are preserved. No unchanged quality rerun was requested because another job
also failed to complete.

The capacity repair retains the same three native partitions, every file and case,
real PostgreSQL/Redis, all volume/index/performance gates and exactly six job names.
Three existing container jobs each run one complete native partition on their own
runner and services. The dependent reliability job starts only after the container
matrix succeeds, independently discovers the current file inventory and verifies
all three coverage receipts before running any plan, load or recovery gate. Native
and reliability jobs keep a 20-minute cap; no gate or asserted workload is reduced.
Matrix fail-fast is disabled so a failed partition does not cancel its peers.

Receipts contain only coverage facts and portable repository paths, not raw test
assertions or provider/fixture output. Verification binds the checkout SHA, workflow
run, successful attempt, complete inventory and exact dispatch plan. It rejects
missing, duplicate, overlapping, misplaced, failed, skipped, inconsistent and
wrong-source reports. Same-run successful earlier attempts remain usable for an
unchanged rerun; the actual job dependency graph also requires all partition jobs
to succeed. Artifact names include attempts to avoid overwriting another proof.
The original single-runner CLI remains available, while CI uses the distributed
mode. Empty evidence fails the actual verification CLI before any acceptance gate.

The native inventory hash remains identical to the original fully passing run.
Focused boundary tests cover source and manifest substitution, future attempts,
partial/duplicate file sets, private fields, malformed counts and unsafe paths.
Full project checks and all six exact-head jobs remain required before acceptance.
Production M8 behavior and its remaining implementation/external approvals below
are unchanged; approved Return, retention release controls and the remaining M8
operational evidence are still due.

## Historical repair: include the ten deletion texts in the exact English inventory

Feature `89d3108` is not accepted green. Run `38612700292` passed quality and all
four images. Its native inventory covered all 1,170 cases in 144 files with zero
skips; 1,169 passed and one failed. The locked English catalog assertion still
expected 585 messages, while migration 140 correctly adds ten deletion texts for
595. The repair keeps an exact total and additionally asserts the exact ten-key
deletion namespace. Existing locale, fallback and message checks remain intact.
No production flow or acceptance limit changes. Later plans/load/restore gates
did not run on the failed head and remain required on this repair.

All eight new native Telegram cases passed, including the actual authenticated
webhook with real Redis limits, complete native cleanup/status, provider failure
recovery and the negative lifecycle/ownership probes. The measured 17,206 ms now
replaces the provisional scheduling estimate, with failed overall provenance
explicitly retained. Full project checks and all six exact-head CI jobs are
required before another feature. Full M8 scope and external approvals remain due.

## Historical increment: trusted Telegram own deletion and limited status (migration 140)

Accepted repair `38a3ae1` passed all six exact-head jobs on attempt 1 of run
`38605992173`: all 1,161 native cases in 143 files, zero skips; all 27 plans at
20,000 scale, terminal integrity 1,145.615 ms; support load, backup/restore and
actual collector/privacy rehearsal passed. Native, performance and telemetry ZIP
hashes match GitHub artifact digests. The original failed `07b54ae` run remains
preserved and was not replayed. Its image-pull cause remains unknown; the repair's
collector success does not establish a diagnosis for that earlier failure.

Telegram now composes `/delete`, owner-bound confirm/cancel callbacks and
`/delete_status` through the native limited account-control grants and deletion
store. The actual gateway authenticates its provider webhook before routing any
of these commands. It accepts only private human updates; callback messages must
come from this configured bot and the same private recipient. Callback data contains
only a native owner/version-bound confirmation MAC and fits Telegram's 64-byte limit.
Each exact confirmation action has one stable native command identity across
repeated clicks, even when Telegram assigns distinct update IDs.

The original life and Account version are captured before limiter/native waits.
Grant issuance uses a stable bot/update/User origin ID that deliberately omits the
epoch: a replayed old update cannot acquire a replacement-life grant. A separate
limited resolver includes tombstoned accounts and never changes the existing
product resolver. Delivery rechecks the original Telegram ownership, epoch and
native grant after catalog loading and callback acknowledgment. No ordinary product
session, Redis owned-action vault or new product authority is restored.

All notices and buttons load from versioned UIText keys. Cancellation describes
the exact confirmation; a completed replay reports completion instead of stale
progress. The limited status projection exposes no Root/provider/manifest details
or retained content. Valid rate-limit and unavailable notices contain only fixed
generic text. Provider failures are sanitized; retries use the same already
committed command rather than repeating the tombstone or creating a new Root.

The production flag `NAKH_DELETION_TELEGRAM_ENABLED` defaults OFF and requires
configured worker readiness. The readiness hash remains an operator assertion,
not certification of actual producer drain. Local native evidence covers twenty-way
preparation/confirmation/cancellation, borrowed proof denial, delayed-life and old
origin denial, grant revocation before delivery, provider failure/recovery, and
limited status after actual native completion and settings purge with historical
proof still valid. Privileged epoch changes are negative fixtures, not approved
Return. Empty-provider fixture observations are not evidence of actual Redis
absence. The real authenticated gateway/Redis composition case remains mandatory
in CI; provider send/ack test doubles do not certify actual Telegram delivery.

Migration 140 adds only localization rows; tables, columns, foreign keys and the
retention catalog remain unchanged. Full checks and all six exact-head jobs remain
required before another feature. Approved fresh GUEST Return, later-life Redis
activation and historical proof after real Return, executable controlled retention
release, M8 telemetry/runbooks and the complete interruption/load/recovery matrix
remain due. Retained-data release stays OFF until real periods are approved.
Actual provider/staging/PITR/DR/security/operator sign-offs remain external. No M9.

## Historical repair: preserve populated historical admission and deferred expiry evidence

Feature `07b54ae` is not accepted green. Run `38600724608` passed all four images
and the quality job's complete project check, then failed the collector image pull
with an unknown, nonretryable classification. That original log is preserved;
no control rerun was requested because native CI also failed. The native inventory
still included all 1,161 cases in 143 files: 1,134 passed, 19 failed and eight were
skipped by failed suite setup. Later plan/load/restore gates did not run.

Current production admission correctly requires original epoch columns, but older
schema-85 through schema-99 populated-upgrade fixtures reused that current store.
They must seed historical facts through the frozen pre-epoch implementation from
accepted `bcb634f`, selected explicitly by those historical fixtures. This adapter
is confined to testing and is not exported by production persistence composition.
Current admission keeps every credential, native epoch, replay and status fence.

The retention expiry probe previously used a one-second lease that could expire
before its deferred trigger. It now admits work with a ten-second native lease,
then waits until the actual stored expiry inside the deferred trigger. The existing
nontransactional sequence must prove that path ran, and no partial batch may remain.
Final expiry fixture preparation now uses a separately bounded setup hook; the
unchanged test timeout covers real expiry, rollback and complete fresh recovery.
No native proof guard, test volume, performance limit or 20-minute CI cap is relaxed.

All ten new limited-credential/API cases and both complete-worker cases passed
the original native run. Updated scheduling measurements retain that run's failed
overall provenance and cannot certify acceptance. Complete checks and all six jobs
on the repaired head remain mandatory before another feature. Full M8 scope and
the external retention/provider/operational approvals below remain unchanged.

## Historical increment: limited own account-deletion controls (migration 139)

Accepted repair `bcb634f` passed all six exact-head jobs in run `38590856995`,
final attempt 2: 1,150 native cases in 141 files, no skips; all 27 plans at
20,000 scale, terminal integrity 1,005.756 ms; support load (10 accepted,
90 denied, 100 replayed), backup/restore and the actual collector privacy
rehearsal passed. Saved native, performance and telemetry artifact digests match
GitHub. Attempt 1 quality failed before collector startup during image pull,
classified unknown; the original failure is preserved. One unchanged quality
control rerun was requested only after the original workflow finished. The cause
remains unknown; this does not establish a transient-image-pull diagnosis.

Migration 139 adds immutable, original-life account-control grants and revocations
without changing tables, columns or foreign keys. Opaque `v1.ac` credentials use
a separate key derivation and authenticated purpose from product `v1.us` sessions.
Every use checks native owner, original epoch, expiry and revocation. Limited
controls survive a tombstone in that same epoch; they cannot authorize product
access. Grant issuance is server-internal, never an HTTP endpoint. No bearer or
bearer hash is stored. Grant and deletion-effect commit fences use native time.
Only fully validated immutable grants are classified as retained security facts;
expiry removes authority without invalidating historical audit classification.

The own HTTP API exposes POST `/v1/account/deletion/prepare`, `/confirm`, `/cancel`
and `/status`. It injects identity from the verified limited grant, rejects body
identity/channel/life selectors, projects fixed minimal results, sanitizes errors,
rechecks the same authority after async waits and sends no-store headers. Native
transactions lock the original life and bind a deferred commit fence. Status and
durable command replay cannot cross into a later product life. Ordinary product
credentials do not authenticate this API. Production composition is OFF by default
(`NAKH_DELETION_API_ENABLED=false`); enabling it requires configured worker
readiness, which is an assertion, not evidence of an actual operator drain.

Evidence includes twenty-way grant issuance/revocation, prepare/confirm/cancel
retries, immediate product denial versus limited status after tombstone, suppressed
audit rollback, owner/epoch/purpose substitution, real expiry at deferred commit
with a nontransactional fault-path witness, strict HTTP output/privacy, populated
schema-138 upgrade and complete-worker fixtures containing both grant purposes.
Local PostgreSQL cannot certify Redis: complete-worker Redis checks remain
mandatory in CI. No actual approved Return is exercised by privileged negative
epoch-corruption fixtures.

This increment does not finish M8. Trusted Telegram ingress/localization, approved
fresh GUEST Return and later-life Redis activation, historical proof validity after
real Return, executable controlled retention release, M8 telemetry/runbooks and
full interruption/load/recovery acceptance remain due. Retention release stays OFF
until real periods are approved. Provider/staging/PITR/DR/security/operator sign-offs
remain external. Full local checks and all six exact-head jobs are required before
the next increment.

## Historical repair: use the native retention expiry column in worker evidence

Worker feature `6e99523` passed quality and all four images in run `38586825585`.
Its native job failed in two new worker assertions: both queried `expires_at`
instead of migration 137's `retention_expires_at`. Both workflows had already
reached completed checkpoint eight and passed their earlier phase/Account checks.
This is not accepted complete workflow evidence: the assertions must also pass.
No later plan, load or recovery acceptance is claimed for the failed run.

Review also corrected a later, previously unreached assertion: the owned-token
adapter returns `undefined` for unavailable authority, while raw Redis returns
`null` for a missing physical key. Both contracts are now checked independently.
The fixtures assert successful token/session admission and final native session
revocation, preventing an empty fixture from impersonating cleanup evidence.

The repair uses the correct column without changing the asserted retention policy,
worker behavior, schema, test volume or acceptance limits. An isolated native
schema probe reproduced error 42703 for the old query and successfully executed
the corrected query. It proves SQL compatibility only, not actual Redis cleanup.
Measured native-suite durations from the failed run now replace the provisional
worker estimate: 35,874 ms for the two failed worker assertions and 396,935 ms
for the fifteen passing final-verification cases. Provenance explicitly retains
the failed overall result. These values influence dispatch only and cannot
certify coverage or replace any acceptance gate.

The exact repair head still requires all 1,150 native cases in 141 files with zero
skips/failures, full project checks and all six CI jobs before further feature work.


## Current increment: bounded native and worker deletion composition

Accepted repair `d7d8c2e` passed all six jobs in run `38573877417`: all 1,147
native cases in 140 files, zero skips; all 27 plans at 20,000 scale, terminal
integrity 1,310.265 ms; support load, backup/restore and actual collector/privacy
rehearsal passed. All three saved artifact SHA-256 values match GitHub digests.

The application poller claims one native 120-second lease per poll and prevents
local overlap. A fixed stage executor composes shared closure, authenticated
capture/source archival, ordinary product and financial cleanup, media provider
work, native session and Redis cleanup, pending-policy manifests and final
verification. Each poll performs at most one effective bounded resource/provider
operation, plus fixed empty-resource checks. Empty scans never authorize phase
completion; native independent checkpoint functions still own every transition.
Missing captures/provider effects wait or retry with a sanitized code and real
backoff. A response lost after commit cannot undo a checkpoint. Shutdown stops
polling and drains the current step before closing providers or the database.

The production worker composes real R2, cache-revocation and Redis adapters.
`NAKH_DELETION_WORKER_ENABLED` defaults to false. Enabling requires cache purge,
a 64-character `NAKH_DELETION_CUTOVER_EVIDENCE_HASH`, dedicated R2 credential
references and `NAKH_DELETION_EVIDENCE_KEY_RING_REF`. The hash records a trusted
operator assertion; its format is not proof that producers were drained. Actual
drain approval, provider permissions, staging and recovery approvals remain
external. No deployment or ingress switch is enabled by this implementation.

The key-ring secret is a JSON array of at most 16 entries with exactly `keyId`,
`keyVersion`, and canonical 32-byte base64url `key`. Preload active and historical
versions required by retained captures. IDs use the existing report-key grammar;
duplicate identities, malformed entries and secret-shaped failures are rejected
without echoing key material. Dedicated deletion R2 credentials need source reads,
private evidence writes and ordinary-object deletion; private evidence is never
released by this worker. Verify actual scoped credentials before deployment.

Evidence includes a complete native admission-to-checkpoint-eight workflow,
local poll overlap/shutdown/authority/privacy tests and key rotation. New real
Redis worker cases cover complete session/provider composition and twenty
competing workers; they run in CI, not against a simulated local Redis. The
native fixture without assets/captures does not certify R2 or producer drain.
The minimum native inventory increases to 1,150 cases in 141 files. A provisional
120-second dispatch estimate for the new worker suite is scheduling only, not a
measurement or acceptance assertion. Existing volumes and all gates remain.

Own HTTP/Telegram deletion and Return ingress, approved fresh Return and later-life
Redis activation, full entity/interruption/load/telemetry acceptance and external
operator sign-offs remain M8 work. Retained-data release stays disabled pending
approved periods. Do not mark M8 complete after this increment.


## Current repair: complete final-verification evidence within existing gates

Commit `27d14dc` passed quality and all four image jobs in run `38567949306`.
All 140 native files ran: 1,139 cases passed and four failed. The new actual
Redis/native final-completion case passed, as did 13 of 14 final native cases
and the populated migration upgrade. The head is not accepted as green.

Two Redis-suite failures came from subsequent setup attempting to mutate already
completed work. Setup now isolates only unfinished work; a real native probe
reproduced error 55000 for the old setup and proved the repaired setup preserves
completed checkpoint eight. The final deferred-expiry probe expired during its
prechecks before reaching the test trigger. It now uses a ten-second admission
lease and waits inside that trigger until the actual recorded expiry plus a
margin. The nontransactional sequence must prove the deferred path was reached;
rollback and successful recovery remain required, with no fake clock.

One existing pending-credit proof case exceeded its unchanged 60-second case
limit while combining eight independent faults and all their twenty-way races.
Two explicit batches retain every fault, scan, restoration and successful replay.
Each starts with sender-life so canonical first-observation audit checks remain
identical. This adds four cases and repeats the first fault; it drops none. The
native floor increases to 1,147 cases in 140 files, zero failures/skips required.

The new final suite took 346,759 ms; its unknown-file dispatch estimate had been
30,000 ms. That measured duration now informs balancing, with explicit failed-run
provenance and no acceptance authority. The same three isolated contexts, six
public jobs, all plan/load/recovery gates and twenty-minute job limit remain.
The later performance artifacts were absent because native integration failed;
no downstream acceptance is claimed. Full checks and all six repair-head jobs
are required before further feature work.


## Current increment: fresh final verification and atomic completion

Accepted base `e50b969` passed all six jobs in run `38560803736`:
1,127 native cases in 139 files, three isolated contexts, zero skips; all 27
query plans at 20,000 scale (terminal integrity 1,476.611 ms, below the unchanged
1,500 ms gate); support load, backup/restore smoke and actual collector/privacy
rehearsal passed. Delivery/routing and production recovery approval remain external.

Migration 138 introduces a fresh six-stage provider cycle at verification/7.
Its prepared audit binds checkpoint seven while preserving original phase-five
13-key audit bytes. Revisions remain one immutable chain; namespace, original
product life, cutover evidence and native lease checks remain required. Historical
reconciliation selects the terminal page as of its original timestamp, so later
verification cannot rewrite or invalidate that proof.

Completion independently checks all prior cleanup, the current catalog, retained
record descriptors, native sessions, stable identity minimization and a fresh
terminal provider pass. Reconciliation, completion audit/event, receipt, Root and
work checkpoint eight commit together. Missing writes and lease expiry roll back.
Completion leaves the account deleted and reactivation disabled. Retention release
remains disabled pending approved periods. This increment does not complete M8:
separate approved fresh Return, later-life Redis authority, runtime composition,
telemetry and remaining full acceptance evidence still require implementation.

New evidence includes twenty concurrent claims/observations/completion retries,
lost response and lease generation recovery, six suppressed-write boundaries,
real deferred lease expiry, independent manifest/username corruption, populated
137 upgrade preservation, and actual Redis/native final composition. Local native
observations are fixture inputs, never evidence of actual Redis cleanup or producer
drain. Real Redis composition runs in CI; no production drain approval is inferred.
Full checks and all six exact-head jobs must pass before the next feature.



## Current repair: preserve all acceptance work with three isolated native contexts

Run `38554674643` on `d0e724a` passed quality, the actual collector/privacy
rehearsal and all four image builds. Native integration completed successfully:
1,127 cases in all 139 files, zero skips, inventory digest
`b6c3d0db841d17568fff6c51aa021a4f84f1ad323aa271f121087685d0a150d2`.
The complete native step still took 16 minutes 50 seconds. The job reached its
unchanged 20-minute limit during M7 query-plan testing; the later support load
and backup/restore checks did not run. This head is not accepted as green.

The repair retains duration-balanced dispatch and adds a third isolated native
PostgreSQL/Redis context inside the same reliability job. There are still six
public CI jobs. Each native child has one worker; performance/load/recovery
checks still run after all native children finish. The file inventory, minimum
1,127 cases, zero failed/skipped cases, exact-once complete coverage and all
existing volumes, indexes, thresholds and the 20-minute cap remain required.
Two reports cannot authorize completion of a three-context run.

Redis database 15 remains reserved for the composed HTTP/Redis fixture. The
ordinary three contexts use distinct databases, including at the maximum
accepted base; configurations that could overlap the reserved database fail
before execution. Planning estimates now use all 139 actually completed suite
timings from the failed overall run, explicitly recording that only its native
coverage passed. They are not performance acceptance and never exclude files.
The real CLI selection probe covers all 139 files exactly once across the three
contexts. Full checks and all six exact-head jobs remain required before further
M8 feature work; no migration or product behavior changes in this repair.


## Current repair: balance complete native dispatch within existing limits

Feature `c186dee` passed local full checks and 89 targeted native cases. In run
`38546893913`, the collector initially failed before startup with an unknown
image-pull error. One unchanged quality replay after the original run became
terminal passed the project, dependency, actual collector/privacy and deployment
checks. The unknown original cause is not relabeled transient or erased.

The native job reached its existing 20-minute limit. All 14 retention cases
passed, but full native coverage, performance/load gates and recovery were not
reached. Missing downstream artifacts are consequences, not accepted evidence.
The head is not green and no later M8 feature may proceed from it.

The old filename-hash partition does not balance runtime. Recorded green-run
suite durations plus the observed new suite estimate give 858,663 ms versus
366,045 ms in its two groups. Deterministic duration-based dispatch gives
612,347 ms versus 612,361 ms using the same inputs. These are scheduling estimates,
not measured performance acceptance. New unmeasured suites receive an estimate
and still execute; estimates cannot exclude or authorize a test.

The same two isolated PostgreSQL/Redis contexts, one worker per child, all 139
files, minimum 1,127 native cases, zero skipped/failed cases, unique complete
inventory proof, 20-minute job limit and all existing performance/load/recovery
checks remain required. The real Vitest file-selection probe confirms 70 plus
69 files, exactly once with no omissions or overlap. Four new dispatcher cases
cover deterministic balance, unmeasured files, invalid input and preservation of
independent coverage authority. Full checks and all six exact-head jobs remain
required for this repair before further feature implementation.

An extra root-project type check also exposed two legacy M3 synthetic fixture
queries missing Kysely's required query identifier. Both now provide an opaque
identifier; their SQL, parameters, trigger-restoration assertion, fixture volume
and query-plan acceptance remain unchanged.



## Current increment: provisional retention manifest and checkpoint

Commit `5624d53` passed all six jobs in run `38539338959`, attempt 1.
The native artifact proves 1,112 cases in 138 files with zero skips. All 27
unchanged 20,000-row plans passed; terminal integrity took 1,157.785 ms against
1,500 ms, with both required indexes and no temporary blocks. Support load,
backup/restore and the actual collector privacy rehearsal passed. CloudWatch
metric delivery and SNS routing remain external evidence, not certified here.

Migration 137 adds `identity.data_retention_records`, bringing exact coverage to
153 tables, 1,419 columns and 307 foreign keys. Ten categories are inventoried per
native fenced transaction. The immutable migration snapshot binds every reviewed
table, column, foreign key, disposition, purpose and subject scope. New or changed
unclassified schema blocks both admission and the independent checkpoint.

Each descriptor-only record binds the original Root/life, resource category,
restricted access purpose, historical linked-presence observation (or explicit
unknown for global typed obligations), registry hash, native clock and exact
worker generation. An immutable audit digest authenticates every record field.
The manifest contains no copied messages, payment payloads, credentials, object
keys or provider bodies. Historical presence is an observation, not a continuing
absence assertion; the checkpoint independently rechecks current ordinary-data,
media, session and ephemeral obligations through their native verifiers.

No retention periods have been approved. Affected entries explicitly say
`pending_approval`; null expiry is not a claim of justified indefinite retention.
These are provisional inventory records, not approved production retention
schedules. Existing purpose-specific access controls remain required. Both
retained-data release and mutation of these records are disabled. Reference-only
categories are marked separately; no product-deletion proof deletes financial,
safety, workforce, stable-identity or lifecycle authority.

The separate checkpoint requires the complete authenticated manifest plus all
prior native proofs, and atomically writes audit, event, receipt, Root and work.
It advances only phase 6 to phase 7. Deletion remains incomplete, Return remains
disabled and final verification/service composition/acceptance work is still due.
Concurrency, interruption/new-generation recovery, suppressed mandatory writes,
schema drift, immutable policy controls, corrupted history and actual deferred
lease expiry are covered by native integration cases. Upgrade from populated
schema 136 preserves existing facts and creates no invented retention records.
Full project checks and all six exact-head CI jobs remain required for this head.

## Current increment: durable ephemeral cleanup and checkpoint

Repair `407bd04` passed all six jobs in run `38527306206`, attempt 1. Its native
artifact proves 1,081 cases in 135 files with zero skips. All 27 unchanged
20,000-row plans passed; terminal integrity took 957.016 ms against 1,500 ms,
with the required indexes, one worker and no temporary blocks. Support load,
backup/restore and the actual collector privacy rehearsal passed. The failed
`4a42d7d` head is superseded; it did not reach performance or recovery gates.

Migration 136 adds immutable original-Root ephemeral page receipts. Prepared
native intent commits before provider work. Native lease/current-life checks
surround provider waits, bind observations to the exact cursor and revision,
and recheck the database clock at deferred commit. A concurrent claimant cannot
allocate a second operation for the same revision and generation. A restarted
worker uses a new generation without fabricating an earlier provider outcome.

Removal and independent read-only verification each start a complete cursor
cycle for owned state, legacy state and queue transport. Findings persist across
all pages and force a new cleanup/verification cycle. An index, fence, empty
batch, busy claim or terminal cursor does not authorize completion. Physical
owned orphan values are included; counterpart life state and current workforce
UI references remain independent. Lost/expiring fences produce blockers and
require renewed removal plus a fresh independent verification pass.

The queue pass normalizes only canonically authorized legacy jobs, preserves
active/changed jobs, minimizes ordinary diagnostic/log/event clones and verifies
reference envelopes and control metadata independently. Physical resource batches
remain bounded to 100, event removals to 100 entries, and atomic control/history
reads have a fixed 100,000-entry ceiling. Unknown families fail closed. New worker
failures persist only reviewed coarse codes and no stack/cause; retry attempts,
backoff and canonical financial/inbox authority are unchanged.

The checkpoint independently rechecks native session authority, all earlier
media/product/evidence obligations and the complete immutable pass chain. A
mandatory reverified-intent summary binds original preparation digests and the
last independent proof. This acknowledges uncertain intent without inventing
an original removal count or rewriting its observation. Required audit/event/
receipt/Root/work writes commit together, advancing only phase 5 to phase 6.

Trusted deployment composition must supply the hash of actual operator evidence
that old producers were drained. A hash is an assertion reference, not a scan or
test proving a real deployment. Do not use fixture hashes in deployment. Full
worker/scheduler/HTTP/Telegram composition, retained manifests, final verification,
approved fresh Return and remaining M8 acceptance work are still required.
Retained-data release stays disabled; no retention periods or external staging,
PITR/DR, security review or operator sign-offs are fabricated by this increment.


## Current increment: audited retirement of legacy opaque state

Repair `feeeda7` passed all six jobs in run `38509390470`, attempt 1. Its native
artifact proves 1,046 cases in 131 files with zero skips, including all three
actual Redis/HTTP cases. All 27 full-volume plans passed; terminal integrity took
1,493.327 ms against the unchanged 1,500 ms limit, using the required indexes.
Support load, backup/restore and the actual collector privacy rehearsal passed.
The initial collector image-pull failure on `9e6f875` had an unknown provider
cause; one unchanged quality control passed. No privacy or startup assertion was
relaxed. The separate native import failure was repaired before this increment.

Current unowned administration/UI state uses `:action-v2:` and never falls back
to `:action:`. Account-life-owned values keep their separate namespaces. Explicit
v1 compatibility writers check the permanent retirement fence and write in one
Redis operation; their readers also reject retired state. Existing pre-cutover
runtimes must be drained before enabling deletion. The cutover is global because
old ciphertext has no authenticated user ownership roster. It removes opaque
values without reading, decrypting or inferring ownership from their bodies.

Each removal batch requires native immutable authorization before installing the
fence or deleting at most 100 values. Native observations record only counts,
namespace/progress hashes and a finite continuation flag. Identical twenty-way
observation retries append one fact; changed observations fail closed. A missing
observation remains uncertain intent. A separate read-only physical scan must
start at zero, retain every page and report no findings under a permanent fence;
an arbitrary cursor, zero removal count or fence alone is not completion proof.
Current UI and owning-life bodies remain outside the retired namespace.

Five new native audit cases passed locally, covering concurrency, immutability,
bounds, captured observation data and mandatory-write rollback. Eight Redis cases and three composed native
Redis cases require full CI services. The native floor is 1,062 cases in 134 files.
Full project checks and all six exact-head jobs remain required for this candidate.
No DDL is introduced; schema 134 and the catalog inventory are unchanged.

The [cutover runbook](../../deploy/runbooks/m8-ephemeral-cutover.md) describes
runtime drain, interruption and independent verification. This provider operation
does not advance a deletion Root. Durable full-pass/producer-drain coordination,
uncertain-intent reconciliation, bounded native session revocation, complete queue
verification and the independent ephemeral checkpoint remain required. Policy
manifests, final verification and approved fresh Return remain later M8 work.
Retained-data release stays disabled pending approved retention periods.

## Current repair: explicit HTTP integration dependency

Commit `9e6f875` passed local full checks, GitHub full quality checks and all four
image builds. Native CI ran 1,043 cases successfully, including the eight new
native-session cases, but could not import the new three-case HTTP/Redis suite:
the API package did not declare its test-only Redis workspace adapter. The repair
adds that explicit development dependency and its exact workspace lockfile link.
No external dependency version, production authorization, test case or acceptance
floor changes. A frozen offline install and resolution from the API package verify
the dependency contract; the repaired head still requires full checks and six CI jobs.

The independent quality failure occurred before metric export, during the pinned
public collector image pull. Its finite diagnostic was `collector_startup_unknown`;
the exact provider cause remains unknown. The first failure log is preserved and
one unchanged completed-quality-job diagnostic rerun was requested. No collector
assertion, privacy policy, image or retry classification is relaxed. The failed
native run did not reach plan/load/recovery gates and is not accepted evidence.

## Current increment: original-life native HTTP sessions

Commit `42a03c9` passed all six jobs in run `38498425380`, attempt 1.
Its native artifact proves 1,035 cases in 129 files without skips. All 27
full-volume plans passed; terminal sampling took 940.650 ms against the unchanged
1,500 ms limit, with the required indexes, one worker and no temporary blocks.
Support load, backup/restore and the actual collector privacy rehearsal passed.

The native session host now authenticates user credentials against original-life
session grants. AES-GCM credentials carry only an encrypted grant ID, owner and
original product epoch; neither bearer nor bearer hash is persisted. Immutable
security audits establish the fixed fifteen-minute grant and its revocation.
Twenty issuance retries share one grant and expiry, and twenty revocations append
one revocation fact. Retrying issuance cannot refresh or revive a revoked grant.
Issuance is internal to a trusted primary-authentication host which must capture
the life before asynchronous waits; there is no public mint endpoint or client
selection of the epoch. Legacy actor-only user verifiers fail closed.

The HTTP boundary retains the authenticated life and exact grant, rejects client
scope fields and reauthenticates the original bearer before releasing a result.
Report, support and appeal factories issue owner/life MACs in owned Redis state.
Native writes validate the captured epoch and live session under their existing
Account lock protocol before effects. Report preparation locks the reporter's
Account, while submission preserves canonical two-account lock ordering. Durable
initial-life report digests remain compatible; later lives cannot replay those
retained safety receipts. A replacement session in the same life can still replay
its own business receipt after cache loss.

Authenticator enrollment, confirmation and administrator-session admission also
recheck the original user first factor under native User/Account locks. Issued
workforce sessions retain their independent MFA/RBAC policy. The separate audited
unban permission and retained safety history remain mandatory.

Focused unit evidence covers credential tampering, wrong key/audience, original
scope capture, revoked-result withholding and transport propagation. Native probes
cover grant concurrency, actual Root admission, audit rollback/immutability,
report retry concurrency and stale first-factor denial. Three actual Redis/HTTP
cases require the full CI service: delayed write revocation, withheld response
and actual Root fencing, and report-reference owner/life isolation. Privileged
epoch changes are fault fixtures, not approved Return evidence. The native floor
is 1,046 cases in 131 files. Full project checks and all six exact-head jobs remain
required before this candidate is accepted.

No DDL is introduced; schema 134 and the 150-table/1,381-column/298-FK inventory
are unchanged. This increment does not prove bounded Root session sweeping,
legacy cache producer drain/physical absence, independent ephemeral completion,
policy manifests, final lifecycle verification or approved Return. Those M8
obligations remain. Retained-data release remains disabled until policy periods
are approved, and actual provider/staging/PITR/DR/security/operator sign-offs
remain separate.

## Current increment: original-life safety contact and opaque references

Commit `be0ebe6` passed all six jobs in run `38492388865`, attempt 1. Its native
artifact proves 1,024 cases in 127 files without skips, including six native photo
cases and two actual Redis cases. All 27 full-volume plans passed; terminal
sampling took 1,255.026 ms against the unchanged 1,500 ms limit with both required
indexes, one worker and zero temporary blocks. Support load, backup/restore and
the actual thirteen-metric privacy rehearsal passed; actual CloudWatch/SNS and
operator acceptance remain external.

Telegram support/appeal ingress now captures native User/epoch before rate-limit
or handler waits. It creates per-life support and exact-ban reference issuers and
readers using the owning Redis namespace and independent owner/epoch MACs. The
initial life's deterministic command identity remains compatible; later lives
have distinct command identities. Provider/client epoch fields cannot supply
authority. Notice delivery retains the captured scope and rechecks native life
after catalog waits before sending.

Contact metadata and current-ban queries restrict the captured epoch. Support
admission/send check it under the existing User/Account protocol before replay;
the existing thread epoch also protects quota and cross-life sends. Appeal
submission locks the stable User and owning Account, then rejects a tombstone or
captured-life mismatch before returning a completed submission. Same-life M7
replay semantics remain; exactly one appeal belongs to its immutable ban event.
Review, separate unban permission/confirmation/auditing and retained safety facts
remain unchanged. A product epoch does not erase or relax lifetime safety history.

Local evidence includes thirty focused unit cases and twenty-one native cases in
four files, including the eight new original-life probes. Twenty submission
replays race six separately authorized unban commands: one account effect and six
attempt audits remain. Three real-Redis/composition cases require CI, including a
delayed actual ingress interrupted by an actual deletion tombstone
without provider delivery. Privileged epoch/Redis activation fixtures are
corruption probes and do not prove approved Return. Schema 134 and the catalog
inventory are unchanged. The full project check passed formatting, lint, all 17
workspace type checks, 1,030 unit tests in 221 files and builds. The native floor
is 1,035 cases in 129 files; all six exact-head jobs remain required for this candidate.

This increment binds the actual Telegram contact path. The opt-in HTTP service
factories, authenticated in-flight session scopes, legacy namespace absence,
ephemeral completion proof and later M8 phases still require implementation and
verification. Retained-data release and fresh Return remain disabled.

## Current increment: original-life photo management and menu references

Repair `4734bee` passed all six jobs in run `38484860156`, attempt 1. The native
artifact proves 1,016 cases in 125 files without skips. All 27 full-volume plans
passed; terminal sampling took 1,311.806 ms against the unchanged 1,500 ms limit,
with both original required indexes, one worker and zero temporary blocks. Shared
support load and backup/restore passed. This resolves the preceding failed heads
before further M8 implementation.

The actual Telegram photo adapter now captures native User and account epoch
before callback lookup, rate limiting or application waits. List and mutation
handlers forward that original epoch to the native store. The existing stable
User/Account lock order checks capability and epoch before receipt lookup or
Profile/media access. Mutation receipt hashes include the life authorized under
those locks; old-life replay cannot return a later-life result, and the same
command identity cannot cross lives. Legacy receipts without a life binding fail
closed on conflicting replay rather than being reinterpreted as new authority.

Production callback reads and menu issuers use the original-life Redis namespace
and an independently User/epoch-derived MAC. Delivery freezes the collection's
original scope before catalog/provider waits and rechecks native identity/life
before sending. Unscoped old callbacks require a fresh menu. Legacy cache cleanup
and complete ephemeral phase proofs remain separate obligations; a revoked token
or this runtime change does not authorize deletion completion or Return.

Thirty-eight focused unit cases and six new native cases passed locally, including
twenty-way replay, mismatch before required writes, old-life receipt rejection,
actual lock-wait fencing and an actual deletion tombstone. Two actual Redis cases
require CI and prove copied logical IDs cannot revive old signatures and twenty
revoked issuers cannot modify the newer life. Privileged epoch/Redis activation
fixtures are corruption probes, not approved native Return evidence. No schema
or inventory change is introduced. The full project check passed formatting, lint,
all 17 workspace type checks, 1,020 unit tests in 221 files and builds. The native
floor is 1,024 cases in 127 files; all six exact-head jobs remain required for this candidate.

## Current repair: shared actor-aware action sampling

Run `38477294295` on `0b6123d` passed quality, all four images and all
1,016 native cases in 125 files without skips. Terminal integrity sampling took
1,543.082 ms against the unchanged 1,500 ms limit. The covering index was used,
but did not resolve the performance failure. This head remains unaccepted.

The action source now scans both persisted actor classes together, sharing report
and notice membership work. Audit candidates still require the exact actor class,
administrator, request and command. System actions retain their independent
history rules and never obtain administrator attempt or restoration authority.
Administrator attempts, pair-target membership, restoration, notice and Report
bindings retain their original predicates and one-row-per-action cardinality.

All sixteen focused native integrity tests passed, including corruption,
restoration, duplicate and concurrent-read evidence. The full project check passed
formatting, lint, 17 workspace type checks, 1,015 unit tests in 221 files and builds.
All six exact-head CI jobs remain required. Required
indexes, fixture volumes, memory/worker settings and time limits are unchanged.
An isolated parallel-helper hypothesis was discarded: migration 84 already marks
the helper parallel-safe, so that probe made no meaningful change. No migration
or retained-data release/Return activation is introduced by this source repair.

On Windows, the unmodified failed-head measurement completed at 2,756.642 ms
for terminal sampling and 892.740 ms for terminal actions. The candidate completed
at 2,681.762 ms and 827.722 ms respectively, with the original required indexes,
one worker and zero temporary blocks. These are diagnostic measurements, not a
local performance-gate pass or proof of Linux CI acceptance. Two subsequent
custom module-override control probes failed fixture assertions (operational
health delta and encrypted capture volume); their cause is unresolved and they
are excluded from timing evidence. No production assertion was removed or changed.

## Current repair: covering exact account-action proof

Run `38471167381` on `d637d05` passed quality, all four images and all 1,015
native cases in 125 files without skips. Its terminal M7 statement still took
1,532.326 ms against the unchanged 1,500 ms limit. The failed run remains
preserved and is not a staging candidate. GitHub omitted step arrays, so completed
logs and the exact-head native/performance artifacts supply the gate diagnosis.

The normalized plan performs 20,000 administrator-attempt index lookups for
resolved episodes. Migration 134 adds a partial covering index on administrator
and command, including request, digest and target, restricted to succeeded
`moderation.apply-account-action` attempts targeting users. These are the exact
fields/predicates used by the existing resolution probe. No binding, accepted
result, role, fixture, index requirement, memory/worker setting or time limit is
removed or widened. Verification checks its complete keys, include columns,
predicate and ready/valid state. Entity inventory and retained-data release are
unchanged; no Return activation is introduced.

Populated migration 133 upgrade/bootstrap evidence, native integrity regressions,
full-volume index/timing evidence, the full project check and all six exact-head
jobs remain required. The native floor is 1,016 cases in 125 files.

## Current repair: indexed resolution existence and audit candidates

Commit `3b25802` failed run `38462089620` at the terminal M7 integrity gate:
1,546.493 ms against the unchanged 1,500 ms limit. All 1,015 native cases in
125 files passed without skips, including both new real-Redis lifetime tests.
Quality and all four images passed. Required indexes and one worker were present,
with no temporary blocks. Support load and backup/restore were skipped after
the failed gate; this head is not accepted as a complete green run.

Action checks now join the unique physical audit candidate by its primary key
and retain every original actor, administrator, request and command comparison.
Candidates are narrowed by exact actor class, while pair-target membership stays
independent so an invalid audit actor does not suppress otherwise valid attempt
evidence. No additional audit authority is inferred from existence alone.

Episode resolution retains one explicit validation fact for each resolved owner.
Its indexed existence probe checks exact episode/administrator/target/reason/time
bindings and succeeded account-action attempts bound to command, request, digest
and target. The existing per-owner index lookup is retained; the wide intermediate
CTE, tuple hash and duplicate grouping are removed while valid/invalid duplicate
existence and null rejection remain exact. Action aggregation uses
CASE to short-circuit already-invalid attempts before history/notice probes.
Complete scanner flags and one violation count per entity are unchanged. An
initial uncorrelated candidate lost the required resolution index and was rejected
before acceptance; that index requirement remains mandatory.

All sixteen native integrity/plan regressions passed with both changes, including
twelve additional single-field owner/attempt corruptions, repaired validity and
duplicate candidates. Full-volume comparison, full project checks and all six
exact-head CI jobs remain required. Fixtures, indexes, worker/memory settings,
limits, retained-data release and Return activation are unchanged.

## Current increment: original-life Liked By request and opaque ownership

Repair `31b0167` passed all six jobs in run `38453611944`, attempt 2. Its native
artifact proves 1,006 cases in 124 files, zero skips; the terminal integrity query
took 1,225.322 ms against the unchanged 1,500 ms limit. Load and backup/restore
passed. Attempt 1 failed while pulling the pinned collector image before startup
or metric export. Its finite diagnostic did not identify the registry cause. The
public manifest was available, and the unchanged failed quality job passed on
controlled re-execution, including the actual thirteen-metric privacy rehearsal.
The initial failure remains preserved; no underlying cause is claimed as proven.
Tracked source count for that accepted repair: 218,673.

The actual Liked By gateway resolves native user and account epoch together before
rate limiting or token work. It persists that frozen life with the durable request,
and the claimed worker forwards it to its native page read and reference factory.
Migration 133 rejects unresolved/nonzero legacy provenance rather than inferring
an old life from current dates or ownership. Admission locks the original user and
account and rejects a tombstone or epoch mismatch; owner and epoch are immutable
through lease claims, retries and delivery. The native page read checks that exact
epoch in its repeatable-read snapshot.

Gateway and worker reference factories use the account-life Redis provider and a
signature key derived from both user and epoch. Physical namespaces and signatures
are therefore bound independently: even deliberately reused logical identities
cannot revive an earlier-life token. The page handler selects one reference scope
before awaited media work and retains it through issuance. Later-life issuance
still requires separately approved native Return activation; no new activation
method or approval is introduced. Old unscoped callbacks fail closed and require
a refreshed screen; there is no fallback to their private cached bodies.

Twenty-way native replay, immutable-field corruption, stale admission, exact
provider identity, real tombstone and delayed-page epoch probes passed, along with
the existing delivery and catalog suites (21 cases). The populated 132 upgrade
probe tests rollback on ambiguous ownership and preservation of every old request
field when the original zero epoch is known. Two actual Redis cases test signature
isolation under logical-ID reuse and twenty delayed revoked-life issuers. Complete
project checks, migration evidence and six exact-head CI jobs remain required.
The native floor is 1,015 cases in 125 files. Other user-token runtime paths,
legacy-cache absence proof, the complete ephemeral checkpoint, release-disabled
retention manifests, completion/Return and full saga acceptance remain required.

## Current repair: separate administrator admission and restoration history

Commit `5e67a46` failed run `38447571466` after all 1,006 native cases in
124 files passed without skips. Quality and all four images passed. The terminal
M7 integrity statement took 1,555.047 ms against the unchanged 1,500 ms limit,
with its required indexes, one worker and no spill. Subsequent support load and
backup/restore steps were not reached; this head is not accepted evidence.

The repair separates administrator admission and restoration membership sets.
Admission hashes only the five exact identity/actor/reason/time/next-state fields;
restoration retains those fields and the exact previous-state binding. The former
synthetic admission class cannot equal a restoration state, so the branch dispatch
preserves membership semantics and duplicate-history handling while avoiding the
wider combined UNION hash. Null fields still fail closed. System authority,
restoration selection, audit/attempt/notice bindings, fixtures, indexes, workers
and all acceptance limits remain unchanged.

All sixteen native integrity and plan regressions passed, including corruption,
duplicate histories, review/unban bindings and pooled setting restoration. Full
project checks and six exact-head CI successes remain required before advancing.

## Current increment: audited inactive legacy queue migration

Reference delivery `75cc60d` passed all six jobs in run `38439921757`, including
986 native cases in 122 files without skips. The unchanged terminal M7 query
took 1,043.441 ms at full volume; all performance and backup/restore checks
passed. Tracked source count: 217,622. A duplicate push run was superseded by
the configured same-branch concurrency; only the completed six-success run is
accepted evidence.

The production worker runs one bounded legacy migration batch every five seconds
under a shared Redis lease. It preserves a resumable cursor and unexamined page
keys, so SCAN's advisory count cannot lose work or endlessly restart a page of
already-normalized jobs. At most 100 metadata entries are processed per call.
Active jobs are skipped; an atomic lock/byte comparison also catches a job that
became active or changed while native authorization was running. References with
private extra fields, wrong job/name bindings and foreign pending keys fail closed.

PostgreSQL authorizes each legacy body against its canonical record or independent
ordinary-source purge proof before mutation and requires an append-only prepared
audit. The audit stores only queue/body/reference digests and opaque job identity.
Native advisory locks converge concurrent preparation/observation retries. Outcome
audits retain normalized/already-reference/active/gone/changed facts. If Redis
normalization succeeds but observation fails, the old cursor is retained and the
next exact-reference pass reconciles its persisted preparation. A worker whose
lease expired cannot overwrite a newer cursor. Canonical financial/safety/lifecycle
facts are unchanged; no retained-data release or subject deletion completion is
granted by an operational format pass.

All six focused PostgreSQL cases passed, including twenty concurrent preparations
and observations, required-audit suppression, forged prose, lost observation,
privileged actor corruption and distinct queue namespaces. Production types pass.
Twelve real-Redis cases cover actual lock/byte races, concurrent scanners,
205-job/seven-item cursor recovery, audit failures, malformed references and
namespace isolation. Two combined PostgreSQL/Redis worker journeys prove native
authorization before normalization and recovery after a lost observation. Actual
CI Redis execution without skips remains required; no local Redis is available.
The native floor is now 1,006 cases in 124 files. The full project check passed
formatting, uncached lint, all 17 workspace types, 1,014 unit cases in 221 files
and every build. Four early focused-lint issues were diagnosed and fixed without
relaxing rules. All six exact-head jobs remain required before acceptance. Runtime opaque ownership and
legacy-cache handling, complete audited ephemeral phase verification, retention
manifests, completion/return and final saga/acceptance work remain M8 requirements.

## Current increment: reference-only production queue delivery

Redis revocation `cd856ed` passed all six jobs in run `38429146134`. Its native
artifact proves 966 cases in 119 files, zero skips and all twelve new real-Redis
cases. The unchanged terminal M7 statement took 1,237.117 ms against 1,500 ms;
all performance, support concurrency and backup/restore checks passed. Tracked
source count: 216,731.

The production worker now publishes bound outbox references, never complete
event bodies. References contain only event/schema and original aggregate IDs.
The consumer loads canonical PostgreSQL facts and validates every binding before
dispatch. A missing financial canonical record fails closed. Valid financial,
safety and lifecycle work remains available; proved product cancellation is
suppressed. Sample content cannot cross an immediate tombstone or original life,
and missing sample bodies require the independent immutable source-purge proof.
Live unresolved M0 actors retain their explicit original unresolved ownership.

During rolling transition, existing bodies must match canonical immutable facts
before normalization. The active worker replaces a validated legacy body with a
reference before application processing, so later processing failure/retry does
not retain its private clone. Changed reference/name/job bindings and changed
hydrated bodies fail before normalization. Newly queued references require a
hydrator; older consumer versions cannot execute them. Deploy the new consumer
before enabling deletion, and drain old producers before final legacy absence
verification. Inactive legacy-job sweep and the audited ephemeral checkpoint
remain required; processing normalization alone is not whole-queue completion.

All twelve focused PostgreSQL cases passed, including twenty concurrent reference
resolutions, exactly one projection, forged legacy prose/context/snapshots,
immediate real tombstones, actual audited source removal, lost/corrupt source
proof and financial availability after deletion. Queue and worker type checking
passed. Six real BullMQ cases and two combined PostgreSQL/Redis worker journeys
cover payload minimization, replay, normalization before failure, wrong hydration,
forged references and late delivery after source purge. No local Redis service
is available; these require actual CI execution without skips. Native coverage
now requires at least 986 cases in 122 files. The full project check passed
formatting, uncached lint, all 17 workspace types, 1,014 unit cases in 221 files
and every build after all six new-code lint errors were repaired. All six
exact-head jobs remain required before accepting this increment. M8 remains incomplete;
runtime opaque ownership/legacy cleanup, manifests, completion/return, full saga
composition and final acceptance are still required. Retained-data release is off.

## Current increment: bounded account-life Redis state revocation

Repair `9ab2ba2` passed all six jobs in run `38422566805`, including all 954
native cases in 118 files without skips. The unchanged full-volume terminal
integrity gate took 1,463.468 ms against 1,500 ms. All remaining performance,
support concurrency and backup/restore gates passed. Tracked count: 216,291.

The owning opaque-state adapter partitions values by a one-way User digest and
original product epoch. Physical values keep their existing byte/namespace
policy and native first-allocation TTL. A bounded metadata index never stores
state bodies. Atomic Lua allocation/read/revocation enforces the exact life;
revocation fences reads and late writes before removing at most 100 bodies.
Unknown later lives cannot initialize authority, and old-life cleanup cannot
revoke a separately activated newer life. Fresh return authorization remains
separate and disabled.

Index cleanup requires a complete independently resumed physical-namespace sweep.
Missing index references cannot prove absence, foreign entries fail closed before
body removal, and a SCAN page larger than its advisory count cannot exceed the
actual removal limit. The write-fence read alone is not completion evidence.
Commands remain compatible with staging Redis 7.1; no newer field-expiry command
or dependency/version change is required.

Twelve real-Redis cases cover isolation, first-write TTL, 205-value batching,
twenty concurrent revokers, racing late puts, corrupt foreign index entries,
physical orphans, oversize SCAN pages, unknown lives, stale-life cleanup,
malformed indexes and expired references. Local queue types pass; no local Redis
service is available, so native Redis success requires the actual CI service.
The full project check passed formatting, uncached lint, all 17 workspace types,
1,014 unit cases in 221 files and every build. The native CI floor increases to
966 cases in 119 files. All six exact-head jobs, including actual native Redis
execution without skips, remain required before acceptance.
The unscoped legacy adapter remains unchanged. Runtime owner binding, legacy
state handling, queue cleanup and the audited ephemeral checkpoint remain M8
work; this adapter alone does not authorize a phase advance or deletion ingress.

## Current repair: exact moderation attempt membership

Commit `408964a` passed quality, all four container builds and all 954 native
cases in 118 files without skips. Run `38414973628` failed the unchanged M7
query-plan gate: terminal integrity took 1,562.655 ms against 1,500 ms. Both
required indexes were present, one parallel worker launched and no disk spill
occurred. The previous green run measured 1,301.095 ms for that statement;
other dense statements also slowed. This commit is not accepted as green.

The repair replaces correlated administrator appeal-unban, review and Pair audit
existence probes with uncorrelated exact tuple membership. Every original ID,
command, target type, request, digest and result check remains. Tuple nulls still
fail closed through the enclosing boolean guard. No fixture volume, repeated
sample, required index, worker limit, deadline or timing threshold changes.

All 16 focused native integrity and plan cases passed, including exact review
and unban field drift, duplicate review audits, real Report-bound block/removal
and dismissal, concurrent sampling and current capture/custody corruption.
Independent fresh-database Windows controls at the unchanged 20,000-row volume
completed all fixture and repeated-sampling invariants. The failed-head terminal
statement took 2,860.926 ms; the repair took 2,714.404 ms. Both exceed the original
CI budget locally, so the comparison is diagnostic evidence, not gate acceptance.
The full project check passed formatting, uncached lint, all 17 workspace types,
1,014 unit cases in 221 files and every build after a local Windows Node runtime
crash was diagnosed and the ignored runtime helper was repaired. All six
exact-head jobs remain required before this repair is accepted. No further M8
feature starts from the failed run.

## Current increment: bounded synthetic source cleanup

Custody integration `e8ec365` passed all six jobs in run `38395234556`, including
942 native cases in 117 files without skips, all unchanged performance gates and
backup/restore. Tracked source count was 215,240 lines.

Migration 132 and the owning sample cleanup store remove the synthetic source,
its projection and private source-event copies. Each call processes one original
source and at most 100 event copies; a source remains until every event copy is
gone. Active publication leases wait, locked rows are skipped and retries resume
under the same checked deletion authority. Counterpart records remain intact.
Original actor/life and a one-way name fingerprint remain in a minimal immutable
reference. Legacy walking-skeleton actors without Accounts remain explicitly
unresolved; existing nonzero-life ownership is not guessed during migration.

Every partial/final batch requires the existing product audit/event chain. Final
removal also requires an immutable receipt digest covering the audit and original
event facts; delivery scheduling remains mutable. Missing source bodies without
that proof, wrong ownership/life, and corrupt receipts fail closed. Product
verification independently checks the original references. Source, projection
and publication writes cannot cross a tombstone or original life.

The final focused run passed 19 cleanup/catalog cases, including twenty retries,
205 event copies removed in 100/100/5 batches, active-lease waiting, required-write
suppression rollback, late-write denial and privileged ownership/life/source-loss
probes. All 38 walking-skeleton/product/operational regression cases then passed
on a fresh migrated database. Persistence type checking passed. The catalog now
covers 150 tables, 1,380 columns and 298 foreign keys.

All 63 populated upgrade/bootstrap cases passed, including upgrading from the
previous green migration 131 and replaying migration 132 without changes. The
full project check passed formatting, uncached lint, all 17 workspace types,
1,014 unit cases in 221 files and all builds. All six exact-head CI jobs remain
required before accepting this increment. M8 still requires ephemeral/queue
cleanup, retained-data manifests, final completion and safe return, runtime
composition and final acceptance evidence. Retained-data release stays disabled.

## Current increment: retained photo custody in moderation integrity

Repair `2731798` passed all six exact-head jobs in run `38391345733`. Its retained
native coverage artifact verifies 941 passes in 117 files, two isolated shards
and zero skips. Quality, all four images, every existing performance/load gate
and backup/restore passed. Tracked source count was 215,138 lines.

After legitimate media archival, the moderation integrity query previously
required the removed public asset and variant rows. It now uses the existing
owning source view, which independently authenticates the live original or the
verified private copy. Exact evidence, photo, asset, variant, thumbnail version
and content-hash bindings remain required; no public delivery fallback is added.

Native checks passed all 15 cases in the media and integrity suites. The actual
provider-removal journey preserves the encrypted capture and custody fingerprint,
keeps the current evidence health count unchanged and creates no false retention
finding. Corrupting private proof then increments that count, denies capture
access and media completion, and produces one metadata-only quarantine through
the actual reconciliation scanner. Repeated scans preserve one finding.

Migration 131 marks the existing stable private-proof function parallel safe.
Its body only reads permanent relations and snapshot-stable metadata; it changes
no state and acquires no locks. The verify script requires both properties, and
the populated upgrade matrix now includes migration 130 as a starting state.
Prior migrations, custody predicates and retention policies remain unchanged.
The final native run passed 77 cases in three files, including all 62 populated
upgrade/bootstrap cases and the media/integrity cases on migration 131. The full
project check passed uncached lint, all 17 workspace types, 1,014 unit tests in
221 files and all builds. The native CI baseline is now at least 942 cases.
All six exact-head CI jobs, including unchanged full-volume performance gates,
remain required for this increment. M8 remains incomplete: ephemeral cleanup,
demo/projection cleanup, retention manifests, final completion and safe return,
runtime composition and final acceptance evidence still remain. Retained-data
release stays disabled pending approved periods.

## Current repair: bounded CI work with complete native coverage

Head `ac8daf6` passed quality and three container jobs. All 941 native cases in
117 suites passed, and the repaired M3 setup and plan gate passed. PostgreSQL then
reached its existing 20-minute job deadline before M7/recovery could run. The
Telegram container independently reached its unchanged 30-minute deadline while
Corepack was preparing pinned pnpm 11.19.0, before dependency installation or
application compilation. Run `38368115357` is not accepted as green.

The CI-only integration runner executes the same unfiltered suite in two child
processes. Each child has a new migrated and verified PostgreSQL database and a
separate Redis logical database; files remain serial inside each child, preserving existing fixture and
race semantics. Coverage must include every discovered integration file exactly
once, at least the existing 941 cases, zero failures and zero skips. Missing JSON,
partial runs, duplicate/unexpected files and service absence fail closed before
later gates. Retained evidence contains only counts and a file-inventory digest;
full assertion reports remain temporary and are removed by exact file paths.
All six jobs and the 20/30-minute deadlines, all query/index/timing gates, fixture
volumes and load/recovery checks remain unchanged.

Corepack still verifies the same pinned package manager. Its download now has
three bounded attempts rather than hanging through the entire container deadline.
No application, schema, production permission or retention policy is changed.
Six coverage/environment unit cases and targeted uncached lint passed. The full
local check passed formatting, uncached lint, all 17 workspace type checks,
1,014 unit tests in 221 files and the complete build. Its first run stopped one
test worker after 1,012 passes; both omitted cases passed independently, and the
complete rerun used the local diagnostic Node engine mode without changing CI.

The local parallel native run selected all 941 cases in 117 files: 924 passed,
six failed and eleven were skipped because this Windows host has no Redis.
Two funded-Nakh corruption cases exceeded the unchanged 60-second test deadline;
later assertions observed inconsistent fixture state. The four corruption cases
then passed alone in 48.36 seconds. The complete funded-Nakh and unlock suites
passed all 90 cases without competing checks. Chat's first standalone attempt
encountered incompatible historical fixtures in the old local database during
migration; all 14 chat cases passed on a fresh migrated and verified database.
All 104 cases in the affected suites therefore passed independently. The precise
cause of the parallel run's later assertions is not established; neither skipped
providers nor targeted reruns count as complete native evidence.
All six exact repaired-head jobs remain required. M8 is still incomplete; this
increment only repairs CI reliability.


## Current repair: M3 missing-thumbnail corruption fixture

Repair `3f68ff9` passed quality (including collector privacy), all four container
jobs and every native test: 941 cases in 117 suites. Its PostgreSQL job then
failed during M3 matrix setup, before measuring any plan: the thumbnail-missing
fixture attempted ordinary physical deletion of twenty original variants. The
new owning archive guard correctly rejected that bypass with SQLSTATE 23514.
M1/M3 load passed; later plan/load/recovery gates did not run. Run `38357844508`
is not accepted as a green milestone.

The matrix still injects physical source loss for the same missing-thumbnail
case, using a transaction-local replica setting in its synthetic fixture only.
The script keeps every original matrix state, count assertion, production query,
volume and plan/index/timing limit. The same leased connection must report
normal origin authority after that transaction before plan measurement proceeds.
Production guard functions, migrations and account-removal permissions are
unchanged. The first repaired 5,000-user matrix and all three plan gates passed;
the explicit restoration check also passed. The full local check passed uncached lint, all 17 workspace types, 1,008 unit tests in 220 files and the full build. M3â€“M6 plans/load and the independent M7 concurrency load passed. All six repaired-head CI jobs remain required. M8 implementation remains incomplete.

The local 20,000-row M7 plan run missed two unchanged timing limits: integrity snapshot 2,039.836 ms and terminal snapshot 2,676.216 ms. One standalone control after the full check still missed them (1,976.210 / 2,633.049 ms). The original green source and 128-migration schema from a375b0f also missed them on this Windows host (2,000.461 / 2,721.258 ms). All required indexes and the worker were present, without disk spill. Relevant M7 query/gate sources are unchanged. The comparison does not demonstrate a new regression; the specific local cause remains unproven. No gate is relaxed, and Linux CI must verify performance before acceptance. The diagnostic reference dependency links were restored from main with the unchanged frozen lockfile.


## Current repair: R2 namespace test promise

Feature `b728d6b` passed all four container jobs, but exact-head CI quality
rejected one async-without-await callback in the new R2 namespace test.
The fixture now returns its provider response promise directly; its assertions,
actual adapter call and provider boundary are unchanged. Uncached targeted lint
passes. Local full check and all six repaired-head CI jobs remain required.
The prior Windows validation used a local lint cache; it did not catch this
fixture error, and the cache discrepancy has not been established. The repair
runs local lint without that cache. No production or CI lint rule is relaxed.
The completed original PostgreSQL job failed exactly the legacy signup fixture below: 940 native cases passed, one failed across 117 suites. Downstream plans/load/recovery did not run. This head is not accepted.

A local reproduction also found that the legacy signup fixture physically deleted an original variant to recover from a simulated deletion. The owning media guard correctly rejects that bypass. The fixture now preserves the original source, prepares a fresh asset, updates only its synthetic confirmation draft and obtains fresh eligibility through the real authority. All nine unfiltered identity integration cases passed. The final complete repair check passed uncached lint, all 17 workspace types, 1,008 unit tests in 220 files and the full build. Production guards and original assertions remain unchanged. All six repaired-head CI jobs remain required.


## Current increment: verified media removal and private report evidence

The preceding repair `a375b0f` passed all six exact-head CI jobs in run
`38270429765`, 930 native tests in 116 suites, all 27 unchanged M7 plans,
load, collector privacy and backup/restore. Its terminal snapshot took
1,266.602 ms against 1,500 ms with both required indexes. Tracked count was
212,158 lines. The failed `462769d` head is superseded by that verified repair.

Migrations 129â€“130 add immutable original asset/variant references, bounded
provider operations and audited source-removal receipts. The owning phase-4
worker preserves exact reported thumbnail bytes in a private evidence namespace
before deleting public quarantine, validated and variant objects. It verifies
provider absence, waits for cache purge acknowledgement and drains actual asset
namespaces, including unrecorded variants. Provider calls run outside database
transactions; observations require the current lease and commit fence.

Only independently authenticated private copies can replace the original source
facts for retained report readers. Existing administrator permission and access
audit checks remain required. Private evidence is not a normal delivery path.
Actual asset and variant body removal requires every provider observation and
source receipt; lost or corrupted proof denies replay and phase advancement.
Twenty concurrent retries archive once and complete one media checkpoint.
The transition reaches ephemeral_access/5 without authorizing Return or claiming
account deletion completion. Suppression of any required checkpoint audit,
event, receipt, root or work update rolls back the whole transition.

The complete populated upgrade matrix passed 61 cases through migration 130,
including populated baselines 128 and 129. Initial checkpoint testing found a
missing media phase in the receipt guard; the repaired guard passed concurrent
replay. A real adapter test found and repaired R2 prefix validation for exact
asset namespaces. Existing held-photo cleanup error wording is preserved.
Corrupted private evidence correctly fails at the earlier evidence verification
blocker. The final native run passed 20 cases in six media/photo suites; the operational/catalog regression passed 34 cases in three suites. The complete project check passed 1,008 unit tests in 220 files, all 17 workspace types and the full build. All six exact-head CI jobs remain required for this candidate. No volume, timeout, production CI runtime or assertion was weakened.

Ephemeral access revocation, bounded demo/projection cleanup, retention manifests,
final completion and safe Return, runtime composition and full M8 acceptance
remain required. Retained-data release and deletion ingress stay disabled;
retention periods and external staging/provider/operator approvals are unknown.


## Current repair: product-fence lock ordering

Commit `462769d` passed quality and all four image jobs, but PostgreSQL
integration failed five cases in four suites (924 passed, 929 total).
The new generic write fence acquired Accounts before later Match reference
pair/User locks, and Chat cleanup acquired a Chat before that Account fence.
The completed server log confirms both lock inversions. The notification-life
upgrade also lacked the newly nullable cancellation field in its old snapshot.
Downstream plan/load/recovery gates did not run; this head is not accepted.

Additive migration 128 retains migrations 126â€“127 unchanged. Match birth takes
the existing pair order before User/Account locks. Ordinary inserts lock User
before Account and recheck the verified product checkpoint. Updates already hold
the ordinary source row, which prevents a purge from verifying absence until
commit; they retain post-checkpoint rejection without taking late identity locks.
The derived Chat cleanup checkpoint relies on its actual nondeferrable live-Chat
FK: it cannot outlive body removal. Migration verification requires that FK.
The corrected notification snapshot compares every original field and requires
its new cancellation value to be NULL. No deadline, assertion or gate changed.

All 49 cases in the six focused repair suites passed, including each original
failed race and the original deletion/lease/rollback/catalog checks. The complete populated upgrade matrix passed all 59 cases, including migration
127. Both additional unfiltered runs passed all 18 M7 cases each. The complete
project check passed 997 unit tests in 219 files, all types and the full build.
All six repaired-head CI jobs remain required. M8 remains incomplete; no provider/Return/release or
external acceptance is claimed.

## Current increment: operational cancellation and verified product checkpoint

Commit `78ae245` passed all six exact-head CI jobs in run `38241459117`,
905 native tests in 115 suites, all 27 unchanged M7 plans, load gates,
collector privacy and backup/restore. The terminal snapshot took 1,463.044 ms
against 1,500 ms with both required indexes. Tracked source count was 209,870.

Migrations 126â€“127 classify reviewed minimum event shapes, preserve original
financial/safety/lifecycle channels and cancel ordinary publication under the
exact owning deletion lease. Cancellation keeps only already minimum transport
facts and requires source hashes, audit and event atomically. Active publisher
leases delay cancellation; canceled events cannot be claimed or acknowledged.
Unknown or prose-bearing shapes block verification rather than silently acquiring
retention authority. Immutable owning audits detect even complete loss of source
cancellation links. Historical proof survives expiry without granting new authority.

The product checkpoint verifies actual ordinary absence, original-life source
proof, authenticated zero-credit cutover, closed support scope and minimum
operational metadata before advancing from product_data/3 to media_objects/4.
Original references scope child checks even after parent body removal. Required
audit, event, receipt and both checkpoint writes roll back together. Late ordinary
writes lock the Account and recheck after waits; limited Return routing remains
available. Product completion and Return authorization are not set by phase 4.
Demo content currently blocks this checkpoint and still needs its bounded cleanup.

Provider deletion/absence, ephemeral invalidation, policy manifests, completion,
fresh safe Return, production composition and M8 acceptance remain required.
Retained-data release and deletion ingress remain disabled; no retention period,
external review, staging provider or operator approval is invented.

Final native verification passed 76 cases in six affected suites, followed by
30 final operational/checkpoint/catalog cases after strengthening active Account
locking. Twenty checkpoint retries advance exactly once. Real lease expiry at
deferred commit rolls back all progress; a new generation resumes. Every required
checkpoint write has a suppression/rollback probe. Original Match witnesses deny
lost pair receipts, and canceled source witnesses deny loss of every link.
The broad regression passed 157 of 158 cases: its one historical Flow snapshot
lacked the newly nullable outbox column. Corrected Flow, pending and Nakh snapshots
preserve every old field and require the new value to be NULL; all their affected
suites then passed. A SQL delimiter defect in the added proof helper failed before
commit and was repaired; all final bootstraps and verification passed. Full local
check passed 997 unit tests in 219 files, all types and the complete build. Final
fixture types and formatting/lint passed; all six exact-head
CI jobs remain required before acceptance. No assertion or gate was relaxed.

## Current increment: ordinary notifications and owned transport cleanup

Commit `8df6bdf` passed all six exact-head jobs in run `38223704037`,
889 native tests in 114 suites, all 27 unchanged M7 plans, load, collector
privacy and backup/restore. Its first terminal snapshot took 1,565.743 ms
against 1,500 ms; all required indexes and the worker were present, without
spill or hash batching. Every phase was 1.38â€“1.66 times slower than the prior
green run. Three local alternating old/new comparisons preserved counts but
showed no reliable gain from experimental query changes; all experiments were
discarded. One unchanged diagnostic CI rerun passed, with terminal snapshot
1,488.620 ms and both required indexes. Timing variation is an inference;
the original infrastructure cause is unproven. No gate, volume, sample count
or predicate was relaxed. Tracked source count was 208,379 lines.

Migrations 123â€“125 retain six original notification identity/life/safety fields
and a ten-field audited removal receipt, without copying payloads, templates,
deduplication text, message dates or provider message keys. Exact original
threshold-template/delivery qualification is captured as an episode identity.
Moderation's notice FK targets that immutable reference; new actions still
require the actual original-life notice. Historical safety readers recognize
only independently authenticated body removal, never normal rendering/access.

The owning phase-3 executor waits for active delivery leases/calls and original
Nakh source summaries, removes one body and its delivery rows atomically, and
requires receipt, audit, event and absence under the exact current full-XID
lease at commit. Lost proof denies replay. Retired IDs cannot be reinserted.
Late original payment success/correction keeps its original money/refund/event
facts but creates no product notice for a deleted or different-life payer.
The post-product insertion guard locks the Account and rechecks the checkpoint
after committing waits. Production advance past phase 3 remains unavailable.

Two bounded transport resources remove own cached command responses (including
system-owned registration responses linked by their typed `context.userId`)
and expired two-sided media authority. Expiry is preserved; no TTL or approved
retention period is invented. Response cleanup skips locked rows rather than
inverting command-admission response-before-User/Account locks. Provider message
receipts remain for later provider verification. Typed operational disposition,
the whole-product checkpoint, provider/ephemeral verification, retention records,
completion, safe Return, composition and acceptance evidence remain required.

Initial bootstrap passed 15 native schema/catalog/safety cases. The first broad
run passed 47 cases; its direct delivery lease fixture lacked the required
version increment. The next run passed 52 cases but its fence increment lacked
the required attempt claim. Replacing the fixture with genuine claim admission
preserves both production guards. A committing-checkpoint observer initially
searched uppercase SQL while the builder emits lowercase; its case-insensitive
observer now proves the actual lock wait and rejection. Final verification
passed all 54 cases in four suites, including sixteen new notice/transport
probes, actual MFA-authorized restriction preservation, twenty-way retries,
all mandatory-write rollback paths, expiry, lost proof, bounded cache drains,
registration scope, lock ordering and post-checkpoint insertion rejection.
The populated-migration/deletion regression passed all 156 cases in eleven
suites, including the full historical upgrade matrix. The final complete
project check passed all 966 unit tests in 218 files and the full build.
One repeat could not start its test helper under the Windows sandbox; its
authorized retry passed 961 tests but a worker exited before five existing M4
cases completed. That unchanged isolated suite passed all six tests, and the
subsequent complete check passed. The original worker exit cause is unproven;
no test assertion, safeguard or gate was relaxed. All six exact-head CI jobs
remain required before acceptance.

## Current increment: original Match lives and audited ordinary pair removal

Owned-unlock commit `c937298` passed all six exact-head CI jobs in run
`38217521523`, 877 native tests in 113 suites, all 27 unchanged M7 plans,
load gates, collector privacy and backup/restore. The terminal snapshot took
1,024.671 ms against 1,500 ms with both required indexes. Its first quality
attempt failed before export at collector image pull with an unknown startup
classification. One unchanged diagnostic rerun passed; the original pull cause
remains unidentified, and no retry classification or acceptance gate changed.
Tracked source count was 207,386 lines.

Migrations 121â€“122 preserve each Match's original participant epochs and replace
global historical pair uniqueness with uniqueness within those exact lives.
Legacy epochs are provably zero while Return remains disabled; ambiguous legacy
lives are rejected. New references are stamped under canonical pair/identity/
Account locks and require the original live sources. References remain immutable
and retired Match IDs cannot be reused.

The phase-3 pair executor removes one exact terminal ordinary pair after its
Match/Chat and Likes are archived and reporting windows have expired. A ten-field
immutable receipt binds the Match reference, root, full transaction, current
lease, audit and event. The deletion guard, required-write checks and deferred
proof all require actual removal and current authority. Active administrator
blocks remain retained safety facts. Original Unmatch consistency accepts only
the authenticated original removal proof, checks every historical Match life
and scopes live Likes to their original epochs. Missing receipts are discovered
through retained Match witnesses and denied rather than treated as empty replay.
Neither phase completion, fresh Return nor retained-data release is enabled.

The first test startup was blocked by local child-process permissions before
any database acceptance cases ran. The first native run identified missing
notification preferences in closed-Match fixture setup; the historical Unmatch
and both existing suites passed. Adding both participants' preferences restored
ten new probes; the later-life fixture then hit the existing mandatory two-
participant guard. Adding those actual participants corrects its setup without
relaxing the guard. Final native regressions, the genuine deferred expiry probe,
full project check and all six exact-head CI jobs remain required.

All twelve final new native probes passed, including both genuine terminal
closure paths, twenty-way removal, all four mandatory-write rollbacks, source
waiting/resumption, borrowed authority, lost receipts, original-life digest
corruption, distinct later Match identity and genuine deferred lease expiry.
The broader initial run passed 144 cases and found one stale catalog count.
All three reference suites' exact counts now match 142 tables, 1,316 columns
and 276 foreign keys. Replay additionally discovers missing Match closure
through retained original Match identities and owning archival witnesses.
The final-byte core regression passed all 145 cases in eleven suites, including
the complete populated-upgrade matrix, original unlock/Like/Flow references,
active blocks, Unmatch and survivor reporting. No migration checksum, schema
coverage predicate or production guard was bypassed.

Project verification diagnosed five empty-loop lint errors in the new fixture
and an automated migration-list update that incorrectly expanded a one-value
`toContain` assertion. Comments and the corrected matcher restored the intended
checks; the full check is rerunning and supplies acceptance only on success.
Affected funding, notification and lifetime dependency regressions and all six
exact-head CI jobs remain required before the next feature begins.

Final affected-dependency verification passed 120 cases in twelve further
suites, including original Stars/credit funding and replay, support closure,
financial cutover, pending/Nakh/Photo references and notification lifetimes.
Together with the core batch, 265 distinct native cases in 23 suites passed
with successful cleanup. The full `pnpm check` passed formatting, lint, all
seventeen type checks, all 966 unit tests in 218 suites and every build.
All six exact-head GitHub jobs remain required before any next feature begins.

## Current increment: original owned unlock removal

Repair `f667b21` passed all six exact-head CI jobs in run `38210198537`,
861 native tests in 112 suites, the repaired M4 gate, all 27 unchanged M7
plans, load checks, collector privacy and CI backup/restore. Terminal integrity
took 1,220.121 ms against 1,500 ms and retained both required indexes.

Migrations 119â€“120 retain only eight original financial identity fields for a
paid unlock and a ten-field audited removal receipt. New insertion requires
the original live scope and payer life; references are immutable and retired
IDs cannot be reused. Deleted payers' terminal grants can be removed under
their exact current phase-3 lease and full transaction ID. The counterpart's
financial history remains ineffective and unchanged. Original ledger and
Stars facts stay linked to minimal references; verified fulfillment replay
returns the original financial identity without recreating an access grant.
Required receipt, audit, event and body removal are checked individually and
at commit. Scope closure, original funding and historical audit proof are
separate, avoiding cyclic authority with Like archival. Empty replay discovers
credit witnesses and fulfilled Stars charges even after physical identity loss.
No phase completion, fresh Return or retained-data release is enabled.

The first migration draft's generator boundary was corrected during static
inspection before database execution. Initial native bootstrap ran the schema
and passed all three paid-action cases; eighteen deletion/catalog cases failed
because the new inventory's FK order did not match its exact canonical order.
A fresh catalog comparison found all 141 tables, 1,304 columns and 273 keys,
with no missing or additional key. Sorting the declared keys restored all
21 bootstrap/Like/funding/catalog cases without changing the production guard.

All fifteen final owned-unlock probes passed: genuine credits/Stars for Like
and Match, twenty-way removal/replay, exact financial/root/preview preservation,
counterpart ownership, four required-write rollbacks, borrowed authority,
immutable references and retired IDs, genuine deferred expiry, credit-life
corruption/restoration and fulfilled-Stars discovery after complete identity
loss. Before those cases, twenty migration races upgraded a genuine paid
legacy Like grant from 118 exactly once without changing its original fields,
ledger, balance or source. Full regression, project checks and all six exact-head
CI jobs remain required before this increment is accepted.

Lock-order review removed an unnecessary Nakh-counter acquisition from new
unlock insertion: paid-action writers already hold the pair before inserting
the grant, so acquiring a counter there would invert counter-before-pair Nakh
writers. The guard keeps pair-before-identity/Account locks and current-source
verification. Owned purge retains counter-before-pair order. Mixed-writer native
evidence and the final full checks are required for this repair within the feature.

The core batch passed 136 native cases in eight suites, including the new
mixed-writer probe. Editing the uncommitted insertion guard during an earlier
dependency run correctly triggered migration checksum protection; those
dependencies require fresh final-byte reruns. The first such rerun was
interrupted by a Windows PostgreSQL backend exception `0xC0000005` during
`commit`; the server automatically recovered and resumed connections. Its cause
is not established, and the failed cleanup/recovery logs supply no acceptance.
The standalone mixed-writer suite had passed all sixteen cases before its
cleanup connection reset. A serial fresh rerun remains required.

The first complete project check passed lint and all seventeen type checks but
lost one unit-test worker: 217 suites/960 tests passed, six target-selection
tests were unexecuted. Those six passed in isolation. The complete check is
rerunning with one local test worker, preserving all cases and deadlines;
neither runtime failure is treated as a green feature or bypassed assertion.

Recovered native verification passed all 111 dependency cases in twelve suites
and the standalone sixteen owned-unlock cases, including successful cleanup and
the real mixed-writer barrier. Together with the 136-case core batch, this is
247 distinct cases across twenty suites; repeated probes are not added to that
total. Final M4 full-volume compatibility and the complete serial project check
remain required, followed by all six exact-head CI jobs.

The final M4 compatibility gate passed all six required indexes and unchanged
limits at 5,000 rows. The serial project retry passed formatting, lint, all
seventeen type checks and all 966 unit tests in 218 suites with no lost worker;
every build and all six exact-head CI jobs remain required before committing
and accepting the increment.

The final complete serial check finished successfully through every build.
No production dependency, business predicate, concurrency count, test case or
deadline was relaxed by the local runtime recovery. All six exact-head GitHub
jobs remain required before the next M8 feature begins.

## Current repair: receiver-owned Like query-plan fixtures

Commit `2544d5c` passed local checks and five exact-head CI jobs in run
`38208211154`. GitHub PostgreSQL passed all 861 native tests in 112 suites,
then the M4 plan fixture was rejected by the new live Like ownership guard.
The fixture incorrectly made its unlock payer the Like sender; business rules
require the payer to be the Like receiver. The repair reverses the synthetic
Like direction while preserving the payer, invoice/refund ownership, 5,000-row
population, six exact indexed queries and unchanged 1,000 ms limit. No production
guard is changed. Downstream M5â€“M7 gates and backup/restore were skipped and
must pass on the repaired head before any next M8 feature begins.

The corrected local M4 gate passed against a fresh native PostgreSQL database
at the unchanged 5,000-row population and 100 due rows. All six queries used
their required indexes within the unchanged 1,000 ms limit. Its privacy-safe
plan artifact and completed log are retained. The full project check and all
six exact-head GitHub jobs remain required before accepting this repair.

The repaired full project check passed formatting, lint, all seventeen workspace
type checks, all 966 unit tests in 218 suites and every build. Only the synthetic
fixture direction and this diagnostic record changed; production ownership,
archival, lease and financial guards remain intact.

## Current increment: audited referenced Like removal

Commit `d452718` passed all six exact-head CI jobs in run `38204205601`,
851 native tests in 111 suites, all 27 unchanged M7 plans, load checks,
collector privacy and CI backup/restore. The terminal integrity snapshot took
1,490.02 ms against 1,500 ms and retained both required indexes.

Migration 118 removes one original referenced Like per current phase-3 lease.
Its ten-field immutable receipt binds only the original participant lives,
deletion root, full transaction ID, lease and mandatory audit/event. Raw status,
creation/closure times and content are not copied. Match sources must already
be archived; paid unlocks must be terminal and keep their complete original
ledger/payment rows. The Like FK for retained unlocks now targets the minimal
original reference, while new unlock insertion still requires the live Like.
Every required write/removal and commit-time fence is checked; damaged archival
or funding proof denies empty replay. This does not finish phase 3, activate
the whole worker, authorize fresh Return or release retained data.

The first eight native concurrency, mandatory-write rollback, expiry, forgery
and digest probes passed. Added real credit and Stars probes exposed an immediate
FK check preceding the existing after-insert reference creation. The repair
defers that FK to commit, where the reference remains mandatory and the original
live-source check still applies. Failed logs remain preserved; the repaired
funding cases, broader regression, complete project check and all six exact-head
CI jobs are required before acceptance.

Both genuine payment routes then passed. One concurrency fixture assumed that
twenty calls selecting the same candidate would necessarily remove both directions.
The bounded executor correctly returned `hasMore` after stale-candidate retries;
the repaired fixture runs twenty concurrent resumable drains and still requires
exactly two removals, two receipts and two audits. No production batching, lock
order, concurrency count or proof assertion is relaxed.

The repaired core regression passed 120 cases in seven suites, including all ten
new removal/funding probes, both referenced/unreferenced Like paths, native catalog
coverage and the full populated-upgrade matrix. A separate affected-dependency
batch passed 111 cases in twelve suites, including paid actions, Stars receipts,
notification scope fences, financial epochs, support and original references:
231 distinct native cases across nineteen suites. Final focused financial
corruption/restoration probes and the complete project/CI checks remain required.

The final ten-case run also passed corruption/restoration of the exact original
credit epoch and Stars receipt payer, denying empty replay while damaged and
accepting exact repair without restoring product bodies. The first full project
check stopped at nine test-code lint findings: helper return types and untyped
matcher values. Explicit helper types and exact database error strings replace
those values; the full repaired check remains required before committing.

The post-lint-repair native run passed all eighteen cases in the two edited
suites, including the final ten removal/funding cases and eight original Like
reference cases. The exact database rejection strings and final corruption
assertions are verified; repeated cases are not added to the 231 distinct total.

The repaired complete project check passed formatting, lint, all seventeen
workspace type checks, all 966 unit tests in 218 suites and every build. Local
runtime workarounds and the normal content cache do not change production code,
dependencies or assertions. All six exact-head CI jobs remain mandatory before
this increment is accepted and the next M8 feature starts.

## Current increment: audited original Flow archival

Reference commit `d3748c2` passed all six exact-head CI jobs in run `38197446763`,
835 native tests in 111 suites, all 27 unchanged M7 plans, load checks and CI
backup/restore. Terminal integrity took 1,443.387 ms against 1,500 ms with both
required indexes, one worker and no temporary blocks.

Migration 117 removes one original Flow only after delivered and pending bodies
have complete original archival, financial and refund proof. The minimal receipt
binds its original reference, deletion life, full transaction ID, exact current
worker lease and mandatory audit/event. Every write and deletion is checked, then
the complete fence, absence, financial closure and event are verified at commit.
Historical Flow authenticity deliberately does not call financial readers, avoiding
recursive proof; those readers use only verified original Flow lives after removal.
Missing or damaged archival remains visible to reconciliation and denies empty
replay. Current product admission still requires a live Flow and current Accounts.
Original financial records, minimal references, preview usage and root phases remain.
No phase completion, fresh Return or retained-data release is authorized.

Initial focused probes diagnosed an unsupported fixture lease and a callback
assertion that confused recorded receipts with separate correction/refund state.
An attempted quoted shell filter supplied no test evidence. Corrected funding and
terminal probes passed all six cases. The first commit-expiry probe renewed a lease,
which cannot shorten existing authority; its repaired fixture releases and claims
a genuine two-second lease. Failed logs remain preserved. Complete native regression,
populated upgrades, project checks and all six exact-head CI jobs remain required.

The complete first archival run passed 70 cases and failed four funding-matrix
cases, beginning with the unchanged 60-second deadline. A disposable copy of its
synthetic database compared complete proof readers with every predicate retained.
Caching the query plans preserved all four result sets: pending-reference execution
fell from 372 to 85 ms, terminal closure from 317 to 125 ms and delivered original
funding from 3,140 to 528 ms. This is local diagnostic evidence, not acceptance of
a production performance gate. The generated cached-reader definitions initially
lacked separators when combined into one migration; the corrected bootstrap then
ran all 74 archival cases successfully, including the original funding matrix and
all sixteen new Flow cases. No case, concurrency count or deadline was removed.
The initial local full check crashed in the bundled Node runtime during lint with
exit code 0x80000003. Its log is retained; an explicit inherited interpreter-mode
retry and the remaining migration/dependency/CI checks are still required.

The final native regression batches passed all 74 archival cases, 91 populated
migration/reference/registry cases and 82 affected financial, payment, reference
and reconciliation cases: 247 distinct tests in 17 suites. All four original funding
matrix cases passed within their unchanged deadline (46.6/30.3 seconds for credits,
46.2/28.5 for Stars). The inherited interpreter-mode project retry passed lint and
all workspace types but disabled WebAssembly at test-runner startup. A local-only
phase wrapper now confines that workaround to lint/types and leaves the test runner
in its normal runtime; the complete check must pass before committing. Neither
failed bootstrap nor runtime-startup output supplies acceptance evidence.

The final complete project check passed formatting, lint, all 17 workspace type
checks, all 966 unit tests in 218 suites and every build using that phase-specific
local runtime wrapper. Production code, dependency versions, test cases and limits
were unchanged by the workaround. All six exact-head CI jobs remain required before
this Flow archival increment is accepted or the next M8 feature starts.

## Current increment: minimal original Flow references

Repair `ffd2d5f` passed all six exact-head CI jobs in run `38193390260`,
all 823 native tests in 110 suites, all 27 unchanged query plans, load checks
and CI backup/restore. Terminal integrity took 1,207.14 ms against 1,500 ms,
retaining both required indexes, one worker and no temporary blocks.

Migration 116 records only the original Flow ID, sender, receiver and both
product epochs. Populated migration refuses disagreement with delivered or
pending original references. New Flow insertion creates its exact reference in
the same transaction; deferred guards reject missing or mismatched proof.
References are immutable, preserve original directional uniqueness per exact
participant lives and reject retired Flow ID reuse. Current Account admission,
ordinary Flow immutability and all original financial/source checks remain.
No timestamp, text, transport key or new funding authority is retained here.
Flow removal and historical financial readers require a later archival increment;
phase 3 is unfinished, return and retained-data release remain disabled.
Full local checks, native migration/concurrency evidence and all six exact-head
CI jobs remain required before acceptance.

Native verification passed 91 cases across five Flow/reference/registry/upgrade
suites, including all ten new Flow cases and populated paid/unpaid deleted lives
under twenty migration races. The affected dependency batch passed nine suites
with 60 cases; its archival suite passed 55 cases and timed out in the combined
Stars funding corruption matrix. That matrix also timed out in an isolated rerun.
Its complete pre-archival and archived matrices now run as independent lifecycle
cases with every fault, twenty-way retry, reconciliation/restoration assertion and
unchanged 60-second per-case limit retained. All 58 archival cases then passed,
giving 209 distinct passing native cases across 15 suites. The earlier type check
also caught a two-argument migration matcher; separate assertions preserve both
migration checks. Failed logs remain retained. No production proof or performance
gate is relaxed. The final full project check passed formatting, lint, all 17
workspace type checks, all 966 unit tests in 218 suites and every build. All six
exact-head CI jobs remain required before this increment is accepted.


## Current repair: narrow original threshold action candidates

Commit `d40fa82` passed the full local project check and five exact-head CI jobs
in run `38188219341`. PostgreSQL passed all 823 native tests in 110 suites and
26 of 27 query plans, but the terminal combined integrity sample took 1,537.587 ms
against the unchanged 1,500 ms limit. Both required indexes were present, one
worker launched, hashes used one batch and there was no temporary or disk spill.
Load and backup/restore were skipped; this head is not an accepted green commit.

Local paired diagnostics rejected larger action joins, shared actor lookups,
Report membership, batched resolutions, combined aggregation and predicate reordering
without consistent improvement. All were reverted. Batched resolution also lost a
required index. The shared-actor diagnostic ended with PostgreSQL `XX000` after its
paired samples; its cause is not established and that run supplies no acceptance.
The capture rehearsal already uses bounded batches; no memory-pressure cause is
claimed. Failed and rejected diagnostic evidence remains preserved.

The retained plan underestimated system-action candidates at 1,194 against 20,000
actual rows. The repair joins by the verified partial unique episode key and checks
all original administrator-null, target, Report, reason and millisecond-time bindings
in explicit flags. A wrong candidate retains precisely the original missing-binding
flags: only its missing-action finding is added; downstream history/audit/notice
flags are unchanged. Administrator restoration, witness, audit, notice and resolution
checks remain intact. No schema, retention policy or phase progress changes.

Three paired 20,000-row local comparisons retained every phase count and both required
indexes, one worker and zero temporary blocks. Candidate estimates improved from
1,143 to 12,229 for 20,000 actual rows; before/after execution was 3,008/2,918,
2,968/2,891 and 2,669/2,658 ms. These modest local improvements are diagnostics,
not acceptance against the CI limit. The four native suites passed all 19 tests,
including seven full-flag/scanner/count corruption-restoration probes. The initial
last probe attempted an illegal system ban and was rejected by the existing actor
constraint; the repaired probe uses a schema-valid administrator ban, with the
constraint unchanged. Missing/null audit/notice and wrong audit actor probes also
passed. Five additional native moderation, threshold and reconciliation suites
passed all 16 tests, for 35 tests in nine suites on this repair. The complete
project check subsequently passed formatting, lint, all 17 workspace type checks,
all 966 unit tests in 218 suites and every build. All six exact-head CI jobs remain
required before this repair is accepted or M8 feature work advances.
No time limit, fixture population, required index or policy approval is relaxed.

## Current increment: audited terminal unpaid pending body archival

Migration 115 removes one cancelled, expired or system-closed unpaid pending body
per owning phase-3 transaction. The immutable content-free receipt binds its
original version, expiry, terminal time and cancellation resolution to the original
participants, deletion life, full transaction ID, current lease and mandatory
audit/event. Complete original intent and captured-money/refund proof is required;
queued fulfillment cannot lose its target. Receipt insertion, body deletion, audit
and event are checked individually, then rechecked with the live lease at commit.
No Flow, financial record, lifetime preview usage or phase progress is removed.

The lifecycle reader preserves archived terminal sources and missing-proof
sentinels. Full reconciliation and shared financial blockers reject damaged
receipts, original references and refund ownership/amount. Current funding-health
observations count each affected pending or delivered entity once, including
repeated scans with an existing canonical anomaly. Restoring complete proof and
finishing a clean scan clears current health. Historical proof survives expired
transport and worker leases, without granting new removal authority.

The first isolated corruption run exposed a health counter that reported only
delivered funding findings. The counter and Flow reader were repaired; all five
terminal corruption/restoration cases then passed. The first combined run exposed
expensive verification of unrelated archived sources before participant filtering,
causing concurrent checkpoint conflicts. An explicit materialized participant
scope preserves every proof condition while evaluating full closure only for
the owning records. The unchanged timeouts and twenty-way race assertions remain
required. The failed logs are retained; no failed candidate was committed.

The first scoped rerun passed 79 tests and exposed three remaining failures:
the large action race still paid for unrelated pending lookups, and two original
funding tests expected only the delivered entity in health. Conservative candidate
discovery now precedes the lifecycle proof and includes an archived terminal
receipt's original deletion root; a candidate alone grants no authority. Damaged
pending and delivered entities count separately, while multiple findings for one
pending entity count once. The unchanged 205-action/twenty-retry test then passed.
A new receipt-before-expiry fixture initially expected the claimed worker state
instead of `receipt_recorded`; its corrected run uses actual admission, database
clock expiry and delayed worker correction, with one original refund and no delivery.

The complete original-funding corruption matrix subsequently exceeded its unchanged
60-second limit. A read-only plan measured repeated pending verification at about
3,000 ms; the base lifecycle scan took under 1 ms. Rolled-back comparisons retained
every predicate and identified repeated expansion of terminal receipt proof through
the readers. A cached complete predicate reduced diagnostic reference verification
from 894 to 290 ms and closure/bound-closure from 924/1,061 to 157/136 ms. This is
local diagnostic evidence, not CI performance acceptance. The full native matrix,
project check and six exact-head jobs remain required on the repaired candidate.

The optimized archival run passed 54 of 55 tests; the remaining exact-preservation
failure exposed JavaScript Date truncating native financial timestamp microseconds
in a physical-corruption restoration fixture. Restoring the exact saved native
timestamps retained the stronger assertion. The final complete 23-suite regression
run passed all 330 tests, including all 55 archival cases and the populated migration
matrix. A subsequently added focused native overlap test passed: ten archival calls
and ten genuine capture calls committed one body removal, one receipt and one
original payer/charge/amount refund without deadlock or new delivery. The other 55
cases were intentionally filtered in that focused run, not claimed as additional
passes. Receiver-owned historical proof also remains valid in Asia/Tehran after
transport loss and worker lease release. The first full project check stopped on
the fixture helper's missing explicit return type; its annotation was repaired
without changing runtime behavior. The fresh full project check passed formatting,
lint, all 17 workspace type checks, all 966 unit tests in 218 suites and every build.
All six exact-head CI jobs remain required before the next feature.

Populated migration evidence starts under 114 with an already archived paid source
and a live version-6 terminal unpaid source. Applying and replaying 115 preserves
their exact original financial, reference, Flow, root, account and preview facts
and the old paid receipt; it invents no terminal receipt or progress. The current
executor then archives the terminal source. Native acceptance passed as recorded
above; the full project check passed and six exact-head CI jobs remain required.

Catalog coverage is 136 tables, 1,261 columns and 257 foreign keys. Deploy 115 before
the new reader. Remaining product deletion, later checkpoints, media/provider and
ephemeral verification, manifests, fresh Return and worker/ingress composition
still require implementation and evidence. Retained-data release and fresh Return
remain disabled; no retention periods or external sign-offs have been supplied.

## Previous increment: audited paid pending body archival

Commit `09f1f92` passed the full project check (966 unit tests), the final 100-test
native rerun and all six exact-head CI jobs in run `38181487646`. CI passed 800
native tests in 110 suites, all 27 plans, concurrency load, collector privacy and
backup/restore. Initial integrity took 711.350 ms and terminal integrity 938.270 ms
against the unchanged 1,500 ms limit, with both required indexes, one worker,
zero temporary/disk spill and single-batch hashes. Its tracked count was 201,407.

Repair commit `d830409` passed the full project check (966 unit tests), 50 focused
native tests and all six exact-head jobs in CI run `38174316840`. The PostgreSQL
job passed 782 native tests in 110 suites, all 27 plans, load and backup/restore.
Initial integrity took 1,190.699 ms and terminal integrity 1,490.731 ms against
the unchanged 1,500 ms limit, with both required indexes, one worker and no spill.
The pinned collector conversion/privacy gate passed. This establishes the repair;
it does not establish the original failed public-image pull's underlying cause.
The tracked line count was 200,179.

Migration 114 permits one paid pending body per phase-3 transaction, only after
verified final delivered archival and complete original funding. Immutable
content-free receipts bind the original source version, expiry and paid time to
the full transaction ID, current lease, deletion root and mandatory audit/event.
Version 6 sources are supported; delivered-Nakh version limits are not reused.
The receipt digest uses canonical epoch microseconds so timezone changes cannot
invalidate historical proof. Old receipts, expired leases and client flags grant
no new removal authority. Reconciliation reads verified archived lifecycle facts;
a reference with neither a body nor receipt remains visible as an invalid sentinel.
Deploy this migration before the lifecycle reader. Catalog coverage becomes 135
tables, 1,246 columns and 254 foreign keys; retained-data release remains disabled.

New native deferred capture guards require the original payer/amount receipt,
provider event, fulfillment and exact event. A correction additionally requires
the original charge refund. They validate new pending-Nakh capture transactions,
without requiring deleted Profiles or ordinary message bodies. A second genuine
invoice prepared before settlement can therefore record captured money after
archival and create one original refund, without new delivery or credit effects.
Known fulfilled Stars retries still resolve to their original archived delivery.

Native evidence covers twenty archival races and twenty genuine late callback
retries per funding type, exact preserved money/reference/Flow/root/preview facts,
mandatory write suppression, forged fences, actual deferred event loss and lease
expiry, immutable proof and denied ordinary deletion. Altered audit/receipt and
physically missing receipt probes remain visible across repeated full scans and
deny funding replay, then restore clean health. The first lease-loss probe tried
an illegal owner mutation and was rejected immediately; the corrected probe uses
actual expiry to exercise commit-time validation. The populated 113-to-114 upgrade
and migration replay preserve all original facts, then archive the version 6 body.
Twenty requests split between both participant deletion roots archive once.
The broader run passed 250 tests; its remaining failures were outdated migration
totals and the exact rejecting guard expectation. The complete repaired four-suite
rerun passed 100 tests, including all historical migration baselines, original-life
rollback, archival and registry coverage. The complete local check and all six
exact-head CI jobs subsequently passed as recorded above.

This removes paid pending text only. Unpaid terminal pending sources, Flow/product
purge, remaining checkpoints, media/provider proofs and fresh Return still require
implementation and evidence. No financial row, retained identity or lifetime
preview allowance is removed; no retention period or external sign-off is invented.

## Current repair: collector diagnostics and narrow action integrity bindings

Commit `0b5fd5f` passed the complete local check (947 unit tests), targeted type/lint
checks and 290 native regressions. CI run `38168690693` passed all four images, but
quality failed before collector startup while pulling the pinned public image.
The PostgreSQL job passed 782 native tests in 110 suites, then failed the terminal
M7 integrity sample at 1,824.477 ms against the unchanged 1,500 ms limit. M7 load
and restore rehearsal were consequently skipped. Both failures require repair;
the four image successes do not establish a green head.
Its private log reports exit 1 with both output channels and the fixed unknown
classification. No SDK metric export or conversion/privacy assertions ran. The
underlying registry/runtime cause is not established; do not attribute it to an
HTTP status or transport fault without evidence. The GitHub job-rerun request
returned HTTP 403; this host has no usable local Docker runtime.

The repair exposes only a finite failure-kind vocabulary, never process text,
URLs, credentials or payload fragments. Recognized public-image transport errors
and HTTP 500 join the existing bounded transient policy: at most three unchanged
pulls with one- and two-second waits. Denial and missing-image precedence remain;
unsupported platforms, untrusted certificates and exhausted storage fail without
retry, as do unrecognized failures. Container startup, actual SDK export and all
conversion/privacy assertions still run once and must pass. Expanded focused
startup evidence passed 36 tests. The fresh complete project check passed 966 unit
tests in 218 suites, type checks and all builds. All six exact-head CI jobs remain
required for this repair.

Action integrity now uses narrow exact audit and notification membership tuples
instead of carrying their joined metadata rows through history/restoration joins.
Actor, administrator, physical reference, command, request, recipient, notice
type and empty payload bindings remain complete. Null or missing tuples fail
closed; unique physical IDs preserve one action row and entity count. Scanner
flags remain complete, including simultaneous failures. The latest prior-state
ordering, episode resolution proof and all other phases are unchanged.

The isolated Windows full-size comparison retained all 27 plans and both required
terminal indexes, one worker, no temporary blocks or disk sort, and single-batch
hashes. Combined terminal timing improved modestly from 2,639.252 to 2,522.139 ms;
this is diagnostic comparison, not Linux CI acceptance. Lower parallel costs,
additional episode materialization, report-first staging and restoration batching
did not improve the combined measurement and were discarded. No fixture volume,
required index, memory/worker cap or timing threshold is relaxed. Native corruption
and concurrent scanner/count regressions passed 50 tests across 12 native suites,
including real permission-checked separate Appeal unbans. Actual CI remains required; do not
claim the performance failure fixed until the unchanged gate passes.

Do not advance pending-body archival from the failed head. Existing funding
validation, migration 113 and retention restrictions remain intact. This repair
does not establish the original image-pull cause or complete M8 acceptance.

## Current increment: complete pending-backed funding proof

Migration 113 requires the exact original pending reference in both credit and
Stars funding predicates. Credit-backed settlement also requires its paid intent;
a removed credit-to-intent link cannot disguise an originally pending flow as a
direct credit payment. Genuine direct credit flows still pass without a pending
reference. Reconciliation evaluates complete funding binding in addition to its
existing independent life, reference and amount checks, preserving those flags'
meaning. Deploy migration 113 before this reader. No catalog tables, columns or
foreign keys change; coverage remains 134 tables, 1,232 columns and 250 keys.

Native probes use actual pending settlement with credits and actual test-environment
Stars receipt/fulfillment, followed by real deletion, evidence capture and delivered
source archival. They damage both participant epochs, the original intent link,
the reference or intent row, intent status/expiry and the credit-to-intent link.
Run them before and after delivered archival. Twenty competing archival attempts
must reject each unproven live source; twenty fulfilled Stars replays must reject
each unproven original chain. Repeated scans retain one canonical quarantine,
current funding health returns to zero after restoration, and source, money,
provider, fulfillment, account, root and preview facts remain unchanged.
Canonical anomaly detail retains its first observation; current health and full
funding validity independently detect later fault variants.

The first focused run lost an integration worker without an assertion failure or
an established cause. Preserve that unexpected-exit diagnostic. A fresh complete
run passed all 44 tests across four suites. The expanded status/expiry/link probes
and broader upgrade/financial regression matrix then passed all 290 tests across
23 suites, including thirty fault observations before and after delivered archival.
Full project checks and all six exact-head CI jobs remain required for this candidate.

Commit `8b2012b` passed the full local check (947 unit tests), 42 focused native
tests and all six jobs in CI run `38164991395`: 780 native tests across 110 suites,
all 27 plans, load, collector and backup/restore. Initial integrity took 1,159.438 ms
and terminal integrity 1,491.366 ms against the unchanged 1,500 ms limit, with both
required indexes, one worker and zero spill. Its tracked line count was 199,723.

This strengthens existing funding authority; it does not remove pending/Flow
bodies, grant refunds or complete a deletion checkpoint. Archived-charge
correction, remaining product resources and later deletion checkpoints still
require evidence. Fresh Return and retained-data release remain disabled.

## Current increment: missing pending payment records remain visible

Pending reconciliation now starts from each ordinary pending source and left joins
its payment intent. A physically missing intent cannot remove the entity from the
scan. Nullable payment fields fail the original binding and lifecycle status
checks; the existing quarantine findings record only pending status and the fixed
`missing` payment-status marker. No payment, refund, delivery or closure proof is
inferred from that marker. Closed-by-system sources still require their bound
closure, and now independently fail when the intent is absent.

Two isolated corruption cases remove the original intent from real unpaid and
credit-paid sources with deleted owners, complete two durable one-row scans each,
and require one canonical binding and status finding per source. Restoring the
intent restores original-reference validity; ordinary, financial, audit, counter
and preview facts remain identical. Replica-mode removal is a corruption probe,
not production deletion or retention-release authority. All 42 tests across four
focused native suites pass. Full project checks and all six exact-head CI jobs
remain required for this candidate.

The preceding reference commit `e949051` passed a fresh full check (947 unit tests)
and all six jobs in CI run `38162515614`: 778 native tests across 110 suites,
all 27 plans, load, collector and backup/restore. Initial integrity took 824.060 ms
and terminal integrity 1,067.263 ms against the unchanged 1,500 ms limit, with
both required indexes, one worker and zero spill. Its tracked line count was
199,618. The earlier local runtime failure remains diagnosed only as a native
breakpoint; the successful fresh check and CI do not establish its root cause.

Pending-backed credit funding must still require the exact original pending
reference before pending-body archival is introduced. Pending/Flow archival,
archived-charge correction and later deletion checkpoints remain outstanding.
Fresh Return and retained-data release remain disabled.

## Current increment: original pending Nakh references before body archival

Migration 112 adds seven-field original pending references: pending ID, flow ID,
sender/receiver IDs and original epochs, and payment-intent ID. It copies no body,
request hash, action key or lifecycle grant. Backfill requires the original flow
and exact intent owner/life, target, reason and expiry; existing delivered reference
identities must also agree. It does not infer a new life from current Account state.
New source creation automatically saves one reference and checks the complete
intent/source binding at deferred commit, allowing the intent to be written later
in that same transaction. References are immutable and cannot authorize source
reuse after source loss. Reconciliation checks the live pending entity's original
reference so a missing or altered reference remains visible as a binding fault.
Deploy migration 112 before the updated reconciliation reader.

Native evidence passed 40 tests across four suites, including all 12 new reference
cases: populated migration-111 unpaid and credit-paid sources with genuinely
deleted owners, twenty concurrent migration/replay attempts, twenty real creation
retries, seven borrowed reference fields, suppressed-reference rollback, identity
reuse after isolated source-loss corruption and repeated missing/wrong-life/intent
scans. Unsupported legacy target/life bindings fail without rewriting facts,
creating the new table or marking migration progress. Negative corruption uses
isolated replica-mode fixtures; it is not positive archival or fresh Return proof.
Ordinary pending-source deletion remains denied. The catalog has 134 tables,
1,232 columns and 250 classified foreign keys.

The first corruption probes used the wrong reconciliation call shape; fix them
to pass the actual run ID and batch limit as separate arguments. The targeted
linter rejected a cleanup-path throw inside `finally`; check the immutable
temporary path before operations instead, keeping recursive cleanup within that
validated temporary root. Broader regressions, the full project check and all six
exact-head CI jobs remain required for this candidate. The broader native run
passed 286 tests across 23 suites, including the populated upgrade matrix, ledger,
Stars fulfillment/correction, pending settlement, reference preservation, registry
coverage and deletion/evidence checkpoints. Targeted type and lint checks passed.
The first full check terminated in the Windows Node runtime during the linter's
unused-variable traversal (native breakpoint exit `0x80000003`), without a reported
lint-rule failure. Preserve its diagnostic separately and require a fresh complete
check before committing. The cause is not established; do not label it a code,
memory or antivirus defect without evidence.

Pending body removal, late captured-charge correction from archived identities and
flow archival remain separate required work. This reference increment grants no
deletion, delivery, credit or refund authority and completes no checkpoint. Fresh
Return and retained-data release remain disabled without their required proofs.

The preceding archival commit `9543c07` passed the full local check (947 unit tests),
260 focused native tests and all six jobs in CI run `38157525467`: 766 native tests
across 109 suites, all 27 plans, load, collector and backup/restore. Terminal
integrity took 1,456.408 ms against 1,500 ms, with both required indexes, one worker
and zero spill. Its tracked line count was 198,904. This is evidence for that head,
not complete M8 acceptance or external operator/staging approval.

## Current increment: bounded original funded Nakh archival

Migration 111 adds one-source archival batches with at most 100 ordinary rows
across receiver actions, history and the delivered source. A final immutable
receipt preserves original identities, funding references and lifecycle counts,
without Nakh body text, history request text or action idempotency keys. Partial
batches retain the live source and history. Each batch requires the original
phase-3 root, current account life, checkpoint and worker lease, completed evidence
capture, mandatory audit/outbox records and the native full transaction ID.
Deferred checks revalidate actual removal and the lease at commit. A previous
receipt or a still-valid lease cannot authorize another transaction's deletion.

Reconciliation reads live sources or verified final lifecycle facts. Financial
proof and original reference checks remain separate, so a damaged or missing
anchor cannot make an archived entity disappear from the scanner. Known fulfilled
Stars retries return the original delivered identity after validating retained
funding evidence. They create no new delivery. Historical flow, credit and payment
identities cannot be reused for a new source; deleted accounts cannot spend again.

Native evidence covers 205 structurally valid receiver-action rows (one actual
profile-view command plus synthetic report rows), twenty concurrent batches,
competing participant deletion roots, partial receipt reuse rejection, real credit
and Stars funding, archived acceptance, twenty fulfilled payment retries, forged
lease/root/life/phase fields, suppressed mandatory audit/outbox inserts, missing
deferred events, actual deferred lease expiry and repeated archived funding or
reference fault scans. All 13 cases pass with retained financial facts unchanged.
Early fixture failures exposed an invalid repeated profile-view action, omitted
profile evidence capture and an incorrect provider-receipt ordering column; fix
the fixtures rather than relaxing authority. The missing-source assertion uses the
store's actual `not_found` code. New spending denial uses the real ledger command
and its `capability_denied` result, rather than an incomplete SQL insert.
The broader native run passed 260 tests across 21 suites, including populated
upgrades, migration replay, exact catalog coverage, reconciliation, credit/Stars
funding, retained references, shared closure and evidence checkpoints. A test-only
unknown-result property access was replaced with a whole-object assertion; the
targeted type check then passed. Full project checks and all six exact-head CI jobs
remain required before this candidate is accepted.
The first full check rejected an unsafe generic Array matcher in the partial-batch
test. Replace it with an exact native three-history-row assertion and rerun the
complete check; this does not change production code or weaken the test.

This increment does not finish product-data deletion. Pending/Flow bodies, other
remaining product resources, provider cleanup and later checkpoints still require
separate implementation. Fresh Return and retained-data release remain disabled.

Commit `8fee9bd` is the preceding green repair: 947 unit tests and all six jobs in
CI run `38151537357` passed, including 753 native tests across 108 suites, all 27
plans, load, backup/restore and the pinned collector. Terminal integrity took
1,466.611 ms against the unchanged 1,500 ms limit; both required indexes and one
worker were used with zero spill. This proves the preceding repair, not acceptance
of the new archival head or external staging/operator sign-off.

## Current repair: exact system history membership for moderation actions

Commit `b1955d9` passed the complete local check (947 unit tests), 127 focused
native tests and all 752 native CI tests across 108 suites. Quality and all four
container jobs passed. Its database job failed at the unchanged M7 terminal
integrity budget: 1,503.526 ms against 1,500 ms. Both required indexes were used,
one worker launched, and there were no temporary blocks, multi-batch hashes or
disk sorts. Load and backup/restore were skipped after this performance failure;
this head is not complete green CI evidence.

The action history predicate uses one uncorrelated system-history membership set,
matching the exact target, reason, timestamp and expected admission state. It still
requires the system actor and null administrator. Unsupported system restoration
has no prior-state authority and fails closed; null tuple fields also fail.
The detailed scanner and aggregate share this predicate and retain every flag.
Administrator history and latest-prior restoration matching remain unchanged.
No source authority, repair permission, financial effect or deletion rule changes.

Native evidence covers simultaneous audit, attempt, history and notice faults,
twenty concurrent samples, and partial repair that must still report the remaining
history fault. System-history mismatches cover user, reason, timestamp, actor and
state, with valid/invalid duplicates and twenty concurrent reads. Existing
administrator restoration duplicates, wrong targets, original histories,
episode resolution, reconciliation and pooled-setting restoration remain required.
Two discarded aggregate prototypes added redundant scans or lost parameterized
history memoization, without establishing a clear action-query benefit. Preserve
their diagnostics; neither prototype is part of the accepted repair.
The first added system-history probe correctly exposed that its synthetic seed
omitted the owning Report: the action was already invalid before history damage.
Bind that Report explicitly, retaining the exact one-additional-violation assertion.
The full-size Windows comparison retained all 27 plans, both required indexes,
one worker and zero spill. Initial/terminal action times changed from
693.718/892.595 ms to 684.243/865.207 ms: a modest diagnostic improvement, not
CI acceptance or a guaranteed timing margin. Combined terminal timing changed
from 2,955.765 to 2,728.578 ms; Windows results do not meet the CI acceptance budget.
All twenty focused native tests passed across five suites. The first full check
passed formatting and lint but rejected two widened string literals in the new
test's actor/state mutation data. Preserve that failure, retain the literal types
and rerun the complete check; passing native tests do not replace type checking.
Windows full-size timing is comparative evidence only. The 20,000-row populations,
27 plans, 1,500 ms CI budget, required indexes and worker checks remain unchanged.
A full local check and all six exact-head CI jobs are required before new features.
Funded source archival and later M8 phases remain pending; fresh return and retained
release remain disabled.

## Current repair: complete migration-110 upgrade expectations

Commit `1c303df` passed the complete local check (947 unit tests) and 75 native
tests across eight dependency suites. Its quality and four container jobs passed;
the database job failed with 62 failed, 674 passed and 16 skipped tests in 108
suites. All nine failing suites concern stale upgrade expectations. Performance,
load and backup/restore were skipped; artifact upload failures follow missing
downstream evidence. This is a failed head, not complete green CI evidence.
The broader upgrade suites still expected migration names/totals ending at 109.
A native notification upgrade reproduced the extra correctly applied migration
110; the broad migration sweep also reproduced the obsolete `109 - baseline`
and replay totals. These are failed expectations, not failed source backfills.

The repair appends migration 110 to ten exact expected lists in nine suites,
updates both exact numeric totals and explicitly verifies its migration script.
It preserves concurrent upgrade/replay, immutable original-fact comparisons,
native catalog coverage and all migration verification. No test, rollback,
source/funding guard or production behavior is skipped or weakened.
The fresh native rerun passed all 127 tests across twelve suites, including
populated legacy upgrades, concurrency, rollback and original-fact preservation.
The first full repair check crashed during lint with Windows access violation
3221225477 (signed -1073741819), without a lint finding or available Node fault
event. The precise native cause is unconfirmed. Preserve the failure evidence
and rerun the complete unchanged check after native integration work finishes;
no successful partial check substitutes for a complete pass.
The repair requires a fresh complete native dependency run, full local check and
all six exact-head CI jobs before any new feature work. Performance, load and
backup/restore acceptance cannot be claimed for a head whose native job fails.
Verified funded source/history/action archival and later M8 phases remain pending;
fresh return and retained release remain disabled.

## Current candidate: retained original Nakh reference routing

Commit `4dc9160` passed the complete check (947 unit tests), 63 focused native
tests and all six exact-head CI jobs. CI passed 751 tests in 108 suites, all 27
unchanged plans, load, backup/restore smoke and pinned collector conversion.
Support took 47.143 ms; initial/terminal integrity took 728.011/929.437 ms with
both required indexes, one worker and no spill. Tracked count was 197,258.
Durable observation counts now preserve repeated unresolved findings independently
of canonical anomaly deduplication.

Migration 110 routes retained ledger and Nakh-origin Match identifiers through
the existing six-field original Nakh anchors. Its preflight requires the exact
source, flow, participants, both original lives and original funding life. New
spends and Matches still require their exact live funded/accepted source under
deferred commit checks; a historical anchor cannot authorize a new effect.
The existing source, history and receiver-action removal guards remain unchanged.
No source, ordinary text, financial fact, provider outcome or retained identity
is removed or rewritten by this migration. Schema counts remain 132 tables,
1,209 columns and 244 foreign keys, with two targets changed in the registry.

A native baseline verified both old links still pointed to the private source.
The first dependency run found stale registry targets and an omitted migration
in an upgrade expectation; both are corrected without weakening catalog checks.
Evidence includes borrowed-life migration rejection with unchanged old links,
twenty concurrent upgrade retries, exact preservation of original financial and
source facts, and twenty denied source removals. Full check and all six exact-head
CI jobs remain required for this candidate. Verified source/history/action archival,
pending/flow removal and later deletion phases remain pending. Return and retained
release stay disabled; retention periods and external acceptance remain unset.

## Current candidate: durable reconciliation observations

Commit `a105427` passed the complete check (947 unit tests) and all six exact-head
CI jobs, including actual pinned collector conversion. CI passed 750 native tests
in 108 suites, all 27 unchanged plans, load and backup/restore smoke. Support took
76.671 ms; initial/terminal integrity took 1162.765/1484.613 ms with both required
indexes, one planned/launched worker and no spill. Tracked count was 197,080.
The original image-pull error on `8eae999` remains unknown; the repaired head is green.

Four native negative probes reproduced a later scan reporting zero funding
mismatches while the same invalid source remained present. Canonical findings
correctly deduplicate across runs, but their original run binding cannot represent
current observations. Each bounded scan now accumulates content-free quota/funding
observation counts in its locked run cursor, including deduplicated findings.
Anomaly insertion, canonical idempotency and repair authority remain unchanged.

Health reads combine the latest scan with the last completed scan until a new
scan completes. A completed clean scan clears the previous observation; an
unfinished scan cannot erase it. These are bounded scan observations, not an
instantaneous snapshot or permission to repair money, release data or return.
Legacy cursors remain readable and completed legacy runs use their existing anomaly
counts until a fresh complete scan seeds observations. No historical observations
are invented and no migration is required.

Native evidence covers twenty competing workers, repeated invalid scans with one
canonical finding, incomplete scans preserving the last known alert, restored
original sources clearing the alert, and malformed persisted counters failing
without progress or source mutation. Counts require exact nonnegative safe integers;
an older completed result cannot mask an invalid latest cursor. Full check and all
six exact-head CI jobs remain required for this candidate. Funded source archival,
later deletion phases and genuine fresh return remain pending; retention periods
are unset and retained release/return remain disabled.

## Current repair: private-safe collector startup diagnostics

Commit `8eae999` passed the complete local check (944 unit tests) and 62 focused
native tests across six suites. Its four CI images passed, and CI's complete check
and security audit passed. Quality failed before metric export while pulling the
unchanged pinned public collector image, classified only as startup unknown.
Collector evidence and later quality steps were not reached. The database job
passed all 750 tests in 108 suites, all 27 plans, load and backup/restore. Support
took 70.781 ms; initial/terminal integrity took 1164.559/1474.666 ms with both required
indexes, one worker and no spill. This is still a failed head; tracked count was 196,953.

The exact public image manifest was independently available with HTTP 200 after
the failure. The GitHub job-rerun API returned HTTP 403 with the configured
credential. The precise original Docker error remains unavailable; current registry
availability alone does not establish its cause. No image, conversion, privacy,
retry limit or assertion is replaced or weakened.

The diagnostic repair classifies both buffered Docker output channels, retaining
runtime/denial/missing-image precedence over transient transport messages. Startup
failure reporting emits only the fixed classification, retryability, a validated
0â€“255 exit code or null, killed status and two output-presence booleans. No command,
endpoint, raw process output, stack, configuration, credential or metric payload is
printed. Unknown failures still fail immediately; only recognized transient image
pulls retain the existing three-attempt/1â€“2-second retry policy. Native Docker is
unavailable on this host, so actual pinned collector conversion remains a CI gate.

Seventeen focused startup tests pass, including stdout-only failures, mixed-channel
denial/missing precedence, long-buffer denial and private diagnostic suppression.
The first full local repair check exited during lint with Windows access violation
3221225477, without a lint finding or available fault-module evidence. A task-local
single-process lint invocation removes worker threads; repository checks and CI
configuration remain unchanged. This does not establish the precise native crash cause.
The complete check and all six exact-head CI jobs must pass before feature work
resumes. This is startup diagnostics repair, not funded source archival, telemetry
observation completion, fresh return, retained release or external acceptance.
## Previous candidate: original funded-Nakh reconciliation proof

Commit `48a3998` passed the complete check (944 unit tests), 79 distinct focused
native checks and all six exact-head CI jobs. The final local native run passed
735 tests in 106 suites, with eleven Redis tests skipped locally; CI passed all
746 tests in 108 suites. All 27 unchanged plans, load and backup/restore smoke
passed. Support took 78.038 ms; initial/terminal integrity took
1225.462/1473.100 ms with both required indexes, one planned/launched worker,
no temporary blocks, no disk sort and one hash batch. Tracked count was 196,731.

Two isolated negative probes reproduced a reconciliation gap: the scanner counted
the original spend while missing a borrowed funding life or reference life.
The first probe used a nonexistent scanner method; fixing that test call produced
the actual missing-finding failures before production changes. Delivered-Nakh
reconciliation now also uses migration 107's original funding-life proof and the
exact six-field retained reference bound to its original flow. Existing complete
spend/charge, history, notification and accepted-Match checks remain.

The existing funding anomaly category and per-source idempotency remain; diagnostic
fields expose only booleans and bounded counts, never epochs or ordinary text.
Native tests cover both reference participants, a missing reference, original ledger
life, twenty competing workers, one canonical finding across repeated runs, restored
original facts and real native Stars capture/fulfillment with borrowed payer/intent
scope. Every negative corruption is restored and is not evidence of fresh return.
No money, source, retained reference, provider outcome or ordinary content is repaired
by reconciliation. No migration, archival, return or retained release is authorized.

Full native dependency tests, the complete check and all six exact-head CI jobs
remain required. Repeated canonical anomalies retain their original run binding;
the existing latest-run operational metric can therefore omit a still-present
finding on a later deduplicated run. Persistent current-observation telemetry is
still an M8 obligation. Funded source/pending/flow archival and deletion completion
remain pending; retained periods are unset and release/return remain disabled.
## Previous candidate: original chat access and paid source authority

Commit `57db28a` passed the full check (944 unit tests), nineteen focused native
checks and all six exact-head CI jobs. CI passed 738 native tests in 108 suites,
all 27 unchanged plans, load and backup/restore smoke. Support took 72.699 ms;
initial/terminal integrity took 1101.058/1428.542 ms, with both required terminal
indexes, one worker and no disk spill. Tracked count was 196,062 lines.

A native negative probe first reproduced chat capability access after an original
participant epoch changed. Chat capabilities, actual history reads and chat writes
now use current Match lives. Cached predefined and private-text replies require
current chat permission before replay. Paid Like/Match grants and actionable
LikedBy pages require their original current sources; shared paid fulfillment
routes an unavailable source to its original refund instead of granting access.
New chat-message rendering/admission also requires the original active Match,
matched pair, sender and recipient. Historical closure and already-admitted
provider settlement retain their separate existing authority.

Chat and paid writes lock sorted identities before Accounts and recheck sources
after waiting. A native blocking probe proves a queued chat writer does not hold
an Account while waiting for an identity lock, then denies the changed life without
claiming a command. Seventy focused native checks pass, including twenty-way
cached/new access denial, unchanged financial/message snapshots, actual Unmatch,
original-source restoration, competing paid retries and exactly one original refund.
Negative epoch mutations are restored; they do not prove genuine fresh return.
The refund probe settles native provider progress and does not call Telegram.

The first complete native run passed 732 tests but failed three notification
checks: two older fixtures lacked the real matched pair, and a global delivery
claim could be crowded out by unrelated earlier suites. The fixtures now include
the matched pair and the notification suite owns a migrated disposable database.
All nine notification tests pass independently; no production predicate or claim
limit was weakened. Static analysis also required explicit new-test return types
and a typed error handler, which were repaired before final validation.

This candidate adds no migration and depends on migration 109's current-life
views. Full native regression, the complete check and all six exact-head CI jobs
remain required. Return and retained-data release remain disabled; retention periods
are still unset. Whole deletion/return, archive and external acceptance work remains.
## Previous repair: private hashes and the original indexed resolution lookup

Commit `4a9ace6` passed the complete local check (944 unit tests), nineteen focused
native checks, all 738 CI integration tests in 108 suites, quality and four images.
Its performance gate aborted when PostgreSQL could not allocate a further 4 MiB
shared-memory segment. The repair admitted more parallel joins whose shared hash arenas exceeded
the container budget. No M7 performance artifact was produced, so the
required evidence upload also failed; load and recovery were not reached. Tracked
count was 196,014 lines. This failed head cannot authorize another feature.

The preceding `a080a4b` passed functional validation but its terminal snapshot took
1618.338 ms against the unchanged 1500 ms limit. Repair `4a9ace6` retained all
metadata predicates but its direct resolution join also lost a required terminal
index, which the comparative diagnostic had not explicitly checked. Its local
terminal improvement was modest and was not CI acceptance. Candidate inlining
made the local terminal sample slower and was discarded before that commit.

The current repair restores the original indexed resolution lookup and disables
shared parallel-hash tables only inside integrity reads (`SET LOCAL`). Bounded
parallel scans/joins still use setup/tuple costs 250/0.01 and
16 MiB per-node work memory. The cap is reduced to one worker plus its leader,
still respecting disabled parallelism. Witness checks use only resolution-valid
owners in aggregate samples; scanners retain every original owner. Private hashes
avoid the failing shared arena
allocation; this does not establish a total process/connection memory bound.
Native checks require the hash setting and every other local setting to restore
after successful/failed reads, including lower/disabled worker limits.

The grouped resolution fact retains valid and invalid candidates with `bool_or`;
narrow projections and original witness-owner bindings remain. The source Report
keeps its exact indexed existence predicate. Extra probes deny a wrongly owned or
missing source Report, then restore the original binding and require the source
flag and current episode count to clear. A conservative-cost/batch-Report-join
candidate completed all 27 semantic plans and required indexes locally but did
not improve complete timing, so it was discarded.

No CI/shared-memory resource is increased and no fixture volume, repeated sample,
required index, worker check or timing limit is relaxed. The full 27-plan local
diagnostic now explicitly requires both `moderation_actions_episode_resolution_idx`
and `account_history_restoration_state_idx` in the terminal snapshot. Windows
latency is comparative evidence only. Native regressions, the full check and all
six exact-head CI jobs must pass before more M8 features. No migration or
release/return change is added.

## Current candidate: original notification recipient and source lives

Commit `d408090` passed the complete check (944 unit tests), 170 distinct focused
native checks and all six exact-head CI jobs. CI passed 724 native tests in 107
files, all 27 unchanged plans, load and backup/restore smoke. Support took 73.114 ms;
initial/terminal integrity took 1158.558/1389.584 ms with both required terminal
indexes. Tracked count was 195,305 lines. Bounded unreferenced Like purge is verified
as one phase-3 executor, not whole product completion.

Six isolated negative probes reproduced original product-source and recipient-life
borrowing in notification rendering. Migration 109 binds original recipient history,
rejects ambiguous legacy provenance and derives current Like/Match source authority.
Rendering and actual provider admission recheck those lives under sorted identity
locks. Cached deduplication cannot grant old history to a later recipient life.
Terminal closure remains deliverable to its original survivor; an already admitted
provider outcome can settle once under its original lease and attempt fence.
Negative epoch corruption is restored and is never evidence of genuine fresh return.
Populated concurrent upgrades, native mutation/replay/concurrency, the complete
check and six exact-head CI jobs remain required. Return and retained release stay off.

The first broader run exposed a lock-order inversion during concurrent ordinary
unmatches: notification birth tried to acquire a User after a writer already held
its Account. Birth now locks only the governing Account and rereads its epoch;
render/admission retain their sorted User/Account order. The focused fixtures now
create the required Account, and populated Nakh-reference expectations preserve
all original notification fields while explicitly requiring the new epoch zero.
Test assertion/fence/snapshot type errors were diagnosed before any commit.
Diagnostic runs are not acceptance evidence; fresh final runs are required.

Fresh final native validation passed 726 tests in 106 suites; eleven actual Redis
checks in two suites were skipped locally and remain required in CI. The entire
PostgreSQL regression run includes the repaired concurrent unmatch, full populated
migration matrix through 108, original notification history and twenty-way upgrade,
source/recipient life denial, lock-wait admission, immutable epoch, cached replay
and once-only original provider settlement. The persistence compiler passed after
the fixture type repairs. Full check and all six exact-head CI jobs remain required.

## Current candidate: bounded unreferenced Like purge

Commit `40144f5` passed the complete check (944 unit tests), 174 focused native
checks and all six exact-head CI jobs. CI passed 709 native tests in 106 files,
all 27 unchanged plans, load and backup/restore smoke. Support took 80.143 ms;
initial/terminal integrity took 1171.109/1424.740 ms with both required terminal
indexes. Tracked count was 194,635 lines. Original Nakh funding-life verification
is accepted as dependency evidence, not source archival or fresh return.

Migration 108 and the internal Like executor remove only closed, unreferenced
original-life Likes. Each transaction handles one canonically locked pair and at
most two rows. Pair/counter/identity/Account/root/work lock order follows existing
writers. Native admission rechecks original owning life, authentic capture and
phase receipts, and the live deletion generation after lock waits. Actual removal,
required content-free audit/event and deferred commit authority remain atomic.
All referenced Likes and their three original Match/unlock FKs remain unchanged;
blocked references report remaining work instead of false purge completion.
Concurrency, required-write rollback, original retry, migration and integration
evidence, the complete check and six exact-head CI jobs are required. Product
completion, ingress, return and retained-data release remain disabled.

Final focused validation passed 44 native tests across four suites. Wider
validation passed 134 across thirteen suites: 170 distinct checks in sixteen
suites after the shared reference suite is counted once. Evidence includes actual
twenty-way deletion, authentic archived-Match reference preservation, exact-count
and late event corruption rollback, original retry, expiry during removal, actual
deferred commit and Account lock waits, plus populated upgrades through 107.
The first native fixture omitted the survivor's notification preferences; creating
that required fixture state repaired closure without changing production policy.
The final runs passed independently; the complete check and exact-head CI remain
required before the next feature.

## Current candidate: original Nakh funding life at commit

Commit `13794b9` passed the complete check (944 tests), 169 focused native checks
and all six exact-head CI jobs. CI passed 704 native tests in 106 files, all 27
unchanged plans, load and backup/restore smoke. Support took 70.990 ms;
initial/terminal integrity took 1016.360/1284.680 ms with both required terminal
indexes. Tracked count was 194,281 lines.

The isolated additional-spend probe confirmed the existing unique Nakh spend
index already denies reuse. A separate negative credit-life corruption probe
showed receiver commands could commit without checking original funding epoch.
Migration 107 rejects inconsistent legacy provenance without rewriting money,
and requires exact original sender life for credit or payment plus intent at
deferred source commit. All complete funding/receipt/ledger/unique guards remain.
The first draft referenced a nonexistent payment epoch column; it was corrected
to the existing immutable original-intent binding. Fresh focused native validation
passed 47 checks across four suites, including populated rejection/rollback,
credit life, Stars payer identity and intent life, actual twenty-way command
concurrency and original retry. Wider migration and full checks remain required.
Corruption is isolated negative evidence only. Source archival, phase
completion, return and retained release remain disabled; no approval is invented.

## Current candidate: minimal original funded Nakh references

Commit `a74d6f5` passed the complete local check (944 tests in 218 files), 195
focused native checks and all six exact-head CI jobs. CI passed 699 integration
tests in 105 files, all 27 unchanged query plans, load and backup/restore smoke.
Support took 57.330 ms; initial/terminal integrity took 945.350/1146.370 ms with
both required terminal indexes. Tracked count was 193,771 lines. Local lint and
runtime failures were repaired and revalidated before this commit was pushed.

Migration 106 adds exact minimal delivered-Nakh identity, original flow and
participant lives. Native insertion creates the reference and requires it at
commit; mismatched/orphan references, reassignment, release and retired source-ID
reuse fail closed. No ordinary text, lifecycle or funding projection is copied.
Existing financial and product foreign keys remain unchanged. This is dependency
preparation, not source archival, phase completion, return or retained release.
Populated upgrade, concurrent actual creation, mandatory-write rollback/retry,
financial preservation, native integration, full check and six CI jobs are required.
External periods and retained release remain unset/off.

## Current candidate: original Nakh lives and product authority

Repair `dc8cb07` passed the fresh complete check (944 unit tests), 32 focused
native tests and all six exact-head CI jobs. CI passed 688 native tests in 104
files, all 27 unchanged query-plan checks, load and backup/restore smoke.
Support and initial/terminal integrity took 69.005 and 1102.303/1381.985 ms;
both required terminal indexes remained present. Tracked count was 192,814 lines.
The first repair check lost a local test worker without an assertion failure.
Inspection showed worker processes did not inherit the parent runtime flags.
A task-local worker flag probe passed, and the fresh full run passed every test;
the precise original process-exit cause remains unconfirmed. Repository settings
and CI runtime were unchanged.

Migration 105 preserves original Nakh flow fields and adds both owning lives.
Unprovable legacy ownership rejects migration. Native flow and child admission
lock sorted identities then Accounts and recheck exact current lives after waits;
pending funding ownership remains a deferred commit proof. A set-join view gates
content, receiver commands and notices. Cached creation and edit/view replay must
still resolve the original current-life source. Credit-triggered and captured-Stars
delivery require both original participants and funding life, preserving existing
original-charge correction routes. Pending-to-Like conversion writes both locked
lives and rejects borrowed Like facts. All original source FKs and immutable
flow lifecycle remain; no archival, phase completion or return is authorized.
Deploy migration 105 before these product adapters. Old epoch-zero producers
remain compatible while return is disabled; all producers require upgrade before
any separately verified later-life activation.

Focused native and populated concurrent upgrade validation passed 195 checks
across 17 suites. Captured-Stars stale receiver scope produced one original-charge
correction under twenty-way replay, no delivery and unchanged receipt/credit facts.
The first complete check found an unsafe matcher assignment in the new funding
rollback test; its explicit unknown type passed focused lint. A fresh complete
check then passed lint but the worker compiler process exited with Windows
3221225477 without a type diagnostic. The identical worker compiler passed under
the task-local non-JIT runtime; compiler invocations now use that runtime locally.
The precise crash cause is unconfirmed; compiler/source and CI settings are unchanged.
A fresh complete check and six exact-head CI jobs remain required. Privileged
epoch corruption is negative denial evidence only, never
verified fresh return. Retained release, deletion ingress and full return stay off;
no external retention, provider, staging, security or DR approval is invented.

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


### Original-life native session retirement (migration 135)

`PostgresAccountDeletionSessionStore` retires at most 100 unexpired grants per
transaction under the real phase-5 Root lease. Native system security audits bind
exact original grant IDs, Root command/request, epoch, worker generation and native
transaction. An immutable digest receipt binds the complete original source facts.
Mandatory audit/receipt checks revalidate the database-clock lease at commit.
Concurrent retries serialize and an independent inventory checks session authority;
a deleted Account alone does not prove the sessions were revoked. User-session
verification recognizes authenticated Root revocations without changing workforce
MFA or permissions. Valid immutable grant facts are explicitly classified by the
older operational checkpoint; malformed provenance still blocks progress.

Deploy migration 135 before this application version. Populated upgrades preserve
original grant bytes and reject ambiguous grants or unexplained Root revocations
without inventing history. The receipt is retained lifecycle security proof under
approval-required policy; retained-data release remains disabled. This component
does not advance phase 5, authorize Return, or prove cache/queue/provider absence.
Full ephemeral coordination, retained manifests, final verification, composition
and remaining M8 acceptance evidence are still required.


### Schema-135 CI inventory repair

Commit `4a42d7d` passed quality and all four container builds. Native CI ran
1,081 cases but four older catalog assertions still expected schema 134; they
must assert the complete schema-135 inventory: 151 tables, 1,384 columns and
300 foreign keys. The repair updates all four exact inventories, retaining
full registry coverage, migration races and original-fact preservation checks.
The failed head is not accepted: performance, load and restore gates did not
run. Full checks and all six exact-head jobs are required on the repaired head.
