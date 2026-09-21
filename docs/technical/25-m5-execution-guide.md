# M5 Execution Guide — Nakh Lifecycle and FIFO Settlement

Status: approved implementation guide for M5. This guide converts the canonical Nakh, pending
payment, credit settlement, receiver action, Match, notification, and acceptance rules into an
ordered backend plan.

## 1. Authority and boundary

1. The domain documents remain authoritative for product behavior.
2. Existing identity, discovery, interaction, billing, notification, security, localization,
   retention, testing, and deployment rules remain mandatory.
3. This guide owns M5 sequencing, lock order, lifecycle persistence, funding coordination, strict
   FIFO settlement, reminders/expiry, receiver actions, and evidence for `ACC-021..030`.
4. M5 reuses M4's credit ledger, provider receipts, fulfillment/refund state machine, scheduler,
   reconciliation, and notification history. It must not create a second wallet/payment model.
5. Provider-neutral code and deterministic fake-provider evidence may complete before infrastructure
   exists. Real Telegram Stars and Telegram delivery remain staging gates, not reasons to weaken the
   design.

M5 delivers the permanent directional NakhFlow, sender-only unpaid PendingNakh, paid/delivered Nakh,
five-item quota, edit/cancel, direct credit and Stars funding, strict FIFO auto-settlement after every
balance increase, reminders, separate pending/delivered expiry clocks, receiver view/accept/reject,
and Nakh-origin Match/Chat creation.

## 2. Non-goals

Do not add free Nakh, variable prices, partial funding, multiple Nakh flows in one direction,
withdrawal, user-requested refund, visibility-based delayed-delivery denial, receiver visibility of
PendingNakh, Nakh in Liked By, free-text chat, unmatch/report implementation, moderation decisions,
or production charging. M6 owns chat messages and complete notification delivery behavior; M7 owns
reports/moderation; M8 owns deletion hardening; M9 owns production activation.

## 3. Required ownership

```text
packages/domain/src/nakh/                # pure states, text/time/quota/FIFO policies
packages/contracts/src/m5.ts             # strict channel-neutral commands, queries, events
packages/application/src/nakh/            # coordinators, settlement, reminder/expiry ports
packages/persistence-postgres/src/        # Nakh repositories and cross-module transactions
packages/telegram/src/                    # presentation/callback translation only
apps/worker/src/                          # payment fulfillment and FIFO settlement consumers
apps/scheduler/src/                       # bounded reminder/expiry scans
migrations/000031..                       # forward-only M5 schema and localization
```

Nakh owns flow and lifecycle state. Billing owns funding evidence and balance changes. Interaction
owns Like/NotInterested and pair eligibility. Matching owns Match/Chat creation. Cross-module
coordinators may transact through one PostgreSQL unit of work, but no module may infer another
module's result from Telegram messages, outbox payloads, or cached buttons.

## 4. Locked decisions and constants

- A Nakh costs exactly 2 credits or 2 Telegram Stars under MVP configuration. The authoritative
  value is loaded and snapshotted; client/button values are never trusted.
- Nakh starts only from a currently authorized Explore candidate. It ensures the existing unique
  ExploreConsumption rather than creating a second consumption fact.
- `(sender_user_id, receiver_user_id)` identifies one NakhFlow for the account lifetime. Terminal
  pending/delivered state never releases that direction. The reverse direction is separate unless
  pair state blocks it.
- Text is required and contains at most 240 Unicode scalar values. Validate safe storage/Telegram
  rendering without translating, templating, or silently replacing user prose. The delivered Nakh
  copies the final pending text immutably.
- Direct credit funding creates NakhFlow and delivered Nakh atomically; it never creates a transient
  PendingNakh.
- The Stars path creates NakhFlow, PendingNakh, and PendingPayment before invoice creation. Failed or
  abandoned invoice attempts do not terminate the pending item.
- Only `pending_payment` counts toward the sender quota of five. A transactionally locked counter is
  the admission authority; source-row reconciliation detects drift.
- Pending expiry is exactly 14 days from PendingNakh creation. Delivered expiry is exactly 14 days
  from `sent_at`. These clocks never reuse one another.
- Reminders become eligible at day 2, 4, 6, 8, 10, and 12: at least 48 hours after creation or the
  previous reminder, at most six, sender only, and never after terminal state.
- Delayed delivery rechecks active/complete Profile and safe pair state but intentionally ignores
  current visibility. Restricted, banned, deleted, invalid, matched, unmatched, or blocked prevents
  delivery.
