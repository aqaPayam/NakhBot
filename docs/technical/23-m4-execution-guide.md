# M4 Execution Guide — Billing Foundation and Paid Unlocks

Status: approved implementation guide for M4. This guide converts the canonical credit, Telegram
Stars, entitlement, correction, notification, and acceptance rules into an ordered backend plan.

## 1. Authority and boundary

1. Domain documents remain authoritative for product behavior.
2. Existing architecture, transaction, security, localization, testing, retention, and deployment
   rules remain mandatory.
3. This guide owns M4 sequencing, lock order, provider ingestion, fulfillment, correction,
   reconciliation, and evidence for `ACC-020`, `ACC-032..033`, and `ACC-036..038`.
4. M4 may be implemented and fully tested with a deterministic fake Stars provider before a real
   staging bot is available. Live Stars activation remains disabled until the external staging gate
   in section 16 passes.
5. M3's remaining real Telegram and media-provider evidence does not block provider-neutral M4
   code. M4 must reuse the established identity, interaction, Match, media-delivery, outbox, queue,
   idempotency, and configuration boundaries without weakening them.

M4 delivers the authoritative credit ledger, the four configured credit packages, funding intents,
Telegram Stars invoice/pre-checkout/success handling, durable paid fulfillment, Like- and
Match-scoped FeatureUnlocks, automatic system-fault correction, payment reconciliation, and the
notification foundation required by M4 outcomes.

## 2. Non-goals

Do not add a withdrawable wallet, credit transfer, promotional currency, cryptocurrency, arbitrary
prices, partial payment, user-requested refunds, chargeback adjudication, another payment provider,
or direct database repair tools. M4 does not deliver Nakh (M5), free-text chat/message retention
(M6), full notification-channel retry behavior (M6), moderation/admin adjustment UI (M7), or live
production charging (M9).

M4 may create a Match-scoped chat unlock and its durable notifications, but it does not implement
custom chat messages. M4 may emit the post-credit-increase settlement event, but M5 is the first
consumer that fulfills Pending Nakh.

## 3. Required packages and ownership

```text
packages/domain/src/billing/             # money-free credit and entitlement policies
packages/application/src/billing/        # billing use cases, provider ports, reconciliation
packages/application/src/entitlement/    # paid-action coordinator and effective access
packages/contracts/src/m4.ts             # strict versioned channel-neutral schemas
packages/persistence-postgres/src/       # ledger, payment, unlock, notification repositories
packages/telegram/src/                    # XTR invoice/pre-checkout/success adapter only
apps/worker/src/                          # fulfillment, correction and reconciliation consumers
migrations/000025..                       # forward-only M4 schema and localization
```

Billing owns funding facts and never edits interaction or Match tables directly. Interaction owns
Like eligibility. Matching owns Match eligibility. Entitlement coordinates those owners inside one
PostgreSQL unit of work. Telegram translates provider updates into strict application commands and
contains no pricing or entitlement decisions.

## 4. Locked product constants and technical decisions

- Telegram Stars with currency `XTR` is the only external MVP payment path.
- Credits and Stars are positive integers represented as PostgreSQL `bigint`; TypeScript contracts
  use decimal strings at storage/API boundaries so JavaScript number precision is never assumed.
- Active packages are exactly: `starter` 10 credits/10 Stars, `plus` 25/20, `best_value` 50/35,
  and `ultimate` 100/60. A payment snapshots both quantities; later catalog changes do not alter it.
- Liked By profile unlock and chat unlock each cost 4 credits or 4 Stars.
- Prices are loaded from authoritative data, never accepted from Telegram buttons or clients.
- Every balance mutation locks CreditAccount and appends one immutable CreditTransaction. Balance
  is a transactionally maintained projection of that ledger, not an independent source of truth.
- Every external charge first becomes immutable provider evidence. Fulfillment happens from durable
  state and is safe to replay after a crash.
- Invoice payloads contain at least 128 random bits and no clear user, target, price, or internal ID.
  Persist a unique keyed digest plus application-encrypted replay value; never log either form.
- Raw provider payloads are encrypted at the application boundary. Queryable columns contain only
  the validated projection needed for fulfillment, audit, and reconciliation.
- FeatureUnlock is the sole authority for paid Like/Match access. A PaymentRecord, ledger entry,
  callback, button, or Telegram message is never sufficient authorization.
