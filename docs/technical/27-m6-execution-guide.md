# M6 Execution Guide — Chat and Notification Delivery

Status: approved implementation guide for M6. This guide converts the canonical Match, Unmatch,
chat, notification, retention, channel, and acceptance rules into an ordered backend plan.

## 1. Authority and boundary

1. The domain documents remain authoritative for product behavior.
2. Existing identity, matching, interaction, billing, notification, security, localization,
   retention, testing, and deployment rules remain mandatory.
3. This guide owns M6 sequencing, chat persistence and authorization, Unmatch, predefined prompts,
   unlocked text, read/mute state, Telegram relay, live-message cleanup, notification dispatch and
   retry, and evidence for `ACC-031..035` and the M6 portion of `ACC-038`.
4. M6 reuses M3 Match/ChatSession creation and M4 FeatureUnlock, funding, correction, Notification,
   preference, Delivery, outbox, and inbox records. It must not create a second entitlement,
   payment, notification, or pair-state model.
5. Provider-neutral code and deterministic fake-provider evidence may complete before
   infrastructure exists. Real Telegram relay and delivery remain staging gates, not reasons to
   weaken authorization, privacy, or reliability.

M6 delivers active predefined prompts, unlock-gated normalized text, stable per-chat sequence,
keyset history, read and mute state, permanent Unmatch, durable notification dispatch, bounded
provider retry, Telegram bot relay, and cleanup that retains only the newest 50 live messages while
preserving immutable reported context.

## 2. Non-goals

Do not add direct user-to-user Telegram identity exposure, Telegram native forwards, photos, voice,
video, files, stickers, reactions, typing presence, message editing, user message deletion, group
chat, WebSockets, end-to-end encryption, content search, automatic text moderation, report review,
admin chat browsing, account deletion, or production activation. M7 owns report submission,
moderation, explicit safety-review access, and the final Report foreign key. M8 owns full deletion
and retention execution. M9 owns production activation.

M6 does not reopen M4 pricing or entitlement behavior: chat unlock remains 4 credits or 4 Stars,
unique per Match, effective for both participants, without clock expiry, and ineffective after
Match/Chat closure or FeatureUnlock revocation.

## 3. Required ownership

```text
packages/domain/src/chat/                # pure text, capability, prompt, retry, retention policies
packages/contracts/src/m6.ts             # strict channel-neutral commands, queries, events
packages/application/src/chat/            # chat, Unmatch, read/mute, cleanup coordinators and ports
packages/application/src/notification/    # delivery claim/settlement and preference use cases
packages/persistence-postgres/src/        # chat, Unmatch, cleanup, delivery and query repositories
packages/telegram/src/                    # safe rendering, signed callbacks and relay translation
apps/worker/src/                          # Telegram notification delivery consumer
apps/scheduler/src/                       # bounded cleanup and stuck-delivery recovery scans
migrations/000040..                       # forward-only M6 schema and localization
```

Matching owns Match and Unmatch lifecycle. Chat owns message sequence, participant read/mute/warning
state, catalog use, live history, and snapshots. Notification owns durable history and transport
delivery state. Telegram is an adapter: it cannot decide chat eligibility, unlock scope, sequence,
mute policy, or retention.

## 4. Locked decisions and constants

- A ChatSession belongs to exactly one Match and has exactly the same two participants.
- Only an active Match, active ChatSession, safe matched pair, and send-capable Account may produce a
  user message. Restricted, banned, deleted, blocked, unmatched, or closed state rejects sending.
- Every committed message has one positive session-local `bigint` sequence. The ChatSession row is
  the allocator and is locked before insertion. Transaction rollback consumes no sequence.
- Pagination is keyset-only by `(chat_session_id, sequence_number DESC)`; clients never provide an
  offset, sender identity, unlock flag, text rendering key, or delivery target.
- Locked chat accepts only active seeded predefined questions and valid active answers belonging to
  the selected question. IDs are resolved server-side to localization keys.
- Unlocked chat accepts text only. Normalize to Unicode NFC, trim outer Unicode whitespace, reject
  empty text, and enforce at most 1000 Unicode scalar values. Persist normalized user text exactly;
  never translate, template, log, or place it in a queue payload.
