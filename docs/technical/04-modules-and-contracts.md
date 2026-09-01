# Modules and Contracts

## 1. Contract model

Every entry point calls the same application use cases. A command changes state; a query reads state. Contracts are independent of HTTP, Telegram, SQL, and provider SDKs.

Base command envelope:

```ts
type CommandEnvelope<T> = {
  commandId: string;       // UUIDv7, also the idempotency key when appropriate
  commandType: string;
  schemaVersion: 1;
  actor: { userId: string; kind: 'user' | 'admin' | 'system' };
  requestId: string;
  occurredAt: string;      // ISO-8601 UTC
  locale: string;
  channelContext?: {
    channel: 'telegram' | 'web' | 'mobile' | 'internal';
    channelIdentityId?: string;
  };
  data: T;
};
```

Handlers return a typed business result containing stable codes and data. They do not return Telegram button markup or final localized sentences. Expected denial codes include `account_not_active`, `profile_not_eligible`, `pair_unavailable`, `insufficient_credits`, `scope_closed`, `already_processed`, `rate_limited`, and `version_conflict`.

## 2. Module ownership

### Identity and account lifecycle

Owns User, channel identities, Account transitions, settings, signup progress/draft, guest preview counter, deletion initiation, and authorization facts.

Public commands include:

- `RegisterTelegramIdentity`, `RecordActivity`, `StartSignup`, `SaveSignupStep`, `ConfirmSignup`;
- `ConsumeGuestPreview`, `ChangeLocale`, `ChangeVisibility`;
- `RequestAccountDeletion`, `ApplyAccountRestriction`, `ApplyAccountBan`, `RestoreAccount`.

Public queries include `GetAccountContext`, `GetSignupState`, and `CanPerformCapability`.

Only this module changes Account state. Other modules request transitions through it.

### Profile

Owns Profile, optional details, interests/languages/tags, catalog-backed choices, completion validity, and change-review application.

Commands: `CreateOrReplaceDraftProfile`, `ConfirmProfile`, `UpdateEditableProfile`, `SubmitProtectedFieldChange`, `ResolveProtectedFieldChange`, `RevalidateProfile`.

Queries: `GetOwnProfile`, `GetProfileCard`, `GetProfileEligibilityFacts`.

The public profile-card projection applies viewer-specific privacy; repositories never return a raw Profile directly to channel adapters.

### Media

Owns upload intent, asset validation, profile-photo ordering/primary rules, transformation, moderation visibility, and object deletion.

Commands: `CreatePhotoUploadIntent`, `CompletePhotoUpload`, `ApplyMediaValidation`, `SetPrimaryPhoto`, `ReorderPhotos`, `DeletePhoto`, `ModeratePhoto`.

Queries: `GetProfilePhotoSet`, `ResolveMediaDeliveryGrant`.

### Discovery

Owns Explore filters, candidate selection, no-repeat consumption, and Guest preview sampling.

Commands: `SaveExploreFilter`, `ConsumeCandidate`.

Queries/use cases: `GetNextExploreCandidate`, `GetNextGuestPreview`.

It reads eligibility facts through owned read ports and cannot mutate Profile preferences.

### Interaction

Owns Like, Not Interested, pair state, Liked By projection access, and FeatureUnlock.

Commands: `SendLike`, `MarkNotInterested`, `CreateInternalPairBlock`, `RemoveInternalPairBlock`, `GrantScopedUnlock`, `RevokeScopedUnlock`.

Queries: `GetLikedByPage`, `GetUnlockState`, `GetPairAvailability`.

Match creation is delegated to the Matching module through a coordinator; Interaction does not create a second Match implementation.

### Nakh

Owns directional NakhFlow, unpaid PendingNakh, delivered Nakh, receiver actions, reminder/expiry state.

Commands: `CreatePendingNakh`, `EditPendingNakh`, `FundAndSendNakh`, `CancelPendingNakh`, `ViewNakhProfile`, `AcceptNakh`, `RejectNakh`, `ExpirePendingNakh`, `ExpireDeliveredNakh`, `CloseNakh`.

