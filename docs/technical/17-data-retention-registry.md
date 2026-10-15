# Data Retention and Deletion Registry

This registry is mandatory for every user-linked table or object prefix. It records the product-deletion action independently from PostgreSQL foreign-key behavior. The deletion workflow is implemented in M8, with M7 owning moderation/evidence decisions; new migrations must update this file immediately.

## Policy attestations and immutable manifests

Migration 145 reuses append-only administrator and account audits. It changes no
table/column/foreign-key inventory, original manifest or registry hash. Only super
administrators with current native MFA can attest an explicit resource's retention
period for an original completed deletion, or revoke it. The basis is that
original deletion's completion time; there is no default or seeded period.
Evidence is a digest of the separately approved policy, never its prose.

Revision, command/request digest, original Root/manifest, session and transaction
bindings are validated natively. Active policy replacement requires prior
revocation; history survives a separately approved Return. These minimum lifecycle
facts follow the existing audit policy and are not product credentials, unban
authority or release receipts. No periods are approved for deployment. Release
stays disabled and manifest update/deletion guards remain unchanged. Exact
original-row ownership and dependency/proof preservation remain prerequisites.

## Incoming foreign-key review before release

One original captured source can be reviewed under the same transaction as its
current policy. Only an elapsed approved period proceeds to an exact PK row lock
and complete original hash check. The reviewed current catalog supplies incoming
FK column pairs, including composite constraints. Any referencing child resource
is a blocker, independent of its participant/owner or FK delete action. No cascade,
reference detachment, content copying or retained-row mutation is performed.

The parent lock also fences native FK key-share admission for that transaction.
A returned observation is not a lease or release permission. Missing FKs do not
clear logical/shared custody, provider, legal or safety obligations; all remain
part of the actual release protocol. Release stays disabled and no retention
period is approved or seeded by these controls.

## Original retained-source fingerprints

Migration 146 adds no inventory rows or approved periods. During the owning
manifest phase, the worker captures at most ten exact source memberships per
transaction for the 34 approved-policy-release resources. Append-only account
audits retain only original manifest/registry identity, primary-key and complete
row hashes, and exact native lease/transaction proof. Raw keys and contents are
not copied. The checkpoint waits for uncaptured sources, and both insertion and
deferred commit verify the source and current native fence.

A changed row fails its original fingerprint; history is never refreshed from a
later life. Completed legacy Roots are not backfilled. Source membership is a
prerequisite, not a release receipt, approved policy, dependency disposition or
permission to mutate retained data. Physical release remains disabled and must
separately recheck policy, ownership, dependencies and preserved proof at mutation.

## Original-manifest period review

Internal planning checks the exact original completed deletion and manifest,
serializing with policy revocation and Return. Only the latest valid approval
and its valid revocation history determine whether a database-clock period has
elapsed since original completion. Missing approval, revocation and an unelapsed
period remain distinct. Every result keeps release disabled. This review does
not select retained rows, resolve dependencies, create a release lease or grant
permission to mutate retained data. No policy periods are approved or seeded.
Original ownership and the actual mutation-time policy checks remain required.

## Opaque cache cutover namespaces

The old global `{prefix}:action:*` namespace has no authenticated ownership index.
Retire it globally after draining pre-cutover runtimes; never open encrypted bodies
to assign them to a deleting user. A permanent `{prefix}:legacy-action-retired`
fence blocks current-code v1 compatibility writers and readers. Remove at most 100
values per audited batch, then run a separate complete physical absence scan.
Prepared authorization without an observation remains uncertain, not completion.

Current unowned administration/retained-safety UI references use
`{prefix}:action-v2:*`, with the existing purpose-specific byte/lifetime bounds and
no fallback to v1. Product-user references must use the existing owner/epoch-bound
`{prefix}:owned-action:{ownerHash}:{epoch}:value:*` stores. Global retirement does
not remove those current values, native workforce sessions, roles, MFA factors,
financial facts or retained safety proof. Minimal permanent lifecycle fences must
not expire or be removed by ordinary cache cleanup.

The global cutover reuses append-only security audits for authorization and
observation. Only namespace/cursor hashes, batch bounds, actual removal counts,
finite progress flags and audit identities are retained. No key roster, cache body,
user inference or provider endpoint enters these facts. They follow the existing
security-audit policy; no retention duration or controlled-release approval is
invented. Root ephemeral completion still requires its own authenticated proof.

## Native user session security facts

Original-life HTTP sessions reuse append-only `platform.audit_logs`; no new
user-linked table, column or object prefix is introduced. Issuance facts retain
only the session grant identity, actor/subject, original product epoch, native
issue/expiry time and command/request identity. Revocation facts reference the
grant and have empty metadata. No bearer, bearer hash or primary-factor proof is
retained. These security facts remain subject to the security-audit policy;
fifteen-minute credential expiry is not approval to purge their audit history.
Retained-data release stays disabled pending approved periods. Account tombstones
and epoch changes immediately deny use; bounded Root sweeping and independent
ephemeral completion evidence remain separate requirements. Workforce grants keep
their independent MFA/RBAC policy.

## Executable catalog inventory

Migration 134 adds only a partial covering index for succeeded, user-targeted
administrator account-action proof. The inventory remains 150 tables, 1,381
columns and 298 foreign keys. Exact actor/command, request/digest and target
bindings remain mandatory; the index adds no retained data or release authority.

Migration 133 preserves original Liked By delivery ownership through an immutable
account epoch. The inventory now covers 150 tables, 1,381 columns and 298 foreign
keys. Native identity resolution freezes that epoch before asynchronous ingress;
admission rejects a tombstone or mismatched life. Legacy requests are assigned
zero only when their known owner still has the initial life; ambiguous ownership
aborts migration. The transport remains subject to bounded cancellation/purge,
without granting phase completion, retained-data release or approved Return.

Migration 128 changes only product-write lock ordering; the inventory is unchanged.
Its derived Chat cleanup exemption requires the existing nondeferrable live-Chat FK.

