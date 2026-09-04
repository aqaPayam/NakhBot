# M1 Execution Guide — Identity, Access, Localization, Signup, and Profile

Status: approved implementation guide for M1. This document tells the implementation team exactly what to build, in what order, and what evidence is required before M1 is accepted.

## 1. Authority

This guide translates the canonical domain and technical documents into executable work. It does not redefine product behavior.

When documents differ, use this order:

1. `docs/domain/` owns product behavior, states, validation, and acceptance scenarios.
2. [`03-data-architecture.md`](03-data-architecture.md), [`04-modules-and-contracts.md`](04-modules-and-contracts.md), and [`05-transactions-events-and-jobs.md`](05-transactions-events-and-jobs.md) own persistence, contracts, and transaction behavior.
3. This guide owns M1 sequencing, temporary integration boundaries, and completion evidence.

Do not make a product choice in code. If implementation exposes a real conflict with the canonical documents, stop that slice and correct the documents before continuing.

## 2. M1 outcome

At the end of M1, the backend must provide a channel-independent identity and Profile foundation that:

- resolves a Telegram user to exactly one internal User;
- creates the required first-start aggregate idempotently;
- routes every account/Profile state through one centralized capability policy;
- stores locale and visibility settings;
- resumes signup from durable PostgreSQL state;
- validates and normalizes every non-media signup field;
- stores a completed Profile atomically when media eligibility is satisfied;
- supports ordinary Profile edits and protected-field change requests;
- renders Telegram responses through localization keys and typed view models;
- enforces the permanent Guest Preview counter atomically;
- emits durable audit, history, idempotency, and outbox records;
- exposes contracts that future web and mobile clients can use without Telegram concepts in the application core.

M1 is not a prototype. Every implemented write path must be safe under retries, concurrent requests, process crashes, and horizontal scaling.

## 3. Explicit non-goals

Do not implement these features in M1:

- media ingestion, R2 storage, thumbnails, or media moderation;
- discovery ranking or the production Guest Preview candidate query;
- Like, Not Interested, Match, or interaction consumption;
- payments, credits, FeatureUnlocks, or Telegram Stars;
- Nakh flows;
- chat or notifications;
- full administration RBAC, support cases, appeals, or moderation UI;
- web or mobile presentation clients;
- microservice extraction.

M1 may define ports and contracts required by these later modules. It must not add placeholder business behavior that could be mistaken for the finished feature.

## 4. Locked cross-milestone decisions

Several canonical acceptance scenarios cross milestone boundaries. Use the following interpretation so that M1 does not claim evidence it cannot yet provide.

| Scenario | M1 responsibility | Final end-to-end owner |
|---|---|---|
| `ACC-001` simultaneous first start | Full implementation and final evidence | M1 |
| `ACC-002` shared Guest Preview limit | Permanent counter, atomic reservation contract, and concurrency proof; no production candidate delivery | M3 adds candidate eligibility and `ExploreConsumption` proof |
| `ACC-003` active but invalid Profile | Full capability/routing policy and final evidence | M1 |
| `ACC-004` visibility off with pending Nakh | Policy rule and contract proof with a supplied relationship-scope fact | M5 adds real Nakh persistence and end-to-end proof |
| `ACC-005` restricted account and chat | Policy rule and contract proof with a supplied chat-scope fact | M6 adds real chat persistence and end-to-end proof |
| `ACC-006` banned account appeal limit | Banned routing policy in M1 | M7 adds appeal uniqueness and final end-to-end proof |
| `ACC-007` Gregorian birth-year normalization | Full implementation and final evidence | M1 |

The traceability report must distinguish `M1 policy/component evidence` from `canonical scenario closed`. A canonical scenario remains open until its final owner supplies the complete end-to-end test.

Profile completion also depends on M2 media. M1 must define a `ProfileMediaEligibilityPort` and test completion with a deterministic test implementation. The production Telegram route must not allow final confirmation until M2 supplies the real adapter. Do not weaken the canonical requirement of 2–6 accepted photos with exactly one primary photo.

Protected-field review depends on M7 administration. M1 must implement the request and resolution use cases and persistence, but keep the production review endpoint disabled. Tests use an authorized internal reviewer fixture. M7 supplies full RBAC, operator provisioning, and the production administration adapter.

