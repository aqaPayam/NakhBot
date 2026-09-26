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
4. `000049_m7_administration.sql` — AdminUser, role/permission catalogs and joins, attempted-command
   log, evidence-access log, bootstrap constraints, and immutable RBAC seed codes.
5. `000050_m7_support_appeals.sql` — SupportThread/SupportMessage, per-ban UserAppeal uniqueness,
   unanswered-count support, lifecycle guards, and restricted-text grants.
6. `000051_m7_localization.sql` — report reasons/surfaces, safe restriction/ban notices, admin
   outcomes, support, appeal, stale-action, rate-limit, and generic authorization/error keys.
7. `000052_m7_reconciliation.sql` — resumable bounded M7 reconciliation runs, anomaly types, query
   indexes, and verification hardening.

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
Snapshot encryption is performed before entering the short commit using a versioned in-memory
envelope key; the transaction persists only ciphertext/digests. Photo object retention/cleanup uses
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

M7 is code-complete only when `ACC-039..041`, authorization/privacy/snapshot tests, threshold/admin/
internal-block/support/appeal races, reconciliation, retention, production-shaped plans, operations
docs, and CI are green. It is production-ready only after the same immutable release passes real
Telegram evidence reveal, admin permission/failure logging, fifth-report restriction, photo action,
internal-block, support/appeal, rollback, alert, and privacy drills with named backend, product,
operations, moderation, and security sign-off. Without infrastructure it may be called **code
complete / staging blocked**, never live.
