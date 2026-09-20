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

## M1 Guest Preview counter anomaly

1. Stop Guest Preview delivery if any counter exceeds its immutable snapshot or successful deliveries outnumber committed counter events.
2. Compare `identity.guest_preview_counters`, `identity.guest-preview-consumed.v1` audit rows, and unpublished outbox events using only internal IDs in protected tooling.
3. Do not decrement, reset, or recreate a counter. Repair through a reviewed forward operation that preserves the permanent anti-reset rule.
4. Re-run `ACC-002/M1-COUNTER` and the concurrency load smoke before restoring delivery. Candidate delivery remains disabled until M3 provides the same-transaction `ExploreConsumption` proof.

## M1 signup or Profile incident

1. Disable the affected write route while preserving signup drafts, idempotency records, audit rows, and outbox evidence.
2. Classify the failure by stable error code; never copy names, birth years, Profile text, photos, draft bodies, or protected requested values into logs or tickets.
3. Verify Account, signup progress/draft, Profile version/completion, audit, and outbox state as one transaction boundary.
4. Roll back application code only when the schema remains backward compatible. Fix applied migrations with a new forward migration.

## M1 protected-change review anomaly

1. Keep the production review transport disabled and revoke the affected AdminUser binding if authorization is uncertain.
2. Verify the single immutable review, request closure, Profile version, audit record, and outbox event.
3. Never update or delete a review row. Correct an erroneous approved Profile value through a new reviewed request.
4. Escalate any authorization bypass as a security incident; M7 owns RBAC, operator provisioning, and the production administration route.

## M2 media deletion or orphan-cleanup incident

1. Keep database tombstones and delivery denial active. Disable `NAKH_MEDIA_CLEANUP_ENABLED` and
   `NAKH_MEDIA_ORPHAN_RECONCILIATION_ENABLED` if provider identity, bucket scope, or deletion results
   are uncertain; do not restore deleted photos or edit cleanup timestamps.
2. Check only bounded counts, lease age, queue age, and stable error class. Never place object keys,
   hashes, delivery tokens, image content, or continuation cursors in logs or incident tickets.
3. Verify the configured account is restricted to ordinary quarantine, validated, and variant
   prefixes and cannot access moderation evidence. Treat any scope expansion as a security incident.
4. For a provider timeout or unknown delete, preserve the database lease/cursor and retry through the
   normal worker or scheduler. Mark storage deletion complete only after HEAD confirms absence.
5. Re-enable one scheduler replica first, confirm successful scans and cursor progress, then restore
   workers gradually. Persistent old-orphan deletion or cleanup age requires escalation.

## M3 discovery, interaction, or Telegram delivery incident

1. Disable `NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED` on the affected gateway and worker canaries if
   authorization, private-media delivery, provider outcome, receipt state, or Match invariants are
   uncertain. Disable the private edge separately when token verification or bucket scope is suspect.
2. Preserve candidate deliveries, consumptions, Likes, rejections, pair states, Matches, Chats,
   delivery requests/receipts, audits, and outbox facts. Never reopen, delete, or manually rewrite
   these rows; use a reviewed forward repair after the invariant is understood.
3. Diagnose with bounded counts, latency, backlog age, retry/error codes, and protected internal
   queries only. Never place identities, Profile content, cursor/action values, media paths, signed
   URLs, audience credentials, object keys, or raw provider responses in logs or incident tickets.
4. A provider timeout or success without a receipt is an uncertain at-least-once outcome. Let the
   fenced request retry through the resumable sender; do not mark it delivered or fabricate a receipt.
5. Before restoring traffic, run `ACC-016`, `ACC-017`, the full Liked By exclusion matrix, query-plan
   gate, and one canary delivery. Restore one worker, then one gateway, and widen only after backlog
   age returns to zero with no lease-loss, privacy, or invariant alarm.