The first-start aggregate crosses the later billing and notification modules. M1 creates only the canonical zero-balance CreditAccount and default NotificationPreference rows and the minimum tables needed to preserve those invariants. M4 owns credit transactions and balance behavior; M6 owns notification delivery and preference editing.

## 5. Delivery rules

Each vertical slice must include all of the following before it is merged:

1. versioned contracts and stable error/localization keys;
2. domain types and pure rules;
3. application command/query handler and ports;
4. SQL migration or repository change, when needed;
5. PostgreSQL implementation with transaction and lock behavior;
6. Telegram/API adapter changes, when the slice is user reachable;
7. audit, outbox, metrics, and redacted structured logs;
8. unit, integration, concurrency, and contract tests appropriate to the slice;
9. traceability updates and operating notes.

Do not merge an application handler that still uses an in-memory repository in production wiring. Do not merge skipped acceptance or integration tests. Test doubles are permitted only at an explicit later-milestone port such as media eligibility.

## 6. Source layout

Keep the existing packages. Organize M1 by capability inside them; do not create a service or package per entity.

```text
packages/domain/src/
  identity/
  access/
  localization/
  profile/
packages/application/src/
  identity/
  access/
  localization/
  profile/
  signup/
packages/contracts/src/
  identity/
  localization/
  profile/
packages/persistence-postgres/src/
  identity/
  localization/
  profile/
packages/localization/src/
  catalog/
  renderer/
packages/telegram/src/
  start/
  signup/
  profile/
  settings/
packages/testkit/src/m1/
```

The domain package must not import NestJS, Telegram, PostgreSQL, Redis, Kysely, or localization text. The application package may depend only on domain types, contracts, and declared ports. Presentation adapters translate channel input into the same application commands used by future clients.

## 7. Database implementation

### 7.1 Migration sequence

Create new forward-only migrations after the existing M0 migration. Use this order:

1. `000002_m1_identity_localization.sql`
2. `000003_m1_identity_start.sql`
3. `000004_m1_settings.sql`
4. `000005_m1_profile_catalogs.sql`
5. `000006_m1_signup_profile.sql`
6. `000007_m1_profile_change_requests.sql`

Never edit an already-applied migration. Each migration must run on a new database and on a database at the immediately previous version. Each must provide verification queries in its header or companion test. Rollback is application rollback plus a forward repair migration; production data is never removed automatically.

### 7.2 Identity and localization tables

Migration `000002` creates:

- `identity.users`;
- `identity.telegram_identities`, with unique `telegram_user_id` and mutable nullable username;
- `identity.accounts`, one per User, with a checked account state;
- `identity.account_state_history`, append-only and actor-attributed;
- `identity.guest_preview_counters`, one per User, initialized to `count = 0` and immutable `limit_snapshot = 10`;
- `identity.user_settings`, one per User, with `visibility_enabled = true` and `ui_locale_code = 'en'`;
- `billing.credit_accounts`, one per User, initialized to zero with a non-negative balance check and version;
- `notification.notification_preferences`, one per User, with chat, like, Nakh, and match categories enabled by default;
- `catalog.locales`, with `en` active/default and `fa` present but inactive;
- `catalog.ui_texts`, unique by locale and text key;
- the indexes required by [`03-data-architecture.md`](03-data-architecture.md).

Migration or seed code must enforce exactly one default locale. Locale codes and text keys are stable identifiers; displayed text is data, not a business key.

The first-start transaction creates User, TelegramIdentity, Guest Account, UserSettings, GuestPreviewCounter, NotificationPreference, and CreditAccount. M1 must not add a credit ledger entry for the zero initialization or implement notification delivery.

Migration `000003` creates the append-only `platform.audit_logs` stream and its subject, actor, event, and time indexes. It contains stable codes and safe bounded metadata only; Telegram identifiers and user-authored prose are prohibited.

Migration `000004` adds the required localized settings and authorization errors. The settings table itself remains owned by migration `000002`.

### 7.3 Catalog tables

Migration `000005` creates the normalized catalogs and hierarchy required by signup/Profile:

- gender options;
- relationship-gender preferences and their member mapping;
- relationship goals;
- interests;
- languages;
- personality tags;
- countries, provinces, and cities with parent foreign keys;
- optional-detail enumerations defined by the canonical enum registry.

