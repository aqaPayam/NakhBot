# M7 Execution Guide — Reporting, Moderation, Administration, Support, and Appeal

Status: approved implementation guide for M7. This guide converts the canonical reporting,
restriction, review, admin, internal-block, support, appeal, privacy, and acceptance rules into an
ordered backend plan.

## 1. Authority and boundary

1. The domain documents remain authoritative for product behavior.
2. Existing identity, Profile, media, interaction, Match/chat, payment, notification, security,
   localization, retention, testing, and deployment rules remain mandatory.
3. This guide owns M7 sequencing, report reasons, evidence authorization, immutable snapshots,
   distinct-reporter threshold restriction, moderation review/actions, internal blocks, admin RBAC
   and attempted-command logs, support limits, ban appeals, and evidence for `ACC-039..041`.
4. M7 reuses Account/AccountStateHistory, UserPairState, Match/chat closure, photo moderation,
   Notification/Delivery, M6 ChatMessageSnapshot, durable rate-limit records, audit, inbox, and
   outbox models. It must not create alternate Account, pair, media, notification, or chat state.
5. Provider-neutral application and persistence evidence may complete before infrastructure exists.
   Real Telegram admin/moderation/support behavior remains a staging gate.

M7 delivers confidential reporting with immutable evidence, race-safe five-distinct-reporter
restriction, explicit human review, authorized moderation actions, internal safety blocks, complete
admin attempt logging, bounded support, and one appeal per ban event. A Report alone never bans.

## 2. Non-goals

Do not add user-visible blocking, automated banning, ML content moderation, face/age verification,
public moderation reasons, reporter disclosure, unrestricted operator search, bulk report export,
arbitrary chat browsing, manual business-table edits, user-created admin accounts, multi-tenant
roles, legal retention-duration decisions, account deletion, or production activation. M8 owns the
deletion/retention purge saga. M9 owns production activation.

M7 does not reopen M2 photo lifecycle, M3/M5 interaction state, M6 Unmatch/report window or message
retention. It calls their public ports under one coordinator and preserves their invariants.

## 3. Required ownership

```text
packages/domain/src/moderation/          # pure reason, text, threshold, review and appeal policies
packages/contracts/src/m7.ts             # strict user/admin/support channel-neutral contracts
packages/application/src/moderation/     # report, threshold, review, action and evidence ports
packages/application/src/administration/ # RBAC and attempted-command execution boundary
packages/application/src/support/        # support and appeal handlers/ports
packages/persistence-postgres/src/       # M7 repositories and cross-module coordinator stores
packages/telegram/src/                   # signed user/admin actions and localized presentation
apps/api/src/                            # provider-neutral authenticated M7 endpoints
apps/telegram-gateway/src/               # user report/support and admin command ingress
apps/scheduler/src/                      # bounded reconciliation/health sampling only
migrations/000046..                      # forward-only M7 schema, seeds and hardening
```

Moderation owns Report, evidence, snapshot, review, action, threshold, and appeal decisions.
Administration owns admin identity, RBAC, and attempted-command logging. Support owns support
threads/messages. Other modules remain the only writers of their Account, photo, pair, Match/chat,
and Notification state.

## 4. Locked decisions and constants

- Reporter and target are resolved server-side and must differ. Commands never accept an effective
  reporter, target, admin identity, Account state, or permission from client data.
- User reports use one active seeded reason and optional NFC-normalized, outer-trimmed text of at
  most 1024 Unicode scalar values. Empty normalized optional text becomes absent.
- A user may submit at most 10 committed Reports in the rolling prior 24 hours using database time.
  A Report at the exact 24-hour boundary no longer counts. Replays do not consume another slot.
  System/admin safety work does not consume this user limit.
- Evidence types are exactly `profile`, `photo`, `chat`, `message`, and `unmatched_user`. Each
  evidence row has exactly one matching reference. Catalog codes are stable and rows are
  deactivated, never deleted.
- A Nakh receiver's Report action authorizes a target-Profile report through the authoritative Nakh
  relationship; Nakh is not a sixth evidence type and its text is not copied into Report metadata.
- Client evidence references are short-lived, opaque, actor-bound intents. PostgreSQL remains the
  permission source and rechecks the underlying relationship at commit time.
- Mutable evidence is snapshotted in the Report transaction. Snapshot payloads are versioned,
  minimally scoped, application-encrypted, hash-protected, immutable, and readable only through an
  audited safety-review capability.
- Message evidence uses the existing M6 `chat.chat_message_snapshots`; M7 adds its Report foreign
  key. Other mutable evidence uses `moderation.report_snapshots`. A Report never stores content in
  outbox, queue, log, metric, audit metadata, admin log metadata, or Notification payload JSON.
- The automatic threshold is at least 5 distinct reporters with unresolved `submitted` or
  `pending_review` Reports in the rolling prior 30 days, across every evidence type at target-User
  level. Multiple Reports from one reporter count once.
- Threshold evaluation uses database time and a target-User advisory lock. One active threshold
  episode creates at most one system restriction action and at most one Account transition.
- Threshold restriction is not a ban, does not expire automatically, and remains until an
  authorized admin decision. An already restricted target is prioritized without another state
  transition. Banned/deleted targets retain prioritized reports without an illegal transition.
- An individual report is confidential and creates no target notice. The threshold Account
  restriction creates one non-mutable safety Notification without reporter/evidence identity.
- Only an active AdminUser with the exact required permission may view restricted evidence or run a
  mutation. Role names alone never authorize a command.
- Every state-changing admin attempt requires explicit target confirmation and bounded reason, and
  commits exactly one `succeeded`, `rejected`, or `failed` AdminActionLog. Sensitive views create a
  separate append-only access audit.
- Admin mutation reasons are required and limited to 1024 normalized Unicode scalar values. Review
  decision notes and appeal admin notes are optional and limited to 2000 after normalization.
- Internal block is moderation-only, silent to both users, normalized and symmetric. It closes
  active pair state through the existing lifecycle coordinator. Removing it restores no prior
  Match, Like, Nakh, Chat, FeatureUnlock, or Explore eligibility/consumption.
- Non-banned users use Support; banned users use UserAppeal. Support allows at most two unanswered
  user messages across open threads. One appeal is allowed per AccountStateHistory ban event.
- Support and appeal text is required, normalized, non-empty, and at most 2000 Unicode scalar
  values. It is restricted content and never general telemetry.

## 5. Forward-only migration sequence

1. `000046_m7_reports.sql` — moderation schema, seeded reasons, Report, durable user report window,
   replay binding, lifecycle/index/immutability guards, and least-privilege grants.
2. `000047_m7_report_evidence.sql` — typed evidence, encrypted/versioned ReportSnapshot,
   M6 ChatMessageSnapshot Report foreign key, content hashes, access audit, and retention indexes.
3. `000048_m7_threshold_reviews_actions.sql` — target lock support, restriction episode identity,
   ModerationReview, append-only ModerationAction, threshold/review indexes, and safety audit links.
4. `000049_m7_review_consistency_fix.sql` — forward-only row-shape-safe deferred consistency fix
   for Report and ModerationReview trigger sources.
5. `000050_m7_administration.sql` — AdminUser, role/permission catalogs and joins, attempted-command
   log, evidence-access log, bootstrap constraints, and immutable RBAC seed codes.
6. `000051_m7_support_appeals.sql` — SupportThread/SupportMessage, per-ban UserAppeal uniqueness,
   unanswered-count support, lifecycle guards, and restricted-text grants.
7. `000052_m7_appeal_admission.sql` — exact current-ban ownership, immutable submission replay,
   and appeal deletion guards.
