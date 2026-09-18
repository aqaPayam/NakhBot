# M3 Execution Guide — Discovery and Free Interactions

Status: approved implementation guide for M3. This guide converts the canonical discovery,
interaction, matching, delivery, and acceptance rules into an ordered backend plan.

## 1. Authority and boundary

1. Domain documents remain authoritative for product behavior.
2. Existing architecture, transaction, security, localization, testing, and retention rules remain
   mandatory.
3. This guide owns M3 sequencing, transaction boundaries, query plans, temporary delivery state,
   and evidence for `ACC-014..019`.
4. M3 may begin while real M2 provider evidence is pending. It must use M2 delivery-grant ports and
   must not weaken the M2 staging gate.

M3 delivers saved Explore filters, reciprocal candidate selection, durable no-repeat delivery,
Guest Preview candidate delivery, Like, Not Interested, Liked By queries, and mutual-Like
Match/Chat creation. Paid Liked By unlock remains M4. Free chat behavior remains M6.

## 2. Non-goals

Do not add recommendation ML, distance/radius search, province-wide search, swipe restoration,
unlike, native Telegram identity disclosure, paid unlock fulfillment, Nakh, free-text chat, reports,
or admin moderation in M3. Do not build a separate search service before PostgreSQL query-plan and
load evidence proves it necessary.

## 3. Required packages and ownership

```text
packages/domain/src/discovery/            # filter, reciprocity, pair and transition policies
packages/application/src/discovery/       # filter/candidate/consumption use cases and ports
packages/application/src/interaction/     # Like, Not Interested, Liked By and match coordinator
packages/contracts/src/m3.ts              # strict versioned channel-neutral schemas
packages/persistence-postgres/src/        # authoritative query and transactional repositories
packages/telegram/src/                    # localized cards and opaque actions only
migrations/000017..                       # forward-only M3 schema
```

Discovery may read identity/Profile/catalog/media facts through declared ports. Interaction owns
Likes, Not Interested, and pair state. Matching is the only owner of Match and Chat creation, even
when its minimal M3 implementation is composed inside one PostgreSQL transaction.

## 4. Locked product and technical decisions

- Normal Explore requires an active Account, complete Profile, and visibility enabled.
- Guest Preview uses the existing immutable shared limit and a privacy-reduced candidate card.
- Age is approximate because Profile stores Gregorian birth year. One database transaction obtains
  the current UTC year and applies `currentYear - birthYear`; client time is never trusted.
- Explore gender choices are a non-empty subset of the viewer's Profile preference members. Both
  save-time validation and candidate SQL intersect the subset with reciprocal compatibility.
- MVP location filtering is one active City only. Relationship goal is an optional exact match.
- Candidate SQL filters first, orders by indexed rotating shuffle key plus Profile ID, and returns at
  most 100 rows. Application code applies a seeded bounded shuffle; no `ORDER BY random()` is allowed.
- A candidate is authoritatively rechecked on the writer immediately before reservation.
- Consumption is directional and permanent during the account lifetime. Its first reason is
  immutable. Stronger actions use insert-on-conflict and never rewrite that reason.
- Pair locks use one shared UUID-byte normalization and transaction advisory-lock function. All
  Like, Not Interested, Match, Unmatch, Block, and later Nakh paths must reuse it.
- Like and Not Interested are irreversible for users. Not Interested creates no notification.
- Two opposite Likes racing create exactly one Match, two participants, one ChatSession, and two
  ChatParticipants in the same transaction. There is no asynchronous second Match creator.
- Liked By is a derived writer-authorized query. Visibility and changed preferences do not retract a
  sent Like, but Account/Profile/pair/rejection state can make it non-actionable.
- Locked Liked By returns count, opaque Like action token, and blurred-primary delivery grant only;
  it cannot expose name, City, highlight, full photo, or Profile identifiers.

## 5. Migration sequence

Create and verify these forward-only migrations:

1. `000017_m3_discovery.sql` — Explore filter/version, normalized gender members, immutable
   consumption, rotating Profile shuffle key/indexes, and delivery reservations.
