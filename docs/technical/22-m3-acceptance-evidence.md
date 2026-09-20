# M3 Acceptance Evidence and Traceability

Status: automated functional, concurrency, and production-shaped query-plan gates implemented; real
Telegram/private-edge staging evidence remains a release blocker. CI success is not provider or
staging evidence.

This ledger records what the default branch proves and what must still be observed against the exact
immutable staging release. It must not be used to enable M3 before every external blocker is closed.

## Acceptance ledger

| Evidence ID | Automated status | Reproducible evidence | Remaining staging evidence |
|---|---|---|---|
| `ACC-014/M3-FILTER-ISOLATION` | complete | PostgreSQL filter save, replay, version race, and preference-subset tests leave Profile preference unchanged | repeat through the authenticated staging route |
| `ACC-015/M3-RECIPROCITY-PROPERTY` | complete | domain property/boundary tests and PostgreSQL reciprocal candidate selection reject either-sided incompatibility | sample production-shaped catalog/filter combinations |
| `ACC-016/M3-CONSUMPTION-RACE` | complete | integration tests plus `scripts/m3-load-smoke.ts` make 50 simultaneous reservations converge, complete one delivery under 25 replays, and select a different candidate afterward | terminate a staging delivery worker before and after provider acceptance and prove convergence |
| `ACC-017/M3-MUTUAL-LIKE-RACE` | complete | integration test proves one pair race; load smoke races 20 independent opposite-Like pairs and requires one Match, one Chat, and two memberships per pair | run the same burst at the launch profile and inspect invariant alarms |
| `ACC-018/M3-IRREVERSIBILITY` | complete | domain transition tests and PostgreSQL interaction tests prove Like/Not Interested replay, permanent consumption, silent closure, and no reopen path | verify user-visible silence and replay through Telegram |
| `ACC-019/M3-LIKED-BY-MATRIX` | component complete | shared PostgreSQL actionable predicate excludes restricted accounts, pair state, rejection, stale/foreign media, and unauthorized receivers; count/page share one snapshot | complete the production-shaped exclusion matrix and real private-edge denial observations |

## Rule-to-code traceability

| Rule or risk | Primary implementation | Automated evidence |
|---|---|---|
| Filter isolation and reciprocal discovery | domain discovery policy, `PostgresExploreFilterStore`, `PostgresCandidateReservationStore` | unit/property tests plus filter and reservation integration suites |
| No-repeat delivery | candidate reservation/delivery stores and consumption uniqueness | reservation race, completion replay, definitive failure, Guest Preview counter, and M3 load smoke |
| Interaction serialization | canonical pair lock and `PostgresInteractionStore` | simultaneous opposite Likes, replay, Match/Chat cardinality, rejection, and load smoke |
| Liked By privacy | shared actionable predicate, opaque references, blurred grant authorization | count/keyset, exclusion, actor binding, expiry/tamper, stale grant, presentation, and private-edge tests |
| Durable Telegram delivery | gateway handoff, fenced PostgreSQL queue/receipts, resumable worker sender | enqueue replay, lease fencing, retry/terminal classification, receipt replay, partial-send resume, and runtime composition tests |
| Operational safety | bounded M3 metrics, aggregate backlog query, CloudWatch alarms, disabled activation flag | metric registry, backlog integration, configuration, deployment-readiness, and disabled-composition tests |
| Migration safety | migrations `000017` through `000024` and verification SQL | empty/replay migration CI, PostgreSQL integration, restore smoke, and production images |

## Default-branch automated gate

The staging candidate must pass, without skipped M3 acceptance or concurrency scenarios:

1. frozen dependency installation, formatting, lint, type checks, unit tests, and production builds;
2. migration/verification replay and every PostgreSQL/Redis integration suite;
3. `pnpm test:m1-load-smoke` and `pnpm test:m3-load-smoke`;
4. Terraform formatting/validation, container builds, dependency audit, and restore smoke;
5. the production-volume candidate/Liked By query-plan gate, with its privacy-safe artifact retained.

Record for the staging candidate:

| Field | Required value |
|---|---|
| Commit | immutable 40-character default-branch SHA |
| CI run | successful GitHub Actions run URL for that SHA |
| Release | immutable staging image/release identifiers |
| Reviewers | named backend, operations, and security reviewers |
| Recorded at | UTC timestamp |

## Open release blockers

- provision a private R2 bucket and private-media edge with a separate audience-credential key;
- inject the Telegram, action-token, media-signing, audience, and scoped R2 secrets by reference;
- attach the successful production-shaped candidate and Liked By query-plan artifact from the exact
  immutable candidate CI run and confirm its latency/block budgets are still approved;
- complete the remaining `ACC-019` prohibited-state matrix at production-shaped volume;
- run provider-success-before-receipt, worker termination, throttling, timeout, key rotation, and
  rollback drills against real staging services;
- complete [`m3-staging-acceptance.md`](../../deploy/runbooks/m3-staging-acceptance.md), attach only
  protected evidence, and obtain all reviewer sign-offs.

No local fixture, simulated provider, placeholder endpoint, or successful CI run may be entered as
real Telegram, R2, private-edge, performance, or staging evidence.