8. `000053_m7_appeal_unban.sql` — immutable accepted-appeal, Account transition, moderation action,
   and successful admin-attempt evidence.
9. `000054_m7_localization.sql` — report reasons/surfaces, safe restriction/ban notices, admin
   outcomes, support, appeal, stale-action, rate-limit, and generic authorization/error keys.
10. `000055_m7_review_decisions.sql` — explicit dismissal action shape and terminal-review guard.
11. `000056_m7_action_report_scope.sql` — report-linked admin target/assignment and successful-attempt guards.
12. `000057_m7_evidence_access_identity.sql` — admin-bound evidence access command identity, preserving existing audit rows.
13. `000058_m7_unmatch_report_deadline.sql` — post-lock database-time enforcement of the immutable unmatch report window at evidence insertion.
14. `000059_m7_photo_evidence_holds.sql` — exact retained photo variant and content binding.
15. `000060_m7_photo_evidence_cleanup.sql` — hold-aware storage cleanup guards.
16. `000061_m7_photo_capture_complete.sql` — complete capture/hold requirement at commit.
17. `000062_m7_reconciliation.sql` — moderation run/anomaly types in the shared reconciliation
   registry, support/appeal status keyset indexes, and immutable subject-bound support/appeal access
   audits linked to exact admin attempts.
18. `000063_m7_operational_indexes.sql` — queue ages, all-status support admission and latest
   completed moderation scan indexes, verified on empty bootstrap and every recorded upgrade baseline.

Every migration must bootstrap from empty, upgrade from `000045`, replay unchanged, and have
matching verification SQL. Applied migrations are immutable. No migration seeds an enabled admin
identity or real Telegram ID. Roles/permissions are code-owned seeds; operator assignments require
an explicit audited bootstrap command after staging identities exist.

## 6. Persistence invariants

### 6.1 Reports, limits, and replay

`moderation.reports` stores reporter, target, active reason, normalized optional text, status,
database lifecycle times, version, and request identity. Checks reject self-report and invalid
status/timestamp shapes. One request digest binds reporter, target, reason, text, ordered evidence,
and source relationship; identical replay returns the same Report, changed replay rejects.

The daily limit is admitted under a reporter advisory lock from committed Reports in the exact
rolling 24-hour window. The limit and Report commit together. Target threshold evaluation occurs
under a separate target lock after the Report/evidence/snapshots exist in the same transaction.

### 6.2 Evidence and snapshots

`moderation.report_evidence` enforces exactly one typed reference, unique typed references within a
Report, and at least one evidence row before the Report transaction can commit. Live foreign keys
use restricted deletion behavior until their immutable snapshot exists; ordinary cleanup cannot
remove required evidence first. Authorization is type-specific:

- `profile`: an actor-bound recent product relationship resolved from authoritative history;
- `photo`: same relationship plus the target's referenced ProfilePhoto;
- `chat`: reporter is a stored participant in that Match/Chat relationship;
- `message`: reporter is a participant and the message belongs to that ChatSession;
- `unmatched_user`: reporter is either participant and database time is before the exact M6
  `report_window_expires_at` boundary.

Profile/photo/chat/unmatch snapshots contain only the minimum reviewed schema fields. Media
snapshots retain a restricted object/evidence reference and digest rather than embedding image
bytes. Message capture calls the M6 internal snapshot port in the Report transaction. Snapshot
ciphertext records key ID/version, nonce, schema version, hash, and creation time; plaintext never
crosses the repository boundary except through an authorized audited review projection.

### 6.3 Threshold restriction

The threshold query uses `(target_user_id, reporter_user_id)` distinctness, unresolved statuses,
and `submitted_at > database_now - interval '30 days'`; a Report at the exact boundary is expired.
Under the target lock, a crossing creates
or replays one threshold episode, system ModerationAction, AccountStateHistory restriction, safety
audit, safety Notification, Delivery/outbox fact, and priority review state.

Unrestricting closes the active episode but does not dismiss Reports. A later episode is possible
only after an authorized resolution and a new threshold evaluation; it has a new stable episode ID.
No threshold path contains a ban transition.

### 6.4 Reviews and moderation actions

One ModerationReview belongs to one Report. Assignment and state/version transitions are explicit:
`pending -> in_review -> dismissed|actioned`. Report status changes separately and must agree with
the final review outcome. Decision notes/reasons are bounded restricted text.

ModerationAction is append-only. System may only create `restrict_user` for a threshold episode.
Authorized admins may dismiss, keep/unrestrict/restrict, ban/unban, hide/restore/delete a photo,
create/remove an internal pair block, and review change requests through named commands. Each action
stores the exact target and source Report when applicable, never a free-form metadata copy of
evidence.

### 6.5 Admin authorization and logging

AdminUser maps one internal User and verified Telegram identity snapshot. Disabled admins, inactive
roles, or missing permissions deny before evidence reveal or mutation. Super-admin is a seeded role,
not a bypass in code; it receives explicit permission rows.

A state-changing admin command has one unique actor-bound command ID and request digest; identical
replay returns the recorded outcome and changed replay is rejected without repeating an effect. It
runs in an outer transaction with a savepoint around its business effect. Expected
authorization/domain rejection rolls back to the savepoint, inserts one immutable
`rejected` AdminActionLog, and commits no business mutation. Unexpected safe failure rolls back to
the savepoint and records `failed`. Success records `succeeded` in the same outer transaction as the
effect. Connection/transaction loss commits neither effect nor log and the durable command inbox
retries. Logs contain command code, opaque target type/ID, result, correlation, finite safe code,
and time—never report/support/chat text, decrypted snapshots, Telegram IDs, or secrets.

### 6.6 Support and appeal

Support admission locks the User's open threads, counts user messages after the newest admin/support
reply, and atomically rejects a third unanswered message. A reply starts a new count segment. Banned
users cannot open/send Support messages.

Appeal admission locks the exact AccountStateHistory ban event and enforces one UserAppeal by unique
foreign key. Only the currently affected User may appeal. Accepted appeal authorizes a separate
admin unban command; rejection is terminal for that ban event. Appeal status alone never mutates
Account state.

## 7. Lock order and transaction boundaries

Use database time and preserve the global order:

1. authenticated actor User/Account or AdminUser/RBAC rows;
2. reporter/source relationship rows;
3. target-User advisory lock, target Account and AccountStateHistory;
4. normalized pair advisory lock, UserPairState, Match/Chat when an action affects a pair;
5. Profile/ProfilePhoto/MediaAsset for photo actions;
6. Report, evidence, snapshots, review, action, support, or appeal rows;
7. Notification, safety/access/admin audit, outbox, inbox, and idempotency facts.

Report creation locks reporter admission before target threshold state. Two reciprocal reports
therefore lock reporter IDs and target IDs independently, never two User rows in command order.
Cross-user moderation uses normalized UUID order where both Accounts are required.

External Telegram, object storage, KMS, and telemetry calls never occur in a business transaction.
Versioned envelope keys are loaded before entering a transaction. Bounded local snapshot encryption
captures the locked source inside the short commit; only ciphertext/digests persist. Photo object retention/cleanup uses
existing outbox workers after the database decision.

## 8. Canonical use cases

### 8.1 Prepare and submit a Report

The presentation adapter asks the application for an actor-bound evidence intent based on the
current rendered surface. Submission resolves that intent, validates active reason/text, rechecks
the relationship, admits the durable limit, writes Report/evidence/snapshots, evaluates the target
threshold, and creates any one restriction episode atomically. Response exposes only the Report's
opaque ID, safe status, and localized acknowledgement.