Migrations 126â€“127 cover 144 tables, 1,333 columns and 282 foreign keys.
The sole new column links minimum ordinary outbox transport to an immutable
cancellation audit; it defaults to NULL for every existing event. Code-owned
shape policy rejects unknown/prose-bearing payloads, preserves financial,
safety and lifecycle channels, and cancels bounded ordinary publication under
an authenticated current deletion lease. The product checkpoint verifies actual
absence, original source proofs, zero-credit cutover and minimum operations.
Original references scope children after parent body removal. It advances only
to media verification; provider/ephemeral cleanup, policy manifests, completion
and fresh Return remain required. Retained-data release stays disabled.

Migrations 123â€“125 bring the inventory to 144 tables, 1,332 columns and 281
foreign keys. Six-field notification references preserve only original recipient
life, type, empty-payload qualification and an optional exact threshold episode;
ten-field removal receipts bind root, full transaction, lease and audit/event.
No payload, template/dedup text or provider receipt is copied. Historical safety
facts remain inaccessible to normal notification rendering and delivery.
System-owned registration response scope includes its typed `context.userId`.
Own cached response bodies and expired media authority are bounded phase-3
resources 9â€“10; current media expiry remains mandatory. Provider receipts and
global typed operational policy still require their later phases. Retained-data
release and fresh Return remain disabled.

Migrations 121â€“122 bring the inventory to 142 tables, 1,316 columns and 276
foreign keys. Original Match references add only both participant epochs.
Historical pair uniqueness is scoped to those lives. The ten-field ordinary
pair removal receipt binds the original Match, root, transaction, lease and
mandatory audit/event; no raw pair state, reason, time or version is copied.
Active administrator blocks remain safety facts. Historical Unmatch proof can
survive ordinary pair removal without granting a later-life product action.
Retained-data release and fresh Return remain disabled.

Migrations 119â€“120 bring the inventory to 141 tables, 1,304 columns and 273
foreign keys. Original unlock references retain eight financial identity/life
fields; audited owned-grant removal retains ten transaction, lease and audit
bindings. Neither retains grant status, times, revocation prose or administrator
data, nor grants product access. Deleted payers' access projections can be
removed while exact original finance remains linked; the other payer's history
stays ineffective. Controlled retained-data release remains disabled.

Migration 118 brings the executable inventory to 139 tables, 1,286 columns and
265 foreign keys. Its ten-field referenced Like removal receipt binds the
original identity/lives, deletion root, full transaction, lease and audit/event.
No Like status, creation/closure time or content is copied. The original paid
unlock and financial rows remain; the unlock Like FK now targets the minimal
original reference and is checked at commit after reference creation. New unlock
insertion still requires the live original Like. Referenced Like removal is
audited under a current phase-3 lease, without whole-product completion or Return.
Retained-data release remains disabled.

Migration 117 added the ten-field Flow archival receipt retaining only original
reference, deletion, transaction, lease and audit/event bindings. Migration 116
added the five-field original Flow reference (ID, participants and their lives).
Neither retains Flow creation time or product content, grants return, completes
product purge or enables policy release. Retained-data release remains disabled.

Migration 115's terminal unpaid archival receipt brings coverage to 136 tables,
1,261 columns and 257 foreign keys. It retains the original terminal status,
version, expiry, terminal time and cancellation resolution with the deletion,
transaction, lease and audit/event bindings. It contains no message body or
request/action hash. The same lifecycle policy requires approved release; release
remains disabled. Applying this migration does not authorize whole-purge completion
or fresh Return. Native acceptance passed 330 tests across 23 suites and the
additional overlapping capture/archival race. The full project check passed;
all six exact-head CI checks remain required.

Migration 114 brings the code-owned inventory to 135 tables, 1,246 columns and
254 foreign keys. Its new immutable paid-pending archival receipt retains only
original identity, terminal scalars, transaction/lease bindings and audit/event
references. It retains no message text or request/action hash. Policy-approved
release remains disabled. Original financial records, participant references,
Flows and lifetime preview usage are preserved.

Migration 112 adds original pending-funding identity references; migration 111
adds bounded delivered-Nakh archival receipts. Migration 113 strengthens their
original funding proof without changing catalog counts. None grants a fresh
product life, whole-purge completion or retained-data release.

Migration 103 adds a derived read-only support closure proof view and reuses it
in the historical helper. It creates no retained entity or new user data; the
130-table inventory and deletion policies remain unchanged. Live lease and
commit authority, retained transcript access and disabled release are preserved.

[`deletion-registry.json`](../../packages/persistence-postgres/src/deletion-registry.json) is the
code-owned M8 catalog inventory for migration 120: 141 tables, 1,304 columns and 273 foreign keys.

Migration 109 binds notification history to an immutable original recipient epoch.
Legacy history is accepted only with provable original epoch zero; ambiguous
ownership fails the upgrade atomically. New notices are stamped under the recipient
lock, including durable financial corrections while deleted. Read-only Like/Match
views require current original participant lives before product delivery. Terminal
closure notices retain their survivor exception, while cached history cannot borrow
a later recipient life. Already admitted provider outcomes keep their original
settlement fence. No retained entity, release policy or return path is enabled.

Migration 108 removes at most the two closed, unreferenced Likes of one canonically
locked pair under the original phase-3 deletion life and an unexpired lease. The
required content-free audit/event commits with removal; captures are rechecked at
commit. Any minimal reference, Match or paid-unlock source blocks removal. Original
foreign keys, financial facts, safety captures and pair state stay intact. No new
retained entity is created, and this does not complete product purge or enable return.

Migration 107 rejects legacy Nakh funding from a different original sender life
and requires that credit/payment/intent ownership proof at native deferred commit.
It adds no table or copied financial fact. Existing complete funding, captured
receipt, unique spend, immutable ledger and source-reference guards remain.
Historical funds are not rebound to current Accounts. No source archival, reset,
return or retained-data release is enabled.

Migration 106 adds minimal original funded Nakh references: source ID, flow ID,
both original participants and their owning lives. Native source creation requires
the exact reference at commit; references cannot be reassigned or released, and
retired source IDs cannot be reused. No prose, status, deadline or funding amount
is copied. All live-source foreign keys, ledger proof and product read authority
remain unchanged. This prepares archival dependencies without enabling archival,
purge completion, return or retained-data release; approval is still required.

