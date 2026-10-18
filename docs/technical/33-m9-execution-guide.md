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

Staging and inactive production now use one runtime module. The production root
requires separate account custody, explicit capacity/budget inputs, database
purpose isolation and database safeguards, with one NAT per AZ. Staging retains
its prior defaults through explicit state moves. See
[production infrastructure](../../deploy/terraform/production/README.md). This
is infrastructure implementation and mocked-provider evidence; the protected
production deployment workflow/controller now reuses the drained release protocol;
the separate [production bootstrap](../../deploy/terraform/production-bootstrap/README.md)
requires reviewed customer-managed policy hashes and exact environment OIDC trust.
Real IAM qualification and launch acceptance remain open.

Bootstrap candidate `5cd952b` failed Linux validation because its Windows-origin
provider lock lacked the Linux package hash. Read-only init installed the signed
package but could not add that platform hash; subsequent validation correctly
rejected the cached package. The repair records signed `linux_amd64` and
`windows_amd64` hashes for the unchanged AWS 6.61.0 and random 3.9.0 pins across
all caller roots. CI initialization is read-only so future missing hashes fail
instead of being silently repaired in the runner checkout. Require the changed
repair's own full check and six-job evidence; the failed head is not accepted.


The [database purpose isolation foundation](36-m9-database-purpose-isolation.md)
provides trusted native provisioning and host-owned pool admission. The four
composition roots select purpose pools; the production root and release controller
require isolation. Local native and compiled-host journeys qualify those bindings;
real provider/operator journey acceptance remains open. A provider
account/domain/bot setup checklist has been sent to the owner so preparation can
run in parallel; no credentials or real deployment acceptance have been supplied.

The optional [product runtime profile](35-m9-runtime-composition.md) connects
existing feature flags, per-host provider secret references and a private pinned
scanner to the staging deployment. Default configuration and service activation
remain off. Its mocked infrastructure and actual scanner transport rehearsals
are implementation evidence; production composition and live launch acceptance
remain separate work.

The trusted operator entry point now composes the existing audited TOTP native
store through a private CLI, with exact AWS principal and secret-version checks,
historical key custody, private invitation output and idempotent native recovery.
See the [operator procedure](34-m9-trusted-operator.md). Synthetic AWS responses
and local PostgreSQL evidence do not approve real operators or satisfy live
provider acceptance. Production runtime/IaC composition remains the next
independent implementation gap before the owner's consolidated setup checklist.

Repair `a929d12` passed the catalog case and three native shards, but the
scheduler shard hit the existing 20-minute job cap. Dispatch estimates still
described an older baseline. The next repair refreshes 144 completed passing
suite timings from that run, retaining prior estimates for unobserved suites.
All 166 files remain routed exactly once across four shards; complete native
coverage, source receipts and the 20-minute cap remain mandatory. A cancelled
run supplies scheduling measurements, never acceptance evidence.

The chat candidate `c66633a` passed quality but failed its API native shard:
the identity catalog assertion omitted the twelve new chat texts (659 expected,
671 installed). The repair includes the chat manifest in the exact count and
checks every English value and inactive-locale fallback. This failed head is not
an accepted release; the changed repair requires its own full check and six jobs.

The chat composition candidate adds `NAKH_TELEGRAM_CHAT_ENABLED`, disabled by
default and dependent on the existing primary signup entry. The ordinary gateway
dispatches owned chat callbacks and replies before signup and photo ingestion.
The root menu passes its captured native user grant; chat navigation cannot issue
or renew one. A separate MAC domain binds opaque menus and private bot replies to
the Telegram owner, product life, original grant, expected version and expiry.

The transport composes the existing M6 handlers for bounded history, predefined
questions/answers, unlocked text, read state, mute and separately confirmed
Unmatch. Credit unlock requires its own confirmation and existing native price.
The native stores recheck captured grants after canonical pair locks and before
effects or replay. Mute commands retain the selected value across retries. Safety
warnings require provider acknowledgement before the native shown marker. Private
message bodies remain outside navigation/cache values. Migration 159 installs
twelve presentation texts; enabled startup verifies every active UI locale.

Local PostgreSQL/Redis tests exercise concurrency, original-grant revocation,
payment replay, provider-warning failure, private text and Unmatch. The ordinary
compiled gateway also requires webhook/menu evidence before this candidate is
accepted. These synthetic provider transports do not establish real Telegram
delivery or controlled-launch acceptance. Stored-content notification relay,
chat reporting entry, trusted operator provisioning and deployment composition
remain separate open work under the original M9 launch requirements.

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

Normal Explore interaction and full-profile navigation, remaining product/operator
entry points, audited uncertain-delivery reconciliation and the original release
checklist remain unfinished. Delivered Guest Preview cards now provide the full
Profile path described below.
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
is introduced. The signed release archive described below now preserves CI ZIPs and image
attestation bundles separately from these phase observations. Its actual provider
and signature acceptance still requires the protected staging rehearsal. Protocol tests simulate AWS boundaries;
native schema tests use actual PostgreSQL. Neither proves real AWS/R2 acceptance,
production approval, provider canaries, cohort launch or the rest of M9 complete.

## Durable signed release archive