### 8.2 Review a Report and reveal evidence

Queue queries are keyset-only and return metadata before content: reason code, evidence types,
status, age, priority, and aggregate prior-report context without reporter identity. Evidence reveal
requires `view_reports` plus target-scoped confirmation, decrypts only the selected snapshot, and
writes an access audit whether reveal succeeds or is rejected. No bulk export exists.

### 8.3 Apply an Account or photo action

Resolve the signed admin command to one AdminUser and required permission. Recheck target/version,
require explicit confirmation/reason, then call the owning module's public command. Account
restrict/ban/unrestrict/unban writes AccountStateHistory and critical Notification. Photo actions use
the M2 moderation path, revoke delivery before hide/delete becomes visible, and re-evaluate Profile
completion/primary photo. The admin wrapper records the attempt result as defined above.

### 8.4 Create or remove an internal block

Require `manage_internal_blocks`, normalized pair identity, reason, and confirmation. Creation uses
the Match lifecycle coordinator to set `blocked`, close active Match/chat/Likes and scoped access,
and suppress user notification. Removal deletes/ends only the block state; the pair returns to no
stored pair state and old product state remains closed.

### 8.5 Support and appeal

Support commands authorize a non-banned User and enforce the two-unanswered limit before committing
restricted text. Admin replies require `review_support` and are attempted-command logged. A banned
User is routed only to one appeal for the current ban history. Appeal review requires
`review_appeals`; acceptance then invokes the separately permissioned unban command.

## 9. Contracts and presentation

M7 contracts include prepare/submit Report, report metadata page, claim/assign/review, evidence
reveal, Account/photo/internal-block actions, support open/send/reply/close, appeal submit/review,
admin bootstrap/disable/role assignment, reconciliation, and operational-health queries.

Every user mutation carries actor and request/command IDs plus strict typed data. Every admin
mutation also carries expected target version, permission-specific signed action, confirmation,
bounded reason, and correlation. Results expose opaque IDs, status/version/times, finite codes, and
localized presentation references. They never expose reporter identity to the target, decrypted
evidence in list views, RBAC internals to users, Telegram identity, or raw failure data.

Telegram callbacks are short-lived and actor/admin-bound. Lost Redis/menu state is recovered from
signed opaque context plus PostgreSQL authorization. Stale buttons, cross-admin actions, disabled
admins, changed targets, missing permissions, and changed replays return localized safe errors and
still satisfy admin attempt logging where a mutation was attempted.

## 10. Security, observability, reconciliation, and retention

- Report, support, appeal, review-note, and snapshot content is restricted. Never place it in logs,
  traces, metrics, queues, outbox payloads, Notifications, admin metadata, or acceptance artifacts.
- Metrics use finite labels for report outcome/evidence type, limit denial, threshold outcome,
  review age/outcome, moderation action/result, admin denial/result, support/appeal outcome, and
  reconciliation phase. IDs, reason text, catalog reason code, locale, and content are forbidden
  labels.
- Alert on report/review backlog age, fifth-report restriction failure, Account/action mismatch,
  unlogged admin mutation attempt, evidence-decrypt/hash failure, snapshot cardinality drift,
  expired review lease, and reconciliation/health-sampling failure.
- Reconciliation verifies Report/evidence/snapshot shape, M6 message snapshot FK/cardinality,
  threshold distinctness/episode/Account/action/Notification agreement, review/report state,
  action/owning-module state, internal-block closures, RBAC/log integrity, support unanswered count,
  and appeal/ban-history uniqueness.
- Safe repairs use reviewed idempotent commands. Missing/invalid evidence, contradictory Account or
  photo state, unlogged mutation, or snapshot-integrity failure is quarantined; reconciliation never
  invents evidence, reporter identity, admin authorization, decision, block, or appeal outcome.
- Update `17-data-retention-registry.md` in the schema checkpoint for Reports, evidence/snapshots,
  reviews/actions, admin/access logs, support, and appeals. M8 must enumerate each in deletion and
  retained-safety verification.

## 11. Acceptance and fault matrix

- `ACC-039`: five Reports from one reporter do not restrict; five distinct unresolved reporters in
  the rolling 30-day window restrict once; dismissed/actioned/closed and boundary-expired Reports do
  not count;
- `ACC-040`: 20 concurrent candidate fifth Reports create one threshold episode, one system
  restriction action, one Account transition/history, one safety Notification/delivery intent, no
  automatic ban, and no duplicate reporter contribution;
- `ACC-041`: every admin mutation permission combination is tested; success, domain rejection,
  missing permission, stale target, injected failure, replay, and worker crash produce the required
  business state and exactly one immutable attempt result;
- self-report, forged/expired/cross-user evidence, over-limit report, changed replay, post-Unmatch
  exact deadline, and deleted evidence fail without partial Report/snapshot/threshold state;
- snapshot encryption/hash tamper, missing key version, M6 capture failure, photo retention failure,
  and transaction rollback never expose or lose required evidence;
- report dismissal racing fifth submission yields one serializable threshold/review outcome;
- internal block racing Match/chat/send closes safely and removal restores no old product state;
- support third-unanswered-message races admit none beyond two, and one ban event admits one appeal
  across concurrent distinct commands;
- migration bootstrap/upgrade/replay, immutable guards, RBAC seeds, localization completeness,
  retention registry, backup/restore, reconciliation faults, and production-volume report/review
  query plans pass.

Tests assert committed PostgreSQL facts, not only DTOs. Concurrency uses independent connections and
barriers. Fake clocks/keys/providers are deterministic. Real Telegram/admin behavior is claimed only
in staging.

## 12. Delivery checkpoints

1. execution guide, M7 contracts, and pure report/text/threshold/RBAC/support/appeal policies;
2. Report reason/schema, durable user limit, replay, evidence authorization, encrypted snapshots,
   M6 message-snapshot FK, and retention registry;
3. distinct-reporter threshold transaction, restriction episode, Account/safety
   Notification/audit integration, and `ACC-039..040` races;
4. AdminUser/RBAC seeds, signed admin identity, permission matrix, savepoint attempt logging, and
   evidence-access audit;
5. review workflow plus Account/photo moderation actions and their lifecycle coordinator effects;
6. internal block creation/removal and Match/chat/interaction closure races;
7. support and appeal persistence, limits, review commands, and concurrency evidence;
8. Telegram/API presentation, complete localization, privacy/adversarial tests, and static prose
   gate;
9. reconciliation, production query-plan/load gates, finite metrics, alarms, runbook, and acceptance
   ledger;
10. real Telegram moderation/admin/support/appeal staging evidence.

After every checkpoint run formatting, lint, type checking, unit tests, build, migration
bootstrap/upgrade/replay, relevant integration/fault tests, and GitHub CI. Push one locally green
checkpoint and wait for that exact commit to turn green before advancing.

## 13. Definition of done

### Current implementation evidence (2026-10-04)

Support and exact-ban appeal persistence, audited terminal reviews, and a separate permission-checked
unban command are implemented. The presentation work includes seeded English fallback keys and
privacy-safe notices; appeal review/unban confirmation tokens bind the authenticated admin, exact
command, target version, reason, and payload. Confirmation does not replace the transaction's RBAC
check or immutable attempted-command log.

The Telegram webhook now supports `/support [text]` and `/appeal [text]` behind
`NAKH_TELEGRAM_SUPPORT_APPEAL_ENABLED=false`. Enable it only for controlled staging with the bot token
and canonical 32-byte action-token key configured. Provider authentication precedes handling;
private-chat sender identity is resolved server-side. A stable bot/user/update command ID preserves
transactional replay across webhook retries. Restricted text is passed directly to its owning store,
never queued or interpolated in notices. Status lookup selects only the current exact ban's appeal
status. Banned support users receive an appeal prompt, and accepted appeals still require a separate
authorized unban.

