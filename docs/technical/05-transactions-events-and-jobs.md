# Transactions, Events, and Jobs

## 1. Reliability model

Nakh uses:

- ACID PostgreSQL transactions for authoritative state;
- a transactional outbox for facts and requested side effects;
- BullMQ for delivery, delay, retry, and worker scaling;
- a consumer inbox plus business uniqueness constraints for deduplication;
- deterministic idempotency keys at every externally retryable boundary;
- reconciliation jobs for provider operations and derived counters.

Delivery is **at least once**. “Exactly once” is achieved only as a business effect through uniqueness, conditional transitions, ledger rules, and idempotent provider commands.

## 2. Command execution template

1. Validate envelope and payload outside the transaction.
2. Authenticate actor and apply coarse rate limit.
3. Begin transaction with statement/lock timeouts.
4. claim the idempotency key and compare request hash;
5. load current Account/capability and target rows in global lock order;
6. validate invariant and current state;
7. write state plus history/ledger/audit rows;
8. write minimal outbox events in the same transaction;
9. persist the stable command result in the idempotency record;
10. commit;
11. return the committed result;
12. let the dispatcher publish side effects after commit.

An expected rejection may be cached in the idempotency record if repeating it must be stable. Transient infrastructure failures are not recorded as final results.

## 3. Outbox dispatcher

Dispatchers claim batches with `FOR UPDATE SKIP LOCKED`, publish jobs/events with outbox ID as queue job ID, and mark published only after Redis confirms. A crash between publish and mark creates a duplicate queue submission, which consumers handle.

Policy:

- bounded batch and transaction duration;
- exponential backoff with jitter;
- alert on oldest unpublished age, repeated failures, or row growth;
- poison payload moves to an operational dead-letter state without being discarded;
- payload contains IDs and immutable facts, not whole profiles or chat text unless the specific protected workflow requires it;
- outbox cleanup occurs only after the inbox/replay retention window and backup policy.

## 4. Consumer template

1. Validate event/job schema and supported version.
2. Start a trace linked to correlation/causation IDs.
3. Claim `(consumer,messageId)` in inbox.
4. If processed, acknowledge duplicate.
5. Load current authoritative state when required.
6. Execute one bounded idempotent unit.
7. Record result and any new outbox records in one transaction.
8. Acknowledge queue only after commit.

Retry classes:

- retryable: provider timeout, 429, temporary 5xx, deadlock, connection loss;
- terminal business no-op: target deleted/closed, preference muted, already fulfilled;
- terminal malformed: unsupported schema or invalid invariant; page operations and retain payload hash;
- uncertain provider result: do not repeat blindly; reconcile by provider identifier before retry.

## 5. Atomic workflow designs

### Guest preview consumption

- Lock/conditionally update GuestPreviewCounter if below immutable limit.
- Select an eligible preview candidate and insert ExploreConsumption.
- If candidate insert conflicts, try another within a bounded loop.
- Commit count only when a candidate is successfully consumed; if no candidate exists, do not burn a preview.

### Like and mutual Match

- Normalize pair and acquire transaction-scoped advisory lock derived from both UUIDs.
- Recheck account/profile/visibility/reciprocal eligibility and pair exclusions.
- Insert ExploreConsumption if absent, then directional Like; an existing directional Like returns its stable result.
- If reciprocal active Like exists, create the unique Match, participants, pair matched state, ChatSession/participants, close both Likes, and enqueue Match notifications in the same transaction.
- The Match unique pair constraint is the final concurrency guard.

### Not Interested

- Lock pair, validate source, insert unique directional rejection and consumption.
- Close an actionable received/sent Like as specified.
- Pending Nakh cancellation uses the Nakh coordinator so quota and resolution remain consistent.

### Create unpaid Pending Nakh

- Lock sender user counter then normalized directional flow key.
- Validate eligibility and absence of any prior directional NakhFlow.
- Reject if unpaid count is five.
- Create NakhFlow, PendingNakh, and funding intent; increment counter; consume Explore target.
- Store the 14-day deadline from configuration snapshot.

