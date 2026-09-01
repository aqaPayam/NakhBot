# Testing Strategy

## 1. Test philosophy

The highest-risk defects are invalid state transitions, concurrency races, duplicate provider effects, authorization leaks, and irreversible deletion/payment errors. Tests therefore use real PostgreSQL and Redis wherever those semantics matter. Mock-only repository tests are insufficient evidence.

All tests use a fake clock, deterministic UUID generator where helpful, isolated database schema/container, synthetic users, and provider fakes that can duplicate, delay, reorder, fail, and return uncertain results.

## 2. Test layers

### Domain unit tests

Pure policies and transition tables: age/year normalization, Profile completion, reciprocal gender preference, notification mutability, Account capability, Nakh/Like/Match states, scope effectiveness, retry classification, and localization intent variables.

### Application component tests

Run one command/query with real PostgreSQL repositories and fake external ports. Verify rows, history/ledger/audit/outbox, typed result/error, and rollback. Every command has authorization, idempotency, stale-state, and invalid-transition cases.

### Database invariant tests

Execute direct hostile inserts/updates to prove checks, foreign keys, partial unique indexes, append-only permissions, and deferred constraints reject impossible rows. Run migrations from empty and previous snapshots and compare generated schema.

### Concurrency tests

Use two or more independent database connections synchronized at lock points. Repeat enough times to expose scheduling variations. Required races include first start, photo limit/primary, opposite Likes, NakhFlow/quota, accept versus reject/expire, Match creation, credit spends, unlocks, provider callbacks, fifth reports, unmatch/message, and deletion/concurrent commands.

### Contract tests

Validate HTTP, Telegram, event, job, localization, R2, and payment adapters against owned JSON schemas and recorded safe provider examples. Producer/consumer compatibility runs in CI for current plus supported previous schema versions.

### End-to-end tests

Run containers for API, Telegram gateway, worker, scheduler, PostgreSQL, Redis, and fake providers. Drive complete user journeys through webhook/HTTP and inspect only public results plus permitted test probes.

### Performance and resilience tests

- representative launch and 10x profiles with realistic row/index distribution;
- sustained and burst ingress, discovery, chat, notification, photo, payment callback load;
- DB/Redis/provider latency and failure injection;
- worker termination before/after commit/side effect;
- backup restore, release rollback/forward migration, queue replay;
- memory/connection leak and 24-hour soak.

### Security/privacy tests

Object-level authorization, replay/tamper, injection, Unicode/markup, rate-limit bypass, signed media URLs, malformed images, secret/log scanning, admin permissions, deletion manifest, and dependency/container/IaC scans.

## 3. Test data builders

`testkit` supplies builders that create only legal public state through application commands. Special low-level fixtures deliberately create boundary database states for constraint testing. Builders include:

- account in every state with current ban/restriction episode;
- complete/invalid profiles and reciprocal/non-reciprocal preferences;
- valid/hidden/deleted photos and variants;
- pair with consumption/Like/NotInterested/Nakh/Match/block combinations;
- exact balances, PendingPayment/PaymentRecord lifecycle, provider events;
- active/closed chat with message tail and report snapshots;
- distinct reporter windows and admin roles;
- deletion saga at every checkpoint.

Fixtures are versioned with migrations. No production data is imported.

## 4. Domain acceptance suite

The 44 canonical acceptance scenarios in `docs/domain/06-business-rules-and-invariants.md` are executable test IDs `ACC-001` through `ACC-044`. CI must show each ID once in the traceability report; a skipped scenario fails the release build unless it has an explicit expiring waiver.

Additionally test every legal/illegal transition from the status registry and every configuration boundary: value below, exact minimum, exact maximum, above maximum, null, malformed Unicode, duplicate, and concurrent submission.

## 5. Payment correctness suite

- callback duplication/reordering and conflicting duplicate facts;
- exact balance under concurrent spend;
- Stars receipt with target closure before fulfillment;
- crash at every boundary from event receipt through correction;
- FIFO auto-settlement after every successful CreditAccount increase, ordered by created time then ID;
- older ineligible pending item closes and processing continues; older eligible unaffordable item stops the run;
- ledger chain and account balance property tests;
- one charge maps to exactly one fulfillment/correction.

Property: for any history of valid commands and duplicate/reordered messages, CreditAccount balance is non-negative and equals the ledger fold, and each external charge has no more than one value grant.

## 6. Discovery and pair property tests

Generate random user pairs, catalog preference mappings, filters, account/profile/media states, and interaction history. Assert:

- candidates always satisfy reciprocal Profile compatibility;
- temporary filter only narrows candidates;
- no consumed pair is returned again;
- self, deleted/restricted/banned/invalid/invisible/blocked/unmatched users never appear;
- at most one directional Like/NakhFlow and normalized Match exist;
- terminal pair state prevents rediscovery/rematch;
- results do not reveal why an excluded target is absent.

## 7. Deletion verification

Seed a User with every entity/reference, shared pair data, media objects, payment evidence, report evidence, caches, jobs, and derived projections. Interrupt deletion after each checkpoint and resume. A machine-readable assertion lists:

- rows/objects that must be absent;
- shared rows that must be safely closed/pseudonymized;
- explicitly retained rows and matching DataRetentionRecord purpose;
- denied post-delete commands;
- fresh-return state with permanent GuestPreviewCounter/safety policy and no restored product data.

Run this test on every migration that introduces a user-linked table or object prefix. CI requires the table to be added to the deletion registry.

## 8. Performance gates

Before production at expected peak and two-times headroom:

- no SLO regression against the accepted baseline beyond configured tolerance;
- no unindexed high-frequency query or sequential scan over a large authoritative table without review;
- PostgreSQL CPU/IO/connections and Redis memory remain below saturation thresholds;
- queue oldest age returns to baseline after a burst;
- no correctness failure under injected duplicate/retry load;
- media and notification load cannot starve payment/safety queues;
- load-test data scale, scripts, commit, configuration, and results are archived.

## 9. CI pipeline

Pull request:

1. formatting, lint, dependency/import-boundary, generated-contract drift;
2. unit/property tests;
3. SQL migration and database invariant tests;
4. application/concurrency tests with PostgreSQL/Redis containers;
5. contract and adapter tests;
6. security/dependency/secret/IaC scan;
7. build signed candidate images and SBOM.

Main/nightly adds full end-to-end, fuzz/media corpus, extended concurrency, performance smoke, reconciliation, and deletion matrix. Release candidate adds production-like load, restore, migration, failure injection, and manual security/operational sign-off.

Flaky tests are defects: quarantine requires owner, issue, evidence, and expiry; quarantined acceptance/security/payment/deletion tests block release.