Migration 105 adds immutable original sender/receiver lives to Nakh flows without
changing existing text, deadlines, status, funding or quota facts. Ambiguous
legacy owners reject migration. Native flow and source admission lock identities
then Accounts and require those exact current lives; pending funding proof remains
deferred until commit. A derived current-life view supplies product reads and
notifications. Command replay and delivery settlement also require original lives.
No new retained entity, source archival, purge completion, fresh return or retained
release is authorized by these fences.

Migration 104 binds each Like to both original account lives. Only Likes used by
a Match or paid unlock receive a minimal reference containing their original ID,
participants and epochs. Unreferenced Likes have no retained reference. Native
checks require the exact referenced source when the reference commits; reference
changes/deletion and source-ID reuse are denied. Existing live-source foreign
keys remain unchanged, so this preparation cannot authorize product archival or
grant access. Reference release needs approved policy and remains disabled.

Migration 102 binds support threads to their immutable original product epoch.
Its phase-3 executor closes at most one original open thread per transaction and
preserves every retained message. Immutable closure receipts require the exact live
deletion lease, source version/metadata and content-free audit/event at actual commit.
Historical integrity accepts only a fully bound worker closure or the existing
administrator close proof; required access auditing remains unchanged. User replay,
message admission and administrator mutations cannot borrow another product life.
Ordinary deletion never releases retained transcripts or completes the whole purge.

Migration 101 preserves each original credit projection in its product-epoch namespace,
with every original ledger row and financial timestamp unchanged. Only a live phase-3
deletion worker may prepare the next zero-balance projection through an immutable,
audited closure. Its original Account remains deleted in the original epoch; preparing
credits does not complete deletion or authorize return. Deferred checks bind the closure
to actual commit authority and its audit/event. Financial history is never purged by
this cutover; retained-data release remains disabled pending approved policy.

Migration 100 binds each deletion record to the original product epoch stamped from its
locked owning deleted Account. Legacy records keep every original field and gain epoch
zero; unexplained prior return or mismatched pending owner authority rejects upgrade.
The epoch is immutable and one deletion root owns each user/product life. Pending
deletion and Account authority must still agree at actual commit. The existing return
guard selects that exact original epoch and keeps its completion, explicit approval and
safety requirements. No balance reset, later-phase completion, return or retained release
is enabled by this binding; financial epochs and the complete registry verifier remain required.

Migration 99 adds original product-life provenance to CreditAccount and CreditTransaction.
Existing financial fields remain unchanged and both new fields are epoch zero. Stable
financial projections cannot be deleted or rebound, and new credit requires the current
active owning Account, matching projection epoch and original payment/intent owner and
epoch where applicable. Authority is checked again at actual commit. Original Stars
refund obligations remain on their existing separate route. Delayed settlement requires
its positive credit event, sender and pending intent to belong to the same product life.
This is a write/provenance fence; epoch-specific balance partition, controlled projection
reset and verified fresh return remain required. No financial record is purged or retention
approval inferred, and retained-data release remains disabled.
Every column inherits its table's explicit classification/action, and every foreign-key target and
delete/defer action is recorded. There is no default classification for a new table or column.
The native coverage gate rejects new, removed or changed columns, types/nullability and foreign-key
actions before a deletion worker observes the resource. Schema references are fully qualified and
independent of PostgreSQL's search path. Future migrations must update and review this inventory.

The bounded worker observer checks one resource under its exact live deletion lease, using a
code-owned, parameter-bound subject selector. It returns presence only, never rows, content,
storage keys or identifiers. Related rows follow their governing Report/payment/relationship,
rather than an unrelated participant's identity. This inventory is not a purge executor: retained
source archival, dependency release, lifecycle/financial epoch fences and provider absence remain
separate obligations. Globally typed transport/audit/reconciliation obligations without a complete
subject selector return **unknown**, never absence; a linked-row presence observation is not proof
that every polymorphic reference has been resolved. Public catalogs and workforce authority have
their own actions and cannot become ordinary product purge by inheritance. The four object-prefix
descriptors record object obligations; they do not claim provider verification or Redis coverage.
No policy period is invented and retained-data release remains disabled until approval is supplied.

Migration 98 introduces short-lived opaque media-delivery receipts bound to the original
actor/owner product epochs, Photo, asset, variant and Like where applicable. Tombstones
revoke source authority immediately; source identifiers do not prevent ordinary Photo/Like
archival through live product foreign keys. Immutable unexpired receipts cannot be rebound
to a newly actionable source. Expired receipts may be purged as operational bearer authority,
under their existing maximum five-minute grant lifetime; this is not a retained-data period.
The native/API/edge graph and complete concurrency evidence remain required before this
candidate is verified. No moderation-evidence or retention-policy bypass is introduced.

Migration 97 adds explicit initial product epochs to Account and payment intent. Existing rows
remain epoch zero; neither timestamps nor provider transport infer a later product life. Intent
ownership is immutable, admission locks the current active Account and an unverified return is
rejected. Account deletion cannot be bypassed by deleting and reinserting its stable lifecycle row.
Captured package payments remain original-payer financial obligations after deletion. Fulfillment
requires the owning active epoch or one exact original-payment refund and correction event; lease
expiry is checked again at commit. This is an intent/fulfillment fence, not ledger epoch partition,
product-purge completion, fresh-return approval or a retention period. Those obligations remain open.

Migration 95 extends only the immutable phase-receipt transition from evidence capture to ordinary
product data; it adds no table, column or foreign key. The transition requires authenticated current
capture receipts, verified source absence and closure of original survivor reporting windows,
including captures committed while its Account lock was waiting. It rechecks those obligations at
commit and recognizes the one original shared-source receipt if both participants delete. It does
not mark ordinary product purge, provider absence, retention release or fresh return complete.

