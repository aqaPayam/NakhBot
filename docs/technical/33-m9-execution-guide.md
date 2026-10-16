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
