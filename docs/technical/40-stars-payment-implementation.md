# Telegram Stars payment implementation handoff

Status: **payment flow implemented; distinct-checkout approval repair requires final verification before purchases reopen**.

This records the payment implementation and actual deployment verified on
12 November 2026. A real customer payment has not yet been observed. That is an
external acceptance check, not missing checkout code. It must not be represented
as a completed funded test or as unrestricted public-launch acceptance.

## Final implementation review: one checkout approval per intent

Review found that two distinct provider pre-checkout queries could both be
allowed while one invoice was pending. Economic receipt deduplication alone
cannot prevent Telegram from charging twice before either receipt arrives.
New purchases were paused through the tested independent stop before continuing;
financial callbacks/refunds remain enabled. The last native observation contained
zero payment records, so no actual double charge is claimed.

The repair uses the existing payer/target and payment/intent locks, then checks
durable prior approvals across every invoice attempt of the same funding intent.
Only one distinct provider event may be approved. Exact redelivery of that event
can replay after current eligibility checks; rejected events reserve nothing.
A conflicting historical approval also prevents a cached allow from being reused.
There is no timeout-based release of an unknown provider outcome. A customer must
let the original intent resolve/expire rather than authorize another Pay query for
it. A legitimate successful-payment receipt still processes independently.

Native regression cases cover 24 competing provider queries, sibling attempts,
exact winner/loser replay, rejected payer/amount followed by a valid query, and
delivery of the original approved invoice's receipt. No schema or permission
change is required; the existing intent and provider-event indexes support the
lookup. The fixed revision needs its own complete check, native evidence, six
exact-head CI jobs and actual rollout before new purchasing is re-enabled.

## Customer behavior

Customers choose a credit package from their account's credit menu, see the exact
quantity, full Telegram Stars price and v1 terms, and explicitly confirm the
review. Telegram then presents its own Pay confirmation. Merely opening or
accepting the review does not charge Stars. A direct Nakh may instead use its
existing two-Star offer; other product actions use the ordinary credit balance.

The owner approved these native catalog prices and the rendered English terms:

| Credits | Telegram Stars |
|---:|---:|
| 10 | 10 |
| 25 | 20 |
| 50 | 35 |
| 100 | 60 |

The public `/terms` and `/paysupport` routes remain available independently of
new purchase availability. Purchase/refund support is `@NakhSupport`, confirmed
by the owner. Terms explain internal noncash credits, receipt-confirmed delivery,
previously authorized pending Nakh settlement, correction/refund for verified
delivery faults, preserved applicable rights, and the operator's responsibility
for purchase support. Independent contact verification remains deferred by the
owner. No personal operator name or country has been invented or published.

## Implemented flow and authority

| Boundary | Implementation and evidence |
|---|---|
| Native offer | `PostgresFundingStore` captures immutable package quantity/price and native intent lifetime. Callback data and later catalog edits cannot select another price. |
| Customer consent | `PostgresStarsPurchaseConsentStore` binds the exact offer, rendered document, terms version, locale, original account life and original session. Concurrent confirmations retain one immutable audit fact. |
| Invoice | `stars-runtime.ts` uses Telegram `sendInvoice`, `XTR`, an empty provider token and a protected opaque payload. It rechecks original owner, grant, native offer and consent before transport. |
| Pre-checkout | The provider adapter validates payer, currency, amount, bot/environment, native attempt and target, and the repair reserves one approval across the intent's invoice attempts. An answer is not a successful payment. |
| Receipt and delivery | The successful-payment adapter retains encrypted evidence and the original charge identifier. Native receipt/fulfillment handlers apply one economic result under duplicate, conflicting and out-of-order deliveries. |
| Fulfillment failure | Durable correction/refund work handles cases where the authorized product action can no longer be delivered. A failed or ambiguous invoice acknowledgement does not grant credits. |
| Refund transport | The worker verifies original provider custody and the current fenced refund lease before calling `refundStarPayment`. An unknown provider outcome is quarantined; normal polling cannot repeat it. |
| Ambiguous refund | The existing internal `ResolveAmbiguousStarsRefundHandler` and store require an active administrative actor, evidence digest, original refund state and mandatory audit. It is not an unauthenticated public endpoint or automatic permission to retry an unknown refund. |
| Stop and lifecycle | New checkout can be paused while recorded-payment ingress, corrections/refunds and public payment support remain available. Revoked grants or another account life cannot borrow purchase consent. |

