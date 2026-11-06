# M9 implementation verification and launch handoff

Status: **private VPS deployed; owner MFA verified; controlled launch acceptance pending**.

## Current owner direction - non-payment test release

The owner chose a clean public user database while preserving the protected test
backup. Existing test profiles and balances must not be carried into that database.
Real payment implementation and the payment box are deferred. Instead, every
admitted user of the test version should be able to add internal test credits
repeatedly for free. This is a requested implementation, not an activated feature
or a claim that payment qualification has passed. Keep Stars purchases disabled;
do not create fake provider receipts or represent test credits as real money.
The previous one-time 100-credit question is superseded by repeatable free top-ups.
The owner also confirmed that `@NakhSupport` still needs setup; it is not yet a
working public support channel.

The source audit found unfinished customer surfaces beyond the backend milestone
tests: the canonical profile/settings menus, contextual credit access and Liked By
unlock presentation need actual bot wiring. Backend gates alone do not prove a
finished customer application. Complete these flows before final owner testing.

## Invoice-pause composition repair

Commit `23396fe` passed local checks but failed the native process-composition
case: the new invoice switch overloaded the existing Stars `enabled` field, so
signup interpreted paused invoices as a missing callback service. Do not accept
that failed head as a release. The repair retains `enabled` for callback-service
readiness and adds explicit `invoiceCreationEnabled` for menu/invoice admission.
Both composition requirements remain checked. The native process boots in paused
mode before executing the complete original invoice-enabled journey; unit
regressions retain missing-service and missing-invoice-service rejection. All six
exact-head CI jobs must pass before further feature work.

## Public-launch preparation - 6 November 2026

The owner expanded delivery from a completed private trial to public-launch
preparation, retaining the existing `@NakhTestBot` identity and choosing
`@NakhSupport` as the public payment/account/privacy contact. No second bot,
new service login, purchase, funded payment drill or unrestricted activation is
implied by that preparation request. One bot has one active delivery destination;
prepare an explicit held cutover rather than two competing webhooks. Existing
private trial identities, noncash credits and profile data must be reviewed before
any production migration or exposure.

