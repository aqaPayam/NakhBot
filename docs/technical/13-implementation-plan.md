# Implementation Plan

## 1. Team roles

Minimum accountable roles may be combined in a small team, but ownership must remain explicit:

| Role | Accountable work |
|---|---|
| Backend technical lead | architecture, module boundaries, reviews, risk decisions, delivery integration |
| Backend engineers | use cases, adapters, repositories, workers, tests |
| Database engineer/owner | schema/migrations, query/index review, backup/restore, capacity |
| Platform/SRE engineer | environments, CI/CD, secrets, telemetry, runbooks, reliability |
| QA/automation engineer | acceptance/concurrency/E2E/performance traceability |
| Security/privacy reviewer | threat model, access, media/payment/deletion/admin review |
| Product owner | clarifies only genuine product behavior; accepts user journeys/localized copy |
| Moderation/support owner | safety workflow, seed data, runbook and staffing acceptance |

Do not split engineers into Telegram-only business logic and API-only business logic. Teams implement modules/use cases and thin adapters.

## 2. Delivery principles

- Build walking vertical slices through real PostgreSQL/outbox/worker/Telegram fake rather than all tables first and behavior later.
- Establish correctness infrastructure before money and moderation.
- Every slice includes migration, use case, adapter, authorization, idempotency, telemetry, deletion registration, and tests.
- Deploy to staging continuously; keep incomplete surfaces behind flags.
- Product constants/catalog/localization seeds are versioned and reviewed.

## 3. Milestones

### M0 — engineering foundation

Deliver:

- pnpm monorepo, strict TypeScript, import-boundary lint, build/test scripts;
- API/gateway/worker/scheduler bootstraps and typed configuration;
- PostgreSQL/Redis local stack, migration runner, unit of work;
- command/query contracts, error model, idempotency, outbox/inbox;
- OpenTelemetry/log redaction, CI scans, OCI images;
- staging IaC skeleton and fake Telegram/payment/media providers.

Exit gate: duplicate sample command creates one effect/outbox; worker crash/replay is safe; migration and restore smoke run in CI.

### M1 — identity, access, localization, signup/Profile

Deliver User/Telegram identity, Account transitions/history, settings, guest preview counter, signup draft/progress, catalogs, Profile completion/edit/change requests, localization rendering, and start routing.

Exit gate: `ACC-001..007`, access matrix, no prose outside localization, concurrency and protected-field review tests pass.

### M2 — media

Deliver Telegram ingestion, quarantine/validation, thumbnails/on-demand blur, photo order/primary, moderation hide/restore/delete, signed delivery grants, cleanup.

Exit gate: `ACC-008..013`, malicious-image corpus, R2 failure/retry, object authorization and deletion verification pass.

### M3 — discovery and free interactions

Deliver Explore/Guest candidate query, saved temporary filters, reciprocal compatibility, atomic consumption, Like, Liked By derived query, Not Interested, opposite-Like Match/chat creation.

Exit gate: `ACC-014..019`, property and production-volume query-plan tests pass.

### M4 — billing foundation and paid unlocks

Deliver CreditAccount/ledger/packages, PendingPayment/PaymentRecord/provider events, Stars invoice/pre-checkout/success, corrections/refunds, Liked By and chat FeatureUnlocks, reconciliation.

Exit gate: `ACC-020`, `ACC-032..033`, `ACC-036..038`, callback replay/crash/concurrency/property tests and payment runbooks pass.

### M5 — Nakh

Deliver NakhFlow, pending/delivered phases, quota counter, edit/cancel, direct/credit funding, strict FIFO auto-settlement after every balance increase, reminders, expiry, receive/accept/reject/report, Match creation.

Exit gate: `ACC-021..030`, oldest-first/stop/close-and-continue properties, provider replay and concurrency tests pass.

### M6 — chat and notifications

Deliver predefined prompts, unlock-gated text, sequence/read/mute, bot relay, 50-message cleanup, durable notification preferences/delivery/retry.

Exit gate: `ACC-031..035`, `ACC-038`, delivery-provider failures, retention/snapshot and cross-user authorization pass.

