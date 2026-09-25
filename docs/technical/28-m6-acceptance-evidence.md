# M6 Acceptance Evidence and Traceability

Status: provider-neutral implementation is present through checkpoint 8 (chat, Unmatch, notification
delivery, retention, reconciliation, production plans/load, metrics, alarms, and operations). Real
Telegram staging evidence remains a release blocker. Green CI is necessary but is not provider or
staging evidence.

## Acceptance ledger

| Evidence ID | Automated status | Reproducible evidence | Remaining staging evidence |
|---|---|---|---|
| `ACC-031/M6-UNMATCH` | complete | concurrent/replayed Unmatch transaction closes Match, pair, Chat and Likes once; exact 24-hour report boundary | repeat both-participant race through signed test-bot actions |
| `ACC-032/M6-UNLOCK` | complete | M4 concurrent Match unlock charges/grants once; M6 open/send authorization is participant-scoped and warning-gated | complete one real test Stars unlock and observe both participants |
| `ACC-033/M6-UNLOCK-LIFECYCLE` | complete | fake-time/domain and PostgreSQL authorization tests prove no time expiry and immediate closure/revocation denial | exercise closure and correction using the staging release |
| `ACC-034/M6-LOCKED-CONTENT` | complete | domain/application/adapter tests reject locked free text, emoji and unsupported update kinds before persistence/notification | send every Telegram update kind through the test bot |
| `ACC-035/M6-RETENTION` | complete | concurrent sequence allocation, newest-50 read ceiling, snapshot-before-delete integration race, and retained 200-message load artifact | repeat send/snapshot/cleanup with scheduler and worker termination |
| `ACC-038/M6-NOTIFICATION` | complete | mute/preference history assertions plus fenced claim, success, retry, terminal and ambiguous delivery tests | run real Telegram mute, 429, blocked-user, timeout and ambiguous-result drills |

## Rule-to-code traceability

| Rule or risk | Primary implementation | Automated evidence |
|---|---|---|
| Typed immutable messages and sequence | migrations `000040`, chat store and domain policies | predefined/text replay, concurrent allocation, payload/sequence guards |
| Unlock and warning capability | open-chat/chat-state handlers and PostgreSQL store | participant warning monotonicity and Match/unlock lifecycle matrix |
| Permanent Unmatch | migration `000041`, Unmatch handler/store | pair-lock races, closure cardinality and exact report deadline |
| Fenced provider delivery | migration `000042`, worker processor and Telegram sender | lease/fence, 429, terminal, retry exhaustion and ambiguous-call suites |
| Newest-50 retention and snapshots | migration `000043`, retention handler/store | concurrent send/capture/cleanup and immutable snapshot replay |
| Localization | migration `000044` and M6 catalog | complete key parity, prompt ownership and safe rendering tests |
| Reconciliation | migration `000045`, bounded phased store and scheduler | durable resume/cursor and identity-safe anomaly evidence |
| Operational visibility | finite M6 metrics, aggregate health sampler and Terraform alarms | metric registry tests, health integration and Terraform validation |
| Query/load scalability | M6 plan gate and concurrent-message load smoke | production-shaped indexed plans plus 200 send/replay cardinality artifact |
| Migration/recovery safety | forward-only migrations `000040..000045` and verification SQL | empty/upgrade/replay CI, container artifact and backup/restore smoke |

## Default-branch automated gate

The immutable staging candidate must pass:

1. frozen install, formatting, lint, type checks, all unit tests, and production builds;
2. migration bootstrap/verification/replay and every PostgreSQL/Redis integration/race suite;
3. M1/M3 load smokes, M3/M4/M5/M6 production query plans, and M5/M6 concurrency load smokes;
4. dependency audit, Terraform validation, non-root service images, and backup/restore smoke;
5. retention of `m6-query-plans-<sha>` and `m6-load-smoke-<sha>` from that exact release.

Record only the immutable commit, successful CI URL, artifact names/digests, release/image IDs, UTC
timestamp, aggregate measurements, and named backend, operations, security, and product reviewers.

## Open release blockers

- provision isolated staging services and a separate Telegram test bot/Stars flow;
- inject database, Redis, bot, webhook, action/evidence keys, and telemetry credentials by reference;
- verify every M6 dashboard panel and Terraform alarm reaches the operations subscription;
- attach exact-release M6 plan/load artifacts and approve measured latency/capacity budgets;
- run real relay, mute, 429, blocked-user, timeout, ambiguous-result, retry, worker-crash, scheduler
  restart, snapshot/cleanup, database-failover, rollback, and privacy drills;
- complete [`m6-staging-acceptance.md`](../../deploy/runbooks/m6-staging-acceptance.md) with backend,
  operations, product, and security sign-off.

Until these blockers close, M6 is **code complete / staging blocked**, not production-ready, and
Telegram chat relay/normal delivery must remain disabled for real users.
