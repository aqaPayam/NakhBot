# Business Rules, Invariants, and Acceptance Criteria

This is the normative cross-entity product contract. An implementation is not correct unless every MUST/MUST NOT rule and acceptance criterion holds.

## User-facing surfaces

Complete active main menu:

- Explore
- Matches
- Nakhes
- Liked By
- Edit Profile
- Settings

Invalid active menu:

- Fix Profile
- Edit Profile
- Matches
- Nakhes
- Settings
- Support

Restricted menu:

- Edit Profile
- Matches and chats in read-only mode
- Settings
- Support

Settings contains visibility, notification preferences, Edit Profile, account deletion, Support, and UI language when another locale is enabled. Wallet is not a main-menu surface.

Guest Preview and normal Explore cards contain current primary photo, name, approximate age, City, and highlight. Show More opens the full Profile. Normal Explore actions are Like, Send Nakh, Not Interested, Show More, and Report. Guest Preview has no interaction actions.

Nakhes contains received Sent Nakhes, sent Nakh status, sender-only Pending Nakhes, and terminal expired/closed history during the account lifetime. A receiver never sees another user's Pending Nakh.

The English UI tone SHOULD be casual, clear, respectful, and light without sexual pressure, manipulative urgency, or forced humor.

## 1. Access and routing

### Access matrix

| Effective state | Entry route | Guest Preview | Edit/Profile settings | New discovery | Existing Match/chat | Paid actions | Support/deletion |
|---|---|---:|---:|---:|---:|---:|---:|
| guest | Guest / Sign Up | yes, within permanent limit | signup only | no | no | no | yes |
| incomplete | Continue Signup / Browse | yes, same limit | signup only | no | no | no | yes |
| active + complete + visible | Main menu | no | yes | yes | yes | yes | yes |
| active + complete + visibility off | Main menu with paused discovery | no | yes | no | yes | chat unlock and existing Pending Nakh only | yes |
| active + invalid | Fix Profile menu | no | yes | no | yes | existing-chat unlock only | yes |
| restricted | Restricted menu | no | yes | no | read only | no | yes |
| banned | Ban appeal | no | deletion only | no | no | no | appeal or deletion only |
| deleted | Return decision | no | no | no | no | no | limited return message |

Rules:

- Access checks MUST be centralized and evaluated from current Account, Profile completion, visibility, pair state, and scoped entity state.
- A handler MUST NOT infer access from the menu button that led to it.
- Active invalid users MAY use existing chat according to its current lock state and MAY unlock an existing active Match chat; they MUST NOT use Explore, Liked By actions, Like, Not Interested, or Nakh.
- Visibility off MUST NOT close existing Matches or chats.
- Visibility off users MAY view existing Matches, chats, and delivered Nakhes; they MAY act on a delivered Nakh or settle/cancel a Pending Nakh created earlier. They MUST NOT start Explore, Like/Like Back, a standalone Explore/Liked By Not Interested action, Liked By unlock, or a new NakhFlow.
- Pending Nakh conversion to Like or Not Interested is permitted while visibility is off because it terminates a previously authorized flow; current Account/Profile/pair eligibility still applies.
- Restricted users MAY read existing chats but MUST NOT send any message.
- A banned user MUST NOT create SupportThread or SupportMessage and MAY create only one UserAppeal for the current ban event. Account deletion remains available through the dedicated banned-account route.

### Start routing

Every `/start` resolves TelegramIdentity before creating anything.

- Unknown identity: create the first-start aggregate and show Guest / Sign Up.
- guest: show Guest / Sign Up.
- incomplete: show Continue Signup / Browse as Guest.
- active + complete: show the main menu, with discovery paused if visibility is off.
- active + invalid: show Fix Profile.
- restricted: show restriction information and Support.
- banned: show appeal creation or the existing appeal status.
- deleted: evaluate return permission; never create a second User for the same Telegram user ID.

## 2. Identity, Guest Preview, and signup

### Persistent identity