### M7 — reports, moderation, admin, support, appeal

Deliver reasons/evidence/snapshots, distinct threshold restriction, review/actions/internal block, RBAC/action log, support limits, one appeal per ban event.

Exit gate: `ACC-039..041`, permission matrix, concurrent fifth report, operator audit, internal-block lifecycle and threat tests pass.

### M8 — deletion, retention, production hardening

Deliver immediate tombstone, purge saga/checkpoints, shared closure, media deletion, retained-data manifest, fresh return, backup/PITR, dashboards/alerts/runbooks, load/failure/security tests.

Exit gate: `ACC-042..044`, full deletion entity registry, restore/DR, production-like load, external security review, operational sign-off pass.

### M9 — controlled launch

- seed/verify production catalogs, UI text, prompts, prices/config, admin roles;
- create production infrastructure/secrets/bot/webhook/R2;
- run canary synthetic accounts and moderation/payment drills;
- launch small cohort, observe support/safety/capacity, then increase gradually;
- hold daily launch review until error budget, payment reconciliation, safety queue, and deletion remain healthy.

## 4. Work-item definition of done

A backend work item is done only when:

- canonical rule and acceptance ID are linked;
- public contract and authorization/error behavior are documented;
- SQL migration/constraint/index/query plan reviewed;
- transaction, lock order, idempotency, outbox/jobs defined;
- telemetry/audit/redaction implemented;
- user-data classification, retention, and deletion registry updated;
- unit, real-database, adapter, negative, duplicate, and concurrency tests pass as applicable;
- localization keys/seeds exist;
- runbook/alert updated for a new operational failure mode;
- staging journey is demonstrated through an actual adapter;
- no unresolved high-severity review issue remains.

## 5. Pull-request ownership

Require code-owner approval for:

- domain/contract/status/config changes: backend lead + product owner;
- migrations/index/queries: database owner;
- payments/ledger/refund: backend lead + database owner + QA/security reviewer;
- moderation/admin/deletion/retention: security/privacy owner plus module owner;
- infrastructure/secrets/network: platform owner;
- localization seeds/user-facing flows: product/localization owner.

Small reviewable changes are preferred. A migration and the code that depends on it must state deployment order.

## 6. Inputs required before specific milestones

Coding can begin now. These inputs have deadlines:

- before M2 staging: R2 staging account/bucket/credentials and CDN delivery domain;
- before M4 integration: separate Telegram test bot with Stars test workflow and correction verification;
- before M7: bootstrap admin identities, final role assignments, moderation/support operating procedures;
- before M8 production: hosting provider/regions, approved retention durations, KMS/secret/telemetry/paging accounts, launch capacity forecast;
- before M9: production bot/token/webhook domain, production R2, catalog/UI seed approval, on-call and moderation staffing.

## 7. First implementation backlog

The technical lead should create these epics in order:

1. Repository/CI/runtime foundation.
2. PostgreSQL migration and reliability primitives.
3. Identity/account/access/localization.
4. Signup/Profile/catalogs.
5. Media ingestion and delivery.
6. Discovery/interaction/Match skeleton.
7. Billing/entitlements/reconciliation.
8. Nakh and FIFO settlement.
9. Chat/notification delivery.
10. Moderation/admin/support/appeal.
11. Deletion/retention/privacy verification.
12. Production infrastructure, resilience, security, and launch.

Each epic is decomposed into vertical use cases and acceptance IDs, not CRUD tables.

## 8. Go/no-go checklist

No-go if any of the following is true:

- a canonical acceptance scenario is missing, skipped, or flaky;
- payment reconciliation or ledger invariant has an unexplained mismatch;
- object-level authorization or callback replay can leak/grant twice;
- deletion cannot enumerate a newly introduced user-linked table/object;
- backup restore or migration rehearsal failed;
- critical alerts/runbooks/on-call or moderation coverage are absent;
- high/critical security finding is unresolved without approved expiring exception;
- production capacity test misses the agreed peak plus headroom;
- catalog/localization/config seeds differ from approved specification.