- Receiver rejection is persisted as `rejected` but rendered as “Closed.” Generic system/admin
  closure uses `closed`; these meanings must not be merged.

## 5. Forward-only migration sequence

1. `000031_m5_nakh_flows.sql` — schema, NakhFlow, permanent directional uniqueness, user quota
   counter, and retention comments.
2. `000032_m5_pending_nakhes.sql` — PendingNakh lifecycle, text/payment/authorization snapshots,
   quota/reminder/expiry indexes, guards, and M4 PendingPayment foreign key.
3. `000033_m5_delivered_nakhes.sql` — immutable delivered Nakh, history, receiver actions, lifecycle
   guards, inbox/status/expiry indexes, and deferred funding references.
4. `000034_m5_billing_matching.sql` — M4 funding/fulfillment references, Nakh-origin Match source
   constraints, settlement/reconciliation indexes, and required outbox facts.
5. `000035_m5_localization.sql` — pending consent/edit/cancel/reminder/expiry, sent/seen/accepted/
   closed UI, receiver notifications, safe errors, and Telegram presentation keys.

Every migration must bootstrap from empty, upgrade from `000030`, replay unchanged, and have matching
verification SQL. Applied migrations are immutable. Database roles keep Nakh text out of billing,
reconciliation, metric, and generic notification-worker reads except through the narrow delivery
projection that needs it.

## 6. Persistence invariants

### 6.1 Flow and sender counter

`nakh.nakh_flows` stores ID, sender, receiver, and database creation time; rejects self-direction and
uniquely indexes the directional pair. It is stable and never changes direction.

`platform.user_counters` adds one row per user with `pending_nakh_count`, version, and update time.
Only Nakh transaction services modify it. The value must equal the number of the sender's
`pending_payment` rows; reconciliation records drift and uses an audited idempotent repair command.
Admission locks the counter before checking five, so 20 concurrent attempts cannot create a sixth.

### 6.2 Pending Nakh

`nakh.pending_nakhes` stores one row per flow with text, lifecycle/version, optional unique
PendingPayment, auto-settle consent time, creation/expiry, paid/cancelled/expired/closed times,
cancellation resolution, reminder count/last time, and deterministic idempotency facts.

Checks enforce:

- `expires_at = created_at + configured 14-day snapshot` at application creation and greater than
  creation at the database boundary;
- only `pending_payment` has no terminal timestamp/resolution and counts toward quota;
- `paid_and_sent` has `paid_at`; `cancelled` has time and exactly one conversion resolution;
- `expired` and `closed_by_system` have their matching terminal time only;
- reminder count is `0..6`; reminder time is null iff no reminder has been committed;
- text/payment/flow identity is immutable except text while still `pending_payment`.

Partial indexes cover sender FIFO `(sender, created_at, id)` through the flow join/projection, due
expiry, and due reminder. No receiver query may join pending rows.

### 6.3 Delivered Nakh and actions

`nakh.nakhes` stores one row per flow, immutable delivered text, exactly one funding proof, status,
sent time, independent expiry, lifecycle timestamps, and version. Funding is one negative
`spend_nakh` CreditTransaction or one verified Stars PaymentRecord, never both.

`nakh.nakh_status_history` is append-only and records every transition with safe reason/database
time. `nakh.nakh_receiver_actions` is append-only and idempotent by caller action key. A partial
unique terminal action permits only one of accept/reject to win; view-profile/report do not consume
that terminal slot.

Lifecycle checks permit `sent -> seen|accepted|rejected|expired|closed` and
`seen -> accepted|rejected|expired|closed`; terminal states cannot reopen. First view records `seen`
once. Receiver inbox uses keyset order by `sent_at DESC, id DESC`. Expiry scans only sent/seen rows.

## 7. Lock order and transaction boundaries

Use database time and never reverse this order inside an M5 transaction:

1. sender `platform.user_counters` row when pending quota may change;
2. normalized pair advisory lock and current pair/account/Profile eligibility rows;
3. NakhFlow, then PendingNakh or delivered Nakh;
4. funding source: CreditAccount or PaymentRecord/Fulfillment;
5. receiver action, Match/pair/chat rows, notification, audit, and outbox facts.