### Fund and deliver Nakh with credits

- Lock NakhFlow/PendingNakh, then CreditAccount.
- Recheck current non-visibility eligibility and pending state.
- If eligible: spend two credits, insert ledger, create immutable delivered Nakh, transition PendingNakh, decrement quota, create notifications/outbox.
- If no longer eligible: close pending state, decrement quota, do not spend credits.
- One commit makes funding and delivery inseparable.

### Fund and deliver Nakh with Stars

- Record provider success once and lock PaymentRecord, PendingPayment, flow, and pending state.
- Recheck current non-visibility eligibility.
- If eligible, create Nakh and complete funding intent atomically.
- If a system fault makes fulfillment impossible after successful charge, create RefundRecord; never silently retain value.
- Provider success is acknowledged only after durable receipt; target delivery may then retry from the recorded paid state.

### FIFO settlement after a credit increase

- Every committed positive CreditTransaction enqueues one settlement job for that User.
- Serialize settlement per User and select pending-payment items by `created_at`, then ID.
- Lock and revalidate each item. If currently ineligible, transition it to `closed_by_system`, decrement quota, and continue.
- If the next eligible item cannot be fully funded, stop; never skip it for a newer item.
- If fundable, execute the normal atomic credit-funded delivery with a deterministic spend idempotency key and continue while balance permits.
- Duplicate jobs, a worker crash, or concurrent balance increase converges through row locks and conditional pending transitions.

### Accept delivered Nakh

- Lock pair/flow/Nakh.
- Conditional transition from sent/seen to accepted; exactly one terminal action wins.
- Create unique Match, participants, pair state, chat rows; close incompatible interactions; enqueue notifications.
- Duplicate accept returns the existing Match; accept racing reject produces one winner and one stable closed response.

### Scoped Liked By unlock

- Lock Like and funding source.
- Recheck receiver is payer, Like is active/actionable, and pair is eligible.
- Spend four credits plus create FeatureUnlock in one commit, or fulfill paid Stars intent once.
- Unlock has no time expiry, but access query joins the active Like.

### Chat unlock and message send

- Unlock locks active Match and funding source; creates the one-ever Match-scoped FeatureUnlock, notifies both participants, and schedules one safety warning per participant.
- Text send locks ChatSession, verifies Match/pair/account and effective unlock, reserves next sequence, inserts message, creates notification.
- Predefined message paths apply the same Match safety checks but not the text-unlock check when the product rules permit them.

### Unmatch

- Lock pair and Match.
- Transition Match active to unmatched, create one UnmatchRecord with 24-hour report deadline, change pair state, close ChatSession, close/revoke scoped access as required, close active Likes, and enqueue closure notifications.
- Message-retention cleanup is asynchronous; report snapshots created during the window remain independent.

### Report and threshold restriction

- Validate source/evidence and daily rate limit; create Report plus immutable snapshots in one transaction.
- Under a target-level lock, count distinct reporters across all evidence types only for `submitted|pending_review` Reports in the rolling prior 30 days.
- On the fifth unique reporter in 30 days, request the one idempotent restriction transition and create safety audit/outbox records.
- Multiple reports from the same reporter never increment the distinct threshold twice.

### Account deletion

- Synchronously lock Account, set deleted, add history and deletion record, revoke future commands, close active pair/chat state in bounded batches or create mandatory saga work.
- Worker executes a versioned checklist: ordinary DB data, notifications, media objects, caches/sessions, derived projections, pseudonymization, retention manifest, verification.
- Each step has a unique deletion-record/step key and checkpoint.
- Completed means all mandatory steps verified; failures alert and retry.

## 6. Job catalog

