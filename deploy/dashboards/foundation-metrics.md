# M0 dashboard contract

The telemetry backend must chart these low-cardinality signals before M1:

- request count, status class, p50/p95/p99 latency by service and operation;
- process CPU/memory/event-loop lag and restart count;
- PostgreSQL pool wait, query duration, lock/deadlock, connection and migration status;
- Redis connectivity, memory/eviction, BullMQ queue depth, oldest age, retry and failure count;
- outbox unpublished count/oldest age and inbox duplicate count;
- application error code and release comparison.

No User, Telegram, provider charge, object key, or message/profile text is a metric label.

## M1 identity and Profile dashboard

Chart these bounded M1 instruments by release and environment:

- `nakh.m1.handler.count` and `nakh.m1.handler.duration` by the registered `operation`, `outcome`, and `reason_code` values;
- `nakh.m1.signup.count` by `stage` and stable `reason_code`;
- `nakh.m1.profile.completion_transition.count` by `invalidated|restored`;
- `nakh.m1.guest_preview.count` by `consumed|denied`;
- `nakh.m1.protected_change.count` by `requested|approved|rejected|conflict`;
- `nakh.m1.outbox.unpublished_age` without per-User dimensions.

Alert on a sustained first-start failure ratio, signup-confirmation failure spike, any material rise in reviewer authorization denial, Guest Preview denial inconsistent with consumption volume, or unpublished outbox age above the operational SLO. Dashboard variables are limited to service, release, environment, and the finite registries exported by `@nakh/observability`.