Queries: `GetPendingNakhPage`, `GetReceivedNakhPage`, `GetNakhDetails`.

### Matching

Owns Match, exactly-two membership, UnmatchRecord, and chat-session lifecycle request.

Commands: `CreateMatchFromMutualLike`, `CreateMatchFromNakh`, `Unmatch`, `CloseMatch`.

Queries: `GetMatches`, `GetMatchAuthorization`.

Only this module creates or closes a Match. Its create command is idempotent for the normalized pair and validates a typed source proof.

### Chat

Owns chat session/participants/messages/read/mute state and report snapshots.

Commands: `OpenChatForMatch`, `SendPredefinedQuestion`, `SendPredefinedAnswer`, `SendTextMessage`, `MarkChatRead`, `ChangeChatMute`, `CloseChat`, `CaptureReportedMessages`.

Queries: `GetChatPage`, `GetChatCapability`.

Every message command rechecks active Match, pair safety state, Account capability, and, for text, effective Match-scoped unlock.

Granting a chat unlock creates notifications for both participants and a per-participant pending safety-warning intent. `unlock_safety_warning_shown_at` is set only after that participant is shown the warning, immediately or on the next chat open; contact-detail text access is never represented by dismissing a Telegram message alone.

### Billing and entitlements

Owns CreditAccount and immutable ledger, packages, funding intents, invoices/provider events, corrections, and the atomic funding of paid application actions.

Commands: `CreateFundingIntent`, `CreateStarsInvoice`, `RecordProviderEvent`, `ApplySuccessfulPayment`, `SpendCreditsForAction`, `RequestAutomaticCorrection`, `ReconcilePayment`.

Queries: `GetCreditBalance`, `GetCreditLedger`, `GetPackages`, `GetPaymentStatus`.

Billing validates and records funding. The target module validates the intended action immediately before grant. A coordinator makes credit spend plus target grant atomic; Stars success uses a durable fulfillment state machine.

### Notification

Owns durable user notifications, category preferences, delivery creation, retry state, and channel dispatch ports.

Commands: `CreateNotification`, `MarkNotificationRead`, `ChangeNotificationPreference`, `AttemptDelivery`, `RecordDeliveryResult`.

Queries: `GetNotificationPage`, `GetUnreadCount`.

### Moderation, administration, support

Moderation owns reports/evidence/snapshots/reviews/actions/appeals. Administration owns admin RBAC and attempted-command logging. Support owns bounded support conversation.

Every admin mutation is authorized by a permission, recorded before/after execution, carries a reason, and calls the normal application command rather than updating another module's table.

## 3. Application coordinators

Cross-module workflows live in named coordinators with explicit transaction boundaries:

- `SignupCoordinator`: identity + Profile + media eligibility + Account activation.
- `InteractionCoordinator`: consumption + Like/NotInterested + mutual-like Match creation.
- `NakhCoordinator`: quota + Nakh state + billing funding + Match on accept.
- `PaidActionCoordinator`: Credit ledger or paid Payment fulfillment + target action + unlock.
- `MatchLifecycleCoordinator`: Match + pair state + Like/Nakh closure + chat + notifications.
- `ModerationCoordinator`: report threshold + Account/photo/pair action + affected lifecycle closures.
- `DeletionCoordinator`: Account tombstone + access shutdown + purge saga creation.

A coordinator may depend on module public ports and a shared unit-of-work port. It must not import another module's private repository.

## 4. Client-facing HTTP API

The HTTP adapter is present from the start even though Telegram is the MVP channel. Initial endpoints may be internal until web authentication ships.

Conventions:

- base path `/v1`;
- JSON request/response, UTF-8, camelCase externally;
- `Authorization: Bearer <token>` for future client sessions; Telegram gateway uses workload identity internally;
- required `Idempotency-Key` for retryable mutation endpoints involving money, Like, Nakh, Match, reports, deletion, or provider actions;
- `X-Request-Id` accepted or generated; returned in every response;
- keyset pagination with opaque signed cursor; no offset pagination on changing feeds;
- RFC 9457-style problem object with stable application `code`, safe message key, request ID, and field errors;
- optimistic updates use `If-Match`/version where overwriting stale data would be harmful;
- timestamps ISO-8601 UTC; IDs strings; credits/large counters serialized as decimal strings if they can exceed safe JavaScript integers.