- MVP unlocks have no clock expiry. Effective access additionally requires the Like to remain
  actionable or the Match and ChatSession to remain active.
- Normal scope closure never earns a refund. Automatic correction is only for a verified system
  failure or duplicate capture where no equivalent product result was delivered.
- The user-facing payment-attempt limit is 10 created provider attempts in any rolling 10 minutes.
  Callback ingestion, fulfillment, correction, and reconciliation are never rate-limited by it.

## 5. Migration sequence

Create and verify these forward-only migrations:

1. `000025_m4_credit_ledger.sql` — immutable credit transactions, package catalog and exact four
   seed rows; reuse the M1 CreditAccount rather than replacing it.
2. `000026_m4_payment_intents.sql` — PendingPayment and PaymentRecord lifecycle, price snapshots,
   invoice digest/ciphertext, attempt-rate indexes, and strict type/reference checks.
3. `000027_m4_provider_receipts.sql` — Telegram Stars receipt, provider-event inbox, internal
   fulfillment state/lease/fence, and restricted payment audit facts.
4. `000028_m4_feature_unlocks.sql` — Like/Match-scoped FeatureUnlock, one-successful-unlock partial
   uniqueness, one-funding-source checks, and deferred ledger/unlock funding references.
5. `000029_m4_notifications_refunds.sql` — durable Notification/Delivery rows, refund records,
   correction work, and reconciliation anomaly/run facts.
6. `000030_m4_localization.sql` — packages, balances, invoices, pending/success/failure/correction,
   unlock, safety, stale-action, and safe payment error keys.

Each migration must bootstrap from empty, upgrade from `000024`, replay unchanged, and have matching
verification SQL. Applied migrations are immutable. Schema privileges must keep provider payloads,
charge identifiers, ledger rows, and payment audit unavailable to Profile/chat worker roles.

## 6. Persistence invariants

### 6.1 Credit ledger and packages

`billing.credit_transactions` stores account, user, type, signed amount, before/after balances,
exactly the references allowed for that type, a unique business-cause idempotency key, correlation
ID, and database time. Checks enforce `balance_after = balance_before + amount`, non-negative
balances, positive purchase/refund amounts, and negative spends. Update/delete are denied by trigger
and runtime role.

Appending a transaction locks CreditAccount `FOR UPDATE`, returns an existing identical cause as a
replay, rejects a conflicting cause, checks affordability, inserts the ledger row, and updates
CreditAccount balance/version in one transaction. The account balance after commit must equal the
latest ledger `balance_after`; the empty ledger must correspond to zero.

`billing.credit_packages` uses stable code, localization keys, positive credit/Stars amounts,
active flag, and display order. The four seed codes and amounts are verified exactly. Historical
payments use snapshots and never join the mutable package price to decide fulfillment.

### 6.2 Funding intent and payment attempt

`billing.pending_payments` stores user, reason, typed target, chosen funding path, exact required
amount, state/version, and lifecycle times. Package intent targets a package snapshot; Like intent
targets one received Like; chat intent targets one Match. Shape constraints reject mixed targets or
both funding units. Only pending is non-terminal.

`billing.payment_records` stores one provider attempt with user/intent, type/action/package snapshot,
Stars amount, provider/environment/bot identity, invoice payload digest and encrypted value, state,
provider identifiers, and lifecycle/version fields. Unique indexes cover invoice digest and each
non-null provider payment identifier. Type/reference/status/timestamp checks reject impossible rows.

Attempt creation takes an identity-scoped advisory lock, counts records using database time over the
prior 10 minutes, and admits only the first 10. It then locks and revalidates the PendingPayment,
loads the authoritative price, and writes the PaymentRecord. A stable command idempotency key
returns the same attempt; a new genuine retry creates a new record only while the product intent is
pending.

### 6.3 Provider evidence and fulfillment progress

`billing.payment_provider_events` is an inbox keyed by `(provider, provider_event_id)`. It stores an
encrypted raw payload, safe typed projection, schema version, processing state, attempts, and times.
`billing.telegram_stars_payments` stores one successful charge per PaymentRecord and unique Telegram
charge ID, optional provider charge ID, exact amount, and receive time.

`billing.payment_fulfillments` represents internal progress only:
`receipt_recorded -> fulfillment_pending -> fulfilled|correction_required -> corrected`. It owns a
bounded attempt count, availability, lease owner/expiry, monotonically increasing fence token,
sanitized failure code, and timestamps. It does not invent public PaymentStatus values.

