# Open Decisions

This file tracks product and technical decisions that are not finalized yet.

It also records important decisions that have already been locked during domain modeling.

## 1. Product Flow Decisions

### Deleted account reactivation flow

Status: Open

Question:

* When a deleted user starts the bot again, should they restart signup from zero or recover parts of the previous profile?

Current direction:

* Allow signup/reactivation with the same Telegram account.
* Keep minimal audit, payment, report, and safety records.
* Do not automatically restore old profile data unless explicitly decided later.

### Guest preview reset

Status: Closed

Decision:

* Guest and incomplete users share the same permanent preview counter.
* The counter is tied to the Telegram identity/user.
* Starting signup and leaving it incomplete does not reset the counter.

### Wallet visibility

Status: Closed

Decision:

* Wallet is not shown in the MVP main menu.
* Paid flows appear contextually when the user attempts a paid action.

## 2. Signup and Profile Decisions

### Name max length

Status: Open

Question:

* What is the maximum allowed length for profile name?

Current direction:

* Add a reasonable max length before implementation.

### Change request reason max length

Status: Open

Question:

* What is the maximum length for birth year/gender change request reason?

Current direction:

* Keep it short and practical.

### Optional profile field values

Status: Open

Question:

* Which optional fields should be enums and which should be free text?

Fields needing final values:

* Education
* Smoking preference
* Pets
* Exercise/gym
* Religion importance
* Children preference

Current direction:

* Use enums/config values for MVP.
* Convert to editable lookup tables later only if needed.

### Spoken languages

Status: Partially Closed

Decision:

* Spoken languages should be modeled with `Language` and `ProfileLanguage`.
* Do not store languages as messy free text.

Open:

* Final list of language options.

### Personality tags

Status: Partially Closed

Decision:

* Personality tags should be modeled with `PersonalityTag` and `ProfilePersonalityTag`.

Open:

* Final list of personality tags.

## 3. Media and CDN Decisions

### Storage provider

Status: Open

Question:

* Which object storage provider should be used?

Options:

* Cloudflare R2
* AWS S3
* MinIO
* Other S3-compatible storage

Current direction:

* Use object storage plus CDN.
* Do not use local app server storage as the permanent image store.

### CDN provider

Status: Open

Question:

* Which CDN should serve user photos?

Current direction:

* Use CDN URLs for image delivery.

### Photo processing

Status: Open

Question:

* Where should thumbnail and blurred preview generation happen?

Current direction:

* Generate photo variants after upload.
* Store variant metadata as `PhotoVariant`.

### Hidden primary photo behavior

Status: Partially Closed

Decision:

* If admin hides a primary photo, profile validity must be rechecked.

Open:

* Should the system automatically choose another visible photo as primary, or force the user to fix it manually?

Current direction:

* Auto-select another visible photo if available.
* If fewer than 2 visible photos remain, mark profile invalid/incomplete or hidden until fixed.

## 4. Explore and Matching Decisions

### Gender compatibility logic

Status: Closed

Question:

* How exactly should `other` and `prefer_not_to_say` appear in Explore?

Current direction:

* `men` shows profiles with gender `man`.
* `women` shows profiles with gender `woman`.
* `everyone` can show all active visible genders.

Needs final confirmation before implementation.

Decision:

* `men` shows profiles with gender `man`.
* `women` shows profiles with gender `woman`.
* `everyone` can show all active visible genders, including `other` and `prefer_not_to_say`.
* Gender handling must remain extensible because additional gender options may be added later.

### Explore randomization strategy

Status: Open

Question:

* How should profiles be randomized at scale?

Current direction:

* Start simple for MVP.
* Avoid expensive random database ordering later if traffic grows.

### Whole-country Explore

Status: Closed

Decision:

* No whole-country filter in MVP.
* Default location is user’s own city.

### Interested gender update

Status: Closed

Decision:

* Interested gender is one profile-level field.
* Changing it from Explore filters or Edit Profile updates the same value.

### Matched pair discovery

Status: Closed

Decision:

* Once two users match, they cannot Like, Nakh, Not Interested, or rediscover each other in Explore.

## 5. Nakh Decisions

### Pending Nakh visibility

Status: Closed

Decision:

* Pending Nakh is visible only to the sender.
* Pending Nakh does not notify the receiver.
* Pending Nakh does not appear in receiver’s Nakhes.
* Pending Nakh does not appear in receiver’s Liked By.
* Pending Nakh does not create Match.

### Pending Nakh cancellation