- TelegramIdentity.telegram_user_id MUST be globally unique.
- Telegram username MUST NOT be used as an authentication key or permanent identifier.
- MVP signup requires no phone number, email address, government ID, or identity outside Telegram.
- First-start aggregate creation MUST be idempotent under duplicate Telegram updates.

### Guest Preview

- Guest and Incomplete users share one GuestPreviewCounter.
- The lifetime limit is 10 and MUST be incremented atomically.
- Parallel requests MUST NOT allow the count to exceed the stored limit.
- A count is consumed only after the preview message is successfully accepted by Telegram for delivery.
- Each consumed preview MUST create the same transaction's ExploreConsumption.
- Starting signup, abandoning signup, activation, deletion, or return MUST NOT reset GuestPreviewCounter.

Guest Preview target eligibility:

- target is not the viewer;
- target Account is active;
- target Profile is complete and in Iran;
- target visibility is enabled;
- target has a visible primary photo;
- no viewer/target ExploreConsumption exists;
- pair is not blocked.

Guest Preview MUST ignore all viewer Profile fields, SignupDraft values, relationship preferences, age, City, relationship goal, and ExploreFilter.

At the limit, the bot shows signup messaging. If the eligible pool is empty before the limit, it shows an empty teaser state without incrementing the counter.

### Signup validation

Signup order is the SignupStep registry order.

General text rules:

- Trim surrounding whitespace and normalize to Unicode NFC.
- Lengths are counted in Unicode code points.
- Reject control characters other than ordinary spaces.
- Store validated values, never raw Telegram message formatting.

Age:

- The user MUST first confirm 18+.
- Normalize Persian and Arabic digits to Western digits.
- Birth year MUST then be exactly four decimal digits.
- The integer MUST satisfy `min_birth_year <= year <= current Gregorian year - min_signup_age`.
- Jalali years, full dates, decimals, future/current years, and non-numeric input are rejected.
- Exact date, exact age, and age verification are outside MVP.
- Displayed age is `current Gregorian year - birth_year` and is approximate.

Profile:

- Name is required and at most 32 characters.
- Relationship gender preference is required.
- At least 5 and at most 20 distinct active Interests are required.
- Country, Province, and City must be a valid active hierarchy; MVP Country is Iran.
- Relationship goal is required.
- Highlight is required and at most 80 characters.
- Bio is optional and at most 500 characters.
- At least 2 visible photos, at most 6 saved visible+hidden photos, and exactly one visible primary photo are required.
- Optional Profile fields never affect completion.
- Optional height, when present, is an integer from 100 through 250 cm.
- Optional job title is at most 64 characters.
- A Profile may select at most 10 spoken languages and 5 personality tags.

Confirmation MUST atomically validate the entire aggregate. A successful confirmation transitions Account to active and Profile to complete. Partial or stale draft data MUST NOT leak into a completed Profile.

### Profile editing

- Birth year and gender are locked after first completion.
- A locked-field change requires a reason of 1–1024 characters and an admin-approved ProfileChangeRequest.
- Admin approval MUST re-run the same validation as signup.
- Relationship gender preference may be changed only through Edit Profile, not Explore filters.
- A preference change affects future candidate eligibility and interactions; it does not retract already-sent Likes or delivered Nakhes.
- Every edit to required data MUST synchronously re-evaluate Profile completion.

## 3. Media and photos

### Validation and storage

- Dating photos MUST be explicit uploads; Telegram Profile photos are not imported.
- Telegram file IDs are temporary transport references, not media source of truth.
- The backend MUST decode and inspect actual content; filename extension and declared MIME are insufficient.
- Accepted MVP formats are non-animated JPEG, PNG, and WebP.
- GIF, HEIC/HEIF, video, sticker, document, animated image, corrupt image, and non-image files are rejected.
- Original size MUST be at most 10 MB.
- Decoded dimensions MUST be at least 600x600.
- A User may start at most 20 photo-upload attempts in a rolling 24-hour window, including rejected attempts.
- Exact duplicate active images for one Profile MUST be rejected by content hash; normalized visual hash SHOULD be used when available.
- Original media MUST reside in Cloudflare R2 behind an S3-compatible abstraction; user delivery MUST use the CDN abstraction.
- The app server MUST NOT be permanent media storage.

