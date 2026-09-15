# M2 Staging Acceptance Runbook

Use this runbook only after the M2 candidate commit is green on the default branch and the private
media infrastructure exists. This is an evidence procedure, not permission to create cloud resources
or enable media in production.

## 1. Evidence header

Record the immutable commit, CI run URL, staging release ID, UTC start/end times, operator, backend
reviewer, security reviewer, R2 bucket/account identifier, CDN hostname, and rollback release. Never
record secret values, object keys, Telegram file IDs, hashes, signed URLs, or image contents.

## 2. Hard preconditions

Stop before enabling any media flag unless all answers are yes:

- the bucket is staging-only, private, non-listable by clients, and has no public development URL;
- ingestion credentials can access only required quarantine/validated/variant operations;
- cleanup credentials can list, head, and delete only ordinary media prefixes and cannot access
  report-evidence objects;
- the CDN/Worker authenticates the audience, verifies purpose-bound short-lived tokens, and reads R2
  privately;
- current signing/encryption keys and bounded previous verification/decryption keys are injected by
  named secret references;
- ClamAV is healthy on a private worker-only path with a current signature set;
- migrations `000010` through `000015` and their verification scripts passed against staging;
- rollback keeps the applied schema forward-compatible and can disable all media flags independently.

## 3. Safe activation order

1. Keep gateway ingestion, cache purge, cleanup, and orphan reconciliation disabled.
2. Start one media worker with provider credentials and ClamAV; verify readiness without accepting an
   upload.
3. Enable ingestion for the worker, then for one gateway replica. Send only synthetic staging photos.
4. Confirm queue age, validation terminal state, object verification, and bounded metrics before
   widening gateway/worker replicas.
5. Enable private CDN delivery and cache purge only after token/audience negative tests pass.
6. Enable cleanup for one worker and verify one controlled deletion.
7. Enable one orphan-reconciliation scheduler only after the 24-hour grace and reference checks are
   confirmed. Never shorten the grace period during acceptance.

At any uncertain provider response, disable only the affected feature flag, preserve PostgreSQL
intent/tombstones/leases, and retry through the normal worker. Do not repair business tables manually.

## 4. Required observations

For every item record pass/fail, UTC time, safe metric or audit reference, and reviewer initials:

- a registered Telegram user uploads valid JPEG, PNG, and WebP; each becomes visible only after a
  verified thumbnail exists;
- a replayed Telegram update returns the same asset and creates no second attempt or object set;
- oversized, corrupt, animated, spoofed, too-small, and excessive-pixel inputs reach safe terminal
  rejection without becoming deliverable;
- seven accepted assets racing for the final slots leave at most six saved photos;
- injected thumbnail failure creates no visible photo; injected blur failure leaves Profile validity
  unchanged;
- hiding the primary promotes the lowest-order visible replacement and invalidates a one-visible-photo
  Profile synchronously;
- owner deletion denies a new grant immediately, purges CDN paths, deletes only the trusted ordinary
  object plan, verifies absence, and records completion once under replay;
- an old unreferenced synthetic object is removed while a recent or referenced object is retained;
- a cross-user, expired, tampered, wrong-purpose, wrong-path, and unauthenticated delivery request all
  receive indistinguishable private denials;
- logs and exported metrics contain no file ID, object key, hash, filename, signed URL/token, user ID,
  or continuation cursor.

## 5. Load and failure gate

Run the documented launch and 2× media profile with bounded synthetic fixtures. Archive configuration,
duration, rates, queue-age recovery, CPU/memory, database/Redis saturation, R2/provider errors, and SLO
results. Terminate workers before and after each external-write/database-commit boundary and verify
replay convergence. There must be zero correctness, authorization, or privacy failures.

## 6. Acceptance and rollback

M2 may be accepted only when every observation passes, Critical/High defects are zero, every Medium
has an owner and release decision, and both backend and security reviewers sign the evidence record.

On failure, disable the narrowest affected media flag, keep logical delivery denial and tombstones in
force, return to the last immutable compatible image if safe, and follow the M2 media incident section
of [`foundation.md`](foundation.md). Database migrations are never rolled back or edited.