The forward staging workflow now downloads and checks the four exact-source CI
ZIPs, retains their original GitHub digests, and preserves all four image Sigstore
bundles plus an observed trusted-root document. The manifest binds the selected
source, producing controller source, deployment run/attempt, scoped infrastructure,
CI run/attempt and six job IDs, image digests and every retained file's size/hash.
The producing controller must be that same source. `actions/attest@v4` signs the
manifest before the workflow seals it and before any producer drain.

Private versioned S3 custody uses conditional creates, independent version-bound
readback and checksum/body equality for archive bytes as well as phase records.
A completion marker is written only after manifest and image verification and a
fresh newest-CI check. Partial writes remain incomplete and cannot authorize release.
A replay preserves the original manifest/signature bytes; it cannot overwrite a
conflicting archive. Phase record format 2 separately identifies the current
controller SHA, selected image SHA and optional signed archive key/digest. Legacy
format 1 records are not accepted as proof of an unrecorded controller identity.

Rollback may supply an exact `archive_ref` in the form
`archives/<source-sha>/<producing-deploy-run>/<attempt>/manifest.json`.
It verifies the manifest with the current trusted-root configuration and the
original repository, deploy workflow, main ref, source/signer SHA, GitHub-hosted
runner and SLSA subject digest policy. The saved root document is evidence, never
an automatically trusted anchor. Rollback checks all archived bytes, native shard
source receipts, zero skips, 27 plans at 20,000 rows/1,500 ms, both required terminal
indexes, original JIT/worker/spill limits, load totals and both telemetry conversions.
It also verifies the image bundles and current ECR digests/tags without rebuilding,
promoting, reattesting or running a database migration.

The newest selected-source CI run and attempt must still be green, with the same
six job IDs as the signed archive. Only the online ZIP availability/expiry check
is replaced by protected archived bytes; red, pending, superseded or unavailable
CI still denies admission. Verification repeats after drain/schema inspection.
Rollback without `archive_ref` keeps the original live-artifact requirements.
Native current-schema compatibility and the separate transport/data review remain
mandatory for either route. Historical images are not retroactively qualified.

Focused protocol tests cover changed bytes, partial seals, source/controller
separation, failed signatures, current-CI changes, binary custody, malformed ZIPs,
and credential stripping on artifact redirects. A read-only integration probe
successfully downloaded and inspected all four actual CI ZIPs for green source
`7444cb6c35e645a48b2045eee4addc4010228057` (run `38985649458`, attempt 1).
This verifies the GitHub download/report path. Test signature/S3 ports are simulated;
actual signed-manifest verification, AWS policy/version behavior, expired-online-ZIP
rollback and the full controlled deployment/recovery journeys still require the
protected provider rehearsal. No cloud account, approved retention period,
production/operator approval, M8 Root approval or real-user launch is implied.

## Delivered-card full Profile through the gateway

The running Guest Preview composition now offers Show More on the original card.
It carries an opaque owner/bot/life-bound navigation token, not a target user ID or
profile snapshot. Native reads require that exact viewer's delivered candidate
receipt. Pending, uncertain, failed or foreign receipts cannot open a full Profile;
a callback never settles an uncertain provider result. Reads neither select a new
candidate nor consume another preview, including at the lifetime preview limit.

The projection reads current public Profile fields, catalog labels, optional
answers, biography and every visible photo in primary/display order. Each photo
uses the existing native `profile_detail` authority and private media relay. All
original source/session/life/pair/visibility/deletion fences remain in force.
The runtime captures its actor before waits and snapshots source checks before
asynchronous validation. It rechecks every photo source and the whole text version
immediately before each provider send. A change during photo delivery withholds
subsequent text. Full text uses bounded Unicode-safe chunks with plain Telegram
messages; no delivery URL, raw target ID or private snapshot is put in a callback,
transport cache or message metadata.

Profile messages are read delivery and may repeat after provider retries. They do
not repeat the original card's quota consumption or claim a new business effect.
Already accepted Telegram messages and actual provider cleanup remain part of the
separate M8/provider acceptance boundary; this increment does not certify them.
Existing media-grant and signup-navigation deletion coverage is reused. No new
user-linked table, cache namespace, retained-resource adapter or retention period
is introduced; retained-data erasure remains disabled.

Migration 156 seeds four required English `profile.ui.*` texts and preserves the
historical five-key Preview catalog. Enabled preview startup requires this migration
and matching variables in every active UI locale. Apply the source migration before
enabling the new binary. The strict native compatibility command still compares
the complete source ledger, including this migration; historical binaries do not
gain compatibility merely because the new migration contains UI text. Deletion
catalog coverage explicitly accepts this unchanged user-linked layout at schema
156 and still rejects unknown future schemas.

Native checks exercise concurrent/replayed reads with unchanged quota, all visible
photos, pending/foreign/borrowed sources, captured actors, updated text versions,
and visibility/block/photo withdrawal. Gateway tests exercise the real adapter
composition with synthetic media/Telegram, opaque callbacks and target withdrawal
after photo acceptance but before text. The authenticated host case uses actual
Redis and the verified post-Return activation bridge to replay Show More without
changing the original delivery receipt or permanent preview count. Localization,
exact reference counts and
populated migration/replay checks cover the new seed. These are implementation
checks, not a live test-bot rehearsal, content approval or launch sign-off. Normal
Explore interaction delivery, complete menus, operator process composition and the
original production/provider/cohort/health requirements remain outstanding.