Resource groups:

```text
/v1/me/account
/v1/me/signup
/v1/me/profile
/v1/me/photos
/v1/me/settings
/v1/explore
/v1/interactions/likes
/v1/liked-by
/v1/nakhes
/v1/matches
/v1/chats
/v1/credits
/v1/payments
/v1/notifications
/v1/reports
/v1/support
/v1/admin/*             # separate auth audience and authorization
/v1/providers/telegram/*# provider callbacks, not user endpoints
```

Do not expose one endpoint per Telegram button. Endpoints represent stable use cases.

## 5. Authentication model

MVP Telegram requests are authenticated at the webhook adapter, mapped by unique Telegram ID to internal User, and forwarded over an in-process call or authenticated internal HTTP contract. Future web/mobile authentication is added as an Identity adapter:

- exchange a verified Telegram login payload or another approved identity proof for short-lived access and rotating refresh tokens;
- token subject is internal User ID, never Telegram username;
- token includes audience, issuer, session ID, issued/expiry times, and coarse account state version;
- every sensitive command loads current Account authorization; token claims do not override a ban/deletion;
- sessions are individually revocable and credentials are stored hashed;
- admin tokens have a different audience, shorter lifetime, enforced MFA when a web admin client exists, and no reuse as user tokens.

The future session tables belong to Identity and are added when a non-Telegram client is scheduled. They are not needed to implement the Telegram MVP.

## 6. Internal contracts

- In-process calls use TypeScript ports but still accept validated contract objects.
- If a process boundary is used, internal HTTP uses workload identity/mTLS and the same generated JSON Schema.
- Events report facts in past tense, for example `interaction.like-created.v1`, `matching.match-created.v1`, `billing.payment-paid.v1`.
- Jobs are commands to a worker, for example `notification.deliver.v1`, `media.generate-thumbnail.v1`.
- Events cannot request a side effect; jobs can.
- Contracts include ID, schema version, occurred time, correlation/causation IDs, actor context, and minimal payload identifiers.
- Consumers load current authoritative state when action correctness depends on it; an event payload is not an authorization snapshot.

## 7. Localization contract

Application results and notifications contain:

```ts
type LocalizedIntent = {
  key: string;
  variables: Record<string, string | number | boolean>;
  fallbackKey?: string;
};
```

Adapters render using the user's current UI locale and versioned catalog. Variable names are schema-validated. Markup is escaped by default and only approved templates may enable Telegram/HTML formatting. Missing keys emit a metric, fall back to English, and never expose the key or raw exception to the user.

## 8. Authorization policy

Capabilities are checked centrally and then narrowed by the use case:

- guest: start/signup/guest preview/settings/support/deletion as specified;
- incomplete: continue signup/guest preview/settings/support/deletion;
- active: normal product capabilities subject to Profile validity and visibility;
- restricted: only explicitly allowed safety/account/support/appeal capabilities;
- banned: ban notice, single appeal for current ban, deletion where permitted;
- deleted: no product access; fresh return only when Account policy permits.

Profile invalidity affects discovery/interaction capability but does not invent an Account transition. Visibility controls being shown, not whether a user can manage their account. Pair block and Match closure are rechecked for every pair-scoped command.

## 9. Contract review checklist

Before exposing a new command/query/event/job:

- product rule owner and module owner are named;
- authentication, authorization, rate limit, and idempotency behavior are explicit;
- transaction boundary and locks are defined;
- personal data fields and log redaction are classified;
- error codes and localization keys are registered;
- backward compatibility and replay behavior are tested;
- metrics and audit requirements are defined;
- deletion/retention behavior is defined;
- Telegram and future generic client behavior can both be represented without channel fields in the domain.