Unit evidence covers routing, forged/group/bot updates, unsafe identifiers, rate denial, stable replay
identity, privacy, activation, and delivery failure. PostgreSQL integration evidence covers exact-ban
status projection and transactional submissions alongside the existing concurrency and migration
matrix. Replies use localized plain text after business commit; provider retries can duplicate a
notice but cannot duplicate the business write. No real Telegram delivery is claimed.

Support administration, account/photo actions, internal blocks, review assignment, and terminal
review decisions now have explicit confirmation boundaries. Current PostgreSQL permissions remain
authoritative. Photo delivery revocation failures are sanitized and recorded as failed attempts.
Review decisions use the target threshold lock, preserve assignee/version checks, and atomically
write matching Report/Review statuses, audit, and a content-free event. Dismissal writes its own
append-only ModerationAction under migration `000055`; actioned outcomes require a pre-existing
admin action linked to that Report and never execute another account/photo/pair action. Account and
photo confirmations now retain an opaque source Report context. Commit-time checks require the
matching target, unresolved Report and current assigned reviewer. Migration `000056` also enforces
linked action scope and deferred successful admin-attempt evidence. Finalizing a review never repeats
the underlying account/photo action.

Optional report review notes are normalized and encrypted before the transaction with a fresh
AES-GCM nonce and review/key-version associated data. The write capability exposes no reveal path.
Evidence covers ciphertext substitution/tampering, Unicode limits, concurrent retries, competing
confirmed decisions, changed replay, disabled admins, encryption failure, and partial-write rollback.
Migration evidence covers bootstrap, upgrades from `000045` and `000051`, and unchanged replay.

The provider-neutral report metadata handler authenticates queue-scoped admin actions, rechecks
current PostgreSQL permissions, and returns at most 50 metadata items. The default status is
`pending_review`; pages order threshold priority first, then submission time and report ID. Opaque
five-minute cursors bind admin/actor/status and preserve PostgreSQL microseconds. Lists include only
the contract's report ID, reason code, evidence types, status, priority, submission time, prior report
count and version. They expose neither reporter/target identity nor restricted content. Tests cover
pagination ties, forged/cross-scope/expired cursors, bounded reads, and disabled-admin access.

Profile-only report preparation and submission now support authoritative received-Like, received-Nakh
and successfully delivered discovery-card relationships, plus active matches. Match sources resolve
only the opposite stored participant and must remain active at submission; closed/unmatched handling
remains a separate pending flow. Reserved/failed deliveries and other viewers
cannot establish report evidence. Five-minute signed opaque references bind the reporter and retain source,
target and evidence IDs server-side. Preparation and commit recheck current account eligibility;
active and restricted users may report valid evidence, while guest/incomplete/banned/deleted routes
cannot submit a new report. Visibility is not used to retract an existing evidence relationship.
Other evidence selections fail explicitly. Nakh text is neither selected nor copied into evidence.

Submission locks reporter admission and target threshold state, reauthorizes the source, and captures
the locked Profile in the same transaction as the Report, typed evidence, pending review and safe
outbox event. AES-GCM snapshots bind report/evidence IDs, schema/type, key identity/version and content
hash; the write capability exposes no decryption method. The daily ten-report limit admits committed
reports only. Durable command/idempotency replay precedes expiring token resolution, returns the
original submission receipt and rejects changed data. Threshold evaluation captures one post-lock
database instant with microsecond precision, so transactions that started earlier count later commits.

Unit evidence covers token actor/purpose/expiry, typed encryption/tampering and authenticated replay.
PostgreSQL evidence covers real received-Nakh creation through the existing funded flow, unauthorized
sources, post-preparation bans, simultaneous duplicate submissions, ten-of-twelve admission, five
distinct reporters producing one restriction, older transaction start ordering, snapshot failure
rollback and content-free report events. Schema bootstrap/upgrade/replay evidence remains part of CI.
Report adapters remain disabled in ordinary startup; no real report delivery is claimed.

An internal profile reveal store now checks current permissions and decrypts the captured snapshot
inside the admin command transaction. A required actor-bound evidence access audit commits with the
sanitized admin outcome before plaintext can be returned. Missing keys, invalid snapshots and denied
permissions release no content; audit failures abort the whole attempt. Concurrent retries return
one content result and one audit. Replays never decrypt or reload content. Keys must be preloaded;
the transaction performs bounded local cryptography only. The confirmed reveal service binds actor,
command, opaque evidence target, selected evidence ID and normalized reason. Evidence uses immutable
version 1; client IDs cannot override opaque targets. Commit-time permission checks reject revoked
roles even after confirmation. Transport integration remains outstanding.

Selected-report evidence metadata is bounded to five entries and scoped by a current report-version
action token. It returns only report/evidence IDs, evidence types and snapshot schema versions;
queries do not select content, ciphertext, key metadata or user identities. Stale report menus,
cross-actor requests and disabled admins cannot use this read path.
The evidence selection service issues actor-bound opaque reveal actions only for supported profile
schema 1 snapshots. It reloads verified admin identity and current permission when issuing each
action; token storage runs outside SQL transactions. Integration evidence connects the report menu,
metadata selection, opaque action, exact confirmation, historical snapshot and committed access audit.

The authenticated report-reason catalog returns at most 50 active codes and localization keys in
configured display order, without database IDs. Current account eligibility is checked under a shared
lock; active and restricted users can read it, while banned or missing accounts cannot. Submission
still rechecks reason activation independently, so a cached menu never authorizes a disabled reason.

The internal chat snapshot codec now encrypts only the session ID and lifecycle state, with strict
schema/lifecycle validation, fresh nonces and report/evidence/type/key/hash binding. Its reader rejects
message text, participant identities, extra fields, unsupported envelopes and tampering. Chat-only preparation resolves a signed
match context through current account eligibility, active Match/ChatSession state and stored chat
participation. Either participant can receive a typed opaque intent for the opposite participant;
outsiders, unrelated sources, mixed evidence selections and closed contexts are rejected.
Chat submission now uses the shared report transaction for durable replay, rolling admission,
encrypted capture, review/outbox creation and distinct-reporter threshold evaluation. The locked
session must still be active and belong to the same exact prepared relationship. Existing profile
entry points retain their original replay digest namespace. Integration evidence covers simultaneous
retries, token loss, changed replay, closed-session denial, snapshot rollback, ten-of-twelve admission
and five distinct chat reporters causing one restriction. Confirmed chat reveal now shares the
current-permission admin transaction and required access audit. A trusted reader registry limits
supported evidence types; chat content must match the immutable evidence session reference.
Concurrent confirmed retries release one captured result, even after the live session closes, and
never decrypt on replay. Invalid references fail with a sanitized outcome and rejected access audit.

Post-unmatch preparation now accepts a separate actor-bound opaque context for either stored
participant. It checks the immutable M6 deadline with PostgreSQL precision, including a fresh
clock check after source locks. Integration evidence covers real Unmatch, outsiders, expired
windows and lock waits crossing expiry. The internal unmatch snapshot codec encrypts only the
unmatch time and exact 24-hour deadline. Strict validation rejects extra identity/reason fields,
invalid dates and altered intervals; typed authenticated encryption rejects substitution and
tampering without leaking key-provider diagnostics. Post-unmatch submission now uses the shared
atomic admission, capture, review, outbox and threshold transaction. Migration `000058` checks the
post-lock database clock again at evidence insertion, rejecting expiry during later lock waits.
Tests cover duplicate races, ten-report admission, five-reporter restriction, encryption rollback,
expiry after capture and durable replay after the window closes. Bootstrap, upgrades through
`000057` and unchanged replay cover the new guard. Confirmed audited unmatch reveal now verifies
the captured dates against the immutable source record, remains available after the reporting
window closes, and releases content only after its access audit commits. Integration evidence
covers opaque selection, concurrent confirmed retries, corrupted reference dates and permission
revocation after confirmation. No decrypted content is returned on rejected or replayed attempts.