## Delivered Explore source binding for interactions and direct Nakh

Native card-action composition can now construct
`PostgresInteractionStore(database, currentActor, deliveredCardId)` and
`PostgresDirectNakhStore(database, currentActor, deliveredCardId)`.
The actor is a verified current product session and the card ID is resolved by the
server from owned navigation. Passing a card without an actor, or a malformed card
ID, is rejected. A regression first demonstrated that the previous actor-only
interaction path could create a Like for a still-unconfirmed reservation.

The bound writers take the existing shared pair and sorted User/Account locks,
check the current native session, then require the original delivered Explore
receipt for that exact viewer and target. Pending, uncertain, failed, missing,
foreign and Guest Preview receipts cannot authorize these actions. The original
account-life fence runs inside the business transaction: deletion/Return cannot
turn an old card into authority over the counterpart's new life. A disappearing
source is checked again after the pair-lock wait. These checks run before cached
idempotency replies as well as before new mutations. Existing capability, pair,
credit, FIFO, audit and outbox rules continue to govern new writes.

The card ID participates in the request hash. Retrying the same intent preserves
its original source; changing the source while reusing its idempotency key is a
conflict. No private message or Profile snapshot is added to transport storage.
Direct Nakh also captures its whole command/generated write and constructor actor
before asynchronous waits, preventing a queued caller mutation from changing the
message or generated IDs under an earlier request hash. Current-session checks
precede both spending and cached replies. The canonical Nakh cost and ledger
idempotency rules are unchanged.

Existing constructor forms remain available for trusted internal composition and
other owning source workflows. Ordinary card ingress must use the source-bound
form; a target UUID alone is not a delivered-card proof. This increment supplies
the native prerequisite. The normal Explore menu, filter controls, user Nakh
prompts and Report journey still need running-gateway composition before enabling
that product flow. Guest Preview remains free of interaction actions.

Native evidence covers the reproduced pending-card failure, concurrent Like and
Not Interested retries, foreign/changed source rejection, Guest Preview after
activation, one canonical direct-Nakh debit, revoked cached replies, observed
pair waits, write capture, and all three actions after genuine native deletion
and approved Return of the counterpart. The latter runs native photo archival,
media operations/readback receipts and every completion phase; its object/cache
provider is a stateful synthetic fixture, not actual R2 or Cloudflare acceptance.
Only a fresh delivered card authorizes the returned counterpart. There is no new
migration, user-linked table, retention period or retained-erasure adapter, and
retained-data erasure remains disabled. Original M9 provider/operator/cohort/health
acceptance is still required.

## Ordinary Explore entry and delivered-card interactions

`NAKH_TELEGRAM_EXPLORE_ENABLED` connects the active-account Explore button to the
running signup/product gateway. It is false by default and requires signup,
start delivery and photo-ingestion readiness. Guest Preview has its own independent
flag; enabling Explore does not enable guest sampling. Startup checks the existing
schema 156 presentation texts and required interaction texts for every active UI
locale. There is no migration or new retained resource in this increment.

Explore uses the original candidate reservation, effective native filters,
source-bound media authorization, begin-send claim and delivery confirmation.
The existing default or saved filter is applied; interactive filter editing still
requires gateway composition. A definitive provider rejection uses the existing
failure path. An ambiguous acknowledgement leaves the original attempted source
pending; neither retry nor another click turns it into delivery authority.

The delivered card offers Like, Not Interested, Show More, Next and Back. Buttons
contain opaque owner/bot/life-bound references. The server resolves the target
from the original receipt and calls the session/source-bound interaction writer.
Native capability, pair, idempotency, audit and outbox rules remain authoritative.
Like/Not Interested acknowledge the outcome and request the next candidate.
The card and its full-profile presentation share one action group, so a second
competing transition cannot be introduced by opening Show More. Read-only full
profile viewing consumes no additional candidate or guest quota. Revoked sessions
are checked before cached command replies can be reached.

Native transport tests cover concurrent card delivery and Like/Not Interested,
borrowed navigation, shared full-profile action groups, opposite-intent denial,
revoked retries and ambiguous Explore acknowledgements. The existing authenticated
host rehearsal also exercises a separate active account through real Redis and
the actual HTTP/process factory while preserving its unresolved guest reservation.
Media and Telegram providers in these tests are synthetic, not external provider
acceptance. Nakh prompts, Report, filter controls and the other complete product
menus remain to be connected before enabling this flow for canaries. This is not
M9 completion or permission to launch; operator, infrastructure, real-provider,
cohort and health-review acceptance remains required. Retained erasure stays off.

## Credit and consented Pending Nakh from Explore

The enabled Explore gateway now offers Send Nakh on an owned delivered card.
The funding screen shows the existing canonical credit/Stars costs and explicit
consent to later automatic FIFO settlement. Selecting credits or Save as Pending
Nakh opens a private, exact bot-message reply prompt. Sending that reply is the
commit action. No opening text or compose draft enters Redis; signed navigation
contains only the funding selector, original delivery reference and current native
session. The first reply transition wins. An invalid text can be corrected under
the same prompt group. An insufficient-credit transaction rolls back, returns to
the funding choice and requires a new private reply instead of retaining its text.

