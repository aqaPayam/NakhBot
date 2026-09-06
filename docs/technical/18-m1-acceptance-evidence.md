# M1 Acceptance Evidence and Traceability

This ledger distinguishes implemented M1 evidence from scenarios whose final owner is a later milestone. CI evidence is reproducible from the default branch. Staging observations are recorded separately and must never be inferred from local or CI success.

## Acceptance ledger

| Evidence ID | M1 status | Evidence | Canonical status / next owner |
|---|---|---|---|
| `ACC-001/M1-E2E` | closed | simultaneous first-start PostgreSQL test; one User aggregate, audit, outbox, and idempotent replay | closed |
| `ACC-002/M1-COUNTER` | component proof complete | final-slot race plus 50-way concurrency smoke; counter, audit, and outbox stop exactly at 10 | open until M3 atomically creates `ExploreConsumption` after accepted delivery |
| `ACC-003/M1-E2E` | closed | settings versioning, visibility, capability, audit, and replay tests | closed |
| `ACC-004/M1-POLICY` | policy proof complete | centralized Active/visibility capability matrix | open until M5 interaction workflows |
| `ACC-005/M1-POLICY` | policy proof complete | centralized Restricted read/write policy | open until M6 chat workflows |
| `ACC-006/M1-ROUTE` | route proof complete | centralized Banned route/capability policy | open until M7 appeal workflow |
| `ACC-007/M1-E2E` | closed | durable ordered signup, restart/resume, stale writer, confirmation, and media-proof tests | closed |

## M1 rule-to-code traceability

| Rule / risk | Implementation | Automated evidence |
|---|---|---|
| Account transitions and state routing | `packages/domain/src/identity/account.ts`, `packages/domain/src/access/capability-policy.ts` | `packages/domain/src/m1.test.ts`, capability authorizer tests |
| Telegram identity and duplicate first start | identity handler/store and Telegram adapter | Telegram adapter tests and PostgreSQL simultaneous-first-start test |
| Strict contracts and localization-only prose | `packages/contracts/src/m1.ts`, localization manifest | contract and localization manifest tests |
| Durable ordered signup and normalized validation | signup Domain/application/PostgreSQL stores | signup unit tests and restart/stale-writer PostgreSQL test |
| Atomic media-gated Profile confirmation | Profile confirmation handler/store | media-proof unit test and PostgreSQL confirmation replay test |
| Profile edit invalidation/restoration | Profile store synchronous revalidation | PostgreSQL Profile edit/catalog-state test |
| Protected birth-year/gender review | protected-change Domain/handler/store and migration `000008` | authorization unit test and PostgreSQL request/review concurrency test |
| Permanent Guest Preview maximum | `PostgresGuestPreviewStore` transaction primitive | `ACC-002` final-slot PostgreSQL test and `scripts/m1-load-smoke.ts` |
| Idempotency, audit, and outbox atomicity | PostgreSQL stores and foundation tables | replay/conflict tests asserting final audit/outbox state |
| Log privacy and bounded metrics | `@nakh/observability` redaction and M1 metric registries | observability policy tests |
| Deletion ownership | data-retention registry | retention-registry completeness test; deletion execution remains M7-owned |
| Migration and recovery safety | forward migrations, verification SQL, restore smoke | CI migrate/verify/replay and backup/restore jobs |

## Release evidence

Record the default-branch commit and CI run URL after PR 8 passes. Then execute [`deploy/runbooks/m1-staging-acceptance.md`](../../deploy/runbooks/m1-staging-acceptance.md). M1 must not be declared complete until every required staging item has evidence, an owner, and a timestamp.

Cloud purchase is not required for preparation: AWS bootstrap/staging IaC, the guarded manual deployment workflow, and the local production-image rehearsal are versioned and CI-validated. They are readiness evidence only. Real AWS deployment and the manual observations remain mandatory for final M1 acceptance.
