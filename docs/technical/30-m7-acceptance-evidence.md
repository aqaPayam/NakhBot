# M7 Acceptance Evidence and Staging Handoff

Status: **code complete / staging blocked**. Reporting, moderation, administrator authorization,
authenticator MFA, internal blocks, support, exact-ban appeals, reconciliation, retention,
production-shaped plans and collector conversion have automated evidence. Real provider delivery,
deployed alert routing and named operator acceptance remain release blockers. M8/M9 are outside this
handoff. This status supersedes historical progress entries in the M7 execution guide.

## Verified implementation checkpoint

The implementation checkpoint is `dc6487995168883cf54dfe61d9e2a0157546eb39`, verified by
[all six CI jobs](https://github.com/aqaPayam/NakhBot/actions/runs/37610530995): quality,
PostgreSQL reliability, and API, Telegram gateway, worker and scheduler image builds.
The full local check passed 888 unit tests; native CI passed 405 integration tests in 84 files.
Migration bootstrap, historical upgrades, verification and unchanged replay cover migration 84.
The frozen three-role/fourteen-permission seed remains authoritative.

The first collector run on `fa0f8e5` failed its strict root-field assertion because it omitted the
exporter's fixed EMF version field. The checkpoint repair requires `Version: "1"`; every other
privacy, dimension, scope and instrument gate remains active. No acceptance work advanced from the
failed head. The documentation candidate must pass its own exact-head six-job run before handoff;
this checkpoint does not substitute for a later candidate's CI or staging evidence.

## Acceptance ledger

| Evidence | Automated status and reproducible source | Required real staging observation |
|---|---|---|
| `ACC-039` distinct reporters | complete; `moderation-threshold-store.integration.test.ts` tests the rolling 30-day window and distinct unresolved reporters | repeated reports from one reporter do not restrict; five distinct qualifying reporters do |
| `ACC-040` fifth-report race | complete; the same suite races twenty candidate fifth reports into one episode, restriction, history, notice and audit, without a ban | repeat concurrent signed report actions and replay through the test bot |
| `ACC-041` permission and attempted-command audit | complete; administration, admin-command, native-session and HTTP/Telegram ingress suites cover permission denial, stale/disabled/revoked actors, replay, rejection and audit rollback | exercise every role/permission combination, including failed attempts, using enrolled test administrators |
| Immutable report evidence | complete; five report-source/submission suites, report-services composition, snapshot readers, retained-photo reveal/cleanup and evidence-delivery ingress | reveal each synthetic evidence kind through real Telegram/private object delivery; reject foreign, expired and tampered actions |
| Moderation and internal blocks | complete; account/photo moderation, confirmed-action and internal-block suites bind exact targets and serialize against Match creation | confirm photo/account actions, silent pair closure and removal without reopening old Match/Chat access |
| Support admission and review | complete; support-store and user/admin API suites enforce the shared two-unanswered limit, current ownership, confirmation and audited reply/close | exercise banned-user routing, concurrent opens/replays, replies and closure through the test bot |
| One appeal per exact ban | complete; appeal-store, confirmed-appeal and API suites reject forged, foreign and stale opaque user-bound references and converge concurrent submissions | submit/replay against the current ban; confirm an older reference cannot target a later ban |
| Reviewed appeal and separate unban | complete; appeal-review/unban stores and HTTP/Telegram ingress prove acceptance leaves the ban intact and a separately confirmed permission-checked command consumes only the exact current acceptance | accept as reviewer without unban permission, verify the ban persists, then unban as an authorized administrator; race/replay and later-ban denial |
| Native authenticator MFA | complete; TOTP primitive, verifier/enrollment, native-session and host API suites cover one-use counters, enrollment approval, recovery/revocation, rate limits, identity and audit rollback | enroll an authenticator app through the trusted operator approval path; confirm replay, logout, revocation, recovery and first-factor failure |
| Reconciliation and current integrity | complete; bounded ten-phase reconciliation and operational-health/integrity suites preserve cursors, deduplicate findings, detect/clear exact bindings and never repair automatically | terminate/restart scheduler/worker, inject controlled drift, diagnose stale samples, repair only with authorized commands and retain audits/quarantines |
| Migration and recovery | complete; migration suite, container migration artifact and backup/restore smoke | rehearse schema-compatible release rollback and database restoration without reversing migrations or deleting history |
| Performance and telemetry | complete; exact-checkpoint artifacts below | approve launch/2× load budgets and verify CloudWatch alarm/recovery delivery in the real environment |

Sources are under `packages/persistence-postgres/src`, `packages/application/src`, `apps/api/src`
and `apps/telegram-gateway/src`; run `pnpm check` and the CI PostgreSQL reliability workflow to
reproduce the complete set. Synthetic tests are not provider or operator sign-off.

## Retained checkpoint evidence

| Artifact | Verified result | Archive digest |
|---|---|---|
| `m7-performance-dc6487995168883cf54dfe61d9e2a0157546eb39` | all 27 plans passed with original 20,000-row populations and unchanged 1,500 ms limit; support load accepted 10, denied 90 and replayed 100 across five users | `sha256:9c4f6c9568cac92e5b3f81d20f27e9c1636b59f6acac50e13f94d3e029af25db` |
| `m7-telemetry-dc6487995168883cf54dfe61d9e2a0157546eb39` | actual SDK → OTLP HTTP → pinned ADOT → awsemf stdout; thirteen instruments, ten phases, drift/clear, freshness, initial failure, private-marker rejection and preserved prior metrics | `sha256:eaf5da2a70b20174db79a8808b75056d0a6abeb836a5ffe43a0047829309bde5` |

Collector evidence explicitly records `cloudWatchDeliveryVerified: false` and
`snsRoutingVerified: false`. Staging Terraform declares ten phase-only current-drift alarms and
one missing/stale-sample alarm alongside the existing eight operational alarms. Configuration
validation and stdout conversion prove neither deployment nor subscription receipt.

CI retention is fourteen days. Preserve exact-candidate artifacts and their digests in the
restricted release evidence store before expiry. Store only immutable release/image references,
UTC intervals, aggregate measurements, fixed outcomes and named reviewer sign-offs. Do not retain
raw metric payloads, SQL predicates, private prose, subject identifiers, secret material or signed
actions in the shared ledger.

## External release blockers and owners

| Owner | Required completion |
|---|---|
| Backend / operations | isolated PostgreSQL/Redis, secret store, schema-compatible immutable deployment, trusted first-factor authentication, native TOTP key resolution and restricted operator approval/recovery composition |
| Operations | actual CloudWatch export, all nineteen M7 alarms and recoveries reaching the subscribed on-call channel, scheduler restart, failover, restore and rollback drills |
| Moderation / product | separate Telegram test bot and synthetic testers; report, evidence, threshold, photo, internal-block, support and appeal/separate-unban drills on that same release |
| Security | private object storage and retention controls, MFA/key custody, reveal/audit-failure and telemetry privacy review, and signed acceptance of the tested release |
| All five reviewers | complete [the M7 staging runbook](../../deploy/runbooks/m7-staging-acceptance.md), record Critical/High acceptance defects as zero, and sign the evidence ledger |

No real environment or named sign-offs have been supplied or verified. Keep ordinary startup
capabilities disabled until their explicit staging composition is reviewed and tested. M7 remains
**code complete / staging blocked** until these owners close the ledger; it is not production-ready.
