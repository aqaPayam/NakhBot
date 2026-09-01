# PostgreSQL Data Architecture

## 1. Database strategy

Begin with one highly available PostgreSQL cluster and one logical database. Separate ownership with PostgreSQL schemas, repository packages, database roles, and code import rules rather than network services. This preserves atomic business workflows while leaving clear extraction seams.

Schemas:

| Schema | Owner module |
|---|---|
| `identity` | identity, account, signup, settings |
| `catalog` | gender, interests, location, locale, prompts, product configuration |
| `profile` | profiles, optional details, selections, change requests |
| `media` | assets, photo assignments, variants, photo moderation |
| `discovery` | filters and consumption |
| `interaction` | Likes, Not Interested, pair state, paid unlocks |
| `nakh` | Nakh flow, pending and delivered phases |
| `matching` | Match, participants, unmatch |
| `chat` | chat sessions, participants, messages, evidence snapshots |
| `billing` | credit account/ledger, pending funding, payments, provider events, refunds |
| `notification` | notifications, preferences, deliveries |
| `moderation` | reports, evidence, snapshots, reviews, actions, appeals |
| `administration` | admin identity/RBAC/action log |
| `support` | support threads and messages |
| `platform` | outbox, inbox, idempotency, schedules, job runs, audit, retention |

Cross-schema foreign keys are allowed inside this monolith. Cross-module reads and writes in application code still go through module ports. A future extraction replaces the foreign key with an immutable external ID only after an ADR and migration plan.

## 2. Universal conventions

- Primary IDs: UUIDv7 in column `id uuid primary key`; generated before persistence.
- User-facing/public IDs: expose the UUID only where necessary; never expose sequential database identifiers.
- Telegram IDs: `bigint`, globally unique, never used as an internal foreign key.
- Time: `timestamptz`, stored in UTC. Deadlines are explicit timestamps computed at command time from a snapshotted configuration value.
- Text: normalized to Unicode NFC; length constraints count Unicode code points in application validation and have a defensive database byte/character bound.
- Codes/enums: `text` with named `CHECK` constraints. Data-driven catalogs use foreign keys instead.
- Amounts/counts: `integer` unless cumulative scale can exceed it; ledger balances and Telegram IDs use `bigint`.
- Mutable rows: `created_at`, `updated_at`, and `version integer not null default 1` where optimistic concurrency is useful.
- Soft deletion: only where lifecycle/history requires it. Ordinary data is hard-deleted during the deletion workflow.
- JSONB: validate against a versioned application schema; store `schema_version` beside durable payloads.
- Hashes: `bytea`; compare in constant time where security-sensitive.
- Case-insensitive lookup: store normalized columns explicitly; do not rely on session collation.
- Foreign-key action is explicit. Financial/safety/audit evidence normally uses `RESTRICT`; ordinary user-owned product data normally uses controlled workflow deletion, not broad database cascades.

All tables have an explicit owner role. Runtime roles receive only needed statements. Migration ownership is separate from application roles.

## 3. Identity, account, and signup

### Core tables

`identity.users`

- `id`, `last_activity_at`, `created_at`, `updated_at`.
- Index `last_activity_at` only when a real inactivity job needs it.

`identity.telegram_identities`

- `user_id` PK/FK users, `telegram_user_id bigint not null`, mutable username, first/last seen timestamps.
- Unique index on `telegram_user_id`.
- Username is informational and never an authorization key.

`identity.accounts`

- `user_id` PK/FK users; `state`, `state_reason`, `state_changed_at`, `version`.
- Named check for AccountState.
- Index `(state, state_changed_at)` for moderation/lifecycle operations.

`identity.account_state_history`

- append-only `id`, user, previous/next state, reason, actor type, optional actor user/admin, changed time.
- Check actor reference matches actor type; check previous differs from next.
- Index `(user_id, changed_at desc)`; partial index on `(user_id, changed_at desc)` where `next_state='banned'`.
- Update/delete denied to application roles.

`identity.account_deletion_records`