Migration 96 adds a deferred commit fence for nonempty ordinary-product batch audit/events;
it changes no table, column or foreign key. The internal phase-3 sweep covers signup drafts/progress,
ExploreFilter with its required gender selections, candidate deliveries, ExploreConsumption,
NotInterested, notification preferences and User settings. Resource numbers 0..7 are append-only
and code-owned. Each transaction removes at most 100 rows, including filter selections and parent.
Large filter groups leave at least one required selection until the final selection and parent can
be deleted together. The exact current deleted Account, root, phase, lease owner/generation/expiry, original command/request
and matching content-free audit/event are required at commit. Empty retries write nothing.
Committed row absence supports restart independently of expired transport; no product body or
provider identifier is put in these batch records. Remaining financial, Nakh/Like/unlock, notification,
support, media and polymorphic operational dependencies still require their owning executors and
proofs before whole-product completion. Neither a finished sweep nor `hasMore=false` grants a phase
advance, product-purged milestone, completion, retention release or fresh return.

The Redis rows below name logical server-owned keys. The production adapter preserves
short public actions at `{queuePrefix}:action:{opaqueId}` and stores the reviewed
internal UI formats at `{queuePrefix}:action:internal:{sha256(logicalKey)}`. Internal
logical references are never physical keys and cannot alias public actions. Existing
support/ban/report UI receipts and delivered rejection acknowledgements expire within
24 hours; administrator queues, encrypted drafts and decisions expire within five
minutes (pending rejection claims within 30 seconds). First allocation never refreshes
TTL. Native permissions, source ownership and explicit encrypted expiry remain
authoritative. UTF-8 limits match the existing envelope budgets; unknown logical
formats and oversized cache state fail closed. Deletion-time product token invalidation
remains a separate required M8 executor; these expiry rules are not its completion proof.

The M8 owning adapter stores account-life values separately at
`{queuePrefix}:owned-action:{sha256(userId)}:{productEpoch}:value:{referenceDigest}`.
Values retain their original native TTL and byte limits. Its bounded hash index
contains only physical reference keys; its minimal lifecycle marker fences stale
reads/writes and survives body cleanup. Both use the same User hash tag. Removal
requires an independent complete physical-namespace sweep, including unindexed
orphans; an empty index or a write-fence check alone never proves completion.
The native worker must supply original lifecycle authority and resume the scan
cursor. Legacy migration/runtime binding and separately approved fresh-return
activation remain required before M8 ingress can be enabled.

Photo-management callbacks and menu issuance now use that owning namespace with
an independent User/epoch-bound signature. The native adapter captures original
life before asynchronous reads; Profile/media access and command receipts require
that same life under User/Account locks. Menu delivery retains the collection's
captured life across catalog/provider waits. Unscoped old callbacks and legacy
receipts without a life binding fail closed; their physical legacy caches still
require the independently verified sweep. No new table, retained-data policy,
release permission, deletion completion or approved Return is introduced.

The actual Telegram safety-contact producer also freezes native life before
rate-limit/handler waits and uses independent life-bound support/ban reference
signatures in the owning namespace. Native contact metadata, support admission
and exact-ban preparation/submission require the captured epoch; tombstones and
mismatches deny appeal replay before returning retained results. Existing safety
history remains lifetime evidence, not ordinary data scoped away by a new epoch.
HTTP/session binding, legacy namespace absence and complete ephemeral receipts
remain required before deletion completion or approved Return can be enabled.

Production domain-event jobs now contain a bound outbox reference (event ID/type/
schema and original aggregate type/ID), not the event payload. Consumers validate
canonical PostgreSQL facts before dispatch and normalize validated legacy bodies
before application processing. Financial canonical facts remain required; only
proved cancellation/ordinary sample removal permits suppression. This reduces
new private-copy creation; inactive historical bodies, active jobs and old
producers still require a complete verified legacy sweep before deletion can
finish. A normalized job or an empty consumer result alone never proves that sweep.

Inactive legacy jobs are normalized in bounded audited batches under a worker
lease. Native preparation verifies canonical facts and records only body/reference/
queue digests; Redis atomically checks the original bytes and absence of an active
job lock before replacing data. Post-change observation failures are reconciled
from the persisted preparation on the next reference pass. The durable worker
cursor contains only opaque physical job keys and SCAN position. These are
operational migration controls, not retained-data release or deletion-completion
authority; old producers must be drained and complete absence verified separately.