2. `000018_m3_interactions.sql` — directional Likes, Not Interested, normalized pair state,
   constraints, and Liked By indexes.
3. `000019_m3_matching.sql` — unique normalized Match, exactly-two membership foundation,
   ChatSession/participants, and source proof.
4. `000020_m3_candidate_query.sql` — global Guest Preview shuffle index and canonical pair lock.
5. `000021_m3_localization.sql` — Explore, exhaustion, Like, Not Interested, Liked By, Match, stale
   action, and safe error keys with exact variable declarations.

Each migration must bootstrap from empty, upgrade from `000016`, replay unchanged, and have matching
verification SQL. Applied migrations are immutable.

## 6. Persistence invariants

### 6.1 Explore filter and consumption

`discovery.explore_filters` uses User as primary key and stores age range, active City, optional
relationship-goal code, timestamps, and optimistic version. Enforce `18 <= min_age <= max_age <= 120`.
`discovery.explore_filter_genders` has composite primary key `(user_id, gender_option_id)`.

Saving a filter locks User/Profile/filter, rejects inactive catalog references, checks at least one
gender, and verifies every selected gender belongs to the viewer preference. Replace gender members
and increment version in one transaction. It never updates Profile.

`discovery.explore_consumptions` has primary key `(viewer_user_id,target_user_id)`, no-self check,
first reason/time, and immutable-update trigger. Index viewer/recent time; add BRIN only when measured
volume justifies it.

### 6.2 Delivery reservation

`discovery.candidate_deliveries` bridges the PostgreSQL/Telegram boundary without an open database
transaction. It stores a UUID delivery ID, viewer, target, mode `explore|guest_preview`, filter
version, state `reserved|delivered|failed`, bounded attempt count, expiry, optional provider message
ID, and lifecycle timestamps. Only one live reservation exists per viewer. Viewer/target is unique
against consumption before reservation.

Reservation transaction:

1. lock viewer and return any unresolved reservation; expiry only makes it reconciliation-eligible,
   and only a proven definitive non-delivery may mark it failed;
2. validate viewer mode and authoritative target eligibility;
3. insert the reservation without yet creating final consumption;
4. for Guest Preview, lock the counter and admit the reservation only when
   `preview_count + live_guest_reservations < limit_count`;
5. write a minimal delivery outbox event and commit.

Delivery success finalization locks the reservation, inserts consumption with reason `preview`,
increments the Guest Preview counter when applicable, records the Telegram message ID, and marks
delivered in one transaction. A definitive terminal provider failure marks failed and releases the
reservation without creating consumption or incrementing the counter. An uncertain provider result
is retried/reconciled and is never treated as a definitive failure. A crash after reservation cannot
select a second candidate; retry may redeliver only that same reserved card until the provider result
is finalized. State transitions are conditional and idempotent.

### 6.3 Interaction and pair state

`interaction.likes` has UUID ID, sender, receiver, status/version/timestamps, unique directional pair,
and no-self check. Required indexes are receiver/status/created time for Liked By and sender/status
for closure.

`interaction.not_interested` has unique directional pair, validated source, time, and no-self check.
`interaction.user_pair_states` uses normalized `(user_low_id,user_high_id)` primary key, `low < high`,
state/reason/version/time, and legal transition checks.

### 6.4 Minimal matching foundation

`matching.matches` has unique normalized pair, active/closed status, typed source proof, version, and
timestamps. Participant rows have `(match_id,user_id)` primary key. Database constraints plus the
creation transaction guarantee exactly the normalized pair; verification SQL detects malformed
fixture states. `chat.chat_sessions` is unique by Match and two participant rows are created in the
same Match transaction. M3 exposes no chat-send command.

## 7. Candidate query

Candidate SQL starts from the indexed complete-Profile/City/shuffle projection and joins only facts
needed to reject targets. It must enforce:

1. viewer eligibility for the selected mode;
2. target differs from viewer and is active, complete, visible, in Iran, with visible primary photo;
3. no consumption, live reservation, matched/unmatched/blocked pair, or directional Not Interested;
4. viewer preference includes target gender and target preference includes viewer gender;
5. filter gender subset, inclusive approximate-age range, exact City, and optional goal;
6. deterministic seek window over `(city_id, random_shuffle_key, profile_id)`, limit 100.