Every catalog row has a stable code, localization label key, active flag, and display order. Foreign keys use internal IDs; API and seed contracts use stable codes. Never persist translated labels in Profile rows.

Seed at least the complete locked enum registry, Iran, and deterministic test locations. A complete production Iran province/city dataset is a production release input and must be versioned, checksum-verified, and loaded before production signup is enabled. Partial production geography must fail deployment readiness.

### 7.4 Signup and Profile tables

Migration `000006` creates:

- `identity.signup_progress`, at most one current progress row per User;
- `identity.signup_drafts`, at most one draft per User, storing a versioned structured payload and last completed step;
- `profile.profiles`, at most one current Profile per User;
- `profile.profile_optional_details`, at most one per Profile;
- Profile-to-interest, Profile-to-language, and Profile-to-personality-tag join tables with unique pairs;
- all checks, hierarchy foreign keys, and indexes defined by the data architecture.

The persisted draft schema is versioned. A decoder must reject unknown future versions safely and migrate known old versions explicitly; it must never cast arbitrary JSON directly into a domain type.

`profile.profiles` must store `completion_status`, `ever_completed`, and `completed_at` separately. A User who completed once and later becomes invalid is not treated as never completed.

Media IDs are not stored in the M1 Profile tables. M2 owns media records. M1 consumes only the media eligibility result through its port.

### 7.5 Protected changes

Migration `000007` creates:

- the minimal canonical `administration.admin_users` identity table needed by the review foreign key, with no roles, permissions, or production provisioning;
- `profile.profile_change_requests`;
- a partial unique index allowing only one pending request per User and protected field;
- `profile.profile_change_reviews`, unique by request;
- the audit and query indexes defined by the data architecture.

For M1 tests, reviewer identity is a synthetic active AdminUser authorized through `ProfileChangeReviewerAuthorizationPort`. The production review transport remains disabled. M7 adds roles, permissions, action logs, and operator provisioning before enabling that route.

### 7.6 Constraint and repository requirements

The database, not only TypeScript, must enforce:

- one Telegram identity per Telegram user ID;
- one Account, settings row, counter, current Profile, progress row, and draft per User;
- valid state/status/step values;
- non-negative Guest Preview counts and `count <= limit_snapshot`;
- unique catalog codes and selection pairs;
- valid country/province/city hierarchy;
- one pending protected-field request per field/User;
- one review per request;
- append-only account history;
- timestamps stored as `timestamptz` in UTC.

Repository methods must accept an existing transaction when participating in a multi-module use case. They must not silently open nested independent transactions.

## 8. Domain and contract implementation

### 8.1 Stable domain types

Implement branded IDs and exhaustive unions for:

- User, Telegram identity, Profile, catalog, request, and review IDs;
- `AccountState`;
- `SignupStep` in canonical order;
- `ProfileCompletionStatus`;
- `ProfileChangeStatus` and review decision;
- locale code and localization text key;
- capability and denial reason codes.

All state transitions go through one pure `AccountTransitionPolicy`. All access decisions go through one pure `CapabilityPolicy`. Handlers and Telegram menus must not duplicate these rules.

### 8.2 Command envelope

Every M1 command uses the existing command envelope:

- `commandId`;
- stable command `type` and `schemaVersion`;
- authenticated actor;
- `requestId`;
- `occurredAt`;
- UI locale;
- channel context containing identifiers, not channel-specific business rules.

Publish JSON schemas and TypeScript types for every public request and response. Unknown fields are rejected at transport boundaries. Additive response changes require a compatibility test; breaking changes require a new schema version.

### 8.3 Commands and queries

Implement these application operations:

Identity commands:

- `RegisterTelegramIdentity`;
- `RecordActivity`;
- `StartSignup`;
- `SaveSignupStep`;
- `ConfirmSignup`;
- `ConsumeGuestPreview` as the M1 counter contract;
- `ChangeLocale`;
- `ChangeVisibility`;
- internal `TransitionAccountState` used only by the owning module.

Identity queries:

- `GetAccountContext`;
- `GetSignupState`;
- `GetCapabilityDecision`.

Profile commands:

