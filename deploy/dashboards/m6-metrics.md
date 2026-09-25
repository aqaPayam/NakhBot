# M6 Chat and Notification Dashboard Contract

Build this dashboard before enabling M6 in staging. Variables are limited to environment, release,
service, and the finite registries exported by `@nakh/observability`. Message or snapshot content,
locale, Profile data, Telegram/user/entity identifiers, provider responses, tokens, URLs, cursors,
and raw error codes are forbidden in labels, annotations, links, alerts, and exported evidence.

## Chat and authorization panels

- Chart `nakh.m6.chat.send.count` and `nakh.m6.chat.send.duration` by `kind` and `outcome`.
- Chart `nakh.m6.chat.authorization_denials` by the finite `denial` registry. Investigate a rate
  change without adding actor, session, message, locale, or free-text dimensions.
- Chart `nakh.m6.unmatch.count` by `outcome`; compare completed and replayed outcomes with denied and
  failed commands after each release.

## Delivery panels

- Chart `nakh.m6.delivery.count` and `nakh.m6.delivery.duration` by `outcome` and `retry_class`.
- Show the unlabelled retry, terminal-failure, ambiguous, lease-loss, and polling-failure counters
  beside due-delivery count and oldest age.
- Show expired provider-call lease count and oldest age separately. An expired lease after
  `call_started` is uncertain delivery evidence, not permission to resend.

## Retention and integrity panels

- Chart cleanup batches/duration by `outcome`, with aggregate examined, deleted, snapshot, and
  unlabelled failure counters.
- Show cleanup backlog sessions, excess-message count, and oldest age. The user projection remains
  capped at 50 while cleanup catches up.
- Show pending snapshot count and oldest age. Snapshot backlog must return to zero before a cleanup
  or release is accepted.
- Chart reconciliation batches/duration by `phase` and `outcome`, aggregate scanned/anomaly counts,
  and the unlabelled reconciliation-failure counter.
- Show current and 24-hour maximum participant mismatch, sequence/read-cursor anomaly, and delivery
  integrity anomaly values. Any nonzero integrity value blocks release.
- Show `nakh.m6.operational_health.failures` as an unlabelled counter.

## Alert contract

Terraform creates the staging alarms in `deploy/terraform/staging/operations.tf`. Page immediately
for ambiguous delivery, expired provider-call lease, integrity drift, snapshot age, cleanup failure,
reconciliation failure, or health-measurement failure. Page when due-delivery or cleanup age reaches
five minutes. Investigate due count above 100, ten retries in five minutes, or repeated lease loss
before increasing traffic.

Do not clear an alarm by editing chat, Match, Notification, Delivery, snapshot, reconciliation, or
outbox rows. Preserve durable evidence, stop the narrowest producer when required, and use the M6
runbook and normal fenced/idempotent recovery paths. Release annotations contain only immutable
commit/image IDs and UTC times.