The protocol follows Telegram's
[official Stars payment flow](https://core.telegram.org/bots/payments-stars):
invoice, pre-checkout decision, successful-payment receipt, then delivery.
Telegram's pre-checkout deadline remains an operational requirement; automated
test completion is not evidence of live provider latency or availability.

## Verified deployment

The existing `@NakhTestBot` and owner-selected VPS are used. There is no new bot,
provider account, subscription or purchase. Runtime application source is
`d2837ae5f2e637ee37ccbf05656b81cf0cb23669`; the independently checked stop-observer
source is `a113dfab68ce4e1834cb599a1a39c631e6d69fc0`. A later documentation commit
does not silently change the running application audience or image digests.

Both source revisions passed all six exact-head CI jobs. The latter passed on
attempt one in [run 43209887032](https://github.com/aqaPayam/NakhBot/actions/runs/43209887032).
Its ten source-bound artifacts and supplemental recovery fixture were verified;
all 1,665 native integration cases passed with zero skips. The original
20,000-row, 1,500 ms M7 gate was unchanged; its terminal query took 1,432.476 ms.
The commit containing this handoff still requires its own check and six jobs.

Actual deployment evidence, kept privately outside Git, establishes:

- Four accepted-source, non-root services with read-only root filesystems;
  schema 172, five purpose roles and four verified service-reference snapshots.
- Native package prices and rendered purchase terms exactly match owner approval.
  Financial keys are separate from navigation keys and have protected backup
  custody. Existing encrypted administrator authenticator credentials remain
  unchanged.
- Active checkout started with product admission closed. The independent stop
  actually paused new invoices and preserved financial ingress; checkout then
  restarted successfully. No charge or credit transaction was created by this
  drill.
- The owner subsequently authorized the reviewed opening for the original owner
  and nine opaque invitation seats. Native opening receipt replay and invitation
  creation replay passed; an invalid invitation was denied. Free top-ups are off.
- The Telegram webhook includes message, callback and pre-checkout updates. Its
  authentication, provider registration and preservation of pending updates were
  verified. No user update or purchase was fabricated.
- Private R2 upload/read, anonymous denial, deletion/absence, clean scanning and
  EICAR detection passed using synthetic content. An initial runtime key metadata
  check was inconclusive; the diagnostic read returned HTTP 200 and confirmed the
  installed cleanup key active. It was not changed or renewed.
- The activated-trial backup was authenticated on the PC; only database members
  were streamed over the existing encrypted SSH connection to an isolated,
  networkless, non-root, swap-disabled RAM-only PostgreSQL container. All 172
  migration records and one account restored; the temporary container was removed.
  No private backup key left the PC and no plaintext archive was written to disk.
- Service/disk monitoring and ten-minute read-only native health snapshots are
  enabled. These observations do not approve a human daily review or fabricate
  completed customer/moderation/payment journeys.

## Current operating boundary

The authorized trial admits at most ten accounts. Purchasing is currently paused
for the repair; the previous opening is historical evidence, not authority to
resume unqualified code. Its original native expiry and
independent stop are **13 November 2026, 13:26:15 UTC** (16:56 Tehran time).
The cleanup credential expires at 20:29:59 UTC that day. The owner explicitly
deferred Cloudflare renewal, so no new Cloudflare sign-in or credential change
was performed. Do not extend admission past credential qualification without a
fresh review. The stop closes product admission and new invoices while retaining
financial callback/refund processing; it does not discard queued updates.

Keep retained-record erasure, Return/fresh entry, support-body release and orphan
sweeping off. Ordinary account/photo deletion stays enabled. Do not restore an
older database over later financial receipts. A schema-171-only image is not a
qualified rollback on schema 172; use the checked compatible invoice-paused mode
and forward repair for financial incidents.

The operator made no funded test purchase. Actual customer payment/refund
acceptance, real-user canary/moderation journeys, live traffic SLO review and
unrestricted public launch remain external acceptance work under the M9 handoff.
They do not require reopening an implementation task merely to collect evidence,
and must not be claimed complete without their actual records.