- one row per deletion event; user, lifecycle timestamps, `reactivation_allowed`, sanitized failure code/detail.
- Partial unique index on user where `completed_at is null` prevents concurrent deletion workflows.
- Index `(completed_at, requested_at)` for the deletion worker.

`identity.guest_preview_counters`

- user PK, `preview_count >= 0`, immutable positive `limit_count`, first/last preview timestamps.
- Preview consumption uses a conditional atomic update and never a read-then-write count.

`identity.user_settings`

- user PK, visibility boolean, UI locale FK, timestamps/version.

`identity.signup_progress`

- user PK, checked current step, started/completed timestamps, version.

`identity.signup_drafts`

- user PK, `draft_data jsonb`, `schema_version`, last completed step, nullable expiry, timestamps/version.
- Draft validation happens before write. Draft content is never queried to decide discovery eligibility.

## 4. Catalog and Profile

Catalog tables `catalog.gender_options`, `gender_preferences`, `interests`, `languages`, `personality_tags`, `countries`, `provinces`, and `cities` use stable unique code, localization key, active flag, and order as defined by the domain model. Hierarchy has `(parent_id, code)` uniqueness. `catalog.gender_preference_members` has a composite primary key. Catalog rows referenced by product history are deactivated, not deleted.

`profile.profiles`

- user PK plus a UUID `id` unique key for profile-owned references.
- name, Gregorian birth year, catalog FKs, relationship goal, country/province/city FKs, highlight, nullable bio, completion status, `ever_completed`, completed time, random shuffle key, timestamps/version.
- Checks for birth-year floor, text defensive bounds, completion timestamp coherence, and immutable `ever_completed` enforced by a narrow trigger or repository plus trigger.
- A deferred constraint trigger verifies country/province/city ancestry for writes. Application validation provides the friendly error.
- Indexes: `(completion_status, city_id, birth_year)`, `(gender_option_id, gender_preference_id)`, and `(city_id, random_shuffle_key, id)` with partial predicate `completion_status='complete'`.
- Discovery always also checks Account active, visibility, media, reciprocal preference, and pair exclusions; the profile index alone never grants eligibility.

`profile.profile_optional_details`

- profile PK/FK; nullable attributes with defensive checks including height 100..250 and normalized job-title bound.

Selection joins:

- `profile.profile_interests(profile_id, interest_id)` composite PK;
- `profile.profile_languages(profile_id, language_id)` composite PK;
- `profile.profile_personality_tags(profile_id, personality_tag_id)` composite PK.

Every selection-set replacement locks the Profile row before deleting/inserting join rows. Maximum/minimum counts are then transaction-level invariants verified by the Profile application service at confirmation/update; a deferred constraint trigger may additionally enforce hard maxima. Minima apply only when marking complete. This makes concurrent interest/language/tag edits conflict-safe.

`profile.profile_change_requests`

- user, field name limited to `birth_year|gender`, old/requested JSON scalar snapshots, reason, status, submitted/resolved times.
- Partial unique `(user_id, field_name) where status='pending'`.
- Index `(status, submitted_at)` for review queue.

`profile.profile_change_reviews`

- request PK/FK, admin FK, decision, note, reviewed time; immutable after creation.

## 5. Media

`media.media_assets`

- owner, original filename, detected MIME, size/dimensions, content hashes, storage provider/key, stable delivery path, validation state/error, uploaded/deleted times.
- Unique `(storage_provider, storage_key)`; index `(owner_user_id, uploaded_at desc)`; hash index only if deduplication is enabled.
- `storage_key` is private. A stored delivery path is not a public bucket URL and does not authorize access.

`media.profile_photos`

- profile, unique asset, state, primary flag, display order, lifecycle times, timestamps/version.
- Unique `(profile_id, display_order)` for non-deleted photos.
- Partial unique `(profile_id) where is_primary` plus check `is_primary implies status='visible'`.
- Every create/hide/delete/reorder operation first locks the Profile row. It counts non-deleted saved photos under that lock, so concurrent accepted uploads cannot exceed six; it also promotes one visible replacement before a primary can become hidden/deleted.
- Index `(profile_id, status, display_order)`.