- `SaveProfileDraft` through the signup coordinator;
- `ConfirmProfile`;
- `UpdateProfile`;
- `RequestProtectedProfileChange`;
- internal `ResolveProtectedProfileChange`;
- `RevalidateProfile`.

Profile queries:

- `GetOwnProfile`;
- `GetProfileEditModel`;
- `GetActiveCatalogs`;
- `GetProtectedChangeRequestStatus`.

No operation accepts a User ID from Telegram input as authority. The authenticated Telegram identity resolves the User first; requested resource ownership is then checked server-side.

### 8.4 Error and capability contracts

Application errors expose a stable machine code, localization key, safe parameters, retry classification, and optional field path. They never contain final user-facing prose.

At minimum, define stable codes for:

- unauthenticated identity;
- invalid account transition;
- capability denied with denial reason;
- stale signup/Profile version;
- invalid signup step;
- invalid or inactive catalog selection;
- invalid Gregorian birth year or underage User;
- invalid location hierarchy;
- Profile incomplete;
- media eligibility not satisfied;
- Guest Preview limit reached;
- pending protected change already exists;
- protected change no longer valid;
- reviewer unauthorized;
- idempotency key reused with different input.

Capability decisions must return `{ allowed, reasonCode, requiredRoute }`. Implement the complete canonical state matrix now, including later-feature capability names, as pure policy. Later modules supply relationship-scope facts; M1 must not query their future tables.

## 9. Validation and normalization

One shared domain validator must serve Telegram, HTTP, tests, and future clients.

Implement these locked rules:

- normalize human text to NFC;
- trim leading/trailing whitespace;
- count Unicode code points, not UTF-16 code units;
- reject disallowed control characters;
- normalize Persian and Arabic digits to Western digits before parsing birth year;
- accept exactly four Gregorian birth-year digits;
- enforce the canonical floor year and `currentYear - 18` using the injected Clock;
- reject Jalali years, future years, and underage Users;
- enforce name, highlight, bio, reason, job, and height limits;
- require active, distinct catalog selections;
- enforce 5–20 interests, at most 10 languages, and at most 5 personality tags;
- validate the complete Iran country/province/city ancestry;
- require the canonical gender-preference and relationship-goal values;
- keep birth year and gender protected after first completion;
- revalidate required fields synchronously after every relevant edit.

Validation returns structured field errors with localization keys. Never use regular-expression or exception messages as user copy.

## 10. Transaction designs

### 10.1 First start

Within one transaction:

1. claim idempotency for the normalized Telegram update;
2. insert or resolve `telegram_user_id` using its unique constraint;
3. lock the resolved identity/User when another transaction created it;
4. create any missing required aggregate rows with conflict-safe inserts;
5. read the complete account context;
6. write audit and outbox records only for real changes;
7. persist the idempotent response;
8. commit, then render the required route.

Two simultaneous first-start requests must return the same User and leave exactly one of every required row. Username changes update metadata but never identity or authorization.

### 10.2 Account transition

Lock the Account row, validate the transition with `AccountTransitionPolicy`, update the Account, append AccountStateHistory, append audit, emit `identity.account-state-changed.v1`, and store the command result in one transaction. Only the Identity module may perform this write.

### 10.3 Start and save signup

`StartSignup` changes Guest to Incomplete and creates or resumes progress/draft atomically. It never resets Guest Preview usage.

`SaveSignupStep`:

1. validates the command and capability;
2. locks progress and draft in the standard order;
3. compares the expected draft version;
4. validates and normalizes only the submitted step plus affected cross-field rules;
5. writes the structured draft and next step;
6. stores audit/outbox/idempotent result;
7. commits before Telegram rendering.

Duplicate commands return the original response. A stale version returns a stable conflict and the current safe resume state.

### 10.4 Confirm signup

Do not make a network call while holding database locks. Obtain immutable media eligibility through a database-backed port or a prechecked token that is revalidated inside the transaction.

Then, in one transaction and standard lock order:

1. lock User, Account, progress, draft, and current Profile rows;
2. revalidate the complete draft against current active catalogs and location hierarchy;
3. revalidate media eligibility;
4. write Profile, optional details, and all selection joins;
5. set completion status, `ever_completed`, and completion timestamp;
6. mark signup progress completed;
7. transition the Account to Active and append history;
8. append audit and required outbox events;
9. store the idempotent result;
10. commit.

