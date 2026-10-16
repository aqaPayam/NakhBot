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

This first runtime connection sends the public route title only. It issues no
session or action grants and exposes no nonfunctional buttons. Signup, product
navigation and the post-Return activation-to-menu bridge still need wiring
before a usable canary. Existing M8 Return/fresh-entry controls run first in the
webhook and retain their separate confirmation protocol. Rendering tests use
synthetic Telegram delivery; they do not establish real provider acceptance.

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