`media.photo_variants`

- asset, type, storage key/delivery path, dimensions, generated time; unique `(media_asset_id, variant_type)` and unique provider storage key.

`media.photo_moderation_records`

- append-only photo, action, admin, optional report, reason, created time; index `(profile_photo_id, created_at desc)`.

Storage mutations are never attempted inside the database transaction. Rows enter an intermediate validation/cleanup workflow and outbox events drive object operations.

## 6. Discovery and interaction

`discovery.explore_filters`

- user PK, min/max age, city, optional relationship goal, timestamps/version; check `18 <= min_age <= max_age` and a defensive maximum.

`discovery.explore_filter_genders`

- `(user_id, gender_option_id)` composite PK. At least one member is enforced when saving the filter transaction.

`discovery.explore_consumptions`

- viewer, target, immutable first reason/time; unique `(viewer_user_id, target_user_id)` and check viewer differs from target.
- Index `(viewer_user_id, consumed_at desc)` and optional BRIN on `consumed_at` at scale.
- Insert with `ON CONFLICT DO NOTHING`; only the winner may return that newly consumed candidate.

`interaction.likes`

- sender/receiver, status, created/closed times, version; unique directional pair, no self-like.
- Index `(receiver_user_id, status, created_at desc)` for Liked By and `(sender_user_id, status)` for closure.
- Active status/timestamp coherence check.

`interaction.not_interested`

- sender/receiver, source, created time; unique directional pair, no self-row.

`interaction.user_pair_states`

- normalized low/high users, state/reason/change time, version; PK `(user_low_id,user_high_id)`, check low < high.
- Every caller uses one shared pair-normalization function.

`interaction.feature_unlocks`

- payer, type, optional Like scope, optional Match scope, exactly one funding reference, status/lifecycle timestamps.
- Check Like scope iff liked-by type; Match scope iff chat type.
- Check one of PaymentRecord/CreditTransaction is set, never both.
- Each non-null funding reference is unique, so one payment or ledger spend cannot prove two unlocks.
- Partial unique `(like_id) where feature_type='liked_by_profile_unlock'`.
- Partial unique `(match_id) where feature_type='chat_unlock'`.
- Index `(payer_user_id, status, unlocked_at desc)`.

For credit-funded unlocks, the FeatureUnlock-to-CreditTransaction and ledger-to-FeatureUnlock references form one intentional cycle. Both IDs are generated before write and those two foreign keys are `DEFERRABLE INITIALLY DEFERRED`, allowing one atomic commit while preserving both proofs.

Unlock authorization always joins the scope state; an active row alone cannot reopen a closed Like or Match.

## 7. Nakh

`nakh.nakh_flows`

- sender/receiver, created time; unique directional pair and no self-row.
- This stable row is locked before pending/delivered state changes.

`nakh.pending_nakhes`

- flow unique FK, text, status, optional unique PendingPayment, auto-settle authorization, created/expiry/paid/cancel/reminder times and cancellation resolution, version.
- Checks bind timestamps/resolution to status and require expiry after creation.
- Index `(status, expires_at)`; `(status, last_reminder_at, created_at)`; join index through flow sender.
- The maximum five unpaid pending Nakh invariant is enforced by locking a per-user quota row (`platform.user_counters`) before insert; a query-only count is not concurrency-safe.

`nakh.nakhes`

- flow unique FK, immutable delivered text, status and lifecycle timestamps, version.
- Checks legal timestamp/status combinations.
- Index through flow receiver plus `(status, sent_at desc)`; partial `(status, sent_at)` for sent/seen expiry.

`nakh.nakh_status_history` and `nakh.nakh_receiver_actions`

- append-only history/action rows; indexes by Nakh/time.
- Partial unique terminal receiver action per Nakh prevents both accept and reject winning. Report and view-profile actions use caller idempotency rather than that terminal constraint.