Any failure leaves the User Incomplete and preserves the resumable draft.

### 10.5 Profile edit and revalidation

Lock the current Profile before replacing selections. Validate active catalogs and hierarchy inside the transaction. After an edit, recompute completion synchronously:

- a never-completed Profile that fails requirements remains Incomplete;
- a previously completed Profile that fails requirements becomes Invalid;
- an Active Account remains Active; access policy routes it to repair;
- restoring all requirements returns the Profile to Complete.

### 10.6 Protected-field request and review

Submission validates reason length, locks the User/Profile, relies on the partial unique index for concurrency safety, and stores the requested value in a typed versioned payload.

Resolution authorizes the reviewer, locks Account, Profile, request, and review rows, revalidates the proposed value against current rules, applies an approved value, creates exactly one review, closes the request, revalidates Profile completion, writes audit/outbox, and commits atomically. Replaying the same command returns the original decision; a different decision against the same request conflicts.

### 10.7 Guest Preview counter

The M1 repository operation performs one conditional update equivalent to:

```sql
UPDATE identity.guest_preview_counters
SET count = count + 1,
    first_preview_at = COALESCE(first_preview_at, now()),
    last_preview_at = now()
WHERE user_id = $1
  AND count < limit_snapshot
RETURNING count, limit_snapshot;
```

No returned row means the limit is reached. M1 tests prove that concurrent requests can never exceed 10.

M3 must call this operation only after it selects an eligible candidate and Telegram accepts the delivery, and must atomically create `ExploreConsumption`. Until M3 supplies that transaction, the production Guest Preview delivery route remains disabled.

## 11. Localization and presentation

All user-facing prose, button labels, errors, and route messages must resolve through `catalog.ui_texts`. Handlers return typed intents/view models such as message key, safe variables, button keys, and callback intent. They never return Telegram-ready prose.

Create a version-controlled localization manifest containing:

- every text key;
- category;
- required variables and their types;
- English value;
- whether the key is required for route completeness.

Use stable namespaces including `start.*`, `account.*`, `signup.*`, `profile.*`, `settings.*`, `common.button.*`, and `error.*`. CI must fail for a missing required English key, an undeclared variable, an unused required key, or prose introduced in Telegram/application handlers.

UI locale and Profile languages are separate. `ChangeLocale` accepts only an active UI locale. `fa` remains stored but unavailable until its required key coverage is complete and it is explicitly activated.

Telegram remains a thin adapter:

- authenticate and deduplicate the update;
- resolve the User;
- map commands/callbacks to application contracts;
- render the typed localized model;
- sign and validate callback payloads with expiry and intended User;
- never keep durable signup progress in session or Redis;
- never infer access from which menu button was shown.

## 12. HTTP boundary

Add channel-neutral API routes only after their contracts and authorization tests exist. Use resource-oriented endpoints from [`04-modules-and-contracts.md`](04-modules-and-contracts.md) for account context, signup state/steps/confirmation, own Profile, settings, catalogs, and protected change requests.

Every write requires authenticated actor context and idempotency metadata. Versioned writes require `If-Match` or an equivalent expected version. Telegram may call the application handlers in-process, but it must use the same request/response contracts as HTTP.

Do not expose the internal protected-change resolution endpoint or the incomplete Guest Preview delivery route in production M1.

## 13. Security, privacy, and observability

For every M1 path:

- derive identity only from a verified Telegram update or the future authenticated API principal;
- rate-limit start, signup writes, Profile changes, and protected-change submissions;
- redact Telegram IDs, usernames, names, bio/highlight content, draft payloads, and protected requested values from logs;
- never use User IDs, Telegram IDs, locale codes with uncontrolled cardinality, or request IDs as metric labels;
- include request/command/trace IDs in structured logs;
- audit state changes, visibility/locale changes, Profile confirmation, protected requests/reviews, and administrative actions;
- classify retryable database conflicts separately from permanent validation denials.

Add metrics for first-start success/conflict, signup starts/completions/failures by stable reason code, Profile invalidation/restoration, Guest Preview denial, protected request outcome, outbox lag, and handler latency. Dashboards and alerts must use bounded labels only.