| Resource | Classification | Product-deletion action | Retention reason / owner |
|---|---|---|---|
| `administration.admin_sessions` | restricted bearer hashes, factor-proof identifiers and verification/expiry/revocation times | revoke current grants immediately when operator authority ends; retain security history under the approved audit policy; M8 must implement controlled release before deletion | Administration/Security; never retain bearer, factor assertion, OTP or factor secret; ordinary deletion/extension/revival is forbidden |
| `administration.admin_totp_credentials` | actor-bound encrypted authenticator seeds, encryption key/version, activation/revocation audits and consumed counter | revoke factors when workforce authority ends; retain immutable security history only for the approved security window; M8 must implement controlled secret/history release before deletion | Administration/Security; no plaintext seed, URI or code; retain required decryption keys only under the approved key policy; revocation cannot revive a factor |
| `administration.admin_totp_enrollments`, `administration.admin_totp_operator_commands` | encrypted pending seed, invitation hash, exact operator approval/request digest and terminal enrollment receipts | ten-minute enrollment authority; expired/cancelled/completed setup cannot reveal the URI; immutable approval/enrollment history follows the approved security window and requires controlled M8 release | Administration/Security; never retain invitation bearer or URI; new approval and separate revocation are distinct audited operator actions |
| `administration.admin_totp_proofs`, `administration.admin_totp_attempt_windows` | immutable counter-bound proof/audit and mutable five-minute attempt budget | proof authority expires after five minutes; retain proof security history under approved audit policy; one current attempt window per administrator resets on later admission | Administration/Security; no code/seed/bearer; M8 must release subject links without inventing or reviving authority |
| `identity.deletion_confirmations` | user/version-bound authority digest, key ID and five-minute expiry; no bearer | resolve on confirm/cancel/refresh; expired authority cannot authorize deletion; controlled terminal receipt release must follow the approved policy | Identity/Security; retain derive-only old keys only while preparation replay requires them |
| `identity.account_deletion_records` | content-free immutable admission references, lifecycle checkpoint and retained safety bar | retain the deletion event; resumable ordinary purge follows the versioned checklist; completion alone never grants return | Identity/Privacy; no product restoration or invented retention approval |
| `identity.account_deletion_commands` | immutable user/command/request digest and minimal result references | durable irreversible-command replay independently of transport-cache expiry; controlled release under approved policy | Identity/Security; never retain raw confirmation bearer or ordinary product content |
| `identity.account_deletion_work` | mandatory deletion ID, phase/version, monotonic claim generation and bounded lease/retry metadata | resume the exact owning deletion event independently of transport/cache lifetime; expired workers cannot write; never skip a failed phase; completed work requires controlled cleanup | Identity/Operations; fixed error codes only, no arbitrary job payload or retained user content |
| `identity.account_deletion_phase_receipts` | immutable content-free phase/version, checklist, worker generation/expiry and exact audit/event references | preserve verified checkpoint evidence independently of transport expiry; controlled release follows the approved deletion/audit policy | Identity/Privacy/Operations; cannot skip a phase, authorize return or retain product content |
| `identity.account_deletion_evidence_receipts` | restricted capture/snapshot identifiers and integrity fingerprints, owning worker fence and audit/event references | record bounded authentication of existing Report captures before source archival; preserve independently of transport expiry; controlled release under approved policy | Identity/Moderation/Privacy; no copied prose, ciphertext, key identifiers, storage keys or provider payload; capture integrity is not provider-object verification or permission to purge |
| `identity.account_deletion_profile_receipts` | minimal original Profile reference, owning worker fence and required audit/event | prove source removal only after every linked Profile/photo capture is authenticated; immutable replay survives outbox expiry; controlled release under approved policy | Identity/Profile/Privacy; does not authorize phase completion, provider deletion or return |
| `profile.profile_reference_anchors` | original Profile ID and stable owner ID only | preserve exact Report/photo ownership while deleting the ordinary Profile and cascading details; controlled release with governing evidence/lifecycle dependencies | Profile/Moderation/Privacy; no Profile content, location, timestamps or reconstructed capture; cannot authorize new Report admission or Profile reconstruction |
| `identity.users` | internal identifier | retain minimal row | Stable identity and deletion/return safety; Identity |
| `identity.telegram_identities` | direct identifier | retain Telegram ID; clear mutable username when deletion completes | Prevent duplicate identity and enforce return policy; Identity |
| `identity.accounts` | account/safety state | retain state and sanitized reason | Deletion/return and safety enforcement; Identity |
| `identity.account_state_history` | immutable account/safety history | retain | Ban, restriction, deletion, appeal, and audit integrity; Identity/Moderation |
| `identity.guest_preview_counters` | permanent product counter | retain unchanged | Canonical anti-reset exception; Identity |
| `identity.user_settings` | product preference | purge | Recreated with defaults only if return is allowed; Identity |
| `identity.signup_progress` and `identity.signup_drafts` | sensitive signup state | purge | Ordinary product data; Identity/Profile |
| `billing.credit_accounts` | financial foundation | M1 zero-balance row may be purged; M4 policy supersedes after any ledger activity | Billing |
| `notification.notification_preferences` | product preference | purge | Recreated with defaults only if return is allowed; Notification |
| `catalog.locales` | public reference data | retain | Not user-linked; Localization |
| `catalog.ui_texts` | public reference data | retain | Not user-linked; Localization |
| `platform.idempotency_records` | short-lived reliability metadata | expire by configured TTL; redact response payloads | Platform |
| `platform.outbox_events` | reliability/audit transport | retain until published plus operational retention window | Platform |
| `platform.inbox_messages` | deduplication metadata | retain for consumer replay window | Platform |
| Redis `telegram-admin-safety-read:*` | encrypted short-lived admin read command, including restricted reason and actor binding | expire after five minutes; cache loss or key rotation invalidates pending UI references; never extends native authorization | Administration/Telegram; no product content is stored and no authoritative state depends on this cache |
| Redis `telegram-admin-safety-read-withdrawn:*` | content-free UI cancellation marker | expire after five minutes; retain first cancellation without refresh | Administration/Telegram; denies pending read delivery and grants no business permission |
| Redis `telegram-admin-target-selection:*` | first opaque native target action, version and keyed request binding; no target ID, actor ID or prose | expire after five minutes; first allocation wins without refresh; explicit expiry remains enforced on cache TTL failure | Administration/Telegram; native selection and confirmed preparation recheck authority on every attempt |
| Redis `telegram-admin-queue:*` | encrypted metadata selections, pagination and exact private prompt correlation; no support/appeal text or reason | expire after five minutes with explicit expiry; first allocation wins without refresh; cache loss/key rotation invalidates the UI | Administration/Telegram; actor and purpose bound; native authority remains required before reason prompts and confirmed preparation |
| Redis `telegram-admin-support-mutation:*` and `telegram-admin-support-mutation-decision:*` | encrypted native support reply/close draft with reason and reply text; content-free first Confirm/Cancel decision | expire after five minutes without refresh; explicit encrypted draft expiry is enforced even if TTL fails | Administration/Telegram; actor-bound AEAD and opaque references; cache loss is UI loss, never domain authority; native command idempotency/audit owns retries; Cancel cannot undo Confirm |
| Redis `telegram-admin-appeal-review-mutation:*` and `telegram-admin-appeal-review-mutation-decision:*` | encrypted exact appeal review draft, decision, reason and optional private note; content-free Confirm/Cancel winner | expire after five minutes without refresh; explicit draft expiry is enforced independently of TTL | Administration/Telegram; separate AEAD/reference purpose from support; accepts only native review commands, never unban; PostgreSQL owns one effect and one attempted-command audit |
| Redis `telegram-admin-appeal-unban-mutation:*` and `telegram-admin-appeal-unban-mutation-decision:*` | encrypted separately confirmed exact-ban unban draft, reason and both appeal/account versions; content-free Confirm/Cancel winner | expire after five minutes without refresh; explicit draft expiry is enforced independently of TTL | Administration/Telegram; actor/purpose-bound AEAD, native unban-only command allowlist; current permission, accepted appeal and exact ban remain native authority; PostgreSQL owns one effect/audit/notification |
| Redis `telegram-admin-rejection:*` | content-free delivery claim/acknowledgement for fixed admin rejection notices; keyed bot/actor/update binding | pending claim expires after 30 seconds; successful delivery receipt expires after 24 hours without refresh | Administration/Telegram; no reason, target, callback or exception is stored; native handlers always run before notice deduplication |
| Redis `telegram-admin-report-queue:*` | encrypted selected report/version, native queue/cursor authority, bounded evidence metadata choice and owned assignment/decision/account-action prompt reference; no report/evidence prose | expire after five minutes without refresh; explicit encrypted expiry is enforced independently of TTL | Administration/Telegram; actor/purpose-bound opaque references; evidence purpose binds exact report reference, evidence identity/type/schema version; native selection remains authoritative; cache loss requires fresh queue selection |
| Redis `telegram-admin-report-decision-mutation:*` and `telegram-admin-report-decision-mutation-decision:*` | encrypted native assigned-review decision, reason and optional private note; content-free Confirm/Cancel winner | expire after five minutes without refresh; explicit encrypted expiry is enforced independently of TTL | Administration/Telegram; decision-only purpose binds server review/version; current permission/ownership/prior action and immutable attempt audit remain PostgreSQL authority; retained notes use the separately injected domain protector |
| Redis `telegram-admin-report-account-mutation:*` and `telegram-admin-report-account-mutation-decision:*` | encrypted native selected-report Account action, reason, version and content-free Confirm/Cancel winner | expire after five minutes without refresh; explicit encrypted expiry is enforced independently of TTL | Administration/Telegram; actor/purpose-bound account-command-only allowlist; owning-module permission, current report ownership, Account state/history/version and immutable audit remain authoritative; Cancel never reverses Confirm |
| Redis `telegram-admin-report-photo-mutation:*` and `telegram-admin-report-photo-mutation-decision:*` | encrypted native exact-evidence photo action, reason, photo version and content-free Confirm/Cancel winner | expire after five minutes without refresh; explicit encrypted expiry is enforced independently of TTL | Administration/Telegram; actor/purpose-bound photo-command-only allowlist; native current report ownership, permission, photo state/version, idempotency and immutable audit remain authoritative; Cancel never reverses Confirm |
| Redis `telegram-admin-report-queue:photo-prompt:*` | encrypted exact evidence reference and selected photo action, bound to the owned private bot prompt; no reason or evidence prose | expire after five minutes without refresh; explicit encrypted expiry is enforced independently of TTL | Administration/Telegram; separate purpose from assignment/decision/account prompts; native evidence selection is rechecked before action preparation |
| Redis `telegram-admin-report-evidence-mutation:*` and `telegram-admin-report-evidence-mutation-decision:*` | encrypted native exact-evidence read command, bounded reason and content-free Confirm/Cancel winner; never evidence content | expire after five minutes without refresh; explicit encrypted command expiry is enforced independently of TTL | Administration/Telegram; evidence-only actor/purpose-bound allowlist; reader resolution requires Confirm to win; native current permission, immutable evidence binding and append-only audits remain authoritative; replay never resends content |
| Redis `telegram-admin-report-queue:evidence-prompt:*` | encrypted exact evidence reference bound to an owned private bot reason prompt; no reason or evidence prose | expire after five minutes without refresh; explicit encrypted expiry is enforced independently of TTL | Administration/Telegram; separate purpose from photo/assignment/decision/account prompts; fresh native exact evidence selection is required before preparing the confirmed read |
| Redis `telegram-admin-report-assignment-mutation:*` and `telegram-admin-report-assignment-mutation-decision:*` | encrypted native own-review assignment draft/reason and content-free Confirm/Cancel winner | expire after five minutes without refresh; explicit encrypted expiry is enforced independently of TTL | Administration/Telegram; assignment-only allowlist binds server review/version and assignee; PostgreSQL owns permission/idempotency/attempt audit; Cancel never undoes Confirm |
| `channel_telegram.liked_by_delivery_requests`, `channel_telegram.liked_by_delivery_receipts` | Telegram ID, opaque cursor/message key, provider message ID, and short-lived delivery metadata | cancel on product deletion and purge request plus cascading receipts after the seven-day transport-deduplication window; never retain rendered cards or signed media grants | Telegram channel / Privacy |
| `platform.audit_logs` | append-only safe audit metadata | retain by category policy; never store user prose or Telegram identifiers | Platform/Security |
| `chat.predefined_question_sets`, `chat.predefined_questions`, `chat.predefined_answers` | public reference data | retain | Stable localized prompt catalog; Chat/Localization |
| `chat.chat_sessions`, `chat.chat_participants` | relationship and user preference state | purge during product deletion after required lifecycle/evidence handling | Ordinary product data; Chat/Matching |
| `chat.chat_messages` | sensitive user prose and predefined-message history | remove from normal access on lifecycle closure; retain only newest 50 live messages; snapshot authorized evidence before cleanup, then purge ordinary rows | Chat/Privacy |
| `chat.chat_message_snapshot_requests` | restricted report-context marker | retain until every required snapshot is verified, then purge with the governing Report under the M7/M8 evidence policy | Moderation/Privacy |
| `chat.chat_message_snapshots` | immutable sensitive report evidence | never expose through normal chat reads; retain or purge only with the governing Report under the approved evidence policy | Moderation/Privacy |
| `chat.chat_cleanup_checkpoints` | operational retention progress | purge with the ChatSession after cleanup and evidence obligations complete | Chat/Operations |
| `matching.unmatch_records` | immutable relationship-closure and report-window metadata | retain through the safety/report and audit retention window; purge or minimize only under the M8 approved policy | Matching/Moderation |
| `notification.notification_deliveries` | sanitized transport state, opaque provider message key, retry/lease/fence metadata | retain only for the operational delivery and deduplication window; purge independently from durable Notification history | Notification/Privacy |
| `profile.profiles`, optional details, and selection joins | sensitive dating Profile | purge | Ordinary product data; Profile |
| `profile.profile_change_requests` | sensitive correction request | purge after the approved compliance window | Contains protected value snapshots and User reason; Profile/Privacy |
| `profile.profile_change_reviews` | administrative decision | retain only with the corresponding permitted audit window, then purge with request | Administration/Privacy |
| `administration.admin_users` | workforce identity | not part of User product-data deletion | M7 administration lifecycle and audit continuity |
| `administration.admin_roles`, `administration.admin_permissions`, `administration.admin_role_permissions` | code-owned authorization catalog | retain | Stable least-privilege policy; Administration/Security |
| `administration.admin_user_roles`, `administration.admin_action_logs` | workforce authorization and append-only attempt audit | not part of User product-data deletion; retain for the approved security/audit window | Administration/Security |
| `moderation.report_reasons` | public reference data | retain | Stable code-owned safety taxonomy; Moderation/Localization |
| `moderation.reports` | confidential safety complaint and bounded user text | remove from product access immediately; retain or purge only under the approved safety/legal window | Moderation/Privacy; reporter identity is never disclosed to the target |
| `moderation.report_evidence` | restricted typed safety references | retain and purge atomically with the governing Report after snapshot and legal obligations complete | Moderation/Privacy |
| `moderation.report_snapshots` | encrypted immutable sensitive evidence | never expose through ordinary product reads; key-revoke or purge with the governing Report under the approved evidence policy | Moderation/Privacy/Security |
| `moderation.evidence_access_audits` | append-only restricted access metadata | retain for the approved security/audit window; never store decrypted evidence or user prose | Moderation/Security |
| `administration.safety_access_audits` | append-only support/appeal access metadata | retain with the linked admin attempt for the approved security/audit window; M8 must release subject references under approved policy | Administration/Support/Moderation/Security; no content or direct channel identifiers |
| `billing.reconciliation_runs`, `billing.reconciliation_anomalies` | operational progress and restricted integrity references, including moderation subjects | retain for the approved operational/security window; M8 must minimize subject references under approved policy | Platform/Billing/Nakh/Chat/Moderation; finite findings without prose, snapshot payloads or key material |
| `moderation.restriction_episodes` | immutable safety-threshold history | retain for the approved safety/audit window; a resolved episode is never rewritten or reused | Moderation/Safety |
| `moderation.threshold_admission_witnesses` | restricted original reporter/Report admission roster and immutable submission times | retain with the owning restriction episode under the approved safety/audit policy; M8 requires controlled release before ordinary deletion can be allowed | Moderation/Safety; no Report prose, reconstructed legacy roster or external exporter access |
| `moderation.moderation_reviews` | restricted safety workflow and encrypted decision note | remove from product access with the Report; retain or cryptographically erase under the approved safety/legal window | Moderation/Privacy |
| `moderation.moderation_actions` | append-only exact safety action history | retain for the approved safety/audit window; never copy evidence or user prose into the row | Moderation/Security |
| `moderation.user_appeals` | restricted user text and admin decision notes | retain with the exact ban event under the approved safety/legal window; M8 must implement controlled purge | Moderation/Privacy |
| `moderation.appeal_unbans` | immutable appeal-to-unban safety evidence | retain with appeal, Account history, moderation action and admin log; M8 must release all references under approved policy | Moderation/Security |
| `moderation.appeal_submissions` | immutable actor-bound replay digests | retain and purge with the governing appeal; never reset one-appeal admission by ordinary deletion | Moderation/Security |
| `platform.sample_effects` and `platform.sample_projections` | M0 test-only data | remove when M0 sample is retired | Platform |
| `media.media_assets` | sensitive photo metadata, hashes, encrypted temporary transport references | clear transport ciphertext after ingestion ends; soft-delete ordinary assets immediately, verify object purge, then purge metadata after the replay/24-hour attempt window | Media; deletion must not reset upload limits |
| `media.profile_photos` | sensitive Profile/photo association | remove from delivery immediately; purge after object cleanup and permitted safety-reference handling | Media/Profile |
| `media.photo_variants` | private rendition metadata | revoke delivery, verify object deletion, then purge metadata | Media |
| `media.report_photo_evidence_holds` | restricted exact-thumbnail identity and digest | retain with governing Report; block ordinary asset purge; M8 must release holds under the approved evidence policy before media cleanup | Media/Moderation/Privacy |
| confirmed retained-photo delivery buffers | restricted verified thumbnail bytes | transient bounded memory only (two MiB, twenty-second storage deadline); no local spool, URL, Telegram file cache, retry payload or new durable object; native command replay never reopens content | Media/Moderation/Security |
| `media.photo_moderation_records` | append-only safety decision history | retain only for the approved safety/audit window; M8 must implement controlled reference release/purge, not ordinary DELETE against the append-only trigger | Moderation/Privacy; optional report link is disabled until M7 |
| `quarantine/{environment}/{assetId}/` | untrusted private upload | purge on rejection, abandonment, successful publication, or product deletion; verify absence | Media |
| `validated/{environment}/{assetId}/` | private normalized original | purge on ordinary photo/product deletion; retain only under an explicit evidence decision | Media/Moderation |
| `variants/{environment}/{assetId}/` | private served renditions | revoke grants on ordinary photo/product deletion; purge only after any governing Report holds are released under approved policy | Media/Moderation |
| `report-evidence/{environment}/{reportId}/` | restricted encrypted safety evidence | revoke delivery immediately; retain/purge only under explicit evidence policy, independently of ordinary photo cleanup | Moderation/Privacy |

