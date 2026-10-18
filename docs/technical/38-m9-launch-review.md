# Source-bound canary and daily launch review

M9 requires actual provider journeys and a supervised cohort, followed by daily
review of error budget, payments, safety, deletion, capacity and freshness. This
procedure uses the existing private cohort operator and native samplers. It does
not certify provider behavior, approve an operator or authorize cloud charges or
real-user release. CI fixtures remain synthetic. Retained-data erasure stays off.

## Native observations and private evidence

Use the reviewed binding and operator host from
[the cohort operator procedure](37-m9-cohort-operator.md). A command file containing
`{"operation":"health"}` collects current metadata through the same repeated STS,
selected current secret, verified TLS and native owner admission. The response
contains the bound audience, native timestamps, ten current safety integrity
counts, safety queue/scan liveness, eight deletion phase samples and the latest
run metadata for billing, Nakh, chat and moderation reconciliation.

The reads share a read-only repeatable database snapshot and retain the samplers'
existing local execution limits. They do not start jobs, repair entities, write
audits or contact Telegram/R2. A latest run's finding count is historical; it is
not the number of current unresolved defects. Review dispositions separately.
The audience records the selected database context. Actual deployed source and
provider observations require independent evidence below. Native metadata alone
does not prove a successful payment, deleted object or delivered notification.

Keep evidence files in an operator-only directory. Never upload raw provider
responses, private messages, identifiers, tokens, keys or screenshots to public
CI artifacts. The CLI hashes bounded regular files, up to 1 MiB each, and emits
only their role, SHA256 and declared observation/expiry times. It does not
authenticate those files' origins or interpret their contents. The reviewer must
inspect the original private records and independently establish their source,
environment, bot, authenticity and outcome. A hash is only content binding.

## Build a review dossier

Prepare a bounded private request JSON with exactly:

```text
{
  "operation": "prepare-review",
  "phase": "canary | cohort | daily",
  "intent": { ...the exact nine-field native cohort command... },
  "evidence": [
    {
      "role": "deployment",
      "path": "absolute-private-file-path",
      "observedAt": "UTC ISO timestamp with milliseconds",
      "expiresAt": "UTC ISO timestamp with milliseconds"
    }
  ]
}
```

The shown alternatives/placeholders are explanatory; supply one actual phase,
the complete native command and real timestamps. The input file limit is 16 KiB.
Use a placeholder 64-character digest in `intent.reviewDigest` during preparation;
it is the only native field excluded from `intentDigest`, avoiding a circular hash.
The final native command still includes the actual dossier digest in its own
complete command hash. Capture the exact request UUID, expected version, audience,
roster/lives, mode and expiry before review. Changing any requires a new review.

Invoke the ordinary three-path CLI with this request and a NEW private output.
It hashes the attachments, authenticates the operator and collects fresh native
observations before creating `{reviewDigest,dossier}`. Missing or stale evidence,
native integrity failures, scan freshness, pending safety age, unfinished deletion
age and intent expiry appear as finite blockers. Completed deletion history is
not a pending-age failure. Safety thresholds retain the existing 900/1,800/3,600
second operational bounds; latest reconciliation runs must have completed within
an hour (the existing billing/Nakh/chat schedule is fifteen minutes). Unfinished
deletion age uses the original twenty-four-hour objective.

Every supplied record must be fresh, not future-dated, and have a validity window
of at most twenty-four hours. The dossier expires at the earliest attachment,
intent or fifteen-minute native-observation expiry. Recollect after expiry.
An empty blocker list still requires actual content review and explicit approval.
The result always says `requiresHumanApproval:true`, `launchAuthorized:false`
and `evidenceVerification:"operator_supplied_bytes"`.

All phases require these private evidence roles:

| Role | Actual review obligation |
|---|---|
| `deployment` | Exact accepted source/CI archive, four image digests, selected AWS account/region, current fleet, runtime roles, bot/webhook and R2 configuration; verify actual deployment observations |
| `error_budget` | UTC interval, eligible denominators, failures, latency and burn against [the original SLOs](10-observability-and-operations.md); preserve provider outages and missing samples |
| `capacity` | Approved forecast/budget, running/desired/pending fleet, queue age, database/Redis/storage health and scaling limits; no unknown active producers |
| `alert_delivery` | Current metric timestamps plus actual alarm and recovery receipt through the selected paging route |
| `support_safety_review` | Current support/appeal/report queues, assigned staffing, audit/integrity findings and repair dispositions |
| `security_privacy_review` | Approved source/config/roles, MFA and permissions, storage/media access, deletion/Return and retained-category controls; retained erasure remains disabled |
| `staffing` | Named authorized operator, on-call and moderation coverage, independent stop capability and escalation ownership |