Register each M1 entity in the deletion/retention registry. Ordinary signup drafts and Profile data follow deletion policy. The permanent Guest Preview counter is retained as the canonical anti-reset exception and must not be recreated at zero after deletion/re-entry.

## 14. Required test evidence

### 14.1 Unit and property tests

Cover:

- every allowed and denied Account transition;
- the complete capability/state/Profile/visibility matrix;
- Unicode normalization and code-point limits;
- Persian/Arabic digit normalization and Gregorian age boundaries using a fixed Clock;
- all catalog cardinalities and hierarchy checks;
- Profile completion, invalidation, and restoration;
- protected-field classification and proposed-value decoding;
- localization key and variable-schema completeness.

### 14.2 PostgreSQL integration tests

Use real PostgreSQL migrations and repositories. Cover every unique, foreign-key, check, and partial-index invariant; append-only history; transaction rollback; idempotency conflict; selection replacement; draft version conflict; Profile confirmation; and protected review uniqueness.

### 14.3 Concurrency tests

Use real concurrent connections and deterministic barriers for:

- simultaneous first start;
- duplicate signup start/save/confirm;
- two Guest Preview increments at the final slot;
- two pending protected requests for the same field;
- competing protected-change decisions;
- Profile edit racing confirmation;
- account transition racing a capability-gated command.

Tests must assert final database state, history, audit, outbox, and idempotent response—not only HTTP status.

### 14.4 Contract and adapter tests

Verify JSON schemas, backward-compatible responses, stable error codes, signed callback ownership/expiry, no prose outside localization, resume after process restart, duplicate Telegram updates, and consistent behavior between Telegram and HTTP adapters.

### 14.5 Acceptance ledger

Record evidence with these IDs:

- `ACC-001/M1-E2E` — canonical scenario closed;
- `ACC-002/M1-COUNTER` — component proof; canonical scenario stays open until M3;
- `ACC-003/M1-E2E` — canonical scenario closed;
- `ACC-004/M1-POLICY` — policy proof; canonical scenario stays open until M5;
- `ACC-005/M1-POLICY` — policy proof; canonical scenario stays open until M6;
- `ACC-006/M1-ROUTE` — route proof; canonical scenario stays open until M7;
- `ACC-007/M1-E2E` — canonical scenario closed.

No test may be skipped because a dependency is unavailable. Later-module boundaries use explicit deterministic contract fakes; M1-owned PostgreSQL behavior always uses real PostgreSQL.

## 15. Pull request sequence

Implement M1 as these reviewable vertical changes. Do not begin a later item while an earlier migration, contract, or concurrency gate is red.

### PR 1 — M1 domain and contract foundation

- add IDs, enums, transition/capability policies, validation primitives, command/query schemas, error codes, and test fixtures;
- add pure unit/property tests;
- no user-facing route yet.

### PR 2 — identity/localization persistence

- add migration `000002`, seeds, repositories, deletion registry entries, localization manifest/renderer, and integration tests;
- add migration verification and seed idempotency tests.

### PR 3 — idempotent first start and routing

- implement `RegisterTelegramIdentity`, account context, start router, Telegram adapter, audit/outbox, and `ACC-001` concurrency test;
- ensure every state route is produced by centralized policy.

### PR 4 — settings and capability enforcement

- implement locale/visibility writes and capability middleware/guards;
- prove `ACC-003` and M1 policy portions of `ACC-004..006`;
- add no-prose and cross-User authorization tests.

### PR 5 — catalogs and durable signup

- add migrations `000005` and `000006`, seed registry, signup progress/draft repositories, start/save handlers, validators, and resume UI;
- prove `ACC-007` and stale-version/idempotency behavior.

PR 5 implementation record:

- [x] Catalog rows use stable codes, normalized foreign-key hierarchy, active flags, deterministic ordering, and localized label keys.
- [x] The complete locked gender, preference, relationship-goal, interest, language, personality-tag, and optional-detail registries are seeded.
- [x] Iran plus deterministic test locations are seeded; the fixture is explicitly not production-complete.
- [x] Signup progress and schema-versioned drafts are durable and one-per-User.
- [x] Draft decoding rejects unknown schema versions, unknown steps, unexpected fields, and invalid stored shapes.
- [x] Start Signup atomically transitions Guest to Incomplete without resetting Guest Preview usage.
- [x] Save Signup Step enforces canonical order, active catalogs, exact location ancestry, normalization, optimistic versions, idempotency, audit, and outbox.
- [x] Signup resumes from persisted state after process restart and stops at `confirm_profile` until PR 6 supplies media eligibility and atomic confirmation.
- [x] `ACC-007/M1-E2E`, duplicate start/save, idempotency conflict, and competing stale-writer behavior have PostgreSQL evidence.