Direct credit delivery has no pending quota and begins at pair/flow before CreditAccount. Pending
creation/cancel/expiry/settlement locks the sender counter first. Receiver actions never lock the
counter. Pair-scoped M3 commands use the same advisory key, so Nakh cannot race into an impossible
Like/NotInterested/Match combination.

External provider calls never occur inside a product transaction. Stars callbacks first commit M4
evidence; the fulfillment worker later claims with lease/fence and runs Nakh delivery.

## 8. Canonical use cases

### 8.1 Direct credit Nakh

Authorize active/complete/visible sender and target plus Explore source; validate text; lock pair;
return the stable result on command replay; reject existing flow or terminal pair. Lock CreditAccount,
require 2 credits, insert flow/consumption, negative ledger transaction, delivered Nakh/history,
receiver notification and outbox in one commit. Any failure creates none of these effects.

### 8.2 Pending Stars Nakh

Lock sender counter and pair; require count below five; create flow, consumption, PendingNakh with
explicit auto-settle consent, 14-day deadline, and send-Nakh PendingPayment with the same deadline;
increment counter and commit without receiver notification. Invoice creation then uses M4. Replayed
creation returns the same flow/pending/payment; conflicting text/facts reject.

### 8.3 Edit and cancel

Edit locks the counter/flow/pending row, requires sender ownership and `pending_payment`, validates
expected version and text, and changes no payment snapshot or deadline.

Cancel locks counter then pair/flow/pending. The sender chooses exactly one resolution. Revalidate
the terminating interaction, atomically create/replay Like or NotInterested, transition pending to
cancelled, decrement quota, and expire/cancel the still-pending funding intent. It does not remove
flow or consumption and sends no Nakh notification. Concurrent fund/cancel produces one terminal
shape.

### 8.4 Credit delivery and FIFO settlement

The normal credit-delivery coordinator locks counter, pair/flow/pending, then CreditAccount. If
current non-visibility eligibility fails, close_by_system, decrement quota, spend nothing, and return
continue. If eligible but balance is below 2, change nothing and return stop. If fundable, append one
deterministic `spend_nakh`, create Nakh/history/receiver notification, transition paid_and_sent,
decrement quota, and commit atomically.

Every positive CreditTransaction emits `billing.credit-increased.v1`. Settlement serializes per
sender, keyset-selects `pending_payment` by `(created_at,id)`, and repeatedly invokes the same
coordinator. It closes an ineligible oldest item and continues; it stops at the first eligible but
unaffordable item. It never skips that item for a newer row. Duplicate events and crash replay are
harmless.

### 8.5 Stars fulfillment

M4 receipt processing claims the PaymentRecord/Fulfillment, loads its pending-Nakh target, then uses
the same non-visibility eligibility and delivery transaction without a credit entry. Success creates
one Nakh/notification, resolves PendingPayment, transitions pending and decrements quota, and marks
fulfillment complete. Target unavailability after capture creates one RefundRecord and closes the
pending item. Callback replay cannot deliver or notify twice.

### 8.6 Reminder and expiry

Scheduler scans bounded keyset pages with `SKIP LOCKED`. Reminder claim rechecks pending state,
sender ownership, `<6`, deadline, and at least 48 hours since creation/last reminder; one transaction
increments count/time and creates only the sender notification. Provider delivery is asynchronous.

Pending expiry locks counter/flow/pending, conditionally transitions at database time, decrements
quota, and expires the still-pending funding intent; no receiver fact is created. Delivered expiry
locks pair/flow/Nakh and conditionally transitions only sent/seen at its own deadline, appending
history with no refund.

### 8.7 Receiver view, reject, and accept

All commands bind the authenticated receiver and reauthorize the current Nakh. View-profile appends
an idempotent action and moves sent to seen once. Reject races through the unique terminal action,
sets rejected/history, and emits no Match.

Accept locks pair/flow/Nakh and terminal action, then calls the same MatchLifecycleCoordinator used
by mutual Like: create/replay one normalized Match sourced by Nakh, two participants, matched pair
state, ChatSession/two participants, close incompatible active Likes, transition Nakh accepted,
append history, and notify both users in one transaction. Accept racing reject/expiry yields one
winner and a stable closed result; replay returns the existing Match.

## 9. Contracts and presentation

M5 contracts include create-direct, create-pending, edit, cancel-with-resolution, settle, view,
accept, reject, reminder, and expiry commands plus sender pending/status and receiver inbox/detail
queries. Every mutation carries actor, request/command/idempotency IDs, expected version where
applicable, locale, and typed data. Results expose opaque IDs/status/times and the actor-authorized
Profile projection only; never balance/financial/provider facts belonging to another user.

