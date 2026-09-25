# M6 Chat and Notification Delivery Staging Runbook

Use this runbook only after the exact candidate commit is green on the default branch and isolated
staging PostgreSQL/Redis, a separate Telegram test bot, secret store, and observability stack exist.
It does not authorize infrastructure purchase, production traffic, or real-user testing.

## 1. Evidence header

Record the immutable commit and CI run, release/image IDs, UTC start/end, operator, backend,
operations, product and security reviewers, rollback release, M6 query-plan artifact, and M6 load
artifact. Never record message/snapshot/Profile content, Telegram/user/internal identifiers,
provider bodies, tokens, signed actions, secrets, URLs, cursors, or raw errors.

## 2. Hard preconditions

Stop unless all are true:

- migrations `000040` through `000045`, verification, replay, restore smoke, all M6 integration
  suites, the M6 production query-plan gate, and concurrent message load gate passed for the exact
  release;
- M3 Match/Chat and M4 Match-unlock/payment/correction evidence is green for the same release;
- staging uses a separate bot, database, keys, webhook secret, telemetry scope, and synthetic users;
- chat relay and normal notification delivery can be disabled independently while durable history,
  cleanup, reconciliation, and ambiguous-delivery quarantine remain available;
- every panel and alarm in `deploy/dashboards/m6-metrics.md` exports current data, links here, and
  reaches the operations channel;
- rollback uses a schema-compatible immutable image and cannot reverse migrations or discard
  message, Unmatch, Notification, Delivery, snapshot, inbox, outbox, or reconciliation evidence.

## 3. Safe activation order

1. Deploy schema and compatible services with Telegram chat relay disabled. Keep cleanup,
   reconciliation, delivery quarantine, and aggregate health sampling active.
2. Confirm zero integrity anomalies, expired provider-call leases, pending snapshots, due-delivery
   age, and unexplained reconciliation anomalies. Exercise one test alarm and its recovery.
3. Enable one allow-listed synthetic matched pair. Send a predefined question and answer while
   locked; verify stable sequence, durable history, one recipient Notification, and no identity
   exposure.
4. Unlock the Match once through the real test payment path. Confirm both participants receive text
   capability only after each participant's one-time safety warning is rendered.
5. Enable normal Telegram notification delivery. Exercise success, 429, retryable outage, blocked
   recipient, timeout/ambiguous response, stale fence, and worker termination. Never resend an
   ambiguous `call_started` attempt.
6. Exercise mute and global chat preference. Durable Notification history must remain while normal
   Telegram delivery is suppressed; critical payment/safety delivery remains unaffected.
7. Send more than 50 synthetic messages while capturing report context. Confirm normal reads expose
   exactly the newest 50 and the immutable snapshot survives cleanup/replay.
8. Unmatch concurrently from both sides. Confirm one permanent closure, one other-participant
   closure Notification, no NotInterested, and report access before—but not at—the 24-hour boundary.
9. Expand only after backlog ages return to zero, reconciliation is clean, and all alarms recover.

## 4. Required observations

Record pass/fail, UTC time, a privacy-safe aggregate metric/audit reference, and reviewer initials:

- `ACC-031`: concurrent Unmatch/replay converges to one symmetric permanent closure and exact report
  boundary;
- `ACC-032`: concurrent Match unlock charges/grants once and both participants obtain text
  capability only after their own warning;
- `ACC-033`: unlock has no clock expiry, but Match/Chat closure or entitlement revocation denies text
  immediately;
- `ACC-034`: locked text, emoji, photo, forwarded message, voice, video, file, and sticker attempts
  create no message or Notification;
- `ACC-035`: concurrent sends have unique contiguous sequence, normal history remains newest-50, and
  report snapshots survive cleanup and replay;
- `ACC-038`: session mute/global preference suppress normal Telegram delivery but not durable
  history, while critical payment/safety delivery still proceeds;
- every M6 panel contains only finite dimensions, every alarm reaches operations, and every retained
  artifact matches the exact commit.

## 5. Load, fault, privacy, and recovery gate

Run the documented launch and 2× profiles with synthetic accounts. Archive aggregate throughput,
latency, saturation, backlog recovery, alert transitions, query-plan/load artifacts, and immutable
release IDs. Inject duplicate commands/jobs, stale actions/cursors/fences, provider 429/5xx/timeout,
worker termination, Redis interruption, scheduler restart, database failover, snapshot failure, and
concurrent send/cleanup/Unmatch. There must be no duplicate message/Notification/provider settlement,
sequence gap, unsafe resend, identity leak, lost snapshot, or lifecycle drift.

Inspect exported logs, traces, metrics, alarms, artifacts, and tickets for prohibited identity,
message, snapshot, Profile, provider, secret, token, URL, and cursor values. Any leak blocks release.

## 6. Incident actions and rollback

- For due-delivery growth, stop new normal delivery production if age grows, keep durable history and
  quarantine active, inspect finite retry classes, and scale only after database/pool health is known.
- For an expired `call_started` lease or ambiguous result, quarantine and preserve evidence. Never
  infer failure from a timeout and never manually reset it to pending.
- For cleanup or snapshot backlog, keep the read ceiling, pause destructive cleanup if snapshots
  cannot complete, restore scheduler leadership, and replay bounded idempotent batches.
- For participant, sequence, or delivery drift, disable chat mutations/delivery as narrowly as
  possible, preserve the reconciliation run, and repair only through reviewed idempotent commands.

Never reverse an applied migration; edit or delete chat/Unmatch/Notification/Delivery/snapshot/
reconciliation rows; truncate queues; advance read cursors; reopen a closed Match/session; or expose
message content for routine diagnosis.

## 7. Acceptance

M6 may be accepted only when every observation passes, both retained M6 CI artifacts match the exact
release, reconciliation and alarms are clean, Critical/High defects are zero, and backend,
operations, product, and security reviewers sign the evidence ledger. Until then M6 remains **code
complete / staging blocked**, never live.