Provider events, Stars receipts, successful PaymentRecords, and financial audit facts are immutable.
Processing metadata changes only through narrow compare-and-set repository methods.

### 6.4 Feature unlocks

`interaction.feature_unlocks` stores payer, type, exactly one Like/Match scope, exactly one
PaymentRecord/CreditTransaction funding reference, state, unlocked time, optional revocation facts,
and null MVP expiry. Partial unique indexes permit at most one successful unlock per Like and per
Match. Funding references are unique so one payment/spend cannot fund multiple grants.

The credit transaction and FeatureUnlock references form a deliberate cycle. Both foreign keys are
`DEFERRABLE INITIALLY DEFERRED`, allowing both immutable facts to be inserted in one transaction
without temporarily weakening referential integrity.

### 6.5 Notifications, refunds, and reconciliation

M4 creates the durable Notification and one-per-channel Delivery foundation because unlock/payment
transactions must record notifications before external sending. Deduplication keys are deterministic
from the cause and recipient. Existing preferences suppress normal delivery creation, not history;
payment and safety notices always create Telegram delivery regardless of mutable preference flags.
M6 expands dispatch/retry and chat notification behavior without replacing these records.

`billing.refund_records` stores original funding proof, correction reason, amount, deterministic
idempotency key, provider progress, attempts, sanitized failure, and lifecycle times. Credit refunds
link one positive immutable ledger entry. Stars refunds retain the original unique charge reference.

Reconciliation runs and anomalies are append-only operational facts. A reconciliation finding never
repairs financial state by direct update; it schedules an idempotent fulfillment/correction command
or raises an operator-visible anomaly.

## 7. Canonical lock order and transaction boundaries

Every path uses database time and the following order. A repository must not introduce a reverse
order.

1. Identity-scoped advisory lock when creating a provider attempt.
2. Product scope: Like plus normalized pair facts, or Match plus ChatSession.
3. Funding source: CreditAccount for credit spend, or PaymentRecord/Fulfillment for captured Stars.
4. FeatureUnlock/ledger rows and Notification/outbox rows.

Provider ingestion is the exception because it records external evidence before product locking: it
locks PaymentRecord, inserts/deduplicates event and receipt, marks payment paid, creates fulfillment
work, and commits. The worker later locks Fulfillment/PaymentRecord first and then invokes the target
grant using the product-scope lock. Direct Stars fulfillment never locks CreditAccount, so this
ordering cannot cycle with credit spending.

### 7.1 Credit-funded Like unlock

1. Lock Like, receiver/payer authorization, actionable-state dependencies, and pair state.
2. Return the existing successful unlock when the stable command is replayed.
3. Lock payer CreditAccount; require at least 4 credits.
4. Insert one `spend_liked_by_unlock` ledger entry and one Like-scoped FeatureUnlock.
5. Create payer notification/history and transactional outbox facts.
6. Commit all effects together. Any failure creates no spend and no unlock.

### 7.2 Credit-funded chat unlock

1. Normalize and lock the active Match, ChatSession, pair state, and both participants.
2. If an unlock exists, return it without charging either participant.
3. Lock the requesting participant's CreditAccount; require at least 4 credits.
4. Insert one `spend_chat_unlock` entry and one Match-scoped FeatureUnlock.
5. Create a deduplicated unlock notification and safety notice for both participants.
6. Commit together. Concurrent participants converge on the unique Match scope; the loser re-reads
   the winner and is never charged.

### 7.3 Package fulfillment

Lock Fulfillment/PaymentRecord/PendingPayment, then CreditAccount. Verify the paid receipt equals the
snapshotted XTR amount and package facts. Append one positive `purchase` ledger entry, resolve the
intent, create payment-success notification and `credit_increased` outbox event, then mark fulfilled.
Replay returns the same ledger transaction. M5 later consumes the event for FIFO settlement.

### 7.4 Direct Stars fulfillment

Lock Fulfillment/PaymentRecord/PendingPayment, then run the same target validation and grant routine
used by credit funding without creating a credit ledger entry. Create exactly one payment-funded
FeatureUnlock, notifications, resolve the intent, and mark fulfilled in one transaction. If the
scope became permanently unavailable after capture, mark `correction_required`; never create an
invalid grant or pretend the payment failed.

## 8. Stars invoice and callback protocol

### 8.1 Invoice creation

