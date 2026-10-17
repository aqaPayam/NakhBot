# M9 Execution Guide

M9 owns the controlled launch in the original
[implementation plan](13-implementation-plan.md): approved production reference
data and roles, production infrastructure, real canary journeys, a small initial
cohort and ongoing launch-health review. Implementation and simulated evidence
must remain distinct from actual deployment and operator acceptance.

The starting checkpoint is `86d9712b1714655120842f1fd17ed9c82450fb2c`, with
[all six CI jobs green](https://github.com/aqaPayam/NakhBot/actions/runs/38856553297),
1,202 unit tests and 1,286 native tests in 154 files, zero skips. All 27 plans
passed at the original 20,000 scale and 1,500 ms gate; the terminal snapshot took
1,125.382 ms with both required indexes and zero workers/spill. Backup/restore,
support concurrency load and both collector conversions passed. Tracked lines
were 252,138. The [M8 handoff](32-m8-acceptance-evidence.md) owns its external
release conditions.

## Scope and completion

| Original M9 requirement | Remaining implementation and acceptance |
|---|---|
| Production catalogs, text, prompts, prices/config and roles | Verify deterministic reference-data/config snapshots against explicit approved inputs; report drift without inventing prices, identities or role assignments. |
| Production infrastructure, secrets, bot, webhook and R2 | Prepare separately scoped production deployment, source/image provenance, secret/provider composition, migration and schema-aware rollback controls. Keep services inactive until authorized. |
| Synthetic canaries and moderation/payment drills | Verify deployed entry points and real provider journeys with explicitly designated testers; preserve replay, safety, payment and deletion invariants. |
| Small cohort followed by gradual expansion | Provide bounded admission/activation controls, release observations and a reversible stop path that preserves required financial/privacy processing. |
| Daily launch review | Provide a source-bound review of error budget, payment reconciliation, safety queue, deletion, capacity and operational freshness; missing evidence prevents expansion. |

Work in coherent batches and reuse existing stores, host adapters, IaC, telemetry
and runbooks. Add fixes when concrete integration evidence establishes a gap.
Do not reopen completed business modules or create a new generic control platform
merely to accumulate launch commits. Every commit requires `pnpm check`, a push
to `main`, an announced hash and all six exact-head CI successes before advancing.
Failed heads require diagnosis and a changed repair, never an unchanged rerun.
Preserve all native cases, source bindings, scale populations, both required
indexes, memory/worker limits, performance thresholds and CI time caps.

Initial runtime inspection found that `TelegramStartAdapter` returns a computed
`StartViewModel`, while the running gateway acknowledges `/start` without
delivering that view; the worker has no start-view delivery consumer. Connect
the existing localized start/signup/product journeys and required operator
services through actual process entry points before claiming usable canaries.
Exercise the running host, rather than substituting direct store calls or
programmatically composed test-only modules for this launch evidence.

`NAKH_TELEGRAM_START_DELIVERY_ENABLED` now connects the ordinary gateway's
startup response to the active localization catalog. It remains false by
default. Enabled delivery accepts authenticated private starts only, checks
ownership/lifecycle before registration and again after catalog waits, and
re-reads the current route instead of displaying a replayed registration's
historical route. Provider failure permits retry of the original business
update; delivery is at least once, while registration remains idempotent.

With signup disabled, this connection sends the public route title only and
issues no product or action grants. `NAKH_TELEGRAM_SIGNUP_ENABLED` adds the
interactive signup journey and requires start delivery plus media ingestion.
It stays disabled by default. Migration 152 installs 26 required English keys
and the content-free optional-draft event disposition; all active UI locales
must have those keys and matching variables before the gateway can start.

The enabled composition handles every required signup step and all optional
fields, versioned native draft saves, catalog pagination, numbered processed
uploads, review and separately clicked profile confirmation. Private values
remain in PostgreSQL. The bot uses opaque MAC-bound buttons and exact private
bot-message reply bindings. Navigation contains public selectors, expected
versions and a native grant reference, with an explicit fifteen-minute expiry.
The first transition from a rendered menu wins; exact provider retries retain
the original operation. Cache loss resumes from the native draft through
`/start`, and rejected navigation produces a bounded security audit without
copying callback data or answers. Provider delivery remains at least once.

M8 Return/fresh-entry controls run first and retain their separate confirmation
protocol. Only successful native/Redis fresh activation invokes the product
entry hook; its current limited control grant is checked before a separate
native product grant is issued. An ordinary later-life `/start` cannot issue
that grant. The menu reads current Profile completion under native session
locks rather than inferring it from the identity-only snapshot. Native flow
tests use synthetic Telegram delivery and media fixtures; the composed-host
case also uses actual Redis. These are not real provider acceptance, approved
geography/catalog data or operator sign-off. Remaining product navigation,
operator process composition and the original M9 release table still require
completion before usable deployed canaries or launch can be claimed.

Public signup composition must pass its original native `UserSessionActor` to
`PostgresSignupStore` and `PostgresProfileStore`. Their bound mode captures the
actor and write before waits, locks the stable User then Account, and checks the
same current product epoch/grant before reads, mutation or cached replies. All
writers take User/Account locks before claiming idempotency, including trusted
internal retries, so these paths share one serialization order. Stable User
locks use `NO KEY UPDATE` to permit foreign-key readers while serializing
deletion, Return and session revocation. Unbound construction remains for
trusted internal use and existing migration fixtures; public ingress must not
use it. Native store tests are prerequisites for the signup UI and do not prove
deployed primary entry, external provider acceptance or fresh Redis activation.

Discovery filters, candidate reservations and Like/Not Interested stores also
accept a captured native `UserSessionActor` for public composition. They check
the same current grant and product epoch inside their business transaction,
including cached replies and existing reservations. Pair operations retain the
shared pair lock followed by sorted stable User/Account locks; guest capacity
locks follow those identities. Filter saves take User/Account locks before
idempotency. Constructor actors and operation inputs are copied before waits.
Native tests cover retries, opposite Likes, borrowed/revoked grants, revocation
while waiting for the pair lock, empty pools and an original product grant after
approved Return. Unbound construction remains for trusted workers and fixtures.
These boundaries are prerequisites for the remaining discovery UI and do not
claim delivered profile cards or real provider acceptance.

Candidate requests now bind their request ID, actor life, mode and requested
filter version to a minimal receipt in `platform.idempotency_records`. Concurrent
requests that share an unresolved reservation each remember that original ID.
Delivery or definitive failure cannot make replay select a different candidate;
an empty or physically absent original also stays empty for that request. A new
action needs a new request ID. Every replay still checks the current native
session and capability, and changed request data conflicts. Receipts contain only
the delivery ID or null, use the existing twenty-four-hour transport expiry and
actor-owned deletion cleanup, and add no retained-data resource. Public navigation
remains limited to fifteen minutes. Native tests cover concurrent adoption,
terminal replay, changed data, empty/missing originals, Guest Preview consumption
and borrowed/revoked sessions. The provider consumer remains separate work; this
receipt alone never authorizes sending or resolves an uncertain provider result.

The composed delivery/deletion test also exposed a pre-existing classification
gap: candidate delivery emits consumption reason `preview`, which the generic
M8 machine-value list did not accept. Migration 154 recognizes only version one
of that event with exactly its two UUID subjects and `reason=preview`. Additional
fields, invalid/missing subjects, other versions and unknown events still fail
closed; the generic value list is unchanged. Apply this migration before enabling
candidate delivery. The schema-153 upgrade test preserves the original event row
while proving its disposition changes from unclassified to product transport.

`NAKH_TELEGRAM_GUEST_PREVIEW_ENABLED` connects Guest Preview to the running
signup gateway and the existing API media authority. It defaults to false and
requires signup/start/media readiness. Apply migration 155 first; enabled startup
requires its ledger entry and all five new presentation keys in every active
locale. Guests enter from their menu; incomplete users can enter from a signup
step. Signed navigation, native session/epoch checks and durable request receipts
remain authoritative. Redis receives no profile prose, media URL or audience key.

The current card shows the native primary thumbnail, name, approximate age, City
and highlight, with Next and signup/resume navigation. The server fetches bounded
audience-authenticated WebP bytes and uploads them directly to the fixed Bot API
origin. A native compare-and-set checks the captured profile version and current
media/session authority, then records call-start after the media fetch and before
the request. The acknowledgement must identify the same private recipient
and bot. Only known acceptance records consumption and the permanent guest count;
replays cannot send a different card or increment again. Proven pre-call failure
uses a native unstarted-only condition; a rejected provider response may settle
failure without consumption. Unknown/timeout/malformed outcomes remain reserved
and are not blindly retried. Their expiry is a reconciliation deadline, not proof
of non-delivery. Pending calls require trusted outcome verification before release.

Migration 155 prevents ordinary product purge from erasing a started, unresolved
call. Native tests reproduce the former erasure, then prove that purge waits and
late known acceptance after a real tombstone increments the permanent count once
before ordinary source removal. Public reads/call-start still reject revoked
sessions. Existing M8 grace, provider cleanup and Return gates remain required.
The complete native deletion/approved-Return case also preserves a late accepted
preview in the permanent counter, using an actual supported ten-second grant and
its real expiry. Settlement follows the shared pair/sorted User lock order; its
User locks use `NO KEY UPDATE` so account-first safety writers can finish their
foreign-key reads. The observed lock-cycle test reproduces PostgreSQL `40P01`
with the former stronger lock and requires both transactions to complete after
the repair.
These tests use synthetic provider responses; deployed provider acceptance and
operator reconciliation are still external acceptance work. Fixed M1 handler and
Guest Preview counters report delivery outcomes without user/target labels.

Show More/full-profile navigation, normal Explore interaction actions, remaining
product/operator entry points, audited uncertain-delivery reconciliation and the
original release checklist remain unfinished.
The flag must stay disabled for launch until those applicable journey and operator
conditions are satisfied; this card-delivery increment does not close M9.

Candidate media composition supplies the original reservation ID and a captured
native user session to `PostgresMediaDeliveryAuthorization`. Migration 153 adds
immutable source identifiers to the existing short-lived receipt. Card delivery
uses the current primary thumbnail; candidate detail may use another current
visible thumbnail of that same target. Every read checks the exact reservation,
both product epochs, session expiry/revocation, visibility, media storage/validation,
catalog eligibility, pair state and rejection. A deletion root after the original
reservation prevents reusing it for a returned account. Reservation expiry remains
reconciliation eligibility, not proof of non-delivery; only definitive failure
closes that original source.

The migration extends the ordinary-media schema inventory while preserving
pre-existing valid retained manifests and their exact hashes/proofs. New manifests
must use the new inventory hash. Native tests cover reservation-to-grant composition,
contention, captured inputs, source substitution, current visibility/safety,
revocation after an observed pair-lock wait, real deletion and populated upgrade.
These boundaries still require gateway/worker composition and real provider acceptance.

Production moderation snapshots, phase reads and operational-health reads use
interpreted execution. Post-reading Linux comparisons on the dense terminal
fixture favored interpretation; compilation overhead exceeded its execution
savings. Production and original gate readings use the same policy. Compiled
modes remain available for isolated diagnostic comparisons, preserving the
server's existing cost threshold.
Settings remain local to the read transaction and restore after success or
failure. The combined snapshot retains zero workers and the 16 MiB work budget;
the 20,000-row population, all 27 plans, both independent indexes, zero-spill
evidence and 1,500 ms limit remain required. Servers without a JIT provider use
interpreted execution; local settings tests do not prove Linux compilation or
performance. Those results require the exact-source CI plan artifact.
The compilation controls follow PostgreSQL's documented
[JIT cost settings](https://www.postgresql.org/docs/17/runtime-config-query.html#GUC-JIT-INLINE-ABOVE-COST).
Tuple decoding uses the documented
[tuple-deforming control](https://www.postgresql.org/docs/17/runtime-config-developer.html#GUC-JIT-TUPLE-DEFORMING).
Plan evidence includes bounded compilation counters and boolean options, while
discarding code, predicates and unknown fields.
Diagnostic inlining follows PostgreSQL's documented
[function/operator inlining](https://www.postgresql.org/docs/17/jit-reason.html).
The isolated plan fixture compares interpreted, expression-only, inlined and
optimized compilation only after every original plan reading and repeated
invariant check. These bounded diagnostics never replace original timings or
authorize a failed gate. Each comparison has a twenty-second deadline and rolls
back its settings through a savepoint; unavailable comparisons contain only a
fixed status. Actual Linux compilation and performance remain exact-source CI
requirements; the local Windows provider does not compile expressions.

Retained-data erasure stays disabled pending approved policies. Completing all
34 retained-resource erasure adapters is outside the agreed closure scope. No
policy period, security approval, provider result or operator sign-off is seeded
or inferred from fixtures. Actual release must still satisfy the privacy and
other external conditions in the M8 handoff.

## Exact-source CI prerequisite

`scripts/verify-release-ci.ts` reads GitHub Actions metadata for the selected
40-character source SHA and repository. It requires the newest `CI` push-to-main
run to be completed and successful, all six exact named jobs from its explicit
attempt, and one live digest-bearing native/performance/M7/M8 artifact reference
per required kind. Foreign sources/forks, incomplete pages, duplicate jobs or
artifacts, missing/expired evidence and older-attempt records fail closed. It
rechecks the newest run after observation to reject an intervening retry or run.

The staging deployment accepts only its selected main commit as the image tag;
the checkout and built source therefore agree. The check precedes AWS credential
configuration and repeats before database migration and service activation. Its
receipt contains only source/run/attempt, fixed job identities, artifact IDs,
digests, expiry and check time. It does not contain raw API bodies or credentials.

This is a CI metadata prerequisite. The native artifact contents are verified by
the required reliability job. The receipt alone proves neither image provenance,
deployment, provider acceptance nor approval to launch users. Immutable image and
rollback evidence, production setup and the remaining table items above still
need completion. GitHub artifact retention is fourteen days; durable release
evidence is required before relying on older production rollback candidates.

API contracts follow the official GitHub documentation for
[workflow runs](https://docs.github.com/en/rest/actions/workflow-runs),
[attempt-specific jobs](https://docs.github.com/en/rest/actions/workflow-jobs) and
[artifact identity/digest/expiry](https://docs.github.com/en/rest/actions/artifacts).

## External setup boundary

The owner has not prepared cloud accounts, a domain or bots yet and will supply
them when implementation reaches deployment. Continue independent preparation
first, then provide one concrete setup checklist covering accounts/regions,
budget, DNS, separate test/production bots, private R2 and evidence custody,
secret delivery and operator/security/privacy acceptance. Do not request secrets
in chat or deploy billable resources or real-user traffic from a coding approval.
Present the actual reviewed deployment before asking for its final authorization.


## Production reference review and drift verification

`pnpm release:reference --capture <absolute-private-file>` captures the selected
staging or production service's reference state. Run from a clean committed
checkout after `pnpm build`, with `NAKH_RELEASE` equal to that checkout's full
SHA and the actual service configuration loaded through protected provisioning.
Run separately for `api`, `telegram-gateway`, `worker` and `scheduler`; one
service's receipt does not verify the other services' configuration.

The reader uses one read-only, repeatable-read transaction for all catalog rows,
including disabled locales/text/options, prompts, credit packages, report reasons,
administrator bindings, roles, permissions and assignments. Its migration ledger
must exactly match every migration name/checksum in the source checkout. Runtime
configuration covers every reviewed leaf and rejects unknown leaves; it includes
activation flags, namespaces, endpoints and secret-reference names. Connection
userinfo/query credentials, webhook secret material and resolved secrets are
excluded. Domain credit-package and paid-action/Nakh prices are also captured,
with exact decimal strings for bigint amounts. No seeds, prices, roles, policies
or infrastructure are changed by this command.

Keep the file private: it includes administrator identities and assignment
provenance. Capture creates a new file exclusively and never overwrites a reviewed
input. Review its full contents with the product/localization, backend, platform
and security/moderation owners as applicable; record their approval against the
file's digest and selected source/environment/service in protected release
custody. Current fixture values and a newly captured file are not production
approval. Retained-data erasure remains disabled pending its separate policies.

`pnpm release:reference --verify <absolute-reviewed-file>` compares the current
state to that exact input. Missing, extra or changed rows, versions, activation,
prices, configuration, identities, role assignments or source migrations fail the
comparison. Only bounded counts, context and digests reach stdout; mismatches and
provider/database errors print no private values. The reader bounds snapshot size
and query time. Native tests observe a reader blocked by a concurrent price
writer and prove it retains one consistent snapshot; another capture sees the
committed drift, including integer amounts above JavaScript's safe-number range.

A matching reference is one release prerequisite. It does not attest image/cloud
provenance, verify secret material, authenticate an approver, activate a service,
or establish actual provider/canary/cohort acceptance. Production workflow
composition and custody of explicit owner approvals remain required before launch.


## Source-bound release images

Deployment and rollback now use the image-provenance protocol documented in
[the staging deployment guide](../../deploy/terraform/staging/README.md#image-provenance-and-retention).
The deploy path prepares fresh candidate images or verifies prior trusted images,
uses [`actions/attest`](https://github.com/actions/attest) for fresh build subjects,
and verifies their exact repository/workflow/source/digest with
[`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify).
Only verified candidates may receive commit tags. This prevents an interrupted
push/sign sequence from silently qualifying an unknown existing tag. Provider
errors and unknown outcomes fail closed; an exact already-existing promotion
converges only if the registry still identifies the same digest.

The selected digest map binds all four runtime task definitions and the API
migration task. Terraform checks the complete map even for targeted migration
registration. CI builds the actual images and checks their source/application
labels; Docker context excludes Git metadata, dependencies, generated outputs,
`artifacts`, `.env*`, `.aws`, `.codex` and Terraform state. Tagged images
are no longer subject to the old count-based lifecycle eviction rule.

Protocol tests cover fresh and reused images, absent/foreign proof, wrong source
and receipt binding, interrupted preparation, exact manifest bytes, promotion
races and input capture across waits. These tests simulate AWS/Docker/GitHub CLI
boundaries; they do not establish actual ECR or attestation-service acceptance.
Authorized staging must demonstrate that separately. Native schema/transport
rollback compatibility, migration quiescence, durable release custody, protected
production approval, production infrastructure and the rest of the original M9
release table remain required. No cloud deployment or real-user launch follows
from a matching image receipt alone.


## Selected-image native schema prerequisite

The API image includes
`node node_modules/@nakh/persistence-postgres/dist/cli/compatibility.js`.
Run with the selected image's source SHA in `NAKH_RELEASE`, its ordinary protected
configuration and `/app` as the working directory. This read-only command compares
all source migration names and checksums with the actual native ledger. Missing,
additional or changed entries deny admission; an older image cannot pass merely
because its own migrations have already applied. Success prints only the selected
source SHA, migration count and ledger digest. Failure prints a fixed message and
returns nonzero without connection strings, paths or database errors.

The reader shares the existing migrator's advisory lock. It acquires that lock
before opening its repeatable-read transaction, so a concurrent migration must
finish before the reader takes its snapshot. It never applies or reverses a
migration. Native tests cover exact identity, modified/missing/additional rows,
an actual older source inventory and an observed lock wait followed by a newly
committed migration. A subprocess test executes the compiled command outside a
Git checkout and checks sanitized rejection; container CI also checks that the
actual API image contains the command.

This increment packages and verifies the native prerequisite. Deployment/rollback
workflow admission, producer drain, safe scaling restoration, circuit-breaker
fallback policy and durable release custody still require composition before a
release can rely on it. A one-time successful read cannot authorize a concurrent
migration or prove transport/data compatibility, provider acceptance or operator
approval. No cloud resources or users are activated by this command.


## Controlled staging migration and rollback composition

Both actual staging workflows now call the fixed fleet controller described in
[the controlled-release runbook](../../deploy/runbooks/m9-controlled-release.md).
Image preparation stays online; all old producers must be physically stopped
before targeted migration registration or native migration execution. The
controller preserves original capacity and operator scaling holds in protected
phase custody before changes, suspends all scaling categories with minimum zero,
and checks desired/running/pending counts plus actual task/container stop states.
Active task identifiers discovered later are journaled and remain pinned across
controller restarts; list omission is not physical-stop evidence. Unknown active
standalone producers, missing task details, failed/looping pages and provider
errors deny progress.

Forward deployment runs the selected image's migration command and then its
native compatibility command. Rollback runs only compatibility. Task definitions
must identify the selected digest, source, service, private network and actual
runtime database-secret reference; terminal task proof checks the exact task,
command, image digest and zero exit. Conditional preparation claims serialize
concurrent task starts. A prepared task with unknown outcome is preserved and
never blindly invoked again. An expired schema observation requires fresh reviewed
recovery rather than treating an old successful read as current admission.

Activation retains the scaling hold while all selected service tasks and public
readiness checks pass. Only then does Terraform restore the captured per-service
capacity and original suspension flags. Unqualified ECS automatic rollback is
disabled: a previous binary does not gain schema compatibility from a failed new
deployment. Failure/cancellation requests maintenance for all four owned services;
actual cancellation/crash behavior remains a required provider drill. Unknown
standalone tasks and native financial/provider intents are not guessed, retried,
reset or deleted by this controller.

The new bucket stores private operational phase observations using checksum,
conditional-create and independent version-bound readback. No user-linked table,
retention period, private review snapshot, M8 Root completion or erasure authority
is introduced. It does not yet archive all CI ZIPs and signed attestation bundles;
complete that separate release archive before relying on historical candidates
beyond the online evidence lifetime. Protocol tests simulate AWS boundaries;
native schema tests use actual PostgreSQL. Neither proves real AWS/R2 acceptance,
production approval, provider canaries, cohort launch or the rest of M9 complete.