### Visibility pipeline

A ProfilePhoto MUST NOT become visible until:

1. validation succeeded;
2. the original is durably stored;
3. the required thumbnail is durably stored;
4. the ProfilePhoto transaction commits.

A failed attempt MUST NOT consume one of six saved-photo slots. Partial objects MUST be removed or queued for cleanup.

Thumbnail exists to keep Telegram previews and list/card delivery efficient and predictable. It is generated for every visible ProfilePhoto.

Blurred preview:

- is required only for a locked Liked By card;
- is generated on demand for the liker's current primary photo;
- is cached as a PhotoVariant;
- is never an upload-time visibility requirement;
- may fail without invalidating the ProfilePhoto.

### Photo management

- Users MAY reorder photos, select a visible primary photo, replace photos, and delete photos.
- Users MUST NOT set a photo to hidden; hidden is moderation-only.
- A user cannot delete the current primary photo until another visible photo is selected atomically.
- Hidden photos count toward the six saved-photo limit and do not count toward the two-visible-photo requirement.
- Deleted photos count toward neither limit.

User deletion MUST hard-delete the public original and variants unless evidence retention is required. Evidence retention MUST use restricted storage and MUST remove public URLs.

Admin hide is reversible. Admin delete removes the photo from product use and retains only the media/evidence allowed by safety retention.

If moderation removes the primary photo, the lowest display-order visible photo MUST be promoted in the same transaction. Profile completion is then re-evaluated.

MVP has report/admin moderation only; it does not claim automated identity, age, face, liveness, or NSFW verification.

## 4. Explore, filtering, and consumption

### Viewer eligibility

Normal Explore requires Account active, Profile complete, and visibility enabled.

### Target eligibility

A target MUST:

- not be the viewer;
- have Account active, Profile complete, visibility enabled, and a visible primary photo;
- be in the supported Country;
- have no blocked, matched, or unmatched UserPairState with the viewer;
- have no existing viewer/target ExploreConsumption;
- satisfy reciprocal relationship-gender compatibility;
- satisfy the viewer's ExploreFilter.

### Relationship preference versus Explore filter

Profile.gender_preference_id is the relationship preference and participates in reciprocal compatibility.

ExploreFilter.target_gender_option_ids is the user's current browsing subset. It MUST be a subset of the genders included by the viewer's Profile preference. The server MUST intersect it with reciprocal eligibility even if a stale or manipulated client sends broader values.

Default filters:

- target genders: every GenderOption included by the Profile preference;
- minimum age: `max(18, viewer approximate age - 5)`;
- maximum age: `viewer approximate age + 5`;
- City: viewer's City;
- relationship goal: no additional restriction.

MVP location filtering is City-only. Country is fixed to Iran; Province is used to group Cities. There is no Province-wide, Country-wide, free-text, or “Other City” option.

### Randomization

- The database MUST apply all eligibility filters before candidate selection.
- It MUST select at most 100 candidates using Profile.random_shuffle_key or an equivalent indexed rotating key.
- It MUST NOT use full-table per-request random ordering.
- The application shuffles the bounded candidates.
- Shuffle keys refresh every 6 hours.
- Target eligibility MUST be rechecked immediately before display.

### Consumption

- Consumption is created when a Profile Preview is actually delivered or when an action creates a stronger event before preview recording.
- Viewer/target MUST be unique under concurrency.
- Preview, Like, Not Interested, NakhFlow, and Match all consume the target.
- Consumption is permanent during the current account lifetime and cannot be undone by the user.
- Deletion purges ordinary ExploreConsumption; GuestPreviewCounter remains separately permanent.

## 5. Like, Liked By, and Not Interested

### Like