## Required deletion-test assertions for M1

M8 migration 88 adds no retained content or new entity. A terminal pending Nakh is financially
closed only with its exact intent binding and, for every captured Stars attempt, the immutable
receipt, fulfillment correction and matching durable refund obligation. Shared checkpoint receipt
verification repeats this proof at commit. Pending/retryable/terminal-failed refunds remain retained
operational obligations; advancing shared closure does not claim provider refund completion or
authorize release of billing evidence. The ordinary pending text still requires the later purge.

M2 quarantine completion stores byte length, SHA-256, and completion time on `media.media_assets`; these follow that row's purge policy. Temporary Telegram transport ciphertext uses a versioned AES-GCM envelope bound to the environment and asset, and is cleared on quarantine completion or terminal download rejection. Key rotation retains old decrypt-only keys only for outstanding intents; expiry/abandonment cleanup must clear unresolved ciphertext before a key is retired.

- UserSettings and NotificationPreference are absent after product-data purge.
- A zero-balance, never-used CreditAccount may be absent after purge.
- User, TelegramIdentity, Account, AccountStateHistory, and GuestPreviewCounter remain.
- Mutable Telegram username is cleared.
- Guest Preview count and immutable limit snapshot are unchanged.
- A permitted return reuses the same User and TelegramIdentity and never creates a second counter.