Return a privacy-safe candidate projection, never raw Profile rows or storage keys. After bounded
application shuffle, reservation rechecks all authoritative conditions on the writer. Refresh
shuffle keys in stable batches every six hours using the scheduler, with one versioned job identity
per window; the refresh must not lock the whole table in one transaction.

## 8. Atomic commands

### SaveExploreFilter

Strict schema, catalog validation, Profile-preference subset proof, optimistic filter version,
audit/outbox, and stable replay result are one transaction. `ACC-014` compares the Profile preference
before and after. Generated `ACC-015` cases prove no client filter can broaden reciprocity.

### SendLike

Normalize and advisory-lock the pair, claim idempotency, lock both Users/Profiles and pair facts in
UUID order, revalidate capability, insert consumption if absent, and insert/replay the directional
Like. If no reverse active Like exists, create one receiver notification/outbox fact. If it exists,
call the matching coordinator inside the same transaction: create/replay Match, memberships, matched
pair state, ChatSession/participants; close both Likes as `closed_by_match`; emit Match events and no
ordinary Like notification.

M3 records the receiver notification eligibility on the durable Like-created outbox fact. The
Notification module's eventual delivery record and channel sending remain M6-owned; an M3 Like
must not bypass that future preference-aware delivery pipeline.

### MarkNotInterested

Lock the pair, validate source, insert/replay rejection and consumption, and close only the applicable
received Like as `closed_by_not_interested`. Commit audit/outbox facts but no target notification.

## 9. Queries and privacy

`GetLikedByPage` uses keyset pagination bound to receiver, query version, and expiry. It returns only
currently actionable received Likes. Locked results contain an opaque Like reference and blurred
grant; unlocked full-card behavior is M4. Counts and pages use identical predicates. Restricted,
banned, deleted, invalid, rejected, matched, unmatched, and blocked rows are excluded.

Explore/Guest cards use Profile's viewer-safe projection and M2 delivery grants. Telegram callbacks
contain short actor-bound opaque tokens. Every action reloads authoritative state; a rendered card is
never authorization.

## 10. Events, observability, and operations

Version schemas for filter saved, candidate reserved/delivered/failed, consumption created, Like
created/closed, Not Interested created, Match created, and shuffle window refreshed. Payloads contain
internal IDs and stable codes only, never Profile prose, Telegram IDs, media keys, or raw cursor data.

Metrics use bounded labels for candidate result, reservation outcome, delivery outcome, interaction
result, match source, and denial code. Track candidate-query latency/rows examined, exhaustion rate,
reservation age, delivery retries, consumption conflicts, Liked By latency, and pair-lock contention.
Alert on stuck reservations, delivery backlog, query-plan regression, or Match invariant failure.

## 11. Verification and performance gate

- domain/property tests: pair normalization, reciprocal compatibility, filter subset, age boundaries,
  irreversible transitions, and bounded deterministic shuffle;
- contract tests: strict schemas, unknown-field rejection, opaque cursors/actions, and privacy shapes;
- PostgreSQL integration: migrations, filter replacement/version race, reservation/compensation,
  consumption uniqueness, simultaneous Likes, one Match/Chat, Not Interested silence, and Liked By
  exclusion matrix;
- concurrency: same candidate reservation, final Guest Preview slot, duplicate Like, opposite Likes,
  Like versus Not Interested, and block/unmatch boundary fixtures;
- fault injection: crash before/after reservation commit, provider success before result recording,
  definitive provider failure, outbox replay, deadlock retry, and Match audit rollback;
- query plans: seeded production-shaped data, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, no unbounded
  sort/full-table randomization, documented row/latency budgets, and plan artifacts retained in CI;
- static/privacy: no handler-owned prose, storage keys, Telegram identity, raw UUID callbacks, or
  high-cardinality telemetry.

Stable acceptance IDs:

| Evidence | Completion rule |
|---|---|
| `ACC-014/M3-FILTER-ISOLATION` | saving Explore gender leaves Profile preference byte-for-byte unchanged |
| `ACC-015/M3-RECIPROCITY-PROPERTY` | generated filters never admit a pair rejected by either Profile preference |
| `ACC-016/M3-CONSUMPTION-RACE` | concurrent preview/action attempts expose at most one candidate and never repeat it |
| `ACC-017/M3-MUTUAL-LIKE-RACE` | opposite simultaneous Likes create one Match and one Chat with two participants |
| `ACC-018/M3-IRREVERSIBILITY` | Like cannot be withdrawn; Not Interested is silent and non-reversible |
| `ACC-019/M3-LIKED-BY-MATRIX` | actionable count/page exclude every prohibited account/profile/pair/rejection state |

## 12. Pull-request sequence

1. Domain policies, contracts, ports, stable errors/events, and this execution guide.
2. Migrations `000017..000020`, verification SQL, repositories, and migration integration coverage.
3. Filter save plus reciprocal candidate query and production-shaped query-plan evidence.
4. Durable reservation/delivery lifecycle and completion of the M1 Guest Preview acceptance seam.
5. Like, Not Interested, mutual Match/Chat transaction, and concurrency evidence.
6. Liked By projection, blurred grants, opaque Telegram rendering/actions, and privacy tests.
7. Localization migration `000021`, observability/runbooks, load/fault tests, acceptance ledger, and
   staging evidence.

Every increment must pass frozen install, formatting, lint, type checks, unit/integration/concurrency
tests, migration replay/verification, security audit, and production builds. M3 is complete only when
`ACC-014..019` and the production-volume query-plan gate are green with no skipped M3 tests.

## 13. Implementation status

PR 1 foundation:

- [x] canonical pair normalization and invalid/self-pair rejection;
- [x] reciprocal compatibility and Explore-filter narrowing policy;
- [x] approximate-age, City, relationship-goal, and bounded-shuffle policies;
- [x] irreversible Like and pair-state transition policies;
- [x] strict Save Filter, candidate, Like, Not Interested, Liked By, delivery-job, and result schemas;
- [x] explicit versioned M3 event-name registry and stable application error codes;
- [x] channel-neutral discovery/interaction store ports and authorization-first handlers;
- [x] focused domain, schema, privacy-shape, and handler tests;
- [x] migration `000017` discovery/filter/consumption/reservation schema and verification SQL;
- [x] migrations `000018..000019` interaction/Match/Chat foundation and verification SQL;
- [x] migration `000020` global candidate-query index and shared canonical pair lock;
- [x] idempotent PostgreSQL Explore-filter save with optimistic version and preference-subset proof;
- [x] reciprocal Explore/Guest candidate query with bounded shuffle, writer recheck, pair locking,
  Guest Preview admission, and one-live durable reservation;
- [x] idempotent delivery success/failure finalization with atomic consumption and Guest Preview
  counter use, plus definitive-failure compensation without consumption;
- [x] idempotent Like and Not Interested transactions with shared pair locking, immutable
  consumption, silent rejection, and received-Like closure;
- [x] M3 rejects forged Liked By/Pending Nakh action sources until their M4/M5 authorization
  proofs exist; matched Likes suppress ordinary Like notification eligibility;
- [x] opposite-Like serialization into exactly one Match, pair state, two memberships, and one
  two-participant Chat session;
- [x] internal Liked By actionable count/keyset projection under one repeatable-read snapshot;
- [x] signed, receiver-bound, short-lived opaque Liked By cursor/action references with query-version
  binding, purpose separation, and fail-closed resolution;
- [x] blurred-primary grant authorization shares the actionable Liked By predicate and denies stale,
  foreign, wrong-variant, and absent-rendition requests;
- [x] provider-neutral locked-card composition triggers bounded on-demand blur, reauthorizes every
  grant, and returns only opaque actions/cursors and no-store blurred media;
- [x] Telegram locked-card presentation validates callback size and the exact signed blur origin,
  path, rendition, and expiry; it does not send CDN grants directly to Telegram;
- [x] migration `000021` seeds verified English M3 text and exact variable declarations;
- [ ] authenticated Telegram media-byte relay and production wiring, plus final
  performance/acceptance evidence.