- Free-form emoji is text and is unavailable before unlock. Attachments and Telegram forwarded
  messages are rejected before any download or storage work.
- A participant is shown the unlock safety warning before their first free-text send surface is
  enabled. `unlock_safety_warning_shown_at` is committed only when the warning is actually rendered
  in a chat-open response; a failed push leaves it pending for the next open.
- `last_read_at` remains the canonical domain timestamp. M6 also stores
  `last_read_sequence_number` as a derived monotonic implementation cursor for scalable unread
  queries; it cannot exceed the highest committed sequence and never moves backward.
- `ChatParticipant.muted_at` suppresses only that session's `new_chat_message` Telegram delivery.
  The global `NotificationPreference.chat_enabled` suppresses all normal chat Telegram deliveries.
  Either mute suppresses transport creation, never durable in-app Notification history. Critical
  safety/payment/admin/ban/restriction categories still bypass mutable preferences.
- The recipient of a user message is the other stored Match participant, never a command field.
  System messages do not create a message notification unless a named workflow explicitly requires
  one.
- The normal chat projection exposes at most the newest 50 live messages. Cleanup is asynchronous
  and bounded, but reads enforce the same 50-message ceiling even before cleanup catches up.
- Unmatch is permanent and symmetric, creates no NotInterested, permits reporting for exactly 24
  hours from database time, and sends one durable `chat_closed` Notification to the other user.

## 5. Forward-only migration sequence

1. `000040_m6_chat_catalog_messages.sql` — predefined set/question/answer catalogs and seeds,
   ChatMessage, participant read cursor, payload/lifecycle guards, and sequence/history indexes.
2. `000041_m6_unmatch.sql` — UnmatchRecord, Match/pair/chat closure constraints, report deadline,
   replay identity, lifecycle indexes, and closure integrity.
3. `000042_m6_notification_delivery.sql` — delivery lease owner/expiry, monotonically increasing
   fence token, provider progress, retry availability, sanitized result metadata, claim indexes, and
   guarded transitions.
4. `000043_m6_chat_retention.sql` — immutable ChatMessageSnapshot, cleanup candidates/checkpoints,
   audit-safe snapshot hash, restricted grants, and query-plan indexes. `report_id` is a typed UUID
   without a live foreign key until M7 creates `moderation.reports`; M7 adds that forward-only key.
5. `000044_m6_localization.sql` — all prompt set/question/answer keys, chat capability, safety,
   closure, mute/read, retry-safe user errors, and Telegram relay presentation.

Every migration must bootstrap from empty, upgrade from `000039`, replay unchanged, and have matching
verification SQL. Applied migrations are immutable. Catalog references use `ON DELETE RESTRICT` and
catalog entries are deactivated, never deleted. Database roles prevent generic workers, analytics,
and support code from reading message text or snapshots.

The predefined seed sets and their canonical meanings are exactly:

1. `relationship_intent`
2. `ideal_first_date`
3. `chat_frequency`
4. `social_energy`
5. `weekend_habits`
6. `calls_or_texting`
7. `important_values`
8. `meeting_in_person`
9. `relationship_pace`
10. `current_life_focus`

Their English content and choices come from `docs/domain/03-attributes.md`; migrations store stable
codes and localization keys, not prose in handlers.

## 6. Persistence invariants

### 6.1 Prompt catalog and messages

Prompt sets, questions, and answers have stable unique codes or IDs, localization keys, active
flags, and deterministic display order. An answer belongs to exactly one question. Existing message
references remain valid after deactivation.

`chat.chat_messages` stores session, sequence, sender, type, one typed payload, database creation
time, and immutable normalized content. Checks enforce:

- `predefined_question` has sender and only an active question reference at send time;
- `predefined_answer` has sender and only an answer reference tied to the selected question context;
- `text` has sender and normalized non-empty text only;
- `system` has no sender and has bounded localization key plus validated safe arguments;
- sender is one of the two ChatParticipants;
- `(chat_session_id, sequence_number)` is unique and message rows are update-immutable.

The session allocator advances from `n` to `n + 1` in the same transaction that inserts sequence
`n`. One idempotency record binds actor, session, message kind, and normalized payload digest to the
resulting message. Identical replay returns that message; a changed replay rejects.

### 6.2 Read, mute, and safety-warning state