M8 must turn these rules into the automated deletion-registry test required by [`11-testing-strategy.md`](11-testing-strategy.md). M2 introduces the media records, but does not yet implement account deletion or retention-window scheduling.

Migration 91 preserves the exact original Chat/Match reference in `chat.chat_reference_anchors`
(two identifiers only, governing safety policy). `identity.account_deletion_chat_receipts` retains
minimal lifecycle proof, bounded original-message identifiers and exact terminal closure/fence/audit
bindings. It contains no message body or preference state and never authorizes retained-data release.
The final verified batch removes the ordinary ChatSession, participants/preferences and cleanup
checkpoint, while original message snapshots/markers and Unmatch history remain retained. New
reference entities are classified explicitly; a worker rejects all unclassified schema drift.

Migration 92 adds `matching.match_reference_anchors`: only the original Match ID and its
normalized two User IDs. Existing Matches, including deleted participants, are backfilled without
changing product rows or immutable Unmatch facts. New Matches require an exact reference at commit;
missing/suppressed inserts roll back. References cannot be reassigned, deleted or synthesized from
an absent source. Chat anchors and Unmatch facts reference this minimal identity; their subject
selectors and other Match-based deletion observations follow it. Original product sources remain
protected from raw removal while those retained references exist. This migration grants no Match
archival, report admission, fresh return or retained-data release. Verified Match archival remains
required before ordinary source deletion can proceed.

