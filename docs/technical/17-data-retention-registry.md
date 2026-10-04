# Data Retention and Deletion Registry

This registry is mandatory for every user-linked table or object prefix. It records the product-deletion action independently from PostgreSQL foreign-key behavior. The deletion workflow is implemented in M8, with M7 owning moderation/evidence decisions; new migrations must update this file immediately.

| Resource | Classification | Product-deletion action | Retention reason / owner |
|---|---|---|---|
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
| `media.photo_moderation_records` | append-only safety decision history | retain only for the approved safety/audit window; M8 must implement controlled reference release/purge, not ordinary DELETE against the append-only trigger | Moderation/Privacy; optional report link is disabled until M7 |
| `quarantine/{environment}/{assetId}/` | untrusted private upload | purge on rejection, abandonment, successful publication, or product deletion; verify absence | Media |
| `validated/{environment}/{assetId}/` | private normalized original | purge on ordinary photo/product deletion; retain only under an explicit evidence decision | Media/Moderation |
| `variants/{environment}/{assetId}/` | private served renditions | revoke grants on ordinary photo/product deletion; purge only after any governing Report holds are released under approved policy | Media/Moderation |
| `report-evidence/{environment}/{reportId}/` | restricted encrypted safety evidence | revoke delivery immediately; retain/purge only under explicit evidence policy, independently of ordinary photo cleanup | Moderation/Privacy |

## Required deletion-test assertions for M1

M2 quarantine completion stores byte length, SHA-256, and completion time on `media.media_assets`; these follow that row's purge policy. Temporary Telegram transport ciphertext uses a versioned AES-GCM envelope bound to the environment and asset, and is cleared on quarantine completion or terminal download rejection. Key rotation retains old decrypt-only keys only for outstanding intents; expiry/abandonment cleanup must clear unresolved ciphertext before a key is retired.

- UserSettings and NotificationPreference are absent after product-data purge.
- A zero-balance, never-used CreditAccount may be absent after purge.
- User, TelegramIdentity, Account, AccountStateHistory, and GuestPreviewCounter remain.
- Mutable Telegram username is cleared.
- Guest Preview count and immutable limit snapshot are unchanged.
- A permitted return reuses the same User and TelegramIdentity and never creates a second counter.

M8 must turn these rules into the automated deletion-registry test required by [`11-testing-strategy.md`](11-testing-strategy.md). M2 introduces the media records, but does not yet implement account deletion or retention-window scheduling.
