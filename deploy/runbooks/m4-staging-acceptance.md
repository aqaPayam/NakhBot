# M4 Billing and Telegram Stars Staging Runbook

Use this runbook only after the exact candidate commit is green on the default branch and a separate
Telegram test bot, test payment flow, staging PostgreSQL/Redis, secret store, and observability stack
exist. It does not authorize infrastructure purchase, production traffic, real-user testing, or
public repository/object access.

## 1. Evidence header

Record the immutable commit and CI run, image/release IDs, UTC start/end, operator, backend,
operations and security reviewers, test-bot identity fingerprint, rollback release, and retained
query-plan artifact name. Never record bot tokens, invoice payloads, charge IDs, Telegram IDs,
encrypted evidence, internal user/payment/refund IDs, callback bodies, or raw provider errors.

## 2. Hard preconditions

Stop unless all are true:

- migrations `000025` through `000029`, verification, replay, restore smoke, integration tests, and
  the M4 production-volume query-plan gate passed for the exact release;
- staging uses a different bot, database, encryption key ring, webhook secret, and telemetry scope
  from production;
- new invoice creation can be disabled independently while callbacks, fulfillment, refunds, and
  reconciliation continue;
- the configured package catalog and immutable price snapshots have backend/product approval;
- payment evidence keys are injected by reference, old decrypt keys remain available for the
  retention window, and logs/metrics contain no provider or identity secrets;
- alerts for paid-unfulfilled age, correction backlog/age, ambiguous refund, provider conflict,
  ledger mismatch, callback backlog, and scheduler failure reach the operations channel;
- the operator can identify the exact provider charge in protected Telegram tooling without copying
  it into logs, tickets, chat, screenshots, or acceptance evidence.

## 3. Safe activation order

1. Deploy schema and the compatible release with invoice creation disabled. Keep callbacks,
   fulfillment, refunds, and reconciliation running.
2. Verify zero unexplained ledger mismatch, uncertain refund, and paid-unfulfilled findings.
3. Enable invoice creation for one allow-listed synthetic payer. Buy the smallest package and prove
   that durable receipt commit precedes callback acknowledgement and credits are granted once.
4. Replay pre-checkout and successful-payment callbacks. The replay must return the prior outcome,
   create no new value, and expose no raw provider facts.
5. Enable one Like unlock and one Match/chat unlock. Verify one entitlement, both Match participants'
   effective chat access, and critical payment/safety notification behavior under muted preferences.
6. Expand only after reconciliation completes cleanly, correction backlog returns to zero, ledger
   continuity holds, and no payment/security alarm fires.

## 4. Required observations

Record pass/fail, UTC time, an aggregate metric/audit reference, and reviewer initials for:

- `ACC-020`: concurrent Liked By unlock produces one grant/charge, has no clock expiry, and loses
  effective access when its Like is no longer actionable;
- `ACC-032..033`: racing Match unlocks produce one grant, both participants gain access, and Match
  closure/revocation ends effective access without rewriting funding history;
- `ACC-036`: package callback replay and worker termination grant the package credits exactly once;
- `ACC-037`: target closure after capture creates no invalid grant and exactly one correction;
- `ACC-038`: mutable normal notifications obey preferences while payment and safety notices bypass
  mute and remain in durable history;
- ten concurrent open Stars attempts are admitted and the eleventh is rejected, while callbacks for
  earlier attempts remain accepted;
- wrong bot, environment, payer, payload, currency, amount, and reused conflicting identifiers are
  denied/quarantined without value creation;
- every balance change has one continuous immutable ledger entry and account balance equals the
  latest entry;
- scheduler restart resumes one reconciliation run, batch cursors advance, and anomaly records are
  append-only and identity-safe.

## 5. Ambiguous refund drill

1. Create a synthetic paid action, make its target unavailable after capture, and wait for one
   pending refund record.
2. Inject a timeout after the refund request may have reached Telegram but before a response is
   recorded.
3. Confirm the durable record is `failed_retryable/call_started`, the ordinary refund worker cannot
   reclaim it, and `stars_refund_outcome_uncertain` is quarantined by reconciliation.
4. In protected provider tooling, determine whether Telegram applied the refund. Do not infer the
   result from timeout text and do not send another refund while the outcome is unknown.
5. Use the reviewed idempotent reconciliation command for the observed provider result. Until that
   operator command is implemented and reviewed, leave the item quarantined and keep invoice
   creation disabled if the backlog is material.
6. Verify the known-success path produces one `paid -> refunded` payment transition, one
   `correction_required -> corrected` fulfillment transition, one critical payer notice, and no
   second provider call.

Never edit payment, fulfillment, refund, ledger, provider-event, or anomaly tables manually. Never
delete or recreate an uncertain record to make it claimable.

## 6. Dashboard and alert gate

The payment dashboard must show callback decisions/latency, receipt-to-terminal age, fulfillment
backlog and oldest age, refund outcomes/age, reconciliation batches/findings, ledger mismatches,
provider conflicts, notification delivery, PostgreSQL saturation, and release annotations. Labels
are limited to finite outcome/reason codes; user, payment, refund, charge, payload, and Telegram IDs
are forbidden.

Page immediately for any ledger mismatch, provider identifier conflict, ambiguous refund, verified
payment not durably recorded, paid-unfulfilled age above two minutes with growth, or fast payment SLO
burn. Ticket a single safely retryable provider outage only while backlog age and the error budget
remain inside the approved envelope. Every alert must link here and name the billing/on-call owner.

## 7. Acceptance and rollback

M4 may be accepted only when all observations pass, the retained M4 query-plan artifact uses every
required index within budget, reconciliation is clean, Critical/High findings are zero, and backend,
operations, security, and product reviewers sign the evidence record.

On failure, disable new invoice creation first. Continue authenticated callbacks, durable
fulfillment, correction, and reconciliation when safe. Roll back only to a schema-compatible image;
never reverse an applied migration, discard callback evidence, truncate queues, alter balances,
force-complete entitlements, or blindly retry an ambiguous provider operation.
