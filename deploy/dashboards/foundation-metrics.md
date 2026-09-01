# M0 dashboard contract

The telemetry backend must chart these low-cardinality signals before M1:

- request count, status class, p50/p95/p99 latency by service and operation;
- process CPU/memory/event-loop lag and restart count;
- PostgreSQL pool wait, query duration, lock/deadlock, connection and migration status;
- Redis connectivity, memory/eviction, BullMQ queue depth, oldest age, retry and failure count;
- outbox unpublished count/oldest age and inbox duplicate count;
- application error code and release comparison.

No User, Telegram, provider charge, object key, or message/profile text is a metric label.