The credit path invokes the existing source/session-bound direct Nakh writer.
The pending path invokes `PostgresPendingNakhStore(database, actor, deliveryId)`.
It captures actor and full writes before waits, takes the original counter/pair/
User/Account locks, and checks the current session and exact delivered Explore
source before an idempotency claim or cached reply. Missing, foreign, Guest
Preview, unconfirmed and earlier-life receipts cannot create a Pending Nakh.
The source participates in the creation hash; trusted construction preserves its
old hash. Costs, original flow lives, five-pending limit, fourteen-day deadline,
funding intent, FIFO settlement and transactional effects remain unchanged.

Session-bound pending reads, edits and cancellation also check the owning current
grant. Editing/cancelling an existing pending flow does not require a fresh card.
Bound reads use read committed with User/Account locks so an actual revocation
committed while the first lock waits is visible to the grant check. Trusted reads
retain their original read-only repeatable snapshot. Background settlement keeps
its independent authority and does not require a live user session.

Native evidence exercises source/cached-reply fences, concurrent creation/edit/
cancellation, captured writes during observed waits, a disappearing source,
genuine queued revocation, and deletion/approved Return of the counterpart.
Gateway tests exercise one credit debit, sender-only pending creation, explicit
consent, invalid and duplicate replies, insufficient credit, borrowed navigation,
revocation and ambiguous cards. The actual HTTP factory/real Redis rehearsal also
submits a pending opening through Bot API force-reply serialization. Telegram and
media remain synthetic providers in those checks. Report, filter editing,
full remaining menus and original operator/
production/provider/cohort/health acceptance are still outstanding. Explore stays
false by default. There is no new migration or retained resource; retained-data
erasure remains disabled pending approved policies.

## Stars invoice and financial ingress composition

`NAKH_TELEGRAM_STARS_ENABLED` defaults to false. Enabling it resolves the bot
token and `NAKH_STARS_KEY_RING_REF` (default `NAKH_STARS_KEY_RING`) and verifies
financial key custody and active-locale messages at startup. It is independent
of signup and Explore flags: authentic payment receipts must continue to be
processed while product admission is stopped. Disabled financial ingress returns
a retryable error for payment-shaped updates instead of acknowledging and losing
them. Webhook secret authentication precedes all financial processing.

Enabled Explore offers the existing Pay with Telegram Stars option. The private
reply first creates the original consented Pending Nakh, then prepares its native
two-Star attempt and sends a private XTR invoice. The invoice contains generic
localized text and an opaque payload, never the private opening. Provider retries
can repeat presentation of that same attempt and payload. An invoice delivery
acknowledgement never marks payment paid. Public funding stores capture the actor
and writes before waits and check the current native session before new or cached
results; trusted financial worker capabilities remain independent of user sessions.

The key-ring secret is JSON with exactly `activeKeyId`, `digestKey` and `keys`.
Each key entry has exactly `id`, `invoiceKey` and `evidenceKey`; all secrets are
distinct canonical base64url encodings of 32 random bytes. Key IDs use one to 32
ASCII letters, digits, underscores or hyphens. The digest key stays stable; rotate
the active encryption keys by adding a new entry and retaining historical entries
while their financial records exist. Navigation keys must be separate. Startup
checks every referenced key ID and decrypts a bounded sample per key from native
invoices and retained provider evidence; missing or overwritten historical keys
and a changed lookup digest prevent startup. This check is not a full corruption
scan or permission to erase historical keys.

Pre-checkout decisions commit before the Bot API answer, and successful payments
commit before the HTTP acknowledgement. Both reuse the existing native M4 receipt,
quarantine, reconciliation and worker-fulfillment contracts. Evidence encrypts only
bounded canonical financial facts with separate authenticated encryption; arbitrary
Telegram names, addresses and message bodies are not copied. No live product grant
is required to preserve a genuine financial receipt after session revocation.

Native tests cover retries, payer/currency/amount mismatches, revoked and borrowed
funding authority, captured inputs and historical key custody. The actual HTTP
factory with real Redis exercises the Explore reply, lost invoice acknowledgement,
same-attempt replay, webhook authentication, pre-checkout and repeated successful
payment ingestion. Its Telegram transport is synthetic; actual provider, deployed
worker fulfillment/correction, operator and launch acceptance remain required.
There is no migration or new retained resource. Retained erasure stays disabled.

The owner has not created launch-provider accounts yet. Continue independent
implementation and give the owner a concrete setup checklist when deployment
needs those accounts; do not repeatedly request an inventory or invent credentials,
catalog approvals, role holders or real-provider acceptance.

## Public profile reporting from delivered Explore cards

`NAKH_TELEGRAM_REPORTS_ENABLED` defaults to false and composes a separate
authenticated report ingress before signup. Enabled Explore cards and their
Show More view offer Report. Existing report controls continue to work while
signup and Explore admission are stopped, subject to the original current native
grant and the active/restricted reporting policy. Guest and deleted accounts do
not gain reporting authority. Reporting uses its own MAC domain, callback prefix,
private reply bindings and transition receipts; signup controls cannot be used
as report controls.

The user selects an active native reason and either clicks Submit report without
details or sends the exact private reply to submit with details. The prompt
explicitly explains that sending commits the report. Cancel consumes the same
transition group and prevents a late reply from submitting it. Private report
details are not retained in Redis or a compose draft. The existing five-minute
evidence intent, daily native quota, encrypted profile snapshot, confidential
receipt, moderation queue and distinct-reporter threshold remain authoritative.