Status: Closed

Decision:

If sender cancels unpaid Pending Nakh, ask whether to:

* Convert it to a normal Like
* Mark the target as Not Interested

If converted to normal Like:

* Create Like
* Notify receiver
* Show sender in receiver’s Liked By
* Create Match if reverse Like exists

If converted to Not Interested:

* Create NotInterested
* Do not notify receiver
* Keep target consumed

### Nakh and Like separation

Status: Closed

Decision:

* Nakh is not a normal Like.
* Normal Like appears in Liked By.
* Sent Nakh appears in Nakhes.
* Sent Nakh does not appear in Liked By.

### Nakh after Match

Status: Closed

Decision:

* Matched users cannot send Nakh to each other.
* Matched users cannot Like or mark each other Not Interested.
* Matched users move to Chat flow.

### Pending Nakh expiry

Status: Open

Question:

* How long should unpaid Pending Nakh remain payable?

Current direction:

* Pending payments should expire.
* Exact duration is not finalized.

### Nakh reminder schedule

Status: Open

Question:

* When should the bot remind users about unpaid Pending Nakh?

Current direction:

* Use one or more scheduled reminders before PendingPayment expiry.
* Exact timing is not finalized.

## 6. Payment and Credit Decisions

### Credit package sizes

Status: Open

Question:

* What credit packages should users be able to buy?

Current direction:

* Define simple MVP packages before implementation.
* Packages may include discounts.

### Telegram Stars pricing

Status: Open

Question:

* What is the exact Telegram Stars price for each credit package?

Current direction:

* Pricing must be finalized before payment integration.

### Paid action costs

Status: Closed

Decision:

* Send Nakh: 2 credits
* Unlock one match chat: 4 credits
* Unlock one Liked By profile: 4 credits

### Payment idempotency

Status: Closed

Decision:

* Payment callbacks must be idempotent.
* Duplicate Telegram payment callbacks must not double-process credits, unlocks, Nakh delivery, or notifications.

### Refund policy

Status: Open

Question:

* Are refunds supported in MVP?
* If yes, which cases are refundable?

Current direction:

* Keep `RefundRecord` in the domain model.
* Define exact refund rules later.

### Feature unlock after deletion

Status: Open

Question:

* If a user deletes account and later returns, should previous paid unlocks be restored?

Current direction:

* Keep unlock/payment history for audit.
* Do not automatically restore old feature access unless explicitly decided later.

## 7. Chat Decisions

### Free chat mode

Status: Closed

Decision:

* Free matched users cannot type freely.
* Free users can only use predefined questions and predefined answers.

### Chat unlock scope

Status: Closed

Decision:

* Chat unlock is per Match.
* If either side unlocks chat, both users can send text in that Match.

### Message types after unlock

Status: Closed

Decision:

* Only text messages are allowed after unlock.
* Photos, stickers, and media messages are not allowed.

### Contact sharing after unlock

Status: Closed

Decision:

* After chat unlock, users may share phone numbers, Telegram IDs, or other contact info.
* Show a safety warning once when chat unlocks.

### Chat message retention

Status: Partially Closed

Decision:

* Only the last 50 visible messages per chat remain available in normal chat view.
* Reported messages must be snapshotted when needed.

Open:

* Should older non-reported messages be deleted permanently or archived internally?

Current direction:

* Use cleanup/archive job later.
* Keep reported snapshots immutable.

### Predefined question management

Status: Partially Closed

Decision:

* Predefined questions and answers must be data-driven.
* They must not be hardcoded inside chat logic.

Open:

* Should admins edit them through Telegram admin commands, seed files, or database admin tools?

Current direction:

* Seed them first.
* Admin editing can come later.

## 8. Moderation and Safety Decisions

### Report threshold

Status: Closed

Decision:

* Five unique reporters restrict the target until admin review.
* Count unique reporters, not total report count.
* No automatic ban.

### Automatic ban

Status: Closed

Decision:

* There is no automatic ban in MVP.
* Ban requires admin decision.

### Report extra text max length

Status: Open

Question:

* What is the maximum length for optional report extra text?

Current direction:

* Add a practical limit before implementation.

### Support rate limit

Status: Open

Question:

* How often can a user send support messages?

Current direction:

* Support messages must be rate-limited.
* Exact rate limit is not finalized.

### Appeal limit

Status: Partially Closed

Decision:

* Banned users can send one limited appeal/support message.

Open:

* Should admin be able to reset appeal availability?

### Admin list