| Queue/job | Trigger | Idempotency key | Retry/dead-letter behavior |
|---|---|---|---|
| `outbox.dispatch` | continuous | outbox ID | retry; alert on age |
| `notification.deliver.telegram` | Notification outbox | delivery ID | provider-aware backoff; terminal bot-blocked/user-gone |
| `media.validate` | upload complete | asset ID/version | bounded retries; terminal rejected/failed state |
| `media.thumbnail` | asset valid | asset ID + variant | unique variant; retry |
| `media.blur` | blurred preview requested | asset ID + variant | unique variant; retry/on-demand |
| `media.delete-object` | photo/account cleanup | storage key + deletion generation | verify absent; alert persistent failure |
| `nakh.expire-pending` | due scan | pending Nakh ID + expiry | conditional transition |
| `nakh.expire-delivered` | due scan | Nakh ID + expiry | conditional transition |
| `nakh.remind-payment` | due scan | pending ID + reminder window | dedupe notification; stop at terminal |
| `nakh.settle-pending` | every committed credit increase | user ID + credit transaction ID | serialize per user; strict FIFO; idempotent spends |
| `chat.cleanup` | retention scan | chat ID + cutoff | bounded delete; preserve snapshots |
| `billing.fulfill-payment` | provider success | PaymentRecord ID | reconcile before uncertain retry |
| `billing.refund` | correction record | RefundRecord ID | provider-aware retry and escalation |
| `billing.reconcile` | schedule/manual | provider/date bucket | read-only comparison then repair command |
| `account.delete` | deletion initiated | deletion ID + step | checkpointed retry; never skip failed step |
| `discovery.refresh-shuffle` | six-hour schedule | profile ID + window | batched idempotent update |
| `audit.retention` | daily | category + date bucket | policy-guarded deletion/archive |

## 7. Scheduling

The scheduler is horizontally deployed but only one replica owns a short Redis lease at a time. Correctness does not depend on the lease: unique scheduled-run keys and conditional business transitions prevent duplicates.

It wakes frequently, selects due ScheduledJob rows, inserts a JobRunLog and queue work, advances `next_run_at`, then commits. Large scans use keyset batches and `SKIP LOCKED`. Product deadlines are selected directly (`status` plus `expires_at <= now()`), so a missed scheduler window catches up.

No product timer lives only in BullMQ. The database deadline is authoritative; delayed queue jobs are an optimization.

## 8. Backoff and queue controls

- exponential retry with full jitter and a capped delay;
- per-provider concurrency and rate limiter;
- separate queues so media bursts cannot starve payments or safety notifications;
- priority reserved for payment correction, account safety, and user-visible command follow-up;
- worker graceful shutdown stops intake, finishes a bounded active job, then releases lease;
- queue payload maximum kept small; large content lives in controlled storage/database;
- queue depth, oldest job age, retry count, and dead letters page by severity.

## 9. Event catalog

Initial domain event families:

```text
identity.account-state-changed.v1
identity.signup-completed.v1
profile.profile-completed.v1
profile.profile-invalidated.v1
media.photo-visible.v1
media.photo-hidden.v1
interaction.like-created.v1
interaction.not-interested-created.v1
interaction.unlock-granted.v1
nakh.pending-created.v1
nakh.delivered.v1
nakh.accepted.v1
nakh.closed.v1
matching.match-created.v1
matching.match-closed.v1
chat.message-created.v1
billing.payment-paid.v1
billing.credit-transaction-created.v1
billing.refund-required.v1
moderation.report-submitted.v1
moderation.action-applied.v1
account.deletion-requested.v1
account.deletion-completed.v1
```

Events are immutable facts. New consumers may replay them only inside the retained outbox/archive window. If full historical replay becomes a requirement, introduce a dedicated event archive; the operational outbox is not event sourcing.

## 10. Reconciliation

Automated checks compare:

- CreditAccount balance against the ordered ledger;
- successful provider charge against exactly one product fulfillment or correction;
- PendingPayment terminal state against PaymentRecord/target result;
- pending Nakh counter against source rows;
- Match row against two participants, one ChatSession, two chat participants, and pair state;
- visible primary photo/count against Profile eligibility;
- published outbox rows against queue/inbox progress where observable;
- deleted accounts against the purge manifest and object-store absence.

Reconciliation never edits rows directly. It emits a typed repair command with audit trail or pages an operator when automatic repair is unsafe.