## 8. Match and chat

`matching.matches`

- normalized user pair, source, source Like IDs or Nakh ID, status/lifecycle times, version.
- Unique pair; source-shape check; low < high.
- Index `(user_low_id,status)` and `(user_high_id,status)`.

`matching.match_participants`

- `(match_id,user_id)` PK, joined time. Creation service inserts exactly two rows in the Match transaction. A deferred constraint trigger rejects a committed Match without exactly its normalized two users.

`matching.unmatch_records`

- match PK/FK, actor, optional reason, time and report deadline; deadline after unmatch.

`chat.chat_sessions`

- match unique FK, state/lifecycle close reason, `next_sequence_number bigint`, timestamps/version.

`chat.chat_participants`

- `(chat_session_id,user_id)` PK; read/mute/warning times. Deferred constraint verifies exactly the Match participants.

`chat.chat_messages`

- chat, sender nullable only for system type, message type, one typed payload, `sequence_number bigint`, created time.
- Unique `(chat_session_id, sequence_number)`; index `(chat_session_id, sequence_number desc)`.
- Check exactly the payload required by message type.
- The session row reserves the next sequence under lock; API pagination uses sequence, not offset.

`chat.chat_message_snapshots`

- report, session, original message ID (not a live FK after deletion), sender, type, immutable content, original/snapshot times, hash.
- Index `(report_id, original_created_at)`; restricted safety access.

Predefined prompts live in catalog tables with stable code/key/order/active fields and parent/child foreign keys. Message references are `RESTRICT`; catalog rows are deactivated rather than deleted.

## 9. Billing

`billing.credit_accounts`

- user PK, `balance bigint >= 0`, timestamps/version.
- All balance changes lock this row and insert a matching ledger row in the same transaction.

`billing.credit_transactions`

- immutable account/user, type, signed amount, before/after balances, optional typed references, unique idempotency key, created time.
- Check `after = before + amount`, after non-negative, and reference shape appropriate to type.
- Index `(user_id, created_at desc, id desc)` and each non-null reference.
- Update/delete denied.

`billing.credit_packages`

- stable code, localized title/badge, positive credits/Stars, active/order. Historical purchase facts snapshot amount and price in PaymentRecord.

`billing.pending_payments`

- user, reason, typed target, required credits or Stars, status/lifecycle times, version.
- Check exactly the required funding amount for the chosen path and expiry after creation.
- Partial index `(user_id, reason, target_type, target_id) where status='pending'` and unique where the product permits only one open funding intent.

`billing.payment_records`

- user, optional pending funding, type/action/package, status, positive Stars, provider, unique cryptographically random invoice payload, nullable unique provider payment ID, lifecycle times, version.
- Index `(user_id, created_at desc)` and `(status, created_at)` for reconciliation.
- Status/timestamp and type/reference shape checks.

`billing.telegram_stars_payments`

- PaymentRecord PK/FK, unique Telegram charge ID, nullable provider charge ID, amount, receive time, encrypted/redacted raw data plus schema version.

`billing.payment_provider_events`

- provider plus provider event ID unique, type, optional payment, encrypted raw payload, received/processed times, processing status/failure code, attempt count.
- Index `(processing_status, received_at)`.

`billing.refund_records`

- user, one or more original funding references as permitted, reason, Stars/credits correction, state, unique idempotency key, lifecycle times.
- Partial index `(status, created_at)` for retry.

The ledger and provider-event records are immutable financial evidence. Account deletion pseudonymizes their user link using the retention design; it does not fabricate reversal entries.

## 10. Notifications

`notification.notifications`

- user, typed notification, localization keys, validated payload/schema version, read state/times, optional unique dedupe key.
- Index `(user_id,status,created_at desc)`.

`notification.notification_deliveries`

- notification/channel, status, attempt count, next/sent/fail times and sanitized failure code, provider delivery key.
- Unique `(notification_id,channel)`; index `(status,next_attempt_at)`.

`notification.notification_preferences`