Telegram callbacks contain signed opaque references, not raw user/flow/payment IDs or text. Pending
screens state auto-settle consent and remain sender-only. Receiver delivery renders user text using
escaped approved formatting. `rejected` displays the localized “Closed” label.

Required safe errors cover unavailable target, duplicate flow, quota reached, invalid text, stale
version/action, insufficient credits, payment pending/expired, terminal Nakh, and temporary failure.

## 10. Security, observability, and reconciliation

- Never put Nakh text, Profile data, Telegram identity, balance, payment/refund/provider identifiers,
  or internal entity IDs in logs, metric labels, queue names, or alert text.
- Trace by non-secret correlation IDs. Metrics use finite outcomes for creation, delivery, settlement,
  reminders, expiry, receiver actions, backlog count/age, quota drift, and FIFO stop reason.
- Alert on quota drift, paid-but-undelivered age, settlement backlog/oldest age, callback conflict,
  reminder/expiry scheduler failure, or Nakh funding invariant mismatch.
- Reconciliation checks flow direction uniqueness, counter/source count, pending/payment deadline,
  delivered funding proof, pending/delivered coexistence shape, history continuity, notification
  cardinality, and accepted-Nakh Match cardinality. Safe repairs use idempotent commands; financial
  or contradictory facts are quarantined.

## 11. Acceptance and fault matrix

- `ACC-021`: 20 concurrent same-direction starts create one flow/result;
- `ACC-022`: 20 attempts at four existing pending items admit exactly one fifth and no sixth;
- `ACC-023`: pending item is absent from receiver queries/notifications under all replays;
- `ACC-024`: randomized queues/balances prove oldest-first, close-and-continue, and stop-without-skip;
- `ACC-025`: 100 duplicate callbacks, worker crashes before/after each commit boundary, one Nakh and
  one receiver notification;
- `ACC-026`: visibility-off matrix permits delayed delivery while restricted/banned/deleted/invalid/
  matched/unmatched/blocked denies it without spend;
- `ACC-027`: fund/edit/cancel races produce exactly one paid delivery or one Like/NotInterested
  cancellation shape and correct quota;
- `ACC-028`: rejection persists `rejected`, renders Closed, and cannot race into accept;
- `ACC-029`: fake-clock boundaries prove independent pending/sent 14-day clocks and six reminders;
- `ACC-030`: 20 accept/reject/replay workers create at most one Nakh-origin Match/chat with exactly
  two participants;
- migration bootstrap/upgrade/replay, append-only guards, stale lease/version, outbox/inbox replay,
  reconciliation faults, and production-volume FIFO/inbox/due-scan plans pass.

Tests assert committed PostgreSQL facts, not only DTOs. Concurrency uses independent connections and
barriers. Fake providers/time are deterministic; real provider behavior is claimed only in staging.

## 12. Delivery checkpoints

1. execution guide, M5 contracts, pure lifecycle/text/time/FIFO policy;
2. flow/counter/pending migrations and `ACC-021..023` concurrency;
3. direct credit delivery, immutable Nakh/history, and `ACC-026` matrix;
4. edit/cancel conversions and `ACC-027` races;
5. Stars target/invoice fulfillment, corrections, and `ACC-025` replay/crash evidence;
6. strict FIFO worker, credit-increase consumer, and `ACC-024` property/load tests;
7. reminders and independent pending/delivered expiry with `ACC-029`;
8. receiver inbox/view/reject/accept and Nakh-origin Match with `ACC-028/030`;
9. reconciliation, query-plan/load gates, M5 metrics, alerts, runbook, and acceptance ledger;
10. real Telegram/Stars staging evidence.

After every checkpoint run formatting, lint, type checking, unit tests, build, migration
bootstrap/upgrade/replay, relevant integration/fault tests, and GitHub CI. Push one locally green
checkpoint and wait for that exact commit to turn green before advancing.

## 13. Definition of done

M5 is code-complete only when all `ACC-021..030` automated evidence, migrations, reconciliation,
production-shaped plans, operations docs, and CI are green. It is production-ready only after the
same immutable release passes real Telegram/Stars delivery, replay, timeout, worker-crash,
notification, rollback, and monitoring drills with named backend/product/operations/security
sign-off. Without infrastructure it may be called **code complete / staging blocked**, never live.
