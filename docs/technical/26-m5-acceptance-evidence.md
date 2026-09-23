# M5 Acceptance Evidence and Traceability

Status: provider-neutral implementation is present through checkpoint 9 (lifecycle, both funding
paths, FIFO settlement, maintenance, receiver actions, reconciliation, production plans/load,
metrics, alarms and operations). Real Telegram/Stars staging evidence remains a release blocker.
Green CI is necessary but is not provider or staging evidence.

## Acceptance ledger

| Evidence ID | Automated status | Reproducible evidence | Remaining staging evidence |
|---|---|---|---|
| `ACC-021/M5-DIRECTION-RACE` | complete | 20 concurrent starts converge through pair lock, unique direction and replay | repeat through the test bot/channel adapter |
| `ACC-022/M5-QUOTA-RACE` | complete | 20 attempts at four pending items admit one fifth; locked counter/source facts agree | observe localized quota response in staging |
| `ACC-023/M5-PENDING-PRIVACY` | complete | sender-only query and notification assertions; no receiver row/projection while pending | inspect staging Telegram and exported telemetry |
| `ACC-024/M5-FIFO` | complete | randomized property/integration tests plus retained 100-item/160-worker load artifact | exercise credit increases and worker restart in staging |
| `ACC-025/M5-STARS-EXACTLY-ONCE` | complete | receipt replay, fenced fulfillment and crash-boundary facts create one Nakh/notification | run 100 real test callbacks and worker termination |
| `ACC-026/M5-DELAYED-ELIGIBILITY` | complete | visibility-off allowed; restricted/banned/deleted/invalid/pair-terminal states close without spend | exercise the matrix through staging controls |
| `ACC-027/M5-FUND-EDIT-CANCEL-RACE` | complete | concurrent commands converge to one delivery or one chosen conversion with correct quota | repeat with a real pending Stars invoice |
| `ACC-028/M5-REJECT` | complete | terminal-action uniqueness persists `rejected`, blocks accept, and renders Closed | verify localized Telegram rendering |
| `ACC-029/M5-CLOCKS` | complete | fake-clock boundary tests prove six reminders and separate 14-day clocks; scheduler is bounded | restart the staging scheduler across due boundaries |
| `ACC-030/M5-ACCEPT-MATCH` | complete | 20 accept/reject/replay workers create at most one Match/Chat with two participants | observe both staging participants and notifications |

## Rule-to-code traceability

| Rule or risk | Primary implementation | Automated evidence |
|---|---|---|
| Permanent direction and quota | migrations `000031..000032`, PendingNakh store | direction/quota race and counter assertions |
| Funding proof and delivery | direct store, M4 receipt fulfillment, migrations `000033..000034` | credit/Stars atomicity, replay, correction and eligibility suites |
| Strict FIFO | settlement handler/store and credit-increase worker | property tests, duplicate-worker integration and M5 load artifact |
| Maintenance clocks | maintenance handler/store and scheduler | reminder/expiry concurrency and boundary tests |
| Receiver terminal action | delivered store and shared Match lifecycle transaction | reject/accept/replay races and exact participant cardinality |
| Reconciliation | bounded phased reconciliation store and scheduler | durable resume/cursor, append-only identity-safe drift evidence |
| Operational visibility | finite M5 metrics, aggregate sampler, Terraform alarms | metric-label tests, sampler integration and Terraform validation |
| Query scalability | 12-query production plan gate and migrations `000037..000039` | 5,000 pending plus 5,000 delivered rows, required indexes and 1.5-second budgets |
| Migration/recovery safety | forward-only migrations `000031..000039` and verification SQL | empty/upgrade/replay CI, container migration artifact and restore smoke |

## Default-branch automated gate

The immutable staging candidate must pass:

1. frozen install, formatting, lint, type checks, all unit tests, and production builds;
2. migration bootstrap/verification/replay and every PostgreSQL/Redis integration/race suite;
3. M1/M3 load smokes, M3/M4/M5 production query plans, and the M5 FIFO concurrency load smoke;
4. dependency audit, Terraform validation, non-root service images, and backup/restore smoke;
5. retention of `m5-query-plans-<sha>` and `m5-load-smoke-<sha>` from that exact release.

Record the immutable commit, successful CI URL, artifact names, release/image IDs, UTC timestamp, and
named backend, operations, security, and product reviewers. Do not record prohibited user, message,
Profile, financial, provider, credential, or internal identifier data.

## Open release blockers

- provision the isolated staging services and separate Telegram test bot/Stars flow;
- inject database, Redis, bot, webhook, action/evidence keys and telemetry credentials by reference;
- verify all M5 dashboard panels and alarms with the operations subscription;
- attach the exact-release M5 plan/load artifacts and approve measured capacity budgets;
- run real callback replay/conflict, worker termination, provider timeout, correction, FIFO,
  scheduler restart, database failover, rollback, and privacy drills;
- complete [`m5-staging-acceptance.md`](../../deploy/runbooks/m5-staging-acceptance.md) and obtain all
  required sign-offs.

Until these blockers close, M5 is **code complete / staging blocked**, not production-ready, and both
live Nakh creation paths must remain disabled.