A provider-neutral service factory now composes profile, chat and post-unmatch preparation,
submission, evidence actions and confirmed reveal from one trusted capability configuration.
Disabled types cannot prepare or submit new reports and receive no reveal action. Each request
still selects exactly one evidence type. Integration evidence covers all three complete internal
flows, legacy profile receipts, token-loss replay and one shared ten-report limit under mixed-type
concurrency. Transport authentication and presentation remain separate pending work.

The internal photo snapshot codec now encrypts only a restricted opaque evidence-object reference,
the reviewed content digest and the captured primary flag. It rejects raw storage keys, URLs, image
bytes, identities and extra fields. Typed authenticated encryption binds the report/evidence/key
identity and rejects substitution, malformed content and tampering with sanitized failures. Photo
preparation now binds the selected photo to the existing authoritative product relationship and
target ownership. Active validated media with an available thumbnail is required. Integration
evidence covers substituted photos, outsiders, absent selections and unavailable media.
Migration `000059` adds immutable media-owned holds for the exact served thumbnail and digest.
The internal retention port uses only the caller's database transaction; deferred binding requires
the matching photo evidence and governing target before commit. Bootstrap, upgrade and rollback
evidence cover this schema. Migration `000060` guards retained assets and thumbnail variants against
physical purge and new cleanup claims. Existing media cleanup skips held assets while own-photo
soft deletion still succeeds; integration evidence verifies no object deletion for retained evidence,
rejected bypass attempts and unchanged ordinary cleanup. Photo submission now reauthorizes the locked selected photo and commits the hold, encrypted
snapshot, Report, review, outbox and threshold effects in one shared transaction. Migration `000061`
requires every new photo evidence row to have both retained media and encrypted capture at commit.
Concurrent replay, token loss, changed payloads, unavailable sources, admission limits, threshold
restriction and encryption rollback have integration coverage. Confirmed photo reveal now rechecks current admin permission and verifies the captured opaque
reference, digest and primary flag against its immutable media hold. Hidden source photos remain
reviewable; concurrent confirmed retries decrypt once and access audits must commit before any
content is returned. Mismatched references return no content and commit a rejected access audit.
The provider-neutral service factory now configures photo preparation, atomic submission,
evidence actions and confirmed reveal together with profile/chat/unmatch capabilities. Disabled
photo capability denies new intents and submissions and issues no reveal actions; durable receipts
remain replayable. Integration flows exercise all four types and their shared ten-report admission
under mixed-type concurrency. Object delivery and transport presentation remain pending.

Message preparation now uses a separate actor-bound opaque source for one exact live message.
Only stored Match/ChatSession participants may resolve it; preparation selects identity references
without reading content. Source locks follow Match, session and message order to agree with M6
lifecycle closure and cleanup. Tests cover either participant, outsiders, unrelated messages, mixed
evidence, purged sources and closed sessions with retained live evidence. M6 owns live retention;
message preparation does not reopen chat access or invent a separate expiry window.

Message submission now reauthorizes the exact participant-bound source and calls the extracted
M6 in-transaction capture port after writing its governing Report/evidence. M6 remains the sole
message-snapshot writer, preserving its content schema, digest, PostgreSQL timestamp precision,
request markers and newest-50 cleanup behavior. Report, snapshot, review, content-free outbox and
threshold effects commit atomically. The original M6 entry point delegates to the same port and
keeps its existing replay behavior, including legacy pending snapshot requests. Tests cover retry
races, failure after snapshot writes, durable replay after live purge/token loss, report-versus-cleanup
races, ten-report admission and one restriction for five distinct message reporters.
Message review now verifies the existing M6 digest and exact report/message binding before
projecting content without sender identity. Confirmed reveal uses the shared current-permission,
immutable admin-attempt and required evidence-access audit transaction; concurrent identical
commands release content once, and recorded replay never reloads plaintext. Metadata selects only
evidence IDs, types and schema versions, including retained M6 snapshots after live cleanup.
The shared capability factory now governs preparation, capture, metadata actions and readers for
all five evidence types. Integration tests cover enabled/disabled capabilities, durable replay after
token loss or capability removal, and one concurrent ten-report limit across mixed evidence types.
The provider-neutral API now implements authenticated reason lookup, evidence preparation and
report submission. A trusted host must explicitly supply an audience-verifying authenticator and
preloaded evidence capabilities; ordinary startup registers no report routes. Strict contracts bind
the request actor to verified identity and preserve command/idempotency IDs. Responses are validated,
never cached, and errors discard restricted text/details. HTTP-to-PostgreSQL tests cover concurrent
retries, token-loss replay, changed replay, durable admission, all five evidence types, M6 capture
and photo holds. A single host composition uses the shared capability factory for these endpoints.
Concrete web/admin session infrastructure, actual report delivery and object delivery remain staging work.

Authenticated admin report metadata, evidence selection, confirmation and reveal now have strict,
non-cacheable HTTP boundaries. One host configuration governs all five evidence capabilities across
user preparation/submission and admin selection/reveal. Authenticated early execution failures use
an immutable failure-only journal; matching retries recover receipts without effects. Public admin
receipts use finite codes and discard internal values. Only the process committing a fresh successful
reveal can return content, after both admin-attempt and access audits commit. PostgreSQL HTTP tests
cover all five types, concurrent reveal retries, cross-admin token reuse and permission revocation
between preparation and execution. These use synthetic fixtures and an injected test authenticator,
not real admin MFA/session infrastructure or actual Telegram/object delivery.

The shared M7 HTTP host now composes reporting, audited account/photo/internal-block actions,
review claims/assignments/decisions, user support and appeals, confirmed support reply/close,
appeal review and separate permission-checked unban. User support and appeal receipts omit raw
thread/appeal identities; opaque references remain actor-bound. Photo mutation routes are absent
without an explicitly supplied delivery revoker. Review notes require a preloaded protector.
HTTP-to-PostgreSQL evidence covers retry races, limits, exact-ban admission, role revocation and
acceptance without automatic unban. All five report/reveal flows run through the same host.
This remains explicit host registration with an injected verifier, not real session/MFA or delivery.

Support metadata can now prepare a separate confirmed content read for the selected current thread,
including retained closed threads. The read returns at most the newest 50 messages, without sender
identities, only after the admin attempt and immutable support access audit commit. Concurrent retries
return content once; later permission revocation produces a content-free rejected access audit.
Integration evidence includes bounded history and complete rollback on required-audit failure.

Appeal content now has a separate `review_appeals` capability and confirmed audited read. It can
inspect retained terminal/historical text and decision notes without granting a review or unban
command; those commands still require the exact current ban and their own permissions. Only fresh
successful reads return content, after the exact admin-attempt/access-audit commit; retries, stale
versions and revoked permissions return no text or raw user/ban/workforce identity.

Moderation reconciliation now resumes one shared run and commits bounded Report/evidence keyset
scans, cursor progress, counters and deduplicated quarantined findings atomically. It checks missing
evidence, capture shape/binding and retained photo bytes without fetching text, snapshot payloads or
keys. It does not cryptographically verify encrypted hashes; that remains the audited reader's job.
The additional historical and safety phases, scheduler cadence and aggregate liveness sampling are
implemented below; cryptographic integrity verification still belongs to the audited readers.