- Like is free, directional, and unique per sender/receiver during the account lifetime.
- A normal user cannot unlike, withdraw, or resend a Like.
- Creating Like MUST also ensure consumption.
- If no reverse active Like exists, create one receiver Notification.
- If a reverse active Like exists, create one Match atomically instead of two independent Match attempts.
- Like is deleted with ordinary product data on account deletion; “permanent” elsewhere means non-reversible during the account lifetime.

### Liked By

Liked By contains a received Like only when:

- Like is active;
- no matched, unmatched, or blocked pair state exists;
- receiver has no NotInterested toward the liker;
- liker Account is active;
- liker Profile is complete.

Liker visibility and later Profile relationship-preference/filter changes do not retract an already-sent Like. Restricted, banned, deleted, or invalid likers are non-actionable.

Locked view may show only:

- actionable Like count;
- one locked card per actionable Like;
- blurred current primary photo.

It MUST NOT reveal name, full photo, Profile details, City, or highlight before unlock.

### Liked By unlock

- Costs 4 credits or 4 Stars.
- Is scoped to the specific Like.
- Has no time expiry in MVP.
- Reveals the Profile only while the Like remains actionable.
- Cannot be purchased twice for the same Like.
- Does not itself create Like, Match, or NotInterested.
- Normal closure of the Like is not refundable.

After unlock, receiver may Like Back or mark Not Interested. Like Back creates a Match. Not Interested creates a directional NotInterested, closes the received Like as `closed_by_not_interested`, removes the card, and sends no target notification.

### Not Interested

- Is unique and non-reversible during the account lifetime.
- Ensures ExploreConsumption.
- Never notifies the target.
- Does not create a symmetric pair state.
- May originate only from Explore, an unlocked Liked By card, or Pending Nakh cancellation.

## 6. Nakh

### Creation and uniqueness

- Nakh is a paid directional signal sent from Explore only.
- Liked By does not offer Send Nakh; it offers Like Back or Not Interested after unlock.
- NakhFlow sender/receiver MUST be unique and created atomically before funding.
- A terminal PendingNakh or Nakh never permits a second flow in the same direction.
- The reverse direction is independently unique unless pair state blocks it.
- Creating NakhFlow ensures ExploreConsumption.
- Text is required, at most 240 characters, and may be edited only while PendingNakh is pending_payment.

### Eligibility

At flow creation, both users MUST be active, complete, visible, and not paired as matched/unmatched/blocked.

At delayed delivery, both users MUST still be active and complete and the pair MUST remain eligible. Current visibility is intentionally ignored because the flow was created while visible. Restricted, banned, deleted, invalid, matched, unmatched, or blocked state prevents delivery.

### Pending Nakh

- Exists only when provider confirmation is needed.
- Is visible only to the sender.
- MUST NOT notify the receiver, appear in receiver Nakhes, create Like, or create Match.
- MUST display clear consent that later wallet funding automatically settles pending items FIFO.
- A sender may have at most 5 pending_payment PendingNakhes across all receivers.
- Parallel requests MUST NOT create a sixth.
- Expires exactly 14 days after creation.
- Related PendingPayment MUST use the same deadline.

Reminder rules:

- First reminder is eligible 48 hours after creation.
- Later reminders are eligible 48 hours after last_reminder_at.
- Job execution MAY be delayed, so delivery is “at least 48 hours apart,” not exactly on the minute.
- At most six reminders are sent for one PendingNakh, corresponding to the day 2, 4, 6, 8, 10, and 12 eligibility points before day-14 expiry.
- No reminder is sent after paid, cancelled, expired, or system-closed status.
- Receiver never receives a Pending Nakh reminder.

### Funding and delivery

Credit-funded Nakh costs 2 credits. Direct payment costs 2 Stars.

Funding and delivery MUST atomically:

1. claim the NakhFlow/PendingNakh idempotently;
2. validate current non-visibility eligibility;
3. deduct credits or confirm the paid PaymentRecord;
4. create one delivered Nakh with an immutable text copy;
5. transition PendingNakh when present;
6. create one receiver Notification and delivery outbox item.