ChatParticipant retains canonical `last_read_at`, optional `muted_at`, warning time, derived read
sequence, and version. Read advancement is monotonic and clamps to an existing sequence authorized
for that participant. Replays are no-ops. Mute/unmute is an explicit desired state with optimistic
version/idempotency protection; timestamp presence represents the current state.

Showing the safety warning is a monotonic one-time transition. Notification delivery success alone
does not mark it shown because provider acceptance does not prove the participant saw it.

### 6.3 Unmatch

`matching.unmatch_records` uses `match_id` as its unique identity and stores actor, bounded optional
reason code, `unmatched_at`, exact `report_window_expires_at = unmatched_at + interval '24 hours'`,
and command identity. The actor must be a Match participant. The record is immutable.

The same commit transitions Match `active -> unmatched`, pair `matched -> unmatched`, ChatSession
`active -> closed(unmatch)`, closes active Likes as `closed_by_unmatch`, makes Match-scoped unlock
ineffective through lifecycle joins, creates the other participant's closure Notification, and
records outbox work if their current preference permits Telegram delivery. No ordinary refund is
created and no old interaction can reactivate.

### 6.4 Notification delivery

The M4 Notification remains the durable in-app fact. One Delivery per Notification/channel stores
status, attempt number, provider progress, next availability, lease owner/expiry, fence token,
sanitized failure code, optional opaque provider message key, timestamps, and version.

Only `pending|failed_retryable` may be claimed. Claim uses `FOR UPDATE SKIP LOCKED`, increments the
attempt and fence, and grants a short lease. Settlement requires delivery ID, owner, and exact fence.
A stale worker cannot mark sent or schedule a retry. Known Telegram success stores only the opaque
message ID/key. A request that may have reached Telegram but has no response is `ambiguous`, is not
blindly repeated, and is quarantined/alerted for reconciliation. Provider 429 honors bounded
`retry_after`; temporary transport/5xx uses capped full-jitter backoff; bot-blocked, chat-not-found,
and invalid-recipient failures are terminal.

Delivery payloads and queue jobs contain opaque delivery/notification/message IDs and schema
version only. The claimed worker loads a least-privilege rendering projection after authorization.
Provider errors are mapped to finite safe codes; raw responses, chat text, Telegram IDs, usernames,
phone numbers, tokens, and provider request bodies never enter logs or database failure fields.

### 6.5 Retention and snapshots

`chat.chat_message_snapshots` is append-only and stores report UUID, session, original message UUID
without a live message foreign key, sender, message type, immutable content representation,
original/snapshot times, and SHA-256 integrity hash. A unique report/message key makes capture
idempotent. Only the internal report transaction port may create snapshots; M6 tests use that port,
and M7 binds it to an authorized Report.

Cleanup locks one session, computes the 50th newest visible sequence, snapshots any externally
marked report context not already captured, then deletes only older live messages in bounded
batches. It never deletes a message whose required snapshot failed. A crash between snapshot and
delete replays safely. Snapshot rows are not returned by normal chat queries.

## 7. Lock order and transaction boundaries

Use database time and preserve the global order:

1. actor Account/User/Profile capability rows;
2. normalized pair advisory lock, UserPairState, and Match;
3. ChatSession, then ChatParticipants in stable user-ID order;
4. ChatMessage/idempotency or UnmatchRecord/source interaction rows;
5. FeatureUnlock/funding only for paid-unlock workflows already owned by M4;
6. Notification, Delivery, audit, outbox, and inbox facts.

Message sends lock the ChatSession before reserving a sequence. Mark-read and mute lock only the
actor's ChatParticipant after authorizing the Match/session. Unmatch takes the pair lock before the
Match and ChatSession, matching M3/M5 pair operations. Cleanup locks a ChatSession and its selected
message rows but does not lock Accounts or call providers.

External Telegram calls never occur in a business transaction. Product commits create Notification,
Delivery, and outbox facts first. A worker later claims and calls Telegram outside the transaction,
then conditionally settles under its fence.

## 8. Canonical use cases

### 8.1 Open chat and capability

Bind the authenticated user to a stored participant; load active Match/session, pair safety state,
Account capability, effective Match-scoped unlock, participant mute/read/warning state, and active
prompt catalog. Return explicit capabilities for predefined send, text send, mute, read, and
unmatch. Never return payer identity or another user's Telegram identity.