The channel submits only an authenticated actor, reason/target or package code, and stable request
ID. The application verifies capability, target and price, enforces the rolling limit, creates or
reuses PendingPayment, and creates one PaymentRecord with an opaque payload. The Telegram adapter
sends currency `XTR`, the exact snapshotted integer amount, no provider token, and localized text.

### 8.2 Pre-checkout

Telegram pre-checkout must be answered within its provider deadline. The handler validates bot and
environment, hashes and resolves payload, checks payer mapping, currency, exact amount, pending and
unexpired records, and current target/package availability. It never grants access. Known replay
returns the same decision. Failure returns a safe localized reason and records only a sanitized code.

### 8.3 Successful payment

The webhook first passes normal Telegram authentication/update deduplication. In one short database
transaction, insert/deduplicate the provider event, verify bot/environment/payer/payload/currency and
amount, attach unique charge identifiers, record the Stars receipt, transition PaymentRecord to paid,
and enqueue fulfillment. A byte-for-byte logical replay returns the prior result. Reuse of an
identifier with conflicting facts is quarantined, produces no grant, and raises a security alert.

The adapter acknowledges success only after durable receipt commit. It does not wait for product
fulfillment. A crash before commit is safely retried by Telegram; a crash after commit is safely
replayed through event uniqueness and the fulfillment worker.

## 9. Effective access and channel behavior

Liked By reads join active FeatureUnlock to the current actionable Like predicate already shared by
count, page, and media authorization. Locked rows remain privacy-reduced. Effectively unlocked rows
may expose the canonical Profile card and authorized non-blurred media grant. Stale buttons and old
grants are reauthorized at use time; closing/rejecting/matching the Like removes access without
changing the historical funding facts.

Chat text authorization joins active FeatureUnlock to active Match, active ChatSession, participant
membership, pair/account safety, and non-revoked state. M4 exposes this query/port and proves both
participants benefit. M6 is responsible for accepting and relaying free-text messages.

Channel callbacks contain opaque signed action tokens only. They cannot contain price, credit
balance, payment payload, charge ID, Profile ID, Like ID, or Match ID in user-readable form.

## 10. Correction and refund state machine

Credit-funded target work is atomic, so a failure before commit leaves no spend. If a later verified
system defect proves a committed spend produced no equivalent effect, correction locks the original
transaction/account, appends one positive `refund` entry, and links one RefundRecord using a
deterministic key.

For Stars, `correction_required` creates one pending RefundRecord. The refund worker claims it with a
lease/fence, invokes Telegram using the original charge ID, and records only a known terminal result.
Timeout or ambiguous provider response remains retryable and must be reconciled before another
provider call. Successful correction transitions PaymentRecord from paid to refunded and fulfillment
to corrected. A replay cannot call the provider twice after known success.

No automatic correction is allowed merely because a user changed their mind, the unlocked Like
later matched/closed, a Match later closed, moderation acted on the user, or an entitlement was
successfully used.

## 11. Reconciliation

The scheduled reconciler uses bounded keyset batches and `SKIP LOCKED`. It detects:

- paid records without fulfillment/correction beyond the SLO;
- pending fulfillment with an expired lease;
- pending/expired intents with captured value;
- paid PendingPayment without exactly one valid successful receipt;
- package purchase amount differing from its immutable snapshot;
- ledger discontinuity or CreditAccount/latest-ledger mismatch;
- FeatureUnlock without one valid funding proof or with impossible scope shape;
- refund/correction stuck retryable or uncertain;
- callback amount, currency, payer, environment, bot, or identifier conflict.

Safe cases enqueue the normal idempotent command. Unsafe/conflicting cases are quarantined and
paged. Reconciliation never mutates immutable evidence, invents provider success, or grants value by
direct table edit.

## 12. Contracts and safe errors

All M4 commands carry actor, channel, request/correlation ID, expected version where applicable, and
strict target/package data. Public results expose only stable state, amounts safe for that actor, and
opaque continuation/action tokens. They never expose raw provider errors, payloads, charge IDs,
encrypted blobs, SQL details, or another user's balance.

Required safe application errors include unavailable action, already fulfilled, insufficient
credits, package unavailable, attempt limit, payment expired, payment verification failed, payment
pending, correction pending, stale action, and generic temporary failure. User-facing text is loaded
from localization keys only.

## 13. Security and observability

