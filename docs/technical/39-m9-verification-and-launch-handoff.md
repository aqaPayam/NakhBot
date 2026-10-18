# M9 implementation verification and launch handoff

Status: **implementation tooling verified; actual controlled launch not accepted**.
This audit uses the five original M9 requirements in
[the implementation plan](13-implementation-plan.md), preserving the
[M8 handoff scope](32-m8-acceptance-evidence.md). It supersedes historical
remaining-work estimates in the M9 execution guide. It does not close M9 or
authorize deployment, cloud charges or real-user traffic.

## Verified source and evidence boundary

The verified implementation baseline is
`ce1cbabbe8d6edb4f6cfbea375f17d8955fc4c3d`, with
[all six CI jobs successful](https://github.com/aqaPayam/NakhBot/actions/runs/39142428165).
It passed `pnpm check`: 1,489 unit tests in 273 files, types, lint, format and
build. Complete native coverage passed 1,479 tests in 172 files, zero skips,
with four disjoint receipts bound to that source, run and attempt.

All 27 original query plans passed at scale 20,000 and maximum 1,500 ms. The
terminal snapshot took 1,332.440 ms, with the required indexes and zero workers,
JIT or spill. Shared support load accepted 10, denied 90 and replayed 100;
backup/restore passed. Actual pinned collector conversions covered 13 M7 metrics
and ten phases plus 13 M8 metrics and eight phases. The actual pinned scanner
transport accepted clean content and rejected EICAR. Four images passed source,
non-root and CLI checks. These are CI/container/local-native observations.

Downloaded archive SHA256s were independently checked:

| Source-bound artifact prefix | ZIP SHA256 |
|---|---|
| `postgres-integration` | `5cbcab1894a07d39005b862f527f8792cb790c03a27069fff865fc56c999a804` |
| `m7-performance` | `8171f4056c2920b94fad868050585f2715149fed3505585506b9f11e6e03c58c` |
| `m7-telemetry` | `251603531004be0f49f27fcfcecc6f3002ad273d7bc91d4ee91df3dd7425d25f` |
| `m8-telemetry` | `8f3dc2fd96fa8bc512d45abe367071a7abdfb0a49a7bec125ac0916e072dc672` |
| `m9-scanner` | `32678ef66be13d955d5ea75d2cd9b8b35279db0ed1320cd5b200d06f1482754e` |
| `m9-infrastructure` | `0c37b4160d0d9cb86af4cbfd79fbf267f24f9e7ff99ae0f24dc94863d71fbc2e` |

Each artifact name appends the full baseline SHA. The release archive reader also
downloaded and inspected the four native/performance/telemetry ZIPs through the
actual GitHub adapter. This does not prove S3 custody, AWS signatures, real IAM
permissions, CloudWatch/SNS delivery, Telegram/R2 behavior or operator acceptance.
The infrastructure proof covers 138 state moves and zero infrastructure changes
under mocked AWS; the 19 production-bootstrap scenarios are also AWS-mocked.

Tracked lines at that baseline were **293,738**, summing every `total` chunk from
`git ls-files -z | xargs -0 wc -l`. A later revision, including this documentation,
requires its own `pnpm check`, push and six exact-head CI jobs before acceptance.
CI artifact retention is fourteen days; preserve actual release evidence privately
through the reviewed archive procedure before it expires.

## Original requirement audit

| Original M9 requirement | Implementation and inspected automated evidence | Actual acceptance still required |
|---|---|---|
| Seed/verify production catalogs, UI text, prompts, prices/config and administrator roles | `release-reference.ts`, its private CLI and five native cases capture every declared reference category and migration checksum in one read-only repeatable snapshot. They detect text/prompt/price/activation/role drift, preserve exact bigint prices and prove concurrent snapshot consistency. The config projection rejects unknown leaves and excludes secret material. | Capture and review actual production reference inputs separately for all four services, seed only approved values and role assignments, and verify the exact reviewed snapshots. A fixture or new capture is not approval. |
| Create production infrastructure, secrets, bot, webhook and R2 | Shared runtime plus separate inactive production/bootstrap roots, guarded production deploy/rollback workflows, source/image attestations, signed archive/custody protocol, drain/migrate/role/compatibility admission, held activation and scaling restoration. Database-purpose isolation is mandatory in production. Native/compiled-host, protocol, image and mocked-IaC cases cover these controls. | Owner accounts/regions, budget/capacity, actual domain/DNS, bot/R2 and secrets are absent. Qualify actual least-privilege IAM/OIDC and native TLS/roles; execute reviewed infrastructure plans, real custody, provider health, drain, failover/PITR/DR and rollback observations. |
| Run synthetic canaries and moderation/payment drills | Ordinary gateway/API/worker composition and native host suites cover signup/profile/media, discovery/interactions/Nakh, chat/relay/reporting, Stars/correction/refund, admin MFA/evidence, support/appeal and deletion/Return paths. The source-bound review procedure specifies supervised provider journeys and required private evidence roles. | Designated testers must execute the real deployed bot/provider journeys, moderation/permission/MFA and separately approved funded payment/refund drills. Preserve actual native/provider/audit outcomes, including replay and failure/recovery evidence. Test transports do not satisfy this item. |
| Launch a small cohort, observe support/safety/capacity and expand gradually | Migration 163 and native cohort/gateway suites prove immutable audited manifests, exact source/environment/bot and original-life grants, expiry, concurrent CAS/idempotency, owner/runtime denial, Root/Return fencing, indexed admission and limited safety/financial/privacy availability during holds. The private operator requires exact principal/secret/database admission and approved command digest. Reviewed CLI openings require a fresh dossier, including deadline checks after native locks; closing and read-only receipt recovery remain independent. | Approve real operators, private ACLs, roster/lives, stop plan, source/config and explicit release. Execute the initial synthetic-only canary plan, then accept completed drills before public cohort/expansion. Observe actual support, safety and capacity; demonstrate stop and recovery. No cohort has been opened through real providers. |
| Hold daily launch review until error budget, payments, safety and deletion are healthy | Native health reuses the existing safety/deletion samplers in a read-only repeatable snapshot, plus four latest reconciliation probes checked at 20,000 rows under 1,500 ms. Review code binds exact intent/audience, native facts, attachment bytes/roles/times and expiry. Unit/native/compiled-CLI cases reject missing/stale/changed references and verify non-authorizing results. Historical findings remain distinct from current drift. | Review actual error-budget denominators/burn, capacity, metric freshness, alert delivery, reconciliation and dispositions, safety/support queues, deletion/provider completion, staffing and security/privacy sign-offs on the deployed source. Hashes, empty blockers and native metadata do not authenticate external records or replace the human decision. |

The source audit found the implementation tools for each original requirement.
The actual actions in the right column remain unperformed or unverified. M9 is
therefore not complete. Provider qualification can expose concrete defects; fix
them through the same checked-commit/six-job process rather than pre-certifying
untested behavior or adding unrelated business modules.

## Owner preparation, in order

1. Prepare an AWS account for staging with full account/region/IAM control, then
   a separate production account. For this Terraform deployment, use the account
   configuration supported by AWS's
   [advanced signup guide](https://docs.aws.amazon.com/accounts/latest/reference/getting-started.html);
   see its [signup comparison](https://docs.aws.amazon.com/accounts/latest/reference/sign-up-for-aws.html)
   for available service and region controls. Use the provider's account/MFA and
   administrator setup procedure. Initial information needed here is only the
   twelve-digit account IDs and intended region; no credentials belong in chat.
2. Prepare a Cloudflare account and the intended R2 subscription using the
   [official R2 setup guide](https://developers.cloudflare.com/r2/get-started/).
   Supply the account/zone identifiers and intended separate environment buckets.
   Bucket access, cleanup, private evidence custody and purge credentials will be
   scoped separately in protected provisioning. R2 activation/usage has its own
   provider billing; it is not authorized by a successful source build.
3. Select the owned domain and intended staging/production API, webhook and media
   hostnames. Review DNS/Route53/Cloudflare delegation before changing nameservers
   or creating resources. If the domain is not registered, agree the intended
   name and purchase separately; no registrar or purchase has been selected here.
4. Create separate test and production bots through the official
   [BotFather procedure](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).
   Supply bot usernames/identities initially. Deliver bot tokens and webhook secrets
   only through the reviewed private secret/GitHub environment procedure.
5. Agree the initial tester/cohort forecast, region, capacity, monthly budget,
   alert destination and staffing. Review current regional costs and the complete
   concrete Terraform plan before explicit authorization to create billable
   infrastructure. Budget-alert settings are not a price estimate or approval.
6. Approve operator identities, real production deployment policies and exact
   environment OIDC trust. The production bootstrap has no default permission set;
   use observed staging operations and IAM Access Analyzer as described in its
   README, then qualify actual least privilege. Review protected GitHub environments,
   permissions boundaries, state/evidence custody and private operator access.

The owner has said none of these accounts/bots/domain are prepared yet and will
prepare them when requested. Preparation can now begin while the final handoff
revision is verified. This checklist requests setup information; it is not an
authorization for an infrastructure apply or real-user release.

## Release sequence and outstanding evidence

Use [production bootstrap](../../deploy/terraform/production-bootstrap/README.md),
[production infrastructure](../../deploy/terraform/production/README.md),
[purpose isolation](36-m9-database-purpose-isolation.md),
[trusted administrator provisioning](34-m9-trusted-operator.md),
[cohort operations](37-m9-cohort-operator.md) and
[canary/daily review](38-m9-launch-review.md) as the concrete procedures.

After the owner inputs and reviewed plans exist, obtain the specific deployment
authorization, provision staging and qualify real IAM/TLS/provider/custody/drain/
alert/DR behavior. Capture and verify the actual reference/config/role inputs.
Run the scoped synthetic canary and moderation/payment/deletion-Return drills;
resolve failures and preserve reviewed evidence. Only then approve a concrete
production plan, actual production qualification and the exact small-cohort
opening. Each expansion needs a new current roster/version/expiry, dossier,
explicit approval and real observed health. Preserve daily decisions and use
the independent close path for failed or uncertain conditions.

The M8 external privacy/security, recovery and provider obligations remain
applicable. Retained-data erasure and the support-body release remain disabled;
no retention periods are invented, and implementing all 34 retained-resource
erasure adapters is outside the owner-approved implementation scope. Ordinary
product deletion and retained manifests retain their existing separate behavior.