Any failure rolls back all product effects or creates an idempotent correction if external funding can no longer be rolled back.

### FIFO auto-settlement

- Every successful CreditAccount increase triggers settlement after the credit grant is committed.
- PendingNakhes are locked and processed by created_at then ID.
- The system MUST NOT skip an older eligible item to fund a newer one.
- Settlement stops when the next eligible item cannot be fully funded.
- An item that is currently ineligible is closed_by_system and processing continues; it never releases NakhFlow uniqueness.
- Each delivery has its own spend_nakh CreditTransaction.

### Cancellation and expiry

Cancellation requires conversion to Like or Not Interested in the same transaction. It never restores discovery or NakhFlow availability.

Expiry sends no receiver notification, preserves NakhFlow and consumption, and expires the linked PendingPayment if still pending.

### Delivered Nakh

- Appears only in Nakhes, never Liked By.
- Expires 14 days after sent_at if still sent or seen.
- First receiver view records seen once.
- Accept creates Match exactly once.
- Reject records rejected; user-facing status is “Closed.”
- Generic admin/system closure uses closed, never rejected.
- Expiry, rejection, closure, or later unmatch does not refund a successfully delivered Nakh.

## 7. Match, Unmatch, and chat

### Match

- A normalized pair has at most one Match during the account lifetime.
- Match is created only by two opposite active Likes or acceptance of a delivered Nakh.
- Match creation, pair state, source closure, chat creation, participant creation, and notifications are one transaction.
- After Match, neither user may discover, Like, Nakh, or mark the other Not Interested.

### Unmatch

- Either participant may unmatch an active Match once.
- Unmatch is permanent and symmetric.
- It creates UserPairState.unmatched and closes Match/chat.
- It MUST NOT create NotInterested.
- Old Likes MUST NOT return to Liked By.
- Other participant receives one chat-closed Notification.
- Either participant may report the other through the UnmatchRecord for 24 hours.
- After the deadline, unmatched_user evidence is rejected; ordinary retained evidence rules still apply to a previously created Report.

### Predefined chat

- Chat exists only for an active Match.
- Without an effective chat unlock, only active seeded predefined questions and their valid predefined answers may be sent.
- Custom text, photos, media, stickers, and free-form emoji messages are rejected.
- Predefined text comes from localization keys, not handlers.

### Chat unlock

- Costs 4 credits or 4 Stars.
- Is unique and scoped to one Match.
- One participant pays; both participants receive text access.
- Has no time expiry in MVP.
- Access checks use Match scope, never payer ID.
- Both users receive the unlock notification and one safety warning each.
- The warning MAY be shown on the participant's next chat open if immediate delivery fails.
- Closing the Match/chat or revoking FeatureUnlock ends access.
- Normal closure is not refundable.

### Unlocked chat

- Allows text only.
- Each free-text message is required and at most 1000 characters after normalization.
- Photos, media, voice, video, files, and stickers remain prohibited.
- Contact details may be shared after the safety warning.
- Restricted users cannot send.
- The normal view retains only the newest 50 visible messages.
- Cleanup MUST snapshot reported context before deleting an otherwise-expired message.
- Admins may access chat content only through a Report or explicit safety review with an audit event.

## 8. Payments, credits, and refunds

### General

- Telegram Stars is the only external MVP payment provider/currency.
- Wallet is not a main-menu item; purchase screens are contextual.
- Stars amounts and credits are positive integers.
- All costs and packages are loaded from configuration/data.
- Credit balance MUST never be negative.
- Every balance change MUST create exactly one immutable CreditTransaction with matching before/after balances.
- A User may create at most 10 provider payment attempts in a rolling 10-minute window. Callback processing is never rate-limited by this user-facing limit.

### Credit packages

Active packages are exactly the four rows defined in `03-attributes.md`.

- Internal credits cannot buy a CreditPackage.
- A successful package callback grants exactly the selected package's configured credits once.
- Granting credits triggers Pending Nakh FIFO settlement.

### Direct actions