Migration 93 permits one closed Match archival per pair-ordered evidence-phase transaction, after
all live Chats are archived, every linked capture/marker is verified and no active paid grant
remains. An immutable receipt keeps only its exact terminal status/time, original source kind and
Nakh funding identity plus the deletion fence and required audit/event chain. Match participants
and the live Match are removed atomically. Revoked grants, money, captures and immutable Unmatch
facts remain unchanged. Internal lifecycle facts combine live Matches with verified archival
receipts for original Unmatch consistency, post-unmatch reporting and Nakh funding reconciliation;
ordinary product reads still require the live source. New paid grants cannot reference an archived
Match. A receipt alone grants no new product access, report window, phase completion or fresh return.
Commit-time checks revalidate captures, actual source removal and the exact unexpired worker lease.

Migration 94 preserves original Photo/Profile/asset identities in immutable photo references.
Verified owning evidence-phase workers may archive one live Photo per transaction, after all
linked Report captures have authenticated receipts. The commit fence checks source absence,
current captures, the exact unexpired lease and mandatory content-free audit/event bindings.
Report holds, assets, variants and moderation history retain their exact identities. Historical
integrity checks resolve ownership through the original reference; audited evidence access still
requires current administrator permission and its committed access log. The reference grants no
product access. Asset identity deliberately has no foreign key so future verified provider cleanup
can remove ordinary assets; held evidence keeps its independent asset/variant protections.
This archival does not assert provider absence, release retained data or complete a deletion phase.


Migration 135 adds `identity.account_deletion_session_receipts`, retained original-life
session-revocation proof linked to the governing deletion Root and immutable security
audit. It stores only those two IDs and a SHA-256 digest. The digest binds original
grant provenance, epoch, worker lease and transaction; no bearer is retained. Its
purpose is independent proof of authority retirement, not account reactivation.
Release requires approved policy and remains disabled with all retained-data release.


Migration 136 retains `identity.account_deletion_ephemeral_pages` as restricted
original-life lifecycle proof. Fifteen columns bind prepared/observed audits,
Root, revisions, bounded cursors, resource findings, transitions and predecessor
digests. Cursors contain only scan positions and physical reference keys; no token,
message, provider error or job body is copied into proof. Release remains approval
required and disabled. Global queue diagnostic/log/event copies are ordinary
transport; canonical money, inbox receipts and security/safety facts remain under
their independent policies. Current worker queue diagnostics use only coarse codes
and no stack/cause. A reverified-intent summary is absence evidence, not an invented
original effect count. Actual operator producer-drain evidence remains external.


## Provisional retention inventory (migration 137)

`identity.data_retention_records` is lifecycle proof with purpose
`original_life_retention_manifest_pending_policy`. It records descriptors and
historical presence only, never copies of retained product or provider contents.
The exact catalog is 153 tables, 1,419 columns and 307 foreign keys. Existing
registry resource indices are preserved; the new entry is appended.

Records bind original Root/user/life, reviewed type/disposition/purpose, access
purpose, explicit policy status, registry hash, audit digest and native lease.
Global typed scopes remain unknown rather than falsely absent. All categories,
including absent ones, receive a disposition; current ordinary-data obligations
are independently verified before the phase 6 to 7 checkpoint. This checkpoint
is not deletion completion, retention approval or fresh Return authorization.

Unknown periods are `pending_approval`, not approved indefinite retention.
`retention_expires_at`, `indefinite_reason` and `deleted_at` stay null while the
inventory is provisional. Updates/deletes and retained-data release are disabled.
Approving finite schedules or justified indefinite policies requires a separate,
audited implementation and genuine policy approval; no fixture supplies either.
Existing financial, safety and workforce purpose/access restrictions still apply.