Status: Open

Question:

* Which Telegram user IDs are admins?

Current direction:

* Admin Telegram IDs must be configured before launch.

### Admin roles and permissions

Status: Partially Closed

Decision:

* Admin roles and permissions exist in the domain model.

Open:

* Exact permission assignment per role is not finalized.

### Chat review access

Status: Closed

Decision:

* Admins should see chat messages only if a report is submitted or chat review is needed for moderation.
* Reported chat context should be snapshotted.

### UserBlock exposure

Status: Open

Question:

* Should user-facing Block exist in MVP, or should UserBlock remain internal/safety-only?

Current direction:

* Keep UserBlock internal for MVP unless product explicitly exposes Block later.

## 9. Deletion and Retention Decisions

### Account deletion behavior

Status: Closed

Decision:

After account deletion:

* Profile becomes hidden
* Chats close
* Account enters deleted state
* Minimal audit records remain
* Minimal payment records remain
* Minimal report records remain
* Minimal safety records remain

### Reactivation flow

Status: Open

Question:

* When a deleted user returns, should they restart signup fully or recover part of the old profile?

Current direction:

* Allow signup/reactivation with the same Telegram account.
* Do not automatically restore old profile data unless explicitly decided later.
* Keep minimal retained records for audit, payment, report, and safety purposes.

### Guest preview counter after deletion

Status: Closed

Decision:

* Account deletion does not reset the permanent guest/incomplete preview counter.

### Data retention scope

Status: Partially Closed

Decision:

Retain minimal records needed for:

* Payment safety
* Report history
* Abuse prevention
* Auditability
* Legal/accounting traceability

Open:

* Exact retention duration is not finalized.

## 10. Localization and Config Decisions

### MVP language

Status: Closed

Decision:

* MVP is English only.

### Future languages

Status: Closed

Decision:

* Persian and other languages may be added later.
* UI text must be configurable from the beginning.

### UI text storage

Status: Open

Question:

* Should UI text live in YAML files, database records, or both?

Current direction:

* Start with structured text keys.
* Avoid hardcoded user-facing text in handlers.
* Database-backed `UIText` remains in the domain model.

### Product tone

Status: Partially Closed

Decision:

* English MVP tone should be casual and light, but not cringe.

Open:

* Exact copywriting guide is not finalized.

### SystemConfig usage

Status: Closed

Decision:

Configurable product constants should not be scattered across handlers.

SystemConfig or code-level config should cover:

* Guest preview limit
* Minimum signup age
* Minimum profile photos
* Maximum profile photos
* Minimum interests
* Maximum interests
* Highlight max length
* Bio max length
* Nakh text max length
* Nakh expiry days
* Nakh cost
* Chat unlock cost
* Liked By unlock cost

## 11. Closed Decisions

These decisions are already locked.

### Architecture

* Use modular monolith for MVP.
* Keep strict internal module boundaries.
* Do not start with microservices.

### Photo storage

* Use object storage and CDN.
* Do not use local app server storage as the permanent image store.

### User and Profile separation

* User owns identity.
* Account owns access and lifecycle.
* Profile owns dating-visible information.

### Guest and incomplete preview counter

* Guest and incomplete users share the same permanent preview counter.

### Interested gender

* Interested gender is one profile-level field.
* Changing it from Explore or Edit Profile updates the same field.

### Like and Nakh separation

* Normal Like appears in Liked By.
* Sent Nakh appears in Nakhes.
* Pending Nakh is hidden from receiver.
* Nakh does not create a normal Like automatically.

### Pending Nakh cancellation

* Cancelled Pending Nakh must resolve into normal Like or Not Interested.

### Match effects

After Match:

* Users cannot Like each other
* Users cannot send Nakh to each other
* Users cannot mark each other Not Interested
* Users cannot appear to each other in Explore
* ChatSession is created

### Chat unlock

* Chat unlock is per Match.
* If one side unlocks chat, both users can send text in that Match.

### Liked By unlock

* Each Liked By profile is unlocked separately.
* Unlocking one Liked By profile does not unlock others.

### Report threshold

* Five unique reporters restrict the target until admin review.
* No automatic ban.

### Admin interface

* MVP admin interface is Telegram admin commands.
* No web admin panel is required for MVP.

## 12. Notes

* Open decisions must be resolved before final database schema or implementation.
* Closed decisions should not be changed casually.
* If a closed decision changes, update the related domain files.
* Major product decisions should later become ADRs under `/docs/architecture/decisions`.



