If unlocked and the warning is pending, render the localized safety warning and atomically mark the
participant's warning timestamp. Only then return text-send capability. Reopen/replay does not show
it twice.

### 8.2 Send predefined question or answer

Validate the signed current-chat action, actor membership, active prompt row, and answer/question
relationship. Recheck current Account/Match/pair/session state, lock the session, reserve a
sequence, insert the message, and create one recipient Notification plus permitted Delivery/outbox
in one commit. Unlock is not required. Duplicate command returns the same message/sequence and does
not notify twice.

### 8.3 Send free text

Reject all attachment/update kinds before content processing. Normalize and validate the text,
then recheck participant, safe active lifecycle, effective Match-scoped unlock, and that actor's
shown safety warning. Lock the session, reserve a sequence, insert immutable text, and create the
recipient Notification/delivery intent atomically. Unlock closure/revocation racing send produces
either a fully committed authorized message or no message.

### 8.4 Page, read, and mute

`GetChatPage` binds actor membership and returns at most 50 live messages newest-first with a signed
opaque sequence cursor; presentation may reverse one page for display. It resolves predefined and
system localization keys in the viewer's locale. It never exposes another user's internal or
Telegram identity.

`MarkChatRead` advances through an authorized existing sequence and records database time.
`ChangeChatMute` sets or clears the session mute. Both are idempotent, actor-bound, and independent
from global category preferences.

### 8.5 Unmatch

Authorize either participant and acquire the pair lock. In one transaction create/replay the unique
UnmatchRecord, permanently change pair/Match state, close the ChatSession, close related Likes,
invalidate effective scoped access through lifecycle, and create exactly one chat-closed history
Notification for the other participant. Concurrent unmatch calls converge to one record; the
winner's actor and timestamp remain immutable. The report capability is true before the exact
deadline and false at or after it.

### 8.6 Notification dispatch and retry

Outbox dispatch enqueues the opaque Delivery ID. A worker claims under a lease/fence, reloads current
delivery state and least-privilege recipient/rendering data, escapes Telegram formatting, and calls
the adapter. Known success, retryable failure, terminal failure, and ambiguous outcome each use a
separate fenced settlement. Duplicate queue jobs and former lease owners cannot produce a second
settlement.

For `new_chat_message`, the rendering projection verifies that the recipient still belongs to the
session and the message still exists. It may include a safe Profile alias and localized context but
never Telegram username, numeric Telegram ID, phone number, forward attribution, or native profile
link. Reply buttons carry a short-lived signed current-chat token.

### 8.7 Cleanup and snapshot capture

The scheduler selects sessions above the live threshold in bounded keyset pages. Each job retains
the newest 50 live messages, captures required report context through the internal snapshot port,
and deletes only safe older rows. Concurrent sends are ordered by the locked session sequence;
concurrent snapshot requests either commit before deletion or make cleanup defer that message.
Failures retry without losing live or snapshot evidence.

## 9. Contracts and presentation

M6 contracts include open/capability, predefined question, predefined answer, free text, page,
mark-read, change-mute, unmatch, internal snapshot capture, cleanup, delivery claim, and delivery
settlement. Every user mutation carries actor, request/command/idempotency IDs, expected version
where applicable, locale, and typed data. Provider results are separate trusted adapter contracts.

Results expose opaque Match/session/message IDs, sequence/status/times, localized presentation
references, capability booleans, and signed cursors/actions. They never expose internal pair keys,
FeatureUnlock payer, ledger/payment facts, delivery lease/fence, another user's Account state, or
Telegram identity.

Telegram inbound text is treated as a command only when the user has an authenticated current-chat
context. Lost Redis/menu state is recovered from signed opaque context plus PostgreSQL authorization;
Redis is never the permission source. Stale buttons, changed payloads, cross-user tokens, closed
sessions, and unsupported updates return localized safe errors without side effects.

## 10. Security, observability, reconciliation, and retention

- Message text and snapshot content are sensitive. Never place them in logs, metrics, traces, queue
  data, audit metadata, notification payload JSON, provider failure fields, or alert text.
- Metrics use finite labels for send kind/outcome, authorization denial reason, delivery result,
  retry class, backlog count/age, cleanup count/age, snapshot failure, and Unmatch outcome.