Review/action/episode reconciliation now checks report-state agreement, terminal decision evidence,
exact successful command and platform audit links, historical Account transitions, durable notices,
source ownership and one system restriction action per episode. Later Account changes or terminal
review states do not invalidate earlier effects; rolling reporter totals are not incorrectly
recomputed as historical episode totals. Findings remain quarantined with no automatic mutation.

Safety reconciliation now checks the shared unanswered support limit and recorded admin replies/
closures, exact appeal-ban ownership and review/unban evidence, active workforce identity, required
access audits and successful action records. Blocked-pair scans use a composite keyset cursor and
detect active Match/chat/Like/unlock state without copying either user's identity into findings.
The admin command transaction now locks and rechecks the matching verified Telegram identity as
well as current permissions, so a previously prepared token cannot authorize execution after that
identity binding disappears. Historical roles and terminal appeals remain valid retained history.

Checkpoint 8 remains partial. Telegram reporting and admin evidence now have explicit gateway
ports after webhook authentication. All five source buttons carry only opaque native source tokens;
reporter identity is resolved server-side. A user-bound first-write-wins selection receipt supports
stable callback retries and `/report <reference> <reason> [text]` submission. Its 24-hour cache does
not extend the native intent grant; the native store owns replay, current source authorization,
limits and capture. Notices omit Report prose and raw Report IDs.

Admin evidence callbacks resolve an actor-bound already-confirmed command through a server-owned
port. A current Telegram-bound admin session and unexpired MFA are required before execution and
checked again before delivery. Only fresh successful native reads can deliver content after both
required audits commit. Replayed/rejected outcomes remain content-free, even if an incorrect port
supplies a value. Text preserves Unicode boundaries, uses bounded plain chunks and requires link
previews disabled; message/chat/evidence identities are excluded from the projection. Retained
photos require an explicit authorized object-delivery port and never render object references as
text. If delivery fails after the audit commit, retry does not re-expose content; use a fresh explicit
confirmed read. These are injected interfaces and synthetic adapter tests, not a concrete MFA/session
service, command-selection UI, real Telegram/object delivery, or deployment evidence. Ordinary startup
does not automatically enable either port. Remaining account/review/support/appeal admin presentation
and concrete session/delivery composition are still pending.

Confirmed support-thread and appeal reads now have an explicit Telegram gateway port. Actor-bound
short callbacks resolve only already-confirmed native reads, never review or unban mutations.
Current Telegram-bound admin session/MFA is checked before execution and before every outgoing
plain-text chunk. Only fresh successful audited reads deliver restricted content; replayed,
rejected and failed receipts remain content-free even if a faulty port returns a value. Support
history retains its 50-message ceiling; appeal text and retained notes omit user/ban identities.
Session revocation during delivery stops remaining chunks, and provider failures are sanitized.
Synthetic adapter tests cover these boundaries. Concrete confirmation menus, session/MFA service
and real deployed delivery remain outstanding; ordinary startup does not enable this port.

