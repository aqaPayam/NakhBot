# Data Retention and Deletion Registry

This registry is mandatory for every user-linked table or object prefix. It records the product-deletion action independently from PostgreSQL foreign-key behavior. The deletion workflow is implemented in M8, with M7 owning moderation/evidence decisions; new migrations must update this file immediately.

## Executable catalog inventory

[`deletion-registry.json`](../../packages/persistence-postgres/src/deletion-registry.json) is the
code-owned M8 catalog inventory for migration 92: 123 tables, 1,111 columns and 223 foreign keys.
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
