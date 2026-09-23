# M5 Nakh lifecycle dashboard contract

Build this dashboard before enabling M5 in staging. Its variables are limited to environment,
release, service, and the finite registries exported by `@nakh/observability`. Never add Nakh text,
Profile data, locale, balance, user/entity/payment/provider identifiers, callback content, or raw
errors as metric dimensions, annotations, dashboard links, or alert text.

## Lifecycle panels

- Chart `nakh.m5.creation.count` and `nakh.m5.creation.duration` by `outcome` and `funding_type`.
- Chart `nakh.m5.delivery.count` and `nakh.m5.delivery.duration` by `outcome` and `funding_type`.
- Chart `nakh.m5.receiver_actions.count` and `nakh.m5.receiver_actions.duration` by `action` and
  `outcome`; rejection remains a rejection internally even though the product renders “Closed.”
- Chart `nakh.m5.settlement.passes` and `nakh.m5.settlement.duration` by `stop_reason`, with
  `nakh.m5.settlement.delivered` and `nakh.m5.settlement.closed` as aggregate rates.

## Scheduler and integrity panels

- Chart `nakh.m5.maintenance.batches`, duration, examined, and changed by the bounded operation and
  outcome. Put `nakh.m5.maintenance.failures` beside the reminder and both expiry panels.
- Chart `nakh.m5.reconciliation.batches`, duration, scanned, and anomalies by bounded phase/outcome.
  Put `nakh.m5.reconciliation.failures` beside the current run.
- Show current and 24-hour maximum values for settlement backlog count/oldest age,
  paid-undelivered count/oldest age, quota drift, and delivered-funding mismatch.
- Show `nakh.m5.operational_health.failures` and `nakh.m5.callback_conflicts` as unlabelled counters.

## Alert contract

Terraform creates the staging alarms in `deploy/terraform/staging/operations.tf`. Page immediately
for quota drift, funding-proof mismatch, callback conflict, paid-undelivered age of two minutes,
maintenance failure, reconciliation failure, or health-measurement failure. Page when the oldest
settlement item reaches five minutes; investigate count above 100 before expanding traffic.

An alert is not cleared by editing product, billing, notification, reconciliation, or Match rows.
Use the M5 runbook, preserve durable evidence, stop the narrowest producer when necessary, and let
the normal idempotent worker/repair path recover. Release annotations must use immutable commit/image
IDs and must not include user or provider facts.