The concrete admin text sender uses the fixed Telegram Bot API `sendMessage` method with plain
text, `link_preview_options.is_disabled` and `protect_content`, as defined by the
[Bot API](https://core.telegram.org/bots/api#sendmessage). It sends each bounded chunk once,
uses a request deadline and bounds/cancels the provider response stream. Malformed, rejected,
oversized and ambiguous responses expose only the finite internal-error notice, never provider
diagnostics or token-bearing URLs. Synthetic HTTP tests verify the wire contract; this is not
evidence of real Telegram delivery, and retained-photo delivery remains a separate capability.

Support/appeal confirmation references now have a concrete encrypted Redis vault. Only the two
native read command shapes can be stored; each requires an actor-bound action and confirmation.
Separate keys protect AES-GCM command state and opaque HMAC callback references. Actor/reference/
purpose binding prevents substitution. Concurrent allocations retain the first command for five
minutes, changed payloads reject, cache loss fails closed and reads enforce expiry independently
of cache TTL. Native permission, confirmation expiry, auditing and replay remain authoritative.
Restricted reasons, identities and native tokens never appear in plaintext cache values or callback
data. The vault is not a session/MFA service, mutation capability or evidence of a deployed menu.

Owned support/appeal confirmation references can be withdrawn through private `m7c:` callbacks.
Cancellation checks the current verified admin session and cryptographic ownership, writes only a
five-minute content-free cache marker and invokes neither native reader nor mutation. Duplicate
cancellation keeps the first marker. Read delivery re-resolves the exact stored command before
each outgoing chunk, so cancellation/cache loss during a database wait or between sends stops
remaining content. Already-sent messages and committed access audits are not undone. This closes
pending UI state without replacing the native permission/audit boundary; a fresh read needs a new
explicit confirmation reference. Synthetic tests cover withdrawal, expiry and delivery races.

Pending support/appeal reads now have a concrete localized confirmation menu presenter and a
protected Bot API inline-keyboard sender. In the selected-target UI context, the menu presents the
operator's own normalized reason and Confirm/Cancel buttons containing only the opaque vault
reference. It fetches no support/appeal text and executes no native read. Session/MFA and the exact
pending command are checked again before delivery. Both buttons must reference the same pending
read; the sender disallows arbitrary callback actions. Synthetic wire tests cover both read kinds,
revocation, withdrawal/cache loss and callback substitution. Target selection and native draft
preparation still need gateway composition; real Telegram menu/session acceptance remains pending.

An explicit gateway composition now shares native PostgreSQL support/appeal preparation and read
handlers, one encrypted vault, menu presenter, protected sender and read/cancel adapter. Selected
targets and stable command/operation IDs are supplied by the trusted UI boundary. Every preparation
rechecks native permission. Concurrent preparations may issue different valid confirmation tokens;
the vault retains the first for the same exact draft, rejects other payload changes and never
extends its expiry or replaces withdrawn state. Menus fetch no user prose. PostgreSQL composition
evidence connects repeated preparation and callback races to one fresh content delivery and one
required access/admin audit, with permission-revoked preparation denied. Selected-target ingress,
concrete session/MFA and real provider staging evidence remain pending; ordinary startup is disabled.

The explicit read composition also accepts a trusted metadata target selection. It invokes the
native queue-authorized support/appeal reveal-action preparation, then the existing confirmed-read
preparation. The host supplies a stable operation identity and authenticated provider timestamp;
the service derives actor-bound command IDs and accepts no caller-selected actor or permission.
Concurrent native target preparations retain the first opaque action in a five-minute content-free
receipt. Keyed bindings reject changed target, version, reason, timestamp or queue authority without
overwriting that receipt. Cached selection never bypasses native permission/version checks or
extends expiry. No read or mutation executes until the existing confirmation callback. Target queue
presentation, reason-entry ingress and concrete sessions remain pending acceptance work.

The explicit Telegram read ingress now handles `/admin_support` and `/admin_appeals` with their
native status filters, ten metadata rows per page and opaque next-page/target buttons. Encrypted
five-minute UI state binds each selection to its admin and purpose; callbacks expose no target,
queue action or cursor. Native permissions and exact versions are checked before a protected reason
prompt. Only a reply to that admin's exact bot prompt can prepare the read; actor, operation identity
and timestamp come from the authenticated private update. Confirmation and cancellation still use
the existing encrypted read vault. Browsing, choosing and entering a reason disclose no user prose.
Migration 64 seeds twelve English fallback labels with empty variables and bootstrap/upgrade/replay
verification. Deploy it before enabling the injected ingress. Concrete session/MFA, real Telegram
acceptance and the separate mutation/support-reply/appeal-review/unban UI remain pending.

The composed read ingress now acknowledges expected invalid, unauthorized, stale and rate-limited
UI requests. Fixed localized rejection feedback is sent only to a current Telegram-bound private
admin session with valid MFA, rechecked against the original actor before delivery. Invalid or
expired sessions receive no message. No reason, target, token or exception is interpolated. Native
handlers run before notice deduplication; a content-free 30-second claim serializes notice sends
and a 24-hour successful-delivery receipt suppresses repeats. Pending/ambiguous delivery and cache
failures remain sanitized failures, rather than false successful acknowledgements; retry after the
claim expires can repeat only fixed rejection prose. Native confirmation, attempts, access audits
and fresh-only content delivery remain authoritative. Real provider/session acceptance is pending.

The scheduler executes at most 100 metadata rows per moderation batch, continues incomplete runs on
subsequent ticks, waits 15 minutes after completion, and retries failure after one minute. PostgreSQL
owns durable restart recovery, batch serialization and finding deduplication. Only fixed phase/outcome
and aggregate counts leave the scheduler boundary; raw database errors and run/entity identifiers are
discarded. Redis provides best-effort leadership; database guards remain authoritative if its lease
expires mid-batch. Ten integrity phases are implemented without automatic domain mutation.

M7 aggregate queue/scan ages and finite-phase metrics have dashboard/runbook contracts and staging
alarms. Historical quarantines are not mislabeled as current integrity counts. The broader operational
health API contract still needs a current integrity-count sampler. Broader production-shaped scanner
plans, ingress/action telemetry, real exporter/alert routing, session/MFA and Telegram/object delivery
acceptance remain pending. M7 is still implementation in progress, not declared code-complete or live.

Migration 63 adds aggregate-age indexes and all-status support ownership/sender-time indexes.
The M7 CI plan gate runs eight reads against 20,000 synthetic rows per table (six tables), using
the same support/appeal queue and unanswered-count statements as production. Fixture writes stay
in an isolated trigger-bypass transaction and roll back; no synthetic captures become retained
production history. Exported plans contain only execution time, actual row count and index names,
never predicates or bound values. The 1,500 ms gate is a CI envelope, not a staging latency claim.
The load smoke sends 20 concurrent support opens for each of five users, requires exactly two
accepted writes per user, and verifies 20 concurrent replays create no duplicate messages.
Report threshold/admission, appeal uniqueness and separate unban races remain covered by the
existing native/HTTP PostgreSQL integration suites. The six-job workflow retains aggregate M7
performance evidence; actual staging traffic and broader production-shaped reconciliation plans
remain acceptance work.

M7 is code-complete only when `ACC-039..041`, authorization/privacy/snapshot tests, threshold/admin/
internal-block/support/appeal races, reconciliation, retention, production-shaped plans, operations
docs, and CI are green. It is production-ready only after the same immutable release passes real
Telegram evidence reveal, admin permission/failure logging, fifth-report restriction, photo action,
internal-block, support/appeal, rollback, alert, and privacy drills with named backend, product,
operations, moderation, and security sign-off. Without infrastructure it may be called **code
complete / staging blocked**, never live.

### Confirmed support mutation UI evidence

The explicit authenticated Telegram admin ingress now composes native support replies and closure
from the metadata picker. Selecting an open thread offers Read, Reply and Close; closed threads offer
Read. Reply entry binds the first-line review reason and remaining support text to the exact owned
private prompt. Normalized drafts use encrypted actor-bound five-minute UI state with separate
confirmation callbacks; full 2000-scalar replies are previewed in protected bounded chunks.
Native queue selection, confirmed-command authorization, current permission/version checks and
transactional attempted-command audit remain authoritative. Concurrent preparations retain one
exact draft; native execution retries use the same command, yielding one effect and one audit.
A first-write-wins UI Confirm/Cancel decision prevents cancellation from reversing a confirmation.
No historical user content is fetched by this mutation flow. Draft reasons/replies never enter
plain Redis values, callback handles, admin log metadata or operational telemetry.
Migration 65 adds seven English fallback labels; apply and verify it before enabling this ingress.
Unit evidence covers encrypted state, cross-actor/tampered/expired handles, mixed decision races,
payload substitution, full emoji limits and session/cache loss during preview. PostgreSQL ingress
evidence exercises actual picker/prompt/confirmation replies, closure, cancellation and permission
revocation under concurrent confirmation retries. This is implementation evidence; concrete admin
session/MFA composition and real Telegram/provider staging acceptance remain open gates.

### Confirmed appeal review UI evidence

The explicit private admin queue now offers Read, Accept and Reject for submitted/in-review
appeals; terminal appeals retain only Read at this stage. The selected decision and exact target
are bound to the owned bot prompt. Its first line is the bounded review reason, with an optional
private note on remaining lines. Native review access checks current permission, appeal version
and exact current ban before preparation. An encrypted actor/purpose-bound five-minute draft
binds every header, selected-target binding, decision and normalized note to native confirmation.
Protected preview handles the full 2000-scalar note limit; current session/MFA and pending state
are rechecked before each send. Confirm and Cancel have distinct review callbacks and a single
first-write-wins UI decision. Support storage reuses the common validated encryption mechanism
with its own namespace and strict native-command allowlist. Review storage cannot accept unban.
Native PostgreSQL execution and immutable audit remain authoritative for permission, exact ban,
version, idempotency and concurrency. Acceptance/rejection never calls unban and never changes
Account state/history. A separate permission-checked unban UI remains the next implementation.
Migration 66 adds seven English fallback labels and requires bootstrap, upgrade and replay
verification before ingress activation. Unit and PostgreSQL ingress evidence covers payload and
decision substitution, purpose isolation, expiry/cache/session loss, bounded Unicode preview,
concurrent confirmations, cancelled/revoked attempts, and a new ban after draft preparation.
This remains implementation evidence; concrete MFA/session and live provider acceptance are open.

### Separately confirmed accepted-appeal unban UI evidence

Accepted appeals now offer Restore access only after native preparation checks current
`unban_user` permission, the exact accepted appeal and its current ban. A separate owned reason
prompt and protected Confirm/Cancel menu bind a native `moderation.unban-appeal` command.
The encrypted five-minute unban draft has its own actor/purpose namespace and callback pair;
support/review drafts cannot substitute for it. Both appeal and account versions come from native
preparation and are bound to confirmation, including concurrent preparation retries.
Acceptance alone still leaves Account banned. Confirmation uses the owning native account command
and its transactional audit, immutable unban proof, state history, moderation action, notification
and outbox. Cancel cannot undo Confirm, and native idempotency owns repeated confirmations.
Migration 67 adds four English fallback labels; apply and verify before ingress activation.
Unit evidence covers version/payload substitution, purpose isolation, encrypted expiry, permission
availability, session/cache loss and decision races. PostgreSQL ingress evidence covers accepted,
rejected and pending appeals, review-only operators, cancellation, permission revocation, stale
account versions and a later ban, plus one effect/audit/notification under concurrent retries.
Concrete admin session/MFA composition and real Telegram/provider staging acceptance remain open.

### Queue-selected report review preparation evidence

Report queue selection now has a native preparation port that resolves a selected Report and its
expected version to the governing ModerationReview and current review version. Own-assignment uses
the verified current admin identity; the selection contract accepts no review or assignee identity.
The existing review preparation still checks queue authority, terminal state, assigned reviewer,
decision-specific permission and a prior moderation action before actioned closure. Preparation
neither assigns nor reveals evidence. Separate native confirmation binds the derived review target,
version, reason and assignee/decision before execution; idempotency and immutable attempt logging
remain authoritative under concurrent retries, permission revocation or competing assignment.
Strict contracts reject extra identities/content.
The authenticated `POST /v1/admin/moderation/reports/review-selection` route composes this native
port, denies mismatched actors and client authority fields, disables caching and validates the
result before exposing it. The route is absent when its trusted capability is not configured.
Unit evidence covers forged direct inputs, actor/root mismatch, stale report and mid-preparation
review change. PostgreSQL evidence starts from
the actual metadata queue and proves one confirmed assignment and one confirmed dismissal audit,
plus rejection after revocation, reassignment or confirmation-payload substitution. Test fixtures
run in an isolated migrated database. The concrete report queue/review Telegram UI is the next
presentation step; this port provides no deployment or live operator acceptance evidence.

### Confirmed own-review assignment Telegram UI evidence

The explicit private admin ingress now handles `/admin_reports [status]` with native metadata-only
keyset pages of ten. Opaque encrypted five-minute report selections, cursor state and owned bot
prompts have a separate purpose from support/appeal queues. Selecting a report checks native
authority before asking for the assignment reason; it never changes ownership or reveals evidence.
The exact owned reply prepares a native `moderation.assign-review` command with server-derived
review/version and the current operator as assignee. Its encrypted assignment-only vault binds the
target, assignee, headers and normalized reason; support/review/unban drafts cannot substitute.
Protected Confirm/Cancel callbacks have one first-write winner. Current Telegram-bound session/MFA
is rechecked before outgoing messages and native execution; PostgreSQL owns permission/version
checks, one assignment effect and one immutable attempt audit under confirmation retries.
Migration 68 adds eight English fallback labels and status buttons; apply and verify before enabling
the injected ingress. Unit evidence covers queue pagination, prompt ownership, purpose isolation,
full reason limits, cancellation races, cache/session loss and strict protected delivery.
Actual PostgreSQL ingress evidence covers concurrent preparations/confirmations, cancellation,
revocation, competing assignment and terminal dismissal, with no evidence access, account change,
notification or identity disclosure. Decision/action UI, concrete session/MFA and provider staging
acceptance remain separate open work.

### Assigned report decision Telegram UI evidence

The private report picker offers Dismiss and Complete after moderation action only after native
preparation checks current permissions, assigned ownership and the prior action required for
completion. Each action binds an owned reason/optional note prompt to the exact selected report.
A separate report-decision encrypted five-minute vault binds the native review target/version,
normalized reason/note and stable provider operation headers. Protected Confirm/Cancel callbacks
have one first-write winner; native idempotency and attempted-command audit own retries.
The ingress activates these decisions only with an explicitly injected long-term ReviewNoteProtector.
Temporary UI encryption keys are never implicitly used for retained domain notes.
Migration 69 adds seven English fallback labels; apply and verify before activation.
Unit evidence covers note/payload substitution, purpose isolation, cancellation, concurrent
preparation/confirmation and session/cache loss. PostgreSQL ingress evidence covers dismissal,
completion after a separately confirmed native account action, cancellation and permission
revocation, with encrypted notes and no additional account/notification or evidence effects.
Account/photo action UI, concrete MFA/session composition and live operator/provider acceptance
remain open. Completion does not perform an account/photo action itself.

### Queue-selected report Account preparation evidence

A strict native preparation contract now accepts a metadata-root token, selected Report/version
and one of restrict/unrestrict/ban/unban. The governing review and its version come from the
server; native report Account preparation checks assigned ownership and the action permission,
resolves Account/version and binds the source report. A second report/review read rejects changes
during preparation. The result contains only an opaque action token and Account version.
The authenticated no-store `POST /v1/admin/moderation/reports/account-selection` route composes
this port in production and is absent without its trusted capability. Client account/review
identities, reason, prose and version authority are rejected by the strict contract.
Preparation performs no mutation, evidence read or attempted-command audit. Separate native
confirmation still binds the reason, action and Account version; owning-module execution locks
and rechecks current report state, assigned ownership, permission and Account version.
Unit evidence covers scoped/cross-actor roots, invalid selection, changed governing report/review
and strict ingress/result validation. PostgreSQL evidence covers all four separately confirmed
Account actions with one effect/audit/notification under retries, payload substitution and
revocation/reassignment/terminal review after preparation. HTTP integration exercises actual
selected Report preparation before a separately confirmed account action. Report Account Telegram
controls and concrete MFA/session/provider acceptance remain open; this native port grants no
UI or deployment authority by itself. No persistence shape changes are required.

### Separately confirmed report Account Telegram UI evidence

The private report picker now offers restrict, unrestrict, ban and unban according to current
native permission, assigned ownership and Account-state eligibility. Preparation and execution
share the same eligibility rule; restoration still requires immutable state-history resolution.
Account controls work independently of retained review-note capability. Selecting an action
checks native authority before an owned bounded-reason prompt; the exact prompt retains its
first selected action and cannot be rebound by another callback. Native selected-report preparation
derives the governing review and Account/version. A separate encrypted five-minute report-account
vault binds the action, target selection, version, reason and stable provider operation headers.
Protected Account-only Confirm/Cancel callbacks have one first-write winner. Native execution
rechecks permissions, report ownership/status, Account state/version and confirmation, with one
Account effect, immutable audit, state history, moderation action and notification under retries.
It never closes the review, reveals evidence or accepts an appeal; accepted-appeal restoration
continues to use its distinct exact-ban command. Migration 70 supplies six English fallback labels
and must pass bootstrap/upgrade/replay verification before ingress activation.
Unit evidence covers eligibility, action/payload/version substitution, purpose separation, owned
prompts, session/cache expiry, cancellation and protected transport. Actual PostgreSQL ingress
evidence covers all four actions, cancellation, revocation, reassignment, stale Account state and
closed review, with concurrent preparations/confirmations and no identity disclosure.
Concrete session/MFA composition, report photo/internal-block/evidence UI and real operator/provider
staging acceptance remain open.

### Queue-selected report evidence and photo preparation evidence

Strict selected-Report contracts now list bounded evidence metadata and prepare hide/restore/delete
photo actions using a metadata-root token and expected Report version. Metadata grants no content
reveal; photo preparation resolves the governing review/version and delegates evidence-to-photo
ownership and current permission checks to the native port. It accepts no client photo identity
or photo version. Photo preparation rechecks Report/review stability; metadata rechecks Report version/status and
remains available for submitted and terminal reports without requiring an assigned review.
Authenticated no-store `POST /v1/admin/moderation/reports/evidence-selection` and `photo-selection`
routes compose these ports in production and are absent without their trusted capabilities.
Photo preparation returns only the opaque action token and native photo version. No mutation or
evidence-access/attempted-command audit occurs before a separately confirmed native command.
Unit evidence covers actor/root/selection substitution, strict ingress/result contracts, changes
during preparation and cross-report metadata. PostgreSQL evidence starts with native metadata and
confirmed review assignment, denies borrowed evidence and proves one hide/restore/delete effect and
audit under retries, while preserving the evidence hold, encrypted snapshot and retained media.
Rejected confirmations are audited under separate command identities; revocation, reassignment
and terminal reviews after preparation produce no photo effect. HTTP integration retains legacy
route coverage and executes actual selected-Report photo actions with independent confirmation.
Photo/evidence Telegram controls, concrete session/MFA composition and provider/operator staging
acceptance remain open. No new persistence shape or migration is required.