- Use separate test and production bot identities, keys, databases, and telemetry.
- Encrypt invoice replay material and raw provider payload with versioned keys; rotation supports
  old-row decryption until retention permits removal.
- Redact invoice payloads, charge IDs, payment metadata, Telegram identity, and Profile data from
  logs, traces, exception text, queue names, and metric labels.
- Trace invoice creation, provider receipt, fulfillment, correction, and reconciliation using
  correlation IDs that are not financial/provider secrets.
- Metrics include attempts/decisions by safe reason, fulfillment age, reconciliation backlog,
  correction age, ledger mismatch count, and callback conflict count. No user or payment ID is a
  metric label.
- Alerts cover callback backlog, verification rejection surge, paid-unfulfilled SLO breach,
  correction backlog, ledger mismatch, and provider identifier conflict.
- Runbooks cover provider outage, ambiguous refund, paid-but-unfulfilled, callback replay storm,
  ledger mismatch, key rotation, and disabling new invoices while keeping callbacks/reconciliation.

## 14. Automated acceptance and fault matrix

Required tests include:

- exact package seed/configuration and price-snapshot tests;
- ledger sign, chain, non-negative, immutable, idempotency, and property tests;
- two spends racing at exact balance and repeated command replay;
- 11 simultaneous payment attempts admit exactly 10; callbacks remain accepted;
- wrong bot/environment/payer/payload/currency/amount and conflicting identifier negatives;
- the same successful callback 100 times creates one receipt and one fulfillment;
- crash injection before/after event, receipt, paid transition, grant, notification, and completion;
- package callback grants credits exactly once (`ACC-036`);
- concurrent Like unlock creates one grant/charge, has no clock expiry, and loses effective access
  when the Like closes (`ACC-020`);
- both Match participants racing create one chat unlock/charge; both gain access (`ACC-032`);
- chat access has no clock expiry and ends on Match closure/revocation (`ACC-033`);
- target closes after Stars capture: no invalid grant and exactly one correction (`ACC-037`);
- preference matrix suppresses mutable normal deliveries while payment/safety notices bypass mute
  (`ACC-038`);
- reconciliation repairs retryable progress and quarantines contradictions without rewriting facts;
- production-volume indexes/query plans for payment history, due fulfillment, due refund, provider
  dedupe, active unlock, notification delivery, and reconciliation scans.

Tests use deterministic time, random payload sources, fake encryption, fake provider, and explicit
multi-connection barriers. They must assert committed database facts, not only returned DTOs.

## 15. Delivery checkpoints

Implement and push M4 as independently green checkpoints:

1. execution guide, contracts, enums, and pure domain policy;
2. credit ledger/package migrations, repository, invariants, and concurrency tests;
3. funding intent/payment-attempt migrations and application use cases;
4. provider receipt, pre-checkout, fulfillment lease/fence, and replay tests;
5. FeatureUnlock migration plus credit-funded Liked By/chat coordinators;
6. effective Liked By/media and Match/chat authorization reads;
7. Stars package and direct-action fulfillment through the same grant policy;
8. durable M4 notifications and `ACC-038` classification tests;
9. correction/refund state machine and fault-injection tests;
10. reconciliation, query-plan/load gates, dashboards, alerts, and runbooks;
11. real Telegram Stars staging evidence and M4 acceptance ledger.

After every checkpoint run formatting, lint, type checking, unit tests, build, migration bootstrap,
upgrade/replay verification, and relevant integration/fault tests. Push only a locally green commit,
then confirm GitHub CI before treating the checkpoint as accepted.

## 16. Definition of done

M4 is complete only when:

- all migrations and verification scripts pass from empty and from the M3 schema;
- every balance change has one immutable continuous ledger fact and reconciliation is clean;
- every known successful Stars charge reaches exactly one fulfillment or correction;
- Like/Match access is derived only from active FeatureUnlock plus current scope state;
- duplicate/reordered callbacks and injected crashes cannot duplicate value or lose captured value;
- `ACC-020`, `ACC-032..033`, and `ACC-036..038` are linked to reproducible evidence;
- payment/correction security, alert, and operator runbooks are reviewed;
- external Stars staging verifies invoice, pre-checkout, success replay, provider outage, correction,
  and recovery using a separate test bot;
- CI is green and no unresolved high-severity M4 security or data-integrity finding remains.

Without real staging credentials, implementation may reach **code complete / staging blocked**. It
must not be called production-ready or enable live invoices until the external gate is complete.
