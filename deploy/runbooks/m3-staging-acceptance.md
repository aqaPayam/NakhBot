# M3 Staging Acceptance Runbook

Use this runbook only after the candidate commit is green on the default branch and the private R2,
private-media edge, Telegram test bot, and staging observability stack exist. This procedure does not
authorize infrastructure purchase, production traffic, or public bucket access.

## 1. Evidence header

Record the immutable commit, CI run, release/image IDs, UTC start/end times, operator, backend,
operations and security reviewers, private-edge hostname, and rollback release. Never record secret
values, Telegram IDs, user/Profile content, internal user IDs, object keys, signed URLs, audience
credentials, callback payloads, or raw provider responses.

## 2. Hard preconditions

Stop before activation unless all answers are yes:

- migrations `000017` through `000024` and verification/replay passed against staging;
- the bucket is private and the edge maps only independently verified audience plus media claims;
- media-signing and audience-credential keys are distinct, injected by reference, and have a bounded
  reviewed rotation ring;
- gateway and worker use the same immutable release and numeric test-bot identity;
- the feature remains false on every replica except the explicitly selected canary;
- telemetry exports to `Nakh/Platform`, all M3 alarms exist, and the operations subscription works;
- the production-volume query-plan gate is attached to the candidate and within its reviewed budget;
- rollback can disable the gateway, worker poller, and private edge independently without reversing
  schema or deleting durable requests/receipts.

## 3. Safe activation order

1. Keep `NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED=false` everywhere and deploy the compatible schema.
2. Deploy the private edge disabled; prove that it reads no keys and returns a private denial.
3. Enable the edge with the staging-only key ring and private bucket binding. Run negative token,
   audience, path, purpose, expiry, and cross-viewer checks before any Telegram delivery.
4. Start one worker canary with delivery enabled. Keep gateway ingress disabled; confirm zero backlog
   and healthy polling without provider traffic.
5. Enable one gateway canary for allow-listed synthetic staging users. Send one `/liked_by` request.
6. Verify durable enqueue precedes acknowledgement, one worker lease owns delivery, receipts are
   opaque, the edge returns only the blurred rendition, and Telegram receives bytes rather than URLs.
7. Expand gateway and worker replicas only after backlog age returns to zero and no denial, retry,
   lease-loss, privacy, or invariant alarm fires.

## 4. Required observations

For each item record pass/fail, UTC time, safe aggregate metric/audit reference, and reviewer initials:

- saved Explore filters do not change Profile preference and reciprocal selection rejects either-sided
  incompatibility;
- concurrent candidate requests expose one reservation, delivery replay creates one consumption, and
  the next request never returns the consumed candidate;
- opposite simultaneous Likes create exactly one Match, one Chat, and two participants in each;
- Not Interested produces no recipient notification and cannot be undone or replayed into a Like;
- the Liked By count and keyset page exclude restricted/banned/deleted/incomplete/invisible users,
  missing/invalid/deleted primary media, existing pair states, rejection, and non-active Likes;
- duplicate Telegram updates create one durable request; a changed duplicate is rejected;
- provider success followed by worker termination resumes from recorded message receipts without
  re-sending known-success messages; uncertain unrecorded success remains documented at-least-once;
- expired leases reject former owners and retry/exhaustion transitions emit only bounded reason codes;
- signed media paths and audience credentials never appear in Telegram payloads, logs, metrics,
  receipts, tickets, or acceptance attachments;
- ingress/delivery latency, retries, failures, lease loss, pending count, and oldest backlog age are
  visible without identity dimensions and alarms reach the operations channel.

## 5. Load, fault, and recovery gate

Run the documented launch and 2× profiles using synthetic staging accounts. Archive only aggregate
rates, durations, query-plan artifacts, saturation, backlog recovery, alarm transitions, and release
IDs. Inject provider throttling, timeout, terminal recipient denial, worker termination before/after
receipt recording, expired lease ownership, Redis interruption, and private-edge key rotation. There
must be zero authorization, privacy, Match/Chat cardinality, consumption, or permanent-loss defects.

## 6. Acceptance and rollback

M3 may be accepted only when every required observation passes, Critical/High defects are zero, each
Medium has an owner and release decision, both query plans remain within budget, and backend,
operations, and security reviewers sign the evidence record.

On failure, disable the narrowest affected canary flag, preserve durable PostgreSQL requests,
receipts, consumptions, pair states, audit and outbox evidence, and return to the last immutable
schema-compatible image when safe. Do not delete queue rows, reopen Likes, remove consumptions, edit
applied migrations, expose R2, or repair Match/Chat rows manually. Follow the M3 incident section in
[`foundation.md`](foundation.md).