The public native factory returns preparation and submission only and requires
a captured actor and original delivery scope. Preparation, mutation and cached
receipts take the existing target-threshold lock, shared pair lock and sorted
User/Account locks before checking the current grant and delivered Explore
source. Constructor scope and full writes are copied before waits. The source
must remain owned and confirmed, including for cached results. A deletion Root
requested after the original reservation invalidates that delivered source;
approved Return cannot turn an old card into a report about a new profile.

Snapshot capture uses the existing retained-evidence key-ring format configured
by `NAKH_DELETION_EVIDENCE_KEY_RING_REF`. The separately reviewed
`NAKH_REPORT_SNAPSHOT_KEY_ID` and `NAKH_REPORT_SNAPSHOT_KEY_VERSION` select the
write capability explicitly. Historical entries remain available to the existing
deletion and authorized evidence readers. Startup checks referenced key versions
and decrypts a bounded sample per version; it does not claim a full corruption
scan. Snapshot keys must be separate from navigation keys. No administrative
reveal capability or administrative credential is passed to the public report
runtime.

Migration 157 adds two English messages for reply submission and cancellation,
with matching active-locale readiness checks. It adds no retained resource.
Native evidence covers concurrent and reciprocal submissions, borrowed/revoked
grants, cached receipt fences and genuine deletion/Return source replacement.
The actual HTTP factory with real Redis verifies private details, provider
retries, encrypted snapshots, reporting with product admission stopped and
historical-key custody across a process restart. Telegram remains synthetic.

Show More offers Report on each photo, bound to that exact selected photo;
the card and full Profile text retain profile reporting. Photo controls contain
only opaque owner-bound references. The native photo resolver verifies the
original delivered target and current visible owned thumbnail; submission commits
one encrypted snapshot and an immutable photo evidence hold in the same transaction.
Provider retries return the original receipt without another snapshot or hold.
Existing media cleanup protects these holds, and M8 deletion-media execution
copies and verifies held thumbnails before deleting public objects. No separate
photo-retention worker, queue or retained resource is introduced. Real R2 custody
still requires the provider drill.

Cached report receipts recheck the active/restricted policy as well as the
original life and grant. Native regression evidence observes an advisory-lock
wait, applies an actual audited ban or restriction while the retry waits, then
verifies that a ban denies the cached receipt while restriction still permits it.
The session remains valid, so this check does not substitute revocation for
the reporting policy. The full HTTP factory with real Redis also selects the
second, non-primary photo and verifies its exact thumbnail digest, encrypted
snapshot, single hold and duplicate delivery behavior.

The existing native chat, message and unmatched evidence contracts remain
available to their owning compositions. The remaining public/operator journeys
still need process wiring and launch evidence. This does not close M9 or replace
real-provider, production, operator, cohort or health-review acceptance.
Retained-data erasure remains disabled pending approved policies.

## Automatic Stars corrections in the ordinary worker

`NAKH_TELEGRAM_STARS_REFUNDS_ENABLED` independently enables the existing native
refund workflow in the worker. It defaults to false and can remain enabled while
invoice and product admission are stopped. The worker validates retained financial
key custody before polling and drains its current refund before shutdown.

Financial key parsing and encryption keep their established format in the
PostgreSQL adapter, shared by gateway receipt capture and worker correction.
Claims select only the configured bot and environment. After the native fenced
`beginProviderCall` commits, the authority reader checks the exact refund lease,
payment, original receipt, encrypted provider event, payer, charge, amount,
environment, bot and protected invoice. It does not depend on current product
sessions, profile data or a current Telegram identity lookup. Historical financial
keys remain required after deletion and Return.