Credit and direct Stars funding MUST produce identical domain access/delivery:

- Nakh: one delivered Nakh.
- Liked By unlock: one Like-scoped FeatureUnlock.
- Chat unlock: one Match-scoped FeatureUnlock benefiting both participants.

### Idempotency and concurrency

- invoice_payload, provider_payment_id, telegram_charge_id, and provider_event_id MUST be unique at their appropriate boundaries.
- Duplicate, reordered, or retried callbacks MUST NOT duplicate credits, spends, unlocks, Nakh delivery, refunds, or Notifications.
- PendingPayment resolution MUST use locking or compare-and-set from pending to a terminal status.
- Credit spending MUST lock the CreditAccount and scoped target.
- Simultaneous attempts by both Match participants MUST create and charge for at most one chat unlock.

### Refunds

MVP has no user-requested refund, cancellation-after-delivery, or dispute workflow.

Automatic correction is required only when successful funding fails to produce the promised action because of a system fault or duplicate charge.

Not refundable:

- delivered Nakh later rejected or expired;
- Like/Profile unlock becomes irrelevant after Match or rejection;
- Match is unmatched;
- purchase was accidental or user changed their mind;
- scoped access ends normally.

Direct Stars corrections use Telegram's refund mechanism. Internal-credit corrections restore credits with a refund ledger entry. RefundRecord idempotency key prevents repeated correction.

## 9. Notifications

- Notification history is durable and has read/unread state.
- Domain transaction MUST create Notification plus a delivery outbox record before external Telegram sending.
- Telegram delivery is asynchronous and near-real-time; successful domain actions do not wait for the Telegram API response.
- Failed retryable deliveries use bounded retry with backoff and recorded attempts.
- Deduplication keys prevent duplicate notices from replayed domain/provider events.

Normal mutable categories:

- chat;
- Like;
- Nakh;
- Match.

Non-mutable categories:

- safety;
- payment;
- admin;
- ban;
- restriction.

Pending Nakh reminders belong only to the sender. Payment result belongs only to the payer. Match notifications belong to both participants.

## 10. Reporting, moderation, support, and admin

### Reports

- Reporter and target MUST differ.
- Reporter MUST have a valid product relationship to the evidence.
- Optional extra text is at most 1024 characters.
- A User may submit at most 10 Reports in a rolling 24-hour window; safety/admin-originated reports are not counted against this user limit.
- Mutable evidence MUST be snapshotted in the Report transaction.
- ReportSnapshot is immutable and hash-protected.
- A Report alone never bans a User.

### Automatic restriction threshold

Restrict a target when at least 5 distinct reporters have unresolved Reports submitted in the rolling prior 30 days.

- Count distinct reporter User IDs, not Reports.
- Count all evidence types together at target-User level.
- Only submitted and pending_review count.
- Dismissed, actioned, and closed do not count.
- Threshold evaluation and restriction creation MUST be race-safe and idempotent.
- Only one active threshold restriction action is created for the same threshold episode.
- Restriction remains until admin decision.
- Ban always requires admin authorization.
- If the target is already restricted, update/prioritize the review without creating another Account transition. If the target is banned or deleted, preserve/prioritize the Report without attempting an illegal transition to restricted.

### Internal block

- Users have no Block button and receive no block notification.
- Moderation may set a normalized pair to blocked.
- Block closes active Match/chat and prevents all pair discovery/interactions.
- Removing an internal block does not restore old Match, Likes, Nakh, or discovery consumption.

### Admin

- MVP admin UI is Telegram commands.
- Every command checks AdminUser active state, role, and specific permission.
- Every state-changing attempt writes AdminActionLog whether it succeeds, is rejected, or fails.
- Viewing sensitive report/chat evidence is audited.

### Support and appeal

- Non-banned users may create SupportThread.
- At most 2 unanswered user SupportMessages are allowed across open threads.
- An unanswered message is a user message created after the latest admin/support reply. An admin/support reply therefore starts a new unanswered-count segment.
- Support and appeal messages are required and at most 2000 characters.
- Banned users use UserAppeal only.
- One appeal is allowed per ban AccountStateHistory record.
- Accepted appeal permits an admin transition out of banned; rejected appeal is terminal for that ban event.