### PR 6 — Profile confirmation and editing

- add `ProfileMediaEligibilityPort`, confirmation coordinator, Profile queries/edits, revalidation, Telegram/API adapters, and transaction/concurrency tests;
- keep production confirmation disabled until the real M2 media adapter is wired.

### PR 7 — protected changes

- add migration `000007`, request/review use cases, internal reviewer authorization port, audit/outbox, and concurrency tests;
- do not expose production review administration.

### PR 8 — Guest Preview counter and M1 hardening

- add the conditional counter operation and `ACC-002/M1-COUNTER` test;
- complete telemetry, security tests, traceability, runbooks, load smoke, and staging evidence;
- keep production candidate delivery disabled until M3.

Each PR must be independently deployable or protected by a default-off feature flag. Database expand changes deploy before readers/writers; destructive cleanup is deferred to a later verified release.

## 16. CI and staging gates

Every PR must pass:

- frozen dependency installation;
- formatting, lint, type checking, unit/property tests;
- migration from empty and previous schema versions;
- PostgreSQL integration and concurrency tests;
- contract and localization checks;
- production dependency audit with the repository's approved transient-network retry policy;
- container build and startup smoke.

Before M1 acceptance, deploy to staging and verify:

- webhook authentication and duplicate delivery;
- restart during signup followed by correct resume;
- concurrent first start and Guest Preview final-slot tests;
- database rollback on injected failure during confirmation;
- outbox delivery/replay and no duplicate side effects;
- structured-log redaction with representative private data;
- metrics and alerts are visible without high-cardinality labels;
- backup/restore smoke still passes with the current PostgreSQL major version.

## 17. M1 definition of done

M1 is complete only when all items below are true:

- all eight PR outcomes are merged and the default branch is green;
- migrations and seeds are repeatable, reviewed, and verified on a restored database;
- no production path uses an in-memory repository or unversioned draft payload;
- all Account transitions and capability decisions use their centralized policies;
- every user-facing string comes from localization data;
- first start, signup writes, confirmation, edits, and counter updates are idempotent and concurrency tested;
- Profile completion is atomic and cannot bypass media eligibility;
- later-module production routes described in Section 4 remain disabled;
- security, deletion/retention, audit, observability, and runbook requirements are implemented;
- the acceptance ledger accurately distinguishes closed scenarios from partial M1 evidence;
- the traceability matrix links every M1 rule to code and passing tests;
- staging evidence is attached to the release record;
- no unresolved Critical or High defect remains and every Medium defect has an owner and explicit release decision.

## 18. First implementation action

After this guide is accepted, start only **PR 1 — M1 domain and contract foundation**. Before editing code, create a checklist mapping each new type, rule, contract, error code, and test to the canonical paragraph or acceptance scenario it implements. Do not start database migrations until that review is complete.

### PR 1 traceability checklist

- [x] Account states and legal transitions map to Domain Statuses §1.
- [x] Signup steps, completion states, protected fields, and review decisions map to Domain Statuses §§1–2.
- [x] Entry routing and the complete capability matrix map to Business Rules §1.
- [x] Unicode normalization, code-point limits, digit normalization, and birth-year validation map to Business Rules §2.
- [x] Profile selection cardinalities map to Business Rules §3 and Domain Attributes defaults.
- [x] Identity/Profile command schemas map to Technical Modules and Contracts §§3–4 and §15.
- [x] Stable errors, routes, capabilities, and denial reasons contain no user-facing prose and map to localization keys.
- [x] `ACC-003..006` policy evidence and `ACC-007` domain evidence use the phased acceptance IDs in Section 14.5.
- [x] Strict TypeBox schemas reject additional properties, invalid discriminators, and mismatched protected-field values.
- [x] Formatting, lint, type checking, all unit tests, and all package builds pass before PR 1 is committed.