Telegram requires a `/paysupport` entry for digital-goods merchants. The gateway
now recognizes it through the existing support route, with the same private actor,
original-life, throttling, replay and native support constraints. The actual
PostgreSQL/Redis tombstone-race case runs for both support commands. This first
entry increment does not change refund authority or banned/deleted-account rules.
An independent public contact route, reviewed purchase terms and explicit terms
acceptance are still required before accepting Stars; an ordinary support alias
alone does not qualify payments. See
[Telegram's official Stars requirements](https://core.telegram.org/bots/payments-stars).

The current private VPS operator explicitly accepts staging only. Public production
admission therefore needs a reviewed production deployment/operator procedure;
changing `NAKH_ENV` or removing the staging guard is not an accepted cutover.
The existing production AWS implementation remains available, but the owner chose
the existing low-cost VPS. No AWS provisioning or additional expenditure is
approved. Retained erasure and support-body release remain disabled pending the
previously required policies and approvals.

The independent public contact entry is opt-in through
`NAKH_PUBLIC_SUPPORT_TELEGRAM_USERNAME` (username only, without `@`; empty by default).
Once an approved working contact is configured, `/paysupport` returns only that
public handle/button before native product support or cohort admission. Private
sender/chat binding and independent ten-per-minute throttling still apply. It
does not create an account, grant or support thread, forward the submitted body,
or claim that a dispute has been filed. Ordinary `/support` and appeals retain
their native account-life rules. The owner-provided `@NakhSupport` contact still
needs confirmation of ownership and ability to receive private messages before
live activation. Failed public web access is not evidence that the contact is absent.

`NAKH_TELEGRAM_STARS_INVOICES_ENABLED` is a separate, default-off invoice creation
switch; it requires `NAKH_TELEGRAM_STARS_ENABLED=true`. With payment ingress on
and new invoices off, invoice preparation and delivery are denied before database
work while pre-checkout decisions, successful-payment replay and existing financial
obligations continue through their original native path. The native tests cover
both switch states, including concurrent paid retries after session revocation.
Do not disable the whole payment ingress to pause purchases with outstanding
provider obligations. Both settings and the public contact participate in the
exact release reference; no live payment activation or purchase-policy approval
is implied by this implementation.

## Private deletion and recovery checkpoint — 6 November 2026

After explicit owner approval, the private trial was held without discarding
Telegram updates, native admission was closed and all four application producers
were physically stopped. The six-job-green `2ffb1f6` host observer recorded two
matching actual-host observations. The same accepted application `1341139` then
restarted with ordinary deletion ingress/worker and real zone-scoped cache purge
configured. A fresh source/config review reported no blockers; policy 14 reopened
the two original tester lives plus a new eight-seat invitation at the original
6 November 12:26:36 UTC deadline. The new bound stop timer, actual webhook,
four-service readiness, original-life admission and unlisted-identity denial were
verified. The old invitation was invalidated by closure; use the new private handoff.

The owner supplied the new purge credential through the masked private entry form.
Cloudflare accepted a single unused-URL purge request; this does not claim a cached
photo was removed. A disposable R2 object passed upload/read/delete and separate
HEAD-absence verification. No real tester account was deleted by the operator.
The owner reports their tested product flows worked; the newly enabled deletion
journey remains separately unverified. Payments, Return/fresh entry, retained erasure
and support-body release remain disabled. This is private-trial activation, not M9
completion or public-launch qualification.

The final encrypted snapshot was copied off-host and authenticated, including its
actual drain receipt and reopened configuration. The next recovery implementation
is the [isolated backup restore tool](../../deploy/runbooks/private-vps-backup-restore.md).
It restores only authenticated database members into a disposable network-disabled
RAM-backed database, verifies the exact source migration ledger and withholds success
until cleanup is independently observed. Its synthetic tests are not an actual
snapshot restore, PITR, photo recovery or production DR acceptance. Execute its
reviewed bytes only after all six exact-source jobs pass and preserve the actual
result privately; the tool is independent of the running application release.

The first actual restore attempt withheld success before importing private data:
Docker rejected the kernel-only `noswap` tmpfs option. Cleanup and unchanged live
health were independently observed. The repair keeps equal positive memory/swap
limits and verifies the effective cgroup v2 swap limit is zero before and after
import. A real-container synthetic roundtrip, corrupt-import refusal and cleanup
are now required in the final CI job, with a separate non-authorizing artifact.
This fixture evidence does not substitute for the pending real backup observation.

## Dependency security maintenance - 6 November 2026

The inspected advisories are addressed by exact overrides for `fast-uri` 3.1.9
and 4.2.3, Fastify 5.12.6, glob 14.0.2 and minimatch 11.0.1; Vitest and its
coverage adapter move together to 4.1.12. The glob/minimatch major overrides are
restricted to the previously affected major lines. The archive and cleanup
consumers were exercised with synthetic files, including exclusions and preservation
of an unrelated file. Existing sign-in, API and release tests plus all six exact-source
CI jobs remain required. No advisory allowlist or package safety gate is relaxed.
An updated source lockfile does not establish deployment of the patched application.
The security revision `bec484d` passed all six CI jobs; a fresh full dependency
audit and GitHub alert refresh both reported zero current findings.

Actual reference capture on the existing image failed safely because its build
omitted `dist/cli/release-reference.js`. The package build now includes that
existing operator command. A compiled-command native rehearsal covers capture,
verification, changed-reference rejection, private file permissions, refusal to
overwrite a receipt and wrong-source rejection. This packaging fix does not
certify a successful live snapshot; capture and verify the installed revision
with its actual four service configurations after its six-job acceptance.

Restore repair `46e395a` passed all six jobs, including the real-container synthetic
roundtrip and refusal/cleanup rehearsal. Its ten ordinary CI artifacts and separate
source-bound rehearsal artifact were verified privately. The real encrypted backup
is still not certified restored: transferring its decrypted database members back
to the isolated VPS container requires the owner's separate approval. The fixture
never substitutes for that observation or for photo recovery/PITR qualification.

## Verified private trial checkpoint — 5 November 2026

Application `13411398e2597bab548f23bd9add01d5a365ca5c` passed
[all six CI jobs](https://github.com/aqaPayam/NakhBot/actions/runs/42022043319).
The ten source-bound artifacts were verified and preserved. Its archive SHA-256 is
`2fc87788c78fc14bf1270ce40891510226eacc3539f32189c98a7ff982f58662`: all 163 previously
applied CRLF migrations were preserved, migration 164 was applied, and the five
runtime-purpose permissions were provisioned before schema/role/compatibility and
four-service readiness verification. Both existing profiles and MFA were retained.
Encrypted snapshots before and after rollout were copied off-host and authenticated;
this does not claim a restore of those new snapshots.

The reviewed window admits the two owner-controlled accounts plus one eight-seat
shareable invitation, expires 6 November at 12:26:36 UTC and has its bound automatic
stop. Native invitation creation/replay, wrong-secret denial, existing-account
admission and unlisted-identity denial were observed. No synthetic tester was enrolled
to claim a real user journey. The owner subsequently reported that the flows they
tested worked and asked to continue implementation without routine supervised tests.
This is owner-reported acceptance of their tested flows; it does not identify or
certify separately unperformed funded payment, moderation, deletion/Return or recovery
drills. Payments, deletion/Return, retained erasure and support-body release stay off.

Actual configuration inspection found the deletion worker/ingress lack the account
control and confirmation keys, worker evidence-key references, deletion object-key
references, cache-purge credential and recorded producer-drain hash. The existing
ingestion object credential already passed upload/read/delete probes; no broader
bucket access is implied. The next independent preparation is the
[private VPS deletion cutover observer](../../deploy/runbooks/private-vps-deletion-cutover.md).
It is a separate host tool, not a new application release or deletion activation.
Its synthetic tests do not substitute for the required physical drain. The active
trial must not be relabelled as drained merely to supply a configuration hash.

Creating a zone-scoped Cloudflare cache-purge token and any service login remain
subject to the owner's access approval instructions. The existing
[Cloudflare purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/)
accepts `Cache Purge` permission and distinguishes accepted requests from proof that
content was cached or removed. Keep provider acceptance, object absence, current
media authority and independent native checkpoints distinct.

## Private-trial preparation update

The owner subsequently requested shareable access for new testers and private
ratings/comments, without supervised testing. Migration 164 adds an operator-created
staging invitation bound to the current source, bot, policy and its existing expiry.
The explicit members plus invitation capacity cannot exceed ten. Only a SHA-256
token hash is stored. A narrowly granted, token-checking database function consumes
one seat per user; concurrent joins, retries and policy closure share the existing
launch lock. Closing, expiry, deployment-source mismatch and Root/Return deny old
claims. Original launch-policy/member writes remain owner-only. No public mode or
production qualification is added.

After ordinary signup, the worker grants each invited account life 100 noncash
credits once. Native ledger writes recheck the original life and current invitation
authority under locks. Renewals and duplicate deliveries do not replenish credits.
Payments remain disabled. `/feedback 1` through `/feedback 5`, with optional comments,
uses the existing rate-limited private support workflow and its access, text-length,
idempotency and retention controls. It neither publishes reviews nor releases support
bodies. Trial notices use the existing English fallback.

The audit facts contain no token, profile, photo or comment content. There is no new
user-data table or foreign key: the deletion inventory accepts exactly schema 164
with its existing layouts, while valid original-life claim metadata remains fenced
and retained under the existing operational security policy. Retained erasure stays
disabled. Native fixtures cover the populated 163-to-164 upgrade, constrained-purpose
logins, twenty-way replay/capacity races, credits, real deletion/approved Return and
first-Start registration. Fixture/provider stubs are not real human acceptance evidence.
Deployment still requires the full check, all six exact-source CI jobs, a pre-migration
backup, runtime grant provisioning and a fresh bounded review. An owner's instruction
to proceed without supervised testing does not mark unperformed human journeys passed.

The first invitation candidate `e0675bc` passed quality, including `pnpm check`, but
failed native CI: existing populated-upgrade manifests and current migration/catalog
counts still described schema 163. The repair adds the exact new migration and three
catalog entries to those expectations and advances the unknown-future-schema probe to
165. Historical baselines, preserved-row comparisons and rejection assertions remain.
Review also adds rejection of unprotected pre-164 invitation facts, with native proof
that an attempted upgrade rolls back without deleting those facts or adding a ledger
entry. The failed candidate is not deployed; the repair requires its own six-job CI.

Application `541dfb10f79df98a88da0b588f258e0cc9c536c2` passed
[all six CI jobs](https://github.com/aqaPayam/NakhBot/actions/runs/41993354949)
and was deployed after schema, runtime-role and exact migration-byte checks.
Both owner-controlled accounts have now completed ordinary signup, with two
eligible photos each. The second signup recovered its saved answers after the
one-photo review repair. This is actual signup evidence; it does not establish
completed matching, chat, moderation or production launch drills.

The supervised window was intentionally closed early to prepare independent
private use. Its old timer was disabled after successful native closure and
transport hold, so it cannot accidentally stop a replacement window. This early
closure is not evidence that this particular timer reached its original deadline.
The owner requested independent preparation and subsequent testing with friends,
rather than supervised testing of each screen. Friend identification is deferred
until access is needed; unknown accounts remain outside the private cohort.

Background chat delivery needs the worker's existing notification and chat
switches. The worker may configure chat without configuring public signup;
gateway and other service configurations retain the signup requirement. Actual
worker startup still checks its database, localization, bot identity, navigation
key and Redis composition. This change neither enables delivery by default nor
opens a cohort. Deployment, fresh review, a bounded admission window and a bound
automatic stop remain necessary. Payments, retained erasure and support-body
release stay disabled. A private trial does not complete M9 launch acceptance.

## Historical initial private staging checkpoint

The deployed application is `3d227521a3e41512322c253c7e702e66ee58ecc7`, with
[all six CI jobs successful](https://github.com/aqaPayam/NakhBot/actions/runs/41856418428):
`pnpm check`, 1,529 unit cases in 276 files, and 1,505 native cases in 174 files
with zero skips. Ten source-bound artifacts were downloaded and verified.
Tracked lines at that application source were **296,972**. A later documentation
commit does not change the source labels of the four deployed images.

The owner chose a low-cost private VPS pilot instead of provisioning the original
AWS production plan. The VPS, owned domain/DNS/HTTPS, private R2 bucket, test bot,
five native database-purpose logins, private operator and health-transition
alerts now exist. Actual native authenticator activation and one audited browser
administrator sign-in were verified. Enrollment and sign-in are distinct from
product admission; expired staff sessions require normal reauthentication.

After explicit configuration and opening approvals, a fresh blocker-free review
authorized one original owner life on the exact deployed source. Native policy
version 2, actual Telegram webhook registration, authentication-negative HTTP
checks and admission denial for an unlisted identity were observed. Two old
owner setup updates were preserved privately and discarded with approval.
The original scheduled host timer subsequently completed successfully without
changing its deadline. Read-only post-closure checks observed native policy
version 3 closed with no cohort, authenticated webhook requests held with HTTP
503, unauthenticated requests rejected with HTTP 401, and the matching Telegram
webhook removed while preserving pending updates. The original opening receipt
remained recoverable after closure and review expiry. The owner's original
account life was unchanged and no longer admitted. This proves the scheduled
closure, not a completed product journey or permission to reopen the test.

The actual storage SDK probe uploaded/read/deleted its own test object and
verified absence; its anonymous request returned a non-success response without
the test bytes. An authenticated encrypted off-host backup was decrypted in PC
memory and its database dump streamed to an owner-only disposable database on
the original VPS. Recovery verified all 163 migrations, administrator identity,
active authenticator and activation audit, and archived credential-key references.
The scratch database was removed. The private backup key stayed on the PC; no
plaintext archive was written. This is schema/data recovery on the original
host, not PITR, offsite disaster recovery or runtime-role recovery qualification.
The live worker's configured ClamAV transport also accepted a clean sample and
detected EICAR; neither sample was ingested as user media or uploaded to storage.

There are still **zero completed real product canary journeys**. Authenticated
empty HTTP probes, local replay of approved setup commands, provider setup
responses and a blocker-free dossier do not substitute for a user sending a
fresh message through Telegram and completing the ordinary product flows.
Payments, retained-data erasure and support-body release remain disabled.
The owner will return for supervised testing; private evidence stays outside Git.

### Migration byte provenance

The deployed archive was exported from the reviewed Windows checkout. All 163
native migration hashes match that archive's CRLF files; they differ from an LF
checkout of the same Git commit. A clean source checkout with explicit
`core.autocrlf=true` is required to reproduce those deployed migration bytes.
Record the archive hash and checkout policy alongside the source SHA. A source
SHA alone does not establish identical packaged bytes.

Do not rewrite the applied ledger, normalize an existing release archive, or
disable exact migration checks to obtain a passing review. A later release
must preserve the reviewed bytes or use a separately reviewed migration of
the byte-provenance policy before rollout. Linux CI success does not establish
compatibility with this existing CRLF ledger. Private reference capture and
verification remain observations; neither approves the reference values nor
qualifies production.

The historical audit below preserves the original production requirements.
It must not be read as saying that the already-prepared private pilot resources
are absent or that AWS purchases are required to perform the owner-only VPS test.

The low-cost private staging VPS preparation now has a separate
[read-only readiness boundary](40-private-vps-readiness.md). It observes the
reviewed Linux host and native database without AWS credentials and cannot open
a cohort or qualify production. This does not replace the original launch
requirements or the protected operator's opening approval.
This audit uses the five original M9 requirements in
[the implementation plan](13-implementation-plan.md), preserving the
[M8 handoff scope](32-m8-acceptance-evidence.md). It supersedes historical
remaining-work estimates in the M9 execution guide. It does not close M9 or
authorize deployment, cloud charges or real-user traffic.

## Historical implementation baseline and evidence boundary

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
| Create production infrastructure, secrets, bot, webhook and R2 | Shared runtime plus separate inactive production/bootstrap roots, guarded production deploy/rollback workflows, source/image attestations, signed archive/custody protocol, drain/migrate/role/compatibility admission, held activation and scaling restoration. Database-purpose isolation is mandatory in production. Native/compiled-host, protocol, image and mocked-IaC cases cover these controls. | The private VPS, domain/DNS/HTTPS, test bot, R2 and native TLS/purpose roles now exist; see the current checkpoint. The original AWS production account/region/IAM/OIDC path remains unqualified. Complete actual production custody, provider journeys, drain, failover/PITR/DR and rollback acceptance for the selected production architecture. |
| Run synthetic canaries and moderation/payment drills | Ordinary gateway/API/worker composition and native host suites cover signup/profile/media, discovery/interactions/Nakh, chat/relay/reporting, Stars/correction/refund, admin MFA/evidence, support/appeal and deletion/Return paths. The source-bound review procedure specifies supervised provider journeys and required private evidence roles. | Designated testers must execute the real deployed bot/provider journeys, moderation/permission/MFA and separately approved funded payment/refund drills. Preserve actual native/provider/audit outcomes, including replay and failure/recovery evidence. Test transports do not satisfy this item. |
| Launch a small cohort, observe support/safety/capacity and expand gradually | Migration 163 and native cohort/gateway suites prove immutable audited manifests, exact source/environment/bot and original-life grants, expiry, concurrent CAS/idempotency, owner/runtime denial, Root/Return fencing, indexed admission and limited safety/financial/privacy availability during holds. The private operator requires exact principal/secret/database admission and approved command digest. Reviewed CLI openings require a fresh dossier, including deadline checks after native locks; closing and read-only receipt recovery remain independent. | Approve real operators, private ACLs, roster/lives, stop plan, source/config and explicit release. Execute the initial synthetic-only canary plan, then accept completed drills before public cohort/expansion. Observe actual support, safety and capacity; demonstrate stop and recovery. A one-owner private canary policy and webhook were opened with explicit review approval; completed real product journeys, public release and expansion remain unaccepted. |
| Hold daily launch review until error budget, payments, safety and deletion are healthy | Native health reuses the existing safety/deletion samplers in a read-only repeatable snapshot, plus four latest reconciliation probes checked at 20,000 rows under 1,500 ms. Review code binds exact intent/audience, native facts, attachment bytes/roles/times and expiry. Unit/native/compiled-CLI cases reject missing/stale/changed references and verify non-authorizing results. Historical findings remain distinct from current drift. | Review actual error-budget denominators/burn, capacity, metric freshness, alert delivery, reconciliation and dispositions, safety/support queues, deletion/provider completion, staffing and security/privacy sign-offs on the deployed source. Hashes, empty blockers and native metadata do not authenticate external records or replace the human decision. |

The source audit found the implementation tools for each original requirement.
The remaining acceptance actions in the right column are not satisfied by the
partial private-pilot observations above. M9 is
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

This was the preparation list for the original AWS production path. The owner
subsequently prepared the VPS, Cloudflare/R2, domain and test bot described in
the current checkpoint. Separate production infrastructure/bot decisions and
their actual qualification remain outstanding. This historical list does not
authorize purchases, production release or expansion beyond the reviewed pilot.

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