## 11. Deletion, retention, and return

### Account deletion

- User confirmation is required.
- Account becomes deleted before asynchronous purge begins, immediately blocking product access.
- Ordinary product data MUST be permanently purged and never restored.
- Purge is idempotent, restartable, and recorded by AccountDeletionRecord.
- Public media access MUST be removed immediately.

Ordinary product data includes:

- Profile, optional details, selections, and ordinary media;
- Signup draft/progress;
- ExploreFilter and ExploreConsumption;
- Likes, NotInterested, NakhFlow/PendingNakh/Nakh;
- Matches, ordinary chat/messages, and FeatureUnlocks;
- CreditAccount balance, CreditTransactions, product PaymentRecords, and normal refunds;
- normal Notifications, preferences, and support conversations.

Shared-record rule:

- The deleted user's content and access MUST disappear from every participant's user-facing surfaces.
- Shared Matches/chats are closed for the other participant before deleted-user content is removed.
- A payment or credit ledger owned by another User is not deleted merely because its scope involved the deleted User; it is retained only as that other User's financial history, its access scope is terminated, and it MUST contain no restorable deleted-User Profile or message content.
- A paid unlock owned by the deleted User is deleted. A paid unlock owned by the other participant becomes ineffective when its Like or Match scope closes.

Permitted retained data:

- User and TelegramIdentity;
- GuestPreviewCounter;
- Account, AccountStateHistory, and AccountDeletionRecord;
- active restriction/ban/moderation facts required to prevent evasion;
- Report/evidence/safety records that have an explicit retention reason;
- minimum audit metadata required for safety enforcement.

Retained data MUST be inaccessible to normal product restoration and described by DataRetentionRecord. Evidence media MUST be private.

### Return

- Return requires reactivation_allowed plus no retained safety bar.
- Allowed return transitions deleted -> guest and starts Profile/signup from zero.
- GuestPreviewCounter is not reset.
- Credit balance starts at zero.
- No old Profile, purchase, unlock, interaction, Match, chat, or Notification is restored.
- If return is disallowed, the User remains deleted and sees only the limited decision message.

## 12. Localization, configuration, jobs, and observability

### Localization

- MVP UI locale is English.
- All user-facing button, message, error, payment, notification, safety, and admin text MUST load through UIText keys.
- Handlers MUST NOT contain user-facing prose.
- User-generated Profile, Nakh, support, appeal, Report, and chat text is stored as entered after validation and is not localized.
- UI locale and ProfileLanguage selections are independent.

### Configuration

- Defaults in `03-attributes.md` are the approved MVP values.
- Services and jobs read typed configuration through one configuration interface.
- Invalid or missing required configuration MUST fail startup or disable the affected feature safely; it MUST NOT silently fall back to a different product rule.
- Secrets, credentials, and bootstrap admin Telegram IDs are deployment configuration, never SystemConfig or source-controlled documentation values.
- Seed catalogs are versioned, idempotent, and use stable codes.

### Jobs

- Jobs MUST be safe to retry and safe to run concurrently.
- Expiry jobs claim records conditionally from the expected non-terminal status.
- Reminder jobs recheck status and cadence at send time.
- Chat cleanup preserves snapshots.
- Media cleanup never deletes retained evidence.
- Every run writes JobRunLog with counts and failures.

### Audit and sensitive data

- Account transitions, payment events, credit changes, paid actions, Report creation, restrictions, bans, photo moderation, chat closure, deletion, return, and admin actions are auditable.
- Raw provider payload and chat/report evidence have restricted access.
- Logs MUST NOT contain bot tokens, payment secrets, raw credentials, or unnecessary private text.

## 13. Database and transaction invariants

The database MUST enforce where practical:

- unique Telegram user ID;
- one Account, settings row, guest counter, and CreditAccount per User;
- valid location hierarchy;
- unique Profile option selections;
- one visible primary photo per Profile and no more than six saved photos;
- unique ExploreConsumption, Like, NotInterested, and NakhFlow directional pairs;
- normalized UserPairState and Match pairs;
- exactly two MatchParticipants and ChatParticipants after aggregate creation;
- exactly one scope and one funding source per FeatureUnlock;
- non-negative CreditAccount balance;
- unique provider/idempotency keys;
- one appeal per ban event;
- one ProfileChangeReview per request.

Rules that require counts or cross-table state MUST use transactions, locks, serializable logic, or equivalent conflict-safe constraints. An application pre-check without a conflict-safe write is insufficient.

## 14. Minimum acceptance scenarios

The automated test suite MUST include at least these scenarios.

### Identity and access

1. Two simultaneous first-start updates create one User aggregate.
2. Guest and incomplete previews share one counter and cannot exceed 10.
3. An active invalid Profile routes to Fix Profile while Account remains active.
4. Visibility off blocks new discovery but allows an existing Pending Nakh to settle.
5. Restricted user can read but cannot send chat.
6. Banned user cannot create SupportThread and can create one appeal for the ban event.

### Profile and media

7. Persian-digit valid Gregorian birth year is normalized; Jalali and under-18 values are rejected.
8. A Profile with one visible and one hidden photo is invalid.
9. Seven concurrent accepted uploads cannot create more than six saved photos.
10. Thumbnail failure creates no visible ProfilePhoto.
11. Blurred-preview failure leaves ProfilePhoto valid.
12. Hiding a primary promotes another visible photo and may invalidate the Profile.
13. User photo deletion removes public media while preserving only required private evidence.

### Explore and interactions

14. Temporary Explore gender choices do not modify Profile relationship preference.
15. A temporary filter cannot broaden reciprocal compatibility.
16. Preview delivery and consumption are atomic enough to prevent repeat cards.
17. Two opposite simultaneous Likes create one Match and one chat.
18. Like cannot be withdrawn; Not Interested never notifies the target.
19. Liked By excludes Nakh, invalid likers, and terminal pair states.
20. One Liked By unlock reveals one Like, does not expire by time, and cannot be charged twice.

### Nakh

21. Concurrent Nakh starts for the same direction create one NakhFlow.
22. A sender cannot have six pending_payment PendingNakhes.
23. Pending Nakh is invisible to and silent for the receiver.
24. Credit funding settles pending items strictly oldest first.
25. Duplicate provider callbacks deliver one Nakh and one notification.
26. Visibility off does not block existing Pending Nakh delivery; restriction or Profile invalidity does.
27. Cancellation atomically converts to exactly one Like or NotInterested.
28. Rejection stores rejected while displaying Closed.
29. Pending and delivered Nakhes expire from their own 14-day start timestamps.

### Match and chat

30. Accepted Nakh creates one Match/chat under callback retry.
31. Unmatch permanently prevents rediscovery/rematch and allows reports for exactly 24 hours.
32. Simultaneous chat unlock attempts charge once and unlock both participants.
33. Chat unlock has no clock expiry but ends on Match closure/revocation.
34. Pre-unlock custom text and all photo/media messages are rejected.
35. Cleanup retains only 50 normal messages while preserving reported snapshots.

### Payments, notifications, moderation, and deletion

36. Package callback replay grants credits once.
37. A failed paid-action transaction restores credits or creates one Stars refund.
38. Muted normal notifications do not send Telegram delivery; payment/safety notices still do.
39. Five Reports by one reporter do not restrict; five distinct unresolved reporters do.
40. Concurrent fifth Reports create one restriction episode and never an automatic ban.
41. Every admin mutation attempt is permission-checked and logged.
42. Deletion blocks access immediately, safely resumes a failed purge, and never restores product data on return.
43. Returning identity keeps its GuestPreviewCounter and retained safety restrictions.
44. No handler contains user-facing English prose outside localization seed/setup code.