For `canary`, additionally require `canary_plan`: explicitly selected synthetic
testers, approved scenarios, data, stop conditions and any payment budget. This
phase allows preparation of the first restricted tester cohort before completed
drills exist. It never approves public users. Record insufficient traffic honestly;
an initial empty denominator is not evidence of a healthy error budget.

For `cohort` and `daily`, require all four completed drill roles below. The reviewer
must establish actual outcomes for this exact deployed audience, using designated
testers and native/provider records. Rehearsals, mocked AWS, CI conversion/scanner
tests and opaque hash manifests cannot satisfy those external obligations.

| Role | Supervised journey and required outcome |
|---|---|
| `canary_journeys` | Real authenticated webhook/start, catalog/text/prompts, signup/settings/profile, moderation-approved R2 photo delivery, discovery/Like/Nakh/Match/chat, notification/read/mute/Unmatch and reporting; verify provider delivery and replay fencing through ordinary entry points |
| `moderation_drill` | Real staff first factor and authenticator, scoped queue/evidence access, denied wrong role/owner, audited decision, support/appeal review and separately permission-checked exact-ban unban; include session revocation and required-audit failure containment |
| `payment_drill` | Separately approved provider/payment budget, invoice/pre-checkout/payment/fulfillment, duplicate delivery and exact single charge/ledger/effect, correction/refund and actual reconciliation; never infer a provider refund from a local request |
| `deletion_return_drill` | Real Root access fencing, ordinary product/media/ephemeral cleanup and retained manifest, controlled failure/retry, native completion and separately approved Return; old life/grants/media remain fenced and retained erasure stays disabled |

Use ordinary application commands and designated accounts. Do not edit business
tables, fabricate provider receipts, reset reconciliation cursors or expose a
test-only authority route. Preserve exact request identities and private audit
references so retries and failures can be reconciled. Actual funded operations
and real-user release require the owner's explicit reviewed authorization.

## Review, reference verification and opening

The authorized reviewer inspects original evidence, native facts, blockers,
historical findings/dispositions, source/audience, private roster and exact intent.
When the dossier expires or an input changes, prepare a new one. After an operation
has committed, never replace its body under the same request UUID; uncertain
results replay the original approved body to a new private receipt path while
its review is valid. After review expiry, use the read-only `receipt` operation
with that exact original native command. It returns its original receipt or null,
checks the original operator/body and never applies or renews a policy.

For a new opening/expansion, copy `reviewDigest` into the final native command.
Create a private opening request with exactly `operation:"apply-reviewed"`,
`input` (the final native command) and `reviewPath` (the absolute dossier path).
The active CLI rejects an opening submitted through raw `operation:"apply"`.
Closing continues to use ordinary `apply` with empty members and null expiry.

Check the dossier reference without AWS or native effects:

```text
pnpm launch:operator --verify-review <dossier-path> <opening-command-path> <new-private-result-path>
```

This verifies digest, exact intent/audience, empty blockers and expiry. Its result
still says launch is unauthorized and human approval is required. It cannot
authenticate external records or refresh an earlier native observation.

Compute the final command digest with the existing `--digest` mode, which does not
grant approval or verify evidence. Only after actual review and the required
explicit release authorization, put that exact command hash into the protected
binding. The ordinary active CLI rechecks the dossier before AWS/native effects;
the host rechecks after provider waits, and native admission checks its deadline
with the database clock after acquiring advisory/member locks. A lock wait cannot
extend a review. Existing receipts remain independently readable after expiry.
The native command still requires exact operator identity, database owner, CAS,
original lives, full command hash, mandatory audits and expiry. The native store
remains a privileged owner capability, with no public composition.

## Daily decision and stop

Hold the scheduled daily review on the current deployed source and current native
policy. Preserve the private dossier plus the explicit reviewer decision and
actual observations. An automatic hash check or an empty blocker list cannot
replace that decision. Incomplete or uncertain evidence prevents expansion.

For a failed drill, critical drift, stale/missing observations, unapproved source,
provider outage or loss of staffing, use the independently authorized close path
and investigate. Safety/support, payment reconciliation and deletion processing
retain their existing limited availability during a product cohort hold. Confirm
the actual close observation and native policy; do not infer containment from a
failed command or an old receipt. Each expansion requires new current facts,
complete bounded roster, request/version/expiry and explicit reviewed approval.
