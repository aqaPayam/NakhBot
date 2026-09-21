# M4 Acceptance Evidence and Traceability

Status: provider-neutral implementation is present through internal checkpoint 10 (reconciliation,
audited ambiguous-refund resolution, operations, and production-shaped query-plan gates). Real
Telegram Stars staging evidence remains a release blocker. Green CI is necessary but is not provider
or staging evidence.

## Acceptance ledger

| Evidence ID | Automated status | Reproducible evidence | Remaining staging evidence |
|---|---|---|---|
| `ACC-020/M4-LIKED-BY-UNLOCK` | complete | credit/Stars grant races, immutable funding proof, shared actionable-Like predicate, media authorization, closure denial | execute with the separate test bot and private media edge |
| `ACC-032/M4-MATCH-UNLOCK` | complete | concurrent unlock converges to one Match-scoped grant and both participants receive effective access plus notifications | observe both Telegram participants in staging |
| `ACC-033/M4-CHAT-LIFECYCLE` | complete | no clock expiry; Match closure/revocation removes effective access without changing funding facts | close/revoke a staging Match and verify channel behavior |
| `ACC-036/M4-PACKAGE-EXACTLY-ONCE` | complete | receipt replay, lease/fence, ledger uniqueness, and concurrent fulfillment create one purchase and balance increase | terminate the staging worker before/after grant and replay the callback |
| `ACC-037/M4-CORRECTION` | complete | target-close race creates one pending refund; provider-call progress, fenced completion, 20-way finalization, and ambiguous-timeout quarantine prevent blind duplicate refund | execute known-success and ambiguous refund drills against Telegram test payments |
| `ACC-038/M4-NOTIFICATION-POLICY` | complete | preference matrix suppresses mutable delivery while payment/safety categories always create durable delivery | observe muted and critical notices through staging Telegram |

## Rule-to-code traceability

| Rule or risk | Primary implementation | Automated evidence |
|---|---|---|
| Immutable credit ledger | credit ledger domain/store and migrations `000025..000026` | sign/chain/idempotency/property tests, exact-balance races, package fulfillment integration |
| Verified provider receipt | Telegram Stars receipt store and encrypted evidence/payload ports | bot/environment/payer/payload/currency/amount negatives, identifier conflicts, replay races |
| Entitlement authority | paid-action coordinator, target lock, FeatureUnlock and effective-access reads | Like/Match concurrency, current-scope authorization, stale token/media denial |
| Safe correction | refund handler/store and payment/fulfillment lifecycle guards | call-start durability, known-success completion, stale fence, replay, ambiguous outcome quarantine |
| Verified ambiguous outcome | admin-only resolution handler/store and append-only audit | confirmed-not-refunded retry, confirmed-refunded correction, command replay, evidence-digest binding |
| Reconciliation | resumable batch handler/store and scheduler | durable cursor/run facts, append-only anomaly, uncertain-refund and stuck-fulfillment classification |
| Operational visibility | finite M4 metric registry and billing scheduler logs | metric-label unit test, identity-free aggregate outcomes, staging runbook alert requirements |
| Query scalability | M4 exact operational query plan gate | 5,000-row fulfillment, refund, provider dedupe, unlock, notification, and payment-reconciliation plans |
| Migration/recovery safety | migrations `000025..000029` and verification SQL | empty/upgrade/replay CI, integration suites, container migration artifact, restore smoke |

## Default-branch automated gate

The immutable staging candidate must pass:

1. frozen install, formatting, lint, type checks, all unit tests, and production builds;
2. migration bootstrap/verification/replay and every PostgreSQL/Redis integration and race suite;
3. M1/M3 load smokes and both M3 and M4 production-shaped query-plan gates;
4. dependency audit, Terraform validation, non-root container builds, and backup/restore smoke;
5. retention of `m4-query-plans-<sha>` with the exact release evidence.

Record the immutable commit, successful CI URL, release/image IDs, UTC timestamp, and named backend,
operations, security, and product reviewers. Do not record secrets or financial/provider identifiers.

## Open release blockers

- provision the private staging services and separate Telegram test bot/payment flow;
- inject webhook, bot, evidence-encryption, action-token, database, Redis, and telemetry secrets by
  reference and verify rotation/revocation;
- attach the successful M4 query-plan artifact for the exact candidate and approve its budgets;
- run callback replay/conflict, worker termination, provider outage, ambiguous refund, reconciliation,
  mute-policy, rollback, and key-rotation drills;
- execute the admin-only ambiguous-refund command through a protected staging operator harness and
  verify evidence-digest/audit handling; normal workers remain unable to retry blindly;
- complete [`m4-staging-acceptance.md`](../../deploy/runbooks/m4-staging-acceptance.md) and obtain all
  required sign-offs.

Until these blockers close, M4 is **code complete / staging blocked**, not production-ready, and live
invoice creation must remain disabled.
