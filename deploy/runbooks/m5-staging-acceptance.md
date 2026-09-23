# M5 Nakh Lifecycle Staging Runbook

Use this runbook only after the exact candidate commit is green on the default branch and separate
staging PostgreSQL/Redis, Telegram test bot and Stars flow, secret store, and observability stack
exist. It does not authorize infrastructure purchase, production traffic, real-user testing, or
production charging.

## 1. Evidence header

Record the immutable commit and CI run, release/image IDs, UTC start/end, operator, backend,
operations, product and security reviewers, rollback release, M5 query-plan artifact, and M5 load
artifact. Never record Nakh/Profile text, Telegram/user IDs, internal entity IDs, balances, invoice
payloads, charge IDs, callback bodies, secrets, signed URLs, or raw provider errors.

## 2. Hard preconditions

Stop unless all are true:

- migrations `000031` through `000039`, verification, replay, restore smoke, all M5 integration
  suites, the 12-query production plan gate, and FIFO load gate passed for the exact release;
- M4 receipt, fulfillment, correction, refund, ledger, notification, and reconciliation gates are
  green and use the same immutable release;
- staging uses a separate bot, database, keys, webhook secret, telemetry scope, and synthetic users;
- direct-credit and Stars Nakh creation can be disabled independently while callbacks,
  fulfillment, settlement, expiry, and reconciliation continue;
- all alarms in the M5 dashboard contract exist, export current data, link here, and reach the
  operations channel;
- rollback can stop new Nakh creation without reversing schema, deleting flow/history/payment
  evidence, truncating queues, reopening terminal state, or changing balances.

## 3. Safe activation order

1. Deploy schema and compatible services with both Nakh creation paths disabled. Keep receipt,
   fulfillment, settlement, maintenance, and reconciliation consumers running.
2. Confirm zero quota drift, funding mismatch, paid-undelivered backlog, callback conflict, and
   unexplained reconciliation anomaly. Exercise one test alarm and acknowledge its recovery.
3. Enable direct-credit Nakh for one allow-listed synthetic sender/receiver pair. Verify one spend,
   one delivery/history fact, one receiver notification, and no PendingNakh.
4. Enable Stars pending creation for one allow-listed synthetic sender. Confirm the receiver sees no
   pending fact and the sender sees explicit auto-settlement consent and the 14-day deadline.
5. Complete one real test Stars payment; terminate the worker before and after durable boundaries;
   replay callbacks; verify exactly one delivered Nakh/notification and no duplicate correction.
6. Add credits to a sender with several pending items. Verify invalid oldest items close and
   processing continues, while an eligible unaffordable oldest item stops without skipping.
7. Expand only after backlog age returns to zero, reconciliation completes cleanly, and every alarm
   remains healthy.

## 4. Required observations

Record pass/fail, UTC time, a safe aggregate metric/audit reference, and reviewer initials for:

- `ACC-021`: 20 concurrent same-direction starts converge to one permanent flow;
- `ACC-022`: four existing pending items admit one fifth and deny every sixth;
- `ACC-023`: pending text, state and notifications never reach the receiver;
- `ACC-024`: randomized FIFO settlement closes invalid rows, spends oldest-first and never skips an
  eligible unaffordable row under replay/concurrency;
- `ACC-025`: 100 duplicate real test callbacks and worker termination create one delivery and one
  receiver notification;
- `ACC-026`: visibility-off permits delayed delivery while restricted, banned, deleted, invalid,
  matched, unmatched and blocked states deny without spending;
- `ACC-027`: fund/edit/cancel races produce one paid delivery or one chosen interaction conversion
  and the correct quota;
- `ACC-028`: rejection persists `rejected`, renders “Closed,” and cannot race into acceptance;
- `ACC-029`: six 48-hour reminders and independent pending/delivered 14-day clocks hold at boundary
  times and after scheduler restart;
- `ACC-030`: 20 accept/reject/replay workers produce at most one Nakh-origin Match and Chat with
  exactly two participants;
- every dashboard panel has data with only finite labels, and every M5 alarm reaches operations.

## 5. Load, fault and privacy gate

Run the documented launch and 2× profiles using only synthetic staging accounts. Archive aggregate
rates, durations, saturation, backlog recovery, alert transitions, query plans, load evidence, and
release IDs. Inject duplicate events, callback conflicts, worker termination, Redis interruption,
database failover, stale leases, scheduler restart, provider timeout, insufficient credits, and
target restriction after capture. There must be zero duplicate spend/delivery/notification,
out-of-order settlement, quota drift, receiver pending disclosure, or funding mismatch.

Inspect exported logs, traces, metrics, alarms, artifacts, and tickets for prohibited identity,
message, Profile, financial, provider, secret, token, URL, and cursor values. Any leak is a release
blocker even if functional tests pass.

## 6. Incident actions and rollback

- For paid-undelivered growth, disable new Stars invoices first; preserve callbacks and run fenced
  fulfillment/correction. Never refund or redeliver from timeout text alone.
- For settlement backlog, stop new Nakh creation if age grows, keep the credit-increase consumer
  active, inspect finite stop reasons, and scale workers only after PostgreSQL lock/pool health is
  understood.
- For quota/funding drift, stop affected creation/delivery paths, preserve the reconciliation run
  and anomaly facts, quarantine contradictory financial evidence, and repair only through reviewed
  idempotent commands.
- For reminder/expiry failure, keep receiver actions safe, restore scheduler leadership, then run
  bounded catch-up batches; do not change deadlines or reminder counts manually.

Roll back only to a schema-compatible immutable image. Never reverse an applied migration, remove a
NakhFlow, edit ledger/payment/history/anomaly rows, decrement counters manually, reopen terminal
Nakh state, or discard queue/inbox/outbox evidence.

## 7. Acceptance

M5 may be accepted only when every observation passes, both retained CI artifacts match the exact
release, reconciliation and alerts are clean, Critical/High defects are zero, and backend,
operations, product, and security reviewers sign the evidence ledger. Until then M5 remains **code
complete / staging blocked**, never live.
