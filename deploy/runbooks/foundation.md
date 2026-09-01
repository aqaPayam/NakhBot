# Foundation incident runbook

## Database unavailable

1. Confirm writer health, connection pool saturation, and recent release/migration.
2. Stop state-changing traffic if durable claims cannot be written.
3. Follow the managed-provider failover procedure; do not redirect writes to an unverified replica.
4. Verify migrations, sample health query, outbox age, and error budget before restoring traffic.

## Redis or queue unavailable

1. Keep PostgreSQL authoritative and allow committed outbox rows to accumulate.
2. Pause workers/scheduler if Redis responses are uncertain.
3. Restore Redis with the no-eviction queue policy, then restart dispatchers gradually.
4. Verify duplicate jobs create one inbox/business effect and watch oldest outbox/job age.

## Outbox backlog

1. Compare unpublished age with Redis/BullMQ/provider health.
2. Inspect safe error fingerprints and lease expiry; never edit payloads directly.
3. Increase the correct worker/dispatcher capacity only after dependency saturation is excluded.
4. Replay through the normal dispatcher and verify inbox deduplication.

## Bad release or migration

1. Stop rollout and preserve diagnostic/audit evidence.
2. Decide application rollback only if schema remains backward-compatible; otherwise use the reviewed forward fix.
3. Never modify an applied migration file.
4. Run migration verification, synthetic command/replay, and restore smoke before resuming rollout.