- user PK and four mutable category booleans. Non-mutable categories never consult these values.

## 11. Moderation, administration, support

`moderation.reports`

- reporter/target, reason catalog, bounded text, state/lifecycle times, version; no self-report.
- Index `(status,submitted_at)`, `(target_user_id,submitted_at desc)`, and `(reporter_user_id,submitted_at desc)`.
- Threshold queries count distinct reporters only where status is `submitted` or `pending_review` and submission is within the rolling 30-day window.

`moderation.report_evidence`

- report, type, exactly one live reference where still available; check reference matches type.

`moderation.report_snapshots`

- immutable report/type, encrypted JSON payload/schema version, created time, content hash; restricted role.

`moderation.moderation_reviews`

- report unique, optional assigned admin, state/note/lifecycle times, version; partial index on unresolved queue.

`moderation.moderation_actions`

- immutable actor, target user/optional photo/report, action, reason, time; indexes by target/report/time.

`moderation.user_appeals`

- user, unique ban-history event, text, state/reviewer/note/lifecycle; one appeal is therefore enforced per ban event.

`administration.admin_users`, `admin_roles`, `admin_permissions`, `admin_user_roles`, `admin_role_permissions`

- normalized RBAC tables with unique stable codes and pair primary keys. AdminUser binds to an internal user and snapshots Telegram ID for bootstrap verification.

`administration.admin_action_logs`

- append-only every attempted mutating command, target, result, sanitized metadata, correlation/time; indexes by admin/time and target/time.

`support.support_threads`

- user, status, last message/close times, version; index `(user_id,status,last_message_at desc)`.

`support.support_messages`

- thread, exactly one sender user/admin, bounded text, created time; index `(thread_id,created_at)`.

The unanswered-message limit acquires a per-User advisory lock and counts User messages across all open/in-review threads created after the latest admin/support reply. This preserves the two-message limit without inventing a one-open-thread product rule.

## 12. Platform reliability tables

`platform.outbox_events`

- aggregate type/id, event type, schema version, JSON payload, occurred/available times, attempt count, published time, last error code, correlation/causation IDs.
- Index `(available_at,id) where published_at is null`.
- Events insert in the same transaction as business state.

`platform.inbox_messages`

- consumer, message ID, received/processed times, payload hash/result code.
- Unique `(consumer,message_id)`; retained long enough to cover maximum redelivery/replay.

`platform.idempotency_records`

- actor/scope/key, request hash, status, response code/body reference, expiry, timestamps.
- Unique `(actor_user_id,scope,key)`; the same key with a different request hash is rejected.

`platform.user_counters`

- user PK with hot invariant counters such as unpaid pending Nakh count; values are modified only by owning transaction services and periodically reconciled to source rows.

`platform.scheduled_jobs` and `job_run_logs`

- configured job definitions and append-only executions. Unique run key prevents the same schedule window from being enqueued twice.

`platform.audit_logs`, `payment_audit_logs`, `safety_audit_logs`

- append-only, separately permissioned streams with actor, event, subject reference, safe metadata/schema version, correlation and time.

`platform.data_retention_records`

- deletion event, pseudonymous retained subject key, data category, reason, expiry/deletion times. It explains retention; it does not store deleted profile/chat content.

Rate limiting is primarily Redis-backed. Durable `platform.rate_limit_records` exist only for safety blocks or windows that must survive Redis loss.

`catalog.locales`, `catalog.ui_text`, and `catalog.system_config` implement localized copy and typed tunable configuration. Locale/text key and config key are unique. SystemConfig values carry a declared type, validation schema/version, active state, updater, and updated time; secrets, enum registries, and user-facing prose are prohibited. Configuration reads are cached by version and invalidated after a committed update.

## 13. Discovery query design

The MVP candidate query uses PostgreSQL, not a search service:

1. validate viewer Account/Profile/settings/filter;
2. filter candidate Account active, visible, complete, active City/media requirements;
3. apply candidate gender within Explore filter;
4. apply reciprocal preference using `gender_preference_members` in both directions;
5. derive age from birth year using a single request-time current Gregorian year;
6. apply City and optional relationship goal;
7. exclude self, prior consumption, Likes/NotInterested/NakhFlow, terminal/safety pair state, and deletion/moderation state;
8. order by a periodically refreshed shuffle key plus ID;
9. select a bounded candidate pool;
10. atomically insert ExploreConsumption and return only a candidate whose insert succeeds.

Avoid a single giant query once measurements show planner instability. A maintained `discovery.eligible_profile_projection` may denormalize only discovery-safe columns and be updated transactionally/outbox-driven. Authorization and no-repeat insertion still recheck authoritative tables.

## 14. Isolation, locks, and deadlock prevention

Default isolation is `READ COMMITTED`. Lock order is global:

1. normalized User IDs ascending;
2. Account rows ascending;
3. normalized pair/flow/Match rows;
4. scoped business row (Like, Nakh, Match, PendingPayment);
5. CreditAccount;
6. entitlement/notification/outbox inserts.

Commands retry deadlock and serialization errors at most three times with jitter if and only if their idempotency record makes retry safe. Database statements have bounded timeouts. No network call occurs while locks are held.

Critical patterns:

- balance spend: `SELECT ... FOR UPDATE`, validate, update with version, insert ledger;
- guest preview: conditional `UPDATE ... SET preview_count=preview_count+1 WHERE preview_count<limit_count RETURNING`;
- accept/reject Nakh: lock flow and Nakh, conditional terminal transition, create Match once;
- mutual Like: lock normalized pair advisory key or pair row, insert Like, check reciprocal active Like, create unique Match;
- pending Nakh quota: lock user counter, verify/reconcile when suspect, increment with pending insert;
- provider callback: claim inbox/provider-event uniqueness, lock PaymentRecord/PendingPayment/CreditAccount, grant once.

## 15. Retention and deletion

Retention durations are a deployment/compliance schedule and must be approved before production. The mechanics are fixed:

- ordinary profile, discovery, interaction, notification, signup draft, and non-evidence chat data are purged by the deletion workflow;
- shared Match/chat rows are closed first; the other participant receives a channel-neutral closure event;
- report snapshots and message snapshots survive only under documented safety retention and restricted access;
- guest-preview counter and identity return marker survive as required by the domain rules;
- financial ledger/provider evidence is pseudonymized and retained according to accounting/provider needs;
- storage-object deletion is durable work with verification and retry;
- every retained category creates a DataRetentionRecord with reason and review/expiry date where applicable.

Deletion is a saga with checkpoints, not an unbounded cross-table transaction. Account state changes to deleted synchronously; all new commands fail; each purge step is idempotent; completion occurs only after database and object-store verification.

## 16. Growth, partitioning, and replicas

Do not partition small tables. Monitor row count, index size, vacuum duration, retention-delete cost, and query plans. Candidates for monthly range partitioning are outbox/inbox history, delivery attempts, provider events, audit logs, job runs, and eventually chat messages. Partition when a measured maintenance/query problem exists, normally tens to hundreds of millions of rows.

Partition design must account for PostgreSQL unique-key rules; global business uniqueness stays in an unpartitioned registry when necessary. Partition creation, retention detach, and restore are rehearsed before activation.

Read replicas serve analytics, catalog/localization reads, old chat history, and administration queries tolerant of lag. Authorization, discovery consumption, balance, payment, entitlement, and lifecycle decisions use the writer. Replica lag is measured and a request can fall back to the writer.

## 17. Database verification gates

Before the first feature release:

- every foreign key action is reviewed;
- all state codes and shape checks match the canonical registry;
- unique and partial indexes have concurrency tests;
- every list/query has an index-backed plan at production-like volume;
- migrations are run from empty and from the previous release snapshot;
- backup restore and point-in-time recovery are rehearsed;
- application roles cannot mutate append-only tables;
- deletion produces a machine-checked manifest of removed and retained categories;
- schema documentation is generated from migrations and diffed against this design.
