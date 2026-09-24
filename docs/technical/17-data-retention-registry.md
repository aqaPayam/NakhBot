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
| `platform.sample_effects` and `platform.sample_projections` | M0 test-only data | remove when M0 sample is retired | Platform |
| `media.media_assets` | sensitive photo metadata, hashes, encrypted temporary transport references | clear transport ciphertext after ingestion ends; soft-delete ordinary assets immediately, verify object purge, then purge metadata after the replay/24-hour attempt window | Media; deletion must not reset upload limits |
| `media.profile_photos` | sensitive Profile/photo association | remove from delivery immediately; purge after object cleanup and permitted safety-reference handling | Media/Profile |
| `media.photo_variants` | private rendition metadata | revoke delivery, verify object deletion, then purge metadata | Media |
| `media.photo_moderation_records` | append-only safety decision history | retain only for the approved safety/audit window; M8 must implement controlled reference release/purge, not ordinary DELETE against the append-only trigger | Moderation/Privacy; optional report link is disabled until M7 |
| `quarantine/{environment}/{assetId}/` | untrusted private upload | purge on rejection, abandonment, successful publication, or product deletion; verify absence | Media |
| `validated/{environment}/{assetId}/` | private normalized original | purge on ordinary photo/product deletion; retain only under an explicit evidence decision | Media/Moderation |
| `variants/{environment}/{assetId}/` | private served renditions | revoke grants and purge objects on ordinary photo/product deletion | Media |
| `report-evidence/{environment}/{reportId}/` | restricted safety evidence (future M7) | retain/purge only under explicit evidence policy, independently of ordinary photo cleanup | Moderation/Privacy |

## Required deletion-test assertions for M1

M2 quarantine completion stores byte length, SHA-256, and completion time on `media.media_assets`; these follow that row's purge policy. Temporary Telegram transport ciphertext uses a versioned AES-GCM envelope bound to the environment and asset, and is cleared on quarantine completion or terminal download rejection. Key rotation retains old decrypt-only keys only for outstanding intents; expiry/abandonment cleanup must clear unresolved ciphertext before a key is retired.

- UserSettings and NotificationPreference are absent after product-data purge.
- A zero-balance, never-used CreditAccount may be absent after purge.
- User, TelegramIdentity, Account, AccountStateHistory, and GuestPreviewCounter remain.
- Mutable Telegram username is cleared.
- Guest Preview count and immutable limit snapshot are unchanged.
- A permitted return reuses the same User and TelegramIdentity and never creates a second counter.

M8 must turn these rules into the automated deletion-registry test required by [`11-testing-strategy.md`](11-testing-strategy.md). M2 introduces the media records, but does not yet implement account deletion or retention-window scheduling.