- Alert on oldest due delivery age, retry/terminal/ambiguous spikes, expired leases, cleanup backlog,
  snapshot-before-delete failure, sequence drift, participant mismatch, or notification cardinality
  mismatch.
- Reconciliation checks session/Match participant equality, sequence allocator versus maximum
  message, read cursor bounds, message payload shape, active prompt references, Unmatch lifecycle,
  closure Notification cardinality, delivery lease/state shape, and live-message ceiling.
- Safe repairs use normal idempotent commands. Contradictory lifecycle, ambiguous provider outcome,
  or missing evidence is quarantined; reconciliation never invents a message, send receipt, report
  snapshot, or Unmatch.
- Update `17-data-retention-registry.md` in the schema checkpoint for prompt catalogs, live messages,
  snapshots, Unmatch records, and notification delivery metadata. M8 must enumerate them in deletion
  verification.

## 11. Acceptance and fault matrix

- `ACC-031`: simultaneous Unmatch/replay produces one permanent symmetric state, closes chat/Likes,
  never creates NotInterested, and permits reporting before `deadline` but rejects at the exact
  24-hour boundary;
- `ACC-032`: M4's concurrent unlock remains one charge/grant and both participants gain effective
  M6 text capability after their warning is shown;
- `ACC-033`: fake-clock tests prove no time expiry while Match closure, Chat closure, or entitlement
  revocation immediately denies text;
- `ACC-034`: adapters and application commands reject pre-unlock text, free-form emoji, photos,
  media, forwarded messages, voice, video, files, and stickers with no message/notification;
- `ACC-035`: sessions with concurrent sends and report capture expose/retain exactly the newest 50
  live messages while immutable snapshots survive cleanup and replay;
- `ACC-038`: session mute and global chat preference suppress normal Telegram delivery but not
  Notification history; payment and safety notices always create delivery;
- 20 concurrent message sends allocate 20 unique contiguous committed sequences and 20 or fewer
  deduplicated recipient Notifications as dictated by command identity;
- cross-user session/message/cursor/action attempts are denied without existence leaks;
- duplicate jobs, expired leases, stale fences, 429, timeout, 5xx, blocked bot, recipient gone,
  malformed provider response, and ambiguous outcome reach only legal delivery states;
- migration bootstrap/upgrade/replay, immutable guards, localization completeness, retention
  registry, backup/restore, reconciliation faults, and production-volume history/due/cleanup query
  plans pass.

Tests assert committed PostgreSQL facts, not only DTOs. Concurrency uses independent connections and
barriers. Fake providers/time are deterministic. Real provider behavior is claimed only in staging.

## 12. Delivery checkpoints

1. execution guide, M6 contracts, and pure text/capability/retry/retention policies;
2. prompt catalog/message migrations, localization seeds, sequence allocation, and predefined send;
3. effective unlock, safety-warning handoff, free-text send, and `ACC-032..034` lifecycle evidence;
4. history page, monotonic read cursor, session/global mute, and notification-history policy;
5. permanent Unmatch transaction, exact report window, closure notification, and `ACC-031` races;
6. notification claim/lease/fence, Telegram adapter, provider failure matrix, and `ACC-038` delivery;
7. snapshot capture, bounded 50-message cleanup, retention registry, and `ACC-035` races;
8. reconciliation, query-plan/load gates, M6 metrics, alerts, runbook, and acceptance ledger;
9. real Telegram relay/delivery staging evidence.

After every checkpoint run formatting, lint, type checking, unit tests, build, migration
bootstrap/upgrade/replay, relevant integration/fault tests, and GitHub CI. Push one locally green
checkpoint and wait for that exact commit to turn green before advancing.

## 13. Definition of done

M6 is code-complete only when all `ACC-031..035` and `ACC-038` M6 evidence, migrations, delivery
failure tests, authorization tests, reconciliation, retention/snapshot tests, production-shaped
plans, operations docs, and CI are green. It is production-ready only after the same immutable
release passes real Telegram relay, mute, 429, blocked-user, timeout, ambiguous-result, retry,
worker-crash, rollback, alert, and cleanup drills with named backend/product/operations/security
sign-off. Without infrastructure it may be called **code complete / staging blocked**, never live.