The bounded provider request sends the original payer and charge using Telegram's
[refundStarPayment](https://core.telegram.org/bots/api#refundstarpayment) method.
Only a definite successful acknowledgement completes the native refund. Lost,
malformed, oversized or unsuccessful responses retain `call_started` for existing
reconciliation and audited operator resolution. Ordinary polling never retries
that unknown outcome. A custody or authority failure before any provider request
may safely return to `not_started` for the existing delayed retry.

Native evidence exercises a complete deletion/approved Return before correction,
the ordinary worker entry point with real Redis and synthetic provider delivery,
historical key rotation, competing polls, graceful drain, lost acknowledgement,
restart quarantine and exact bot/receipt/lease binding. It is implementation
evidence; real Telegram refunds, reconciliation, operator sign-off and the original
controlled-launch acceptance remain required. No new retained resource or financial
retention period is introduced.

## Existing-grant handoff for administrator first-factor composition

The trusted `UserSessionService.exportCurrent` capability encrypts a bearer for
an already captured, currently valid native user grant. It never calls issuance,
selects a new product epoch, changes the original expiry or creates another audit
grant. Concurrent handoffs produce independently encrypted credentials for the
same authority. The actor is copied before the native lookup; changed owner,
epoch or grant responses are rejected. Bearer consumers still authenticate against
current native authority, so revocation after that lookup cannot preserve access.

This capability is server-internal. It is not an HTTP or Telegram endpoint and
does not accept user-selected actors. The eventual trusted Telegram handoff must
use its original authenticated actor and keep credentials out of logs, query
strings and persistent browser storage. It does not replace authenticator-app
codes, operator-approved enrollment, current role checks or the separate admin
session audience.

Native evidence covers twenty concurrent handoffs with unchanged audit facts
and expiry, borrowed grants, revocation, real Root admission, expired/malformed
native facts and a separately labelled epoch-change fault fixture. Existing HTTP
TOTP enrollment/sign-in tests now use an exported existing first-factor grant.
The ordinary administrator process, real Telegram first-factor delivery and
operator/provider acceptance remain unfinished; this prerequisite does not claim
that those entry points are deployed or close M9. Retained erasure stays disabled.

## Native administrator entry in ordinary API and Telegram processes

`NAKH_ADMINISTRATION_ENABLED` now composes the existing native TOTP host in the
ordinary API and private administrator ingress in the gateway. It defaults to
false. The configured public origin must be canonical HTTPS, with loopback HTTP
permitted only for local/test operation. Startup requires migration 158, the
required localized catalog, Redis and distinct authentication, navigation,
review-note and report-snapshot keys. Historical key versions remain required;
startup verifies referenced versions and a bounded encrypted sample for each.
This is a custody check, not a complete corruption scan.

A current staff user's private product menu supplies an encrypted existing-grant
handoff in the sign-in URL fragment. It preserves the captured native grant and
expiry. Later-life ordinary starts cannot issue a replacement grant. The page
removes the fragment before its first request and keeps credentials in memory.
It uses same-origin scripts, restrictive response headers and no browser storage.
Enrollment consumes a separately approved invitation, confirmation consumes its
TOTP counter, and sign-in requires a subsequent code. The API derives identity
from the native user bearer and rechecks staff eligibility. Public operator
provisioning and recovery endpoints are absent.

Migration 158 installs fifteen administrator presentation keys without adding a
retained resource. Legacy upgrade fixtures include the new catalog migration;
unknown future schema versions remain rejected. The native host fixture launches
the compiled API and gateway with real isolated PostgreSQL and Redis. Synthetic
Telegram transport exercises private entry, concurrent retries with one original
grant, native TOTP, the administrator queue, actual report capture and concurrent
audited assignment/decision commands with encrypted notes. It also exercises
revocation, genuine native Root and approved Return, historical factor custody
without consuming counters, and disabled routes without administrator secrets.
Deletion provider/absence observations in that fixture remain synthetic.

This completes another process composition, not launch acceptance. Photo provider
delivery/cache purge, remaining public journeys, operator host provisioning and
real AWS/R2/domain/Telegram deployment still require completion and evidence.
The owner has not created those accounts; provide one concrete setup checklist
after independent implementation. Real operator, cohort and health acceptance
remain required. Retained-data erasure stays disabled pending approved policies.

## Administrator held-photo delivery and cache revocation

`NAKH_ADMIN_MEDIA_ENABLED` composes the existing photo moderation and audited
evidence delivery in ordinary hosts. It defaults to false and requires both
administration and configured Cloudflare cache purge. The API and gateway use
`RevokePhotoDeliveryCache` with native rendition paths and the actual Cloudflare
purger. A failed purge prevents hide/delete from committing; native confirmation,
assigned review, current permissions, version checks and immutable command receipts
still govern every effect. Retrying a command cannot produce another native effect.

The gateway supplies all five retained-evidence readers and the existing audited
private delivery adapter. Held photos use the real R2 SDK GET path with separate
`NAKH_ADMIN_EVIDENCE_R2_ACCESS_KEY_REF` and
`NAKH_ADMIN_EVIDENCE_R2_SECRET_KEY_REF` credentials. Provision these credentials
with read-only access to evidence objects, without write/delete rights. They are
resolved only when administrator media is enabled; public release snapshots contain
the reference names, never secret values. Native audited authority, physical hold,
content digest and current administrator session are checked before delivery.
Bytes are uploaded directly with protected content, without a public URL or file
cache. A logical photo deletion preserves the reported object's hold.

The compiled API/gateway fixture exercises purge refusal, separate confirmed
hide/delete commands, duplicate command receipts, retained holds after deletion,
opaque Telegram selection and eight concurrent reveal confirmations yielding one
signed S3 GET and one protected upload. It uses real PostgreSQL/Redis with synthetic
Cloudflare, Telegram and S3 transports, including the real SDK signer. Separate
startup tests leave photo commands absent and never resolve provider credentials
when media is disabled. This is implementation evidence, not actual provider,
deployment or operator acceptance. M9's remaining public journeys, operator
provisioning, controlled rollout and launch-health requirements remain open.

## Stored chat relay and private reply handoff

With both chat and Telegram notification delivery enabled, the ordinary worker
renders the exact native stored chat message using the recipient's catalog and
the same user-bound chat alias as the gateway. It sends literal plain text,
without forwarding sender metadata or exposing peer identifiers. The existing
notification authority, current-pair checks, sorted identity locks, lease fences
and ambiguous-result quarantine remain authoritative. Projection and provider
admission also enforce mute and the native fifty-message visibility bound.

Delivery captures an existing, unexpired native user grant; it never issues or
renews one. Signed Open chat navigation and reply state preserve that exact grant.
A reply binding is registered only for a matching private-chat/bot receipt after
durable sent settlement. Redis failure cannot turn known success into another
send. Missing grants retain stored-content delivery with a localized primary-entry
recovery instruction. Gateway replies recheck the original grant before effects
or replay. Unlock commands use their dedicated `v1.pa` action-token namespace.

Migration 160 adds three relay texts. Enabled worker startup verifies schema,
chat catalog variables and safety texts for every active UI locale. Native tests
cover capture without issuance, revocation, mute and visibility bounds; the
compiled ordinary worker/gateway fixture exercises stored-content relay, private
reply, exact-update replay and revoked reply context with real PostgreSQL/Redis
and synthetic Telegram transport. Real provider and launch acceptance remain
pending. Chat reporting, trusted operator provisioning and production composition
remain open; retained-data erasure stays disabled pending approved policies.

The first relay candidate, `198ba5d`, failed its API native shard because the
ordinary-host fixture now starts the worker, while that shard's build closure
included only API and gateway. The worker entry point was absent on the clean
runner. The repair adds the worker dependency closure to the same shard build.
It preserves every native case, all four source receipts, six jobs and their
existing time limits. Repair `1320593` passed all six jobs; its source receipts
and four archived evidence bundles were verified.

## Conversation, message and post-Unmatch reporting

The public report host accepts separately captured conversation scopes alongside
delivered-card scopes. Every scope freezes the original user grant and exact
selection. Native Match anchors establish the reporter's original product epoch;
they do not grant chat access or authorize evidence capture. Preparation, new
submission and cached receipts use the existing threshold, pair and sorted
identity/Account lock order and recheck that original grant. Native M7 resolvers,
capture, rate limits, snapshots, review and retention controls remain authoritative.
Public services expose preparation and submission without administrative reveal.

Enabled chat/report hosts offer conversation reporting and numbered peer-message
selection from the current fifty-message window. Ended-chat entries expose only
opaque context and aliases, with twenty-row keyset pages and the existing native
Unmatch deadline. They do not reopen history or extend reporting eligibility.
Report menus and source/selection cache values omit private message bodies. Reporting
does not issue or renew a user grant. Enabled report startup requires migration 161.

Migration 161 installs four presentation texts and aligns minimal publication
classification with the canonical `message` and `unmatched_user` evidence kinds.
The old classifier omitted both and accepted the historical spelling `unmatch`,
which made real report events block the fail-closed deletion publication gate.
The migration preserves that historical spelling as safety proof, recognizes the
five canonical kinds, and continues rejecting unknown shapes, private content and
unsupported schema versions. Classification grants no capture, purge or release
authority. SQL/TypeScript policy parity and a genuine Root/Return after report
submission verify this composition without bypassing the publication checkpoint.

Native evidence covers twenty concurrent submissions with one capture, borrowed
and revoked grants, exact conversation/message selection, visibility bounds,
twenty-row paging across twenty-two ended contexts, immutable deadlines and
original-life denial after genuine Root and approved Return. An authentic later-life
grant succeeds for a new conversation and remains denied for the old one. The
ordinary compiled API/gateway/worker fixture also exercises report submission and
replay alongside private chat and existing administrator journeys. Provider
transports and lifecycle provider observations remain synthetic.

Dispatch estimates are refreshed from all 166 completed passing suite timings in
accepted run 39073210547 at `1320593`. The new suite retains the existing unknown-file
fallback; independent complete coverage still governs acceptance. All native
cases, four source receipts, six jobs and twenty-minute caps remain required.
Trusted operator provisioning, production composition and actual launch acceptance
remain open. The owner still needs one concrete provider setup checklist after
independent implementation. Retained-data erasure stays disabled pending approved
policies.


## Native cohort authority foundation

Migration 163 adds content-free launch policy and membership facts to the existing
immutable security audit, with no new user-data table, reference catalog, outbox
payload or retained-data release adapter. The protected database owner is the only
issuer: both current and authenticated session identity are checked, including
calls through a definer function. Runtime purpose logins can read admission but
cannot manufacture a policy or membership.

The native controller serializes operator changes, requires the expected global
version, captures a sorted bounded roster and original product epochs, and commits
policy plus all grants atomically. One request ID cannot change issuer, audience,
roster or review digest. Replaying an earlier successful opening after a stop
returns historical metadata without reopening it. Missing policy, closed policy,
expiry, wrong source/environment/bot, absent membership, deleted accounts and
later product lives all deny admission. Policies expire within 24 hours and hold
at most 100 explicitly selected users. The reference to a private review digest
is a prerequisite, not proof that provider or operational acceptance occurred.

Each member is the audit subject; the issuer is the protected system operator.
Validated content-free grants retain their existing security-proof classification.
Root fences them immediately, and fresh Return requires a new original-life grant.
Malformed facts remain blockers. Reserved launch facts written before the owner
and manifest guards existed make the populated upgrade fail atomically.

Native evidence includes concurrent same-command retries, conflicting versions,
mandatory-audit rollback, incomplete deferred manifests, original-life Root/Return,
source/environment/bot isolation, runtime and nested-definer denial, historical
upgrade rollback, and indexed admission over 20,000 earlier policies under the
unchanged 1,500 ms bound. The complete existing 27-plan gate remains unchanged.

The gateway composition below consumes this native authority. The protected
operator host is not yet composed. Keep launch activation off until the remaining
entry points and source-bound canary/daily-review procedures are implemented and accepted. Real
provider and operator approvals, small-cohort launch and observed health remain
required. Retained erasure remains disabled pending approved policies.

## Gateway cohort dispatch and primary entry

An active staging or production product gateway requires migration 163, a full
source SHA and the configured bot identity. Its composition has no switch to
bypass cohort admission. Local/test profiles retain synthetic fixture behavior.
Each new product dispatch reads native membership without caching a successful
receipt, and checks the original Telegram owner and Account epoch across waits.
The release controller already binds the configured release SHA to the selected
image source; changing the source, environment or bot requires a new policy.

Authenticated payment updates, deletion/Return controls, support/appeals, reporting
and administrator handlers run before product admission. Restricted chat dispatch
decodes owned navigation and permits only mute, confirmed Unmatch and bounded
ended-conversation report selection. It cannot spend credits, send text/questions,
open ordinary chat history or issue product navigation. Unmatch retries preserve
one native record and outbox event; content-free delivery notices may repeat.

An unlisted first `/start` can create its limited native identity, allowing an
operator to select that existing user later. It receives the existing localized
capability-denial text and no product buttons or user-session grant. Explicit
membership allows the ordinary primary-entry path. A stop prevents a later start
from renewing that grant and blocks saved signup/photo/interaction navigation.
Approved fresh-entry controls still complete, but their optional product-opening
hook requires the new original-life membership independently. Deleted-account
start titles remain part of limited privacy access.

Admission controls new dispatches; it does not cancel an already executing native
command or reverse financial settlement. Native session, account, pair, permission
and idempotency checks remain mandatory. Native staging HTTP/Redis evidence covers
the registration/open/stop boundary; chat evidence covers retained safety actions
without history disclosure. Telegram transports remain synthetic.

The restricted safety entry and hosted API qualification below cover the next
entry boundaries. The protected operator host, actual canaries, health review and
provider approvals remain required before launch.

## Restricted reporting entry and hosted API qualification

An authenticated private `/report` can open report choices after old navigation
or authentication proof is unavailable. It first resolves the Telegram owner and
original Account epoch, checks the current identity and reporting eligibility,
and reads only current-life conversation metadata. Missing ownership, banned or
deleted Accounts, old product lives and expired post-Unmatch windows cannot mint
fresh reporting navigation. A separate entry rate budget is keyed by the stable
user identity and does not reset on Return.

This deliberate entry uses the existing native user authentication primitive with
a request ID bound to bot, Telegram owner, original life and update. Concurrent
retries converge on one new proof. It neither updates nor revives the old proof,
changes primary-entry activation, nor publishes a generic credential. The host
emits only report-domain opaque capabilities. Original product navigation retains
its original grant, and normal product dispatch still requires cohort membership.
Native report preparation and capture reauthorize the selected incident and
evidence independently.

The chooser returns twenty metadata-only choices and a keyset cursor, retaining
the same grant on later pages. It combines currently active conversations and
still-reportable Unmatch incidents without chat history, names, message text or
raw IDs in provider payloads. Original reporting deadlines are unchanged. An
approved fresh Return sees no earlier-life contexts; an eligible new context
requires its own fresh authentication proof.

The ordinary API bootstrap supplies no optional legacy user-report/support
composition. Its baseline routes are health and the foundation sample route;
valid sample writes now return 404 in both hosted environments, before native
effects. The real staging HTTP fixture checks the registered baseline route set,
readiness, rejected retries and absence of idempotency/outbox writes. Production
continues to require purpose-role and TLS admission. Enabled modules add the
existing authenticated administrator and limited privacy surfaces, or the signed
media source-authority endpoint covered by their existing native suites. Existing
media grants retain their independent TTL and source-revocation rules; report
entry cannot issue a media grant or a new discovery delivery.

The stopped-cohort staging gateway fixture exercises fresh report entry, opaque
selection, native evidence capture and duplicate submission, while ordinary
`/start` remains denied. Provider menu/prompt delivery is synthetic and unexpected
live transport calls fail the fixture. Additional native evidence covers twenty
entry retries, retained revocation of the old grant, ownership/account denial,
twenty-row paging across twenty-two contexts, immutable deadlines and genuine
Root/approved Return fencing. These fixtures do not prove real provider delivery
or operator acceptance. Retained-data erasure remains disabled.

Dispatch estimates use all 170 completed passing suite timings from accepted
source `ca74a49`, run 39126923511. The new API suite keeps the existing 30-second
unknown-file fallback. Four shards, twenty-minute job caps, independent complete
coverage and zero skips remain mandatory; only dispatch weights change.

### Required native receipt upload transport recovery

Run 39130853636 for source `77b2182` is not accepted. Its scheduler native
shard passed all 332 tests in 44 files, but the subsequent GitHub CreateArtifact
request timed out (`ETIMEDOUT`). The required receipt was unavailable and the
aggregate job could not run; passing native tests alone do not satisfy acceptance.

Receipt transport now has two attempts, each bounded to one minute. Only the
first upload tolerates failure, and a final gate requires an actual successful
upload outcome. The retry replaces only the same source/shard/run-attempt
artifact if necessary. Native execution is not retried by this transport repair.
The aggregate still independently validates source binding and complete coverage.
Four native shards, twenty-minute job caps, zero skips and all 27 query plans
remain mandatory. GitHub's raw step `outcome` is checked before the
`continue-on-error` conclusion adjustment; see the
[official steps context documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#steps-context).
