# Open Decisions

This file tracks product and technical decisions that are not finalized yet.

It also records important decisions that have already been locked during domain modeling.

## 0. Source of Truth Decisions

### MVP PDF vs Git domain docs

Status: Closed

Decision:

* The original MVP PDF is treated as historical product input.
* The Git domain documentation is the source of truth for database design and implementation.
* If the MVP PDF conflicts with the Git domain docs, follow the Git domain docs.

## 1. Product Flow Decisions

### Deleted account reactivation flow

Status: Closed

Question:

* When a deleted user starts the bot again, should they restart signup from zero or recover parts of the previous profile?

Current direction:

* Allow signup/reactivation with the same Telegram account.
* Keep minimal audit, payment, report, and safety records.
* Do not automatically restore old profile data unless explicitly decided later.

> **Suggested direction:**  
> <span style="font-size: 1.2rem;"> Account deletion should be permanent. Meaning that when a user deletes it's account, all previous records (all payments, matches and ...) are deleted and only safety measures remain. For example if a user has had to delete it's account due to being reported multiple times, it should not be able to delete it's account, came back later and carry on abusing other users. Other than safety records, no other data should be preserved. </span>


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

### Birth year calendar and age calculation

Status: Closed

Decision:

* Users enter Gregorian birth year only.
* Exact birth date is not collected.
* Displayed age is approximate.
* Age is derived from Gregorian birth year and must not be stored as a separate source-of-truth field.

### Interest ownership

Status: Closed

Decision:

* Interests belong to the dating profile, not directly to the user.
* Profile interests are modeled through `ProfileInterest`.
* A complete profile must have at least 5 interests.
* A profile can have at most 20 interests.

### Name max length

Status: Closed

Question:

* What is the maximum allowed length for profile name?

Current direction:

* Add a reasonable max length before implementation.

> **Suggested direction:**  
> <span style="font-size: 1.2rem;"> Simply start with 32 chars long. </span>

### Change request reason max length

Status: Closed

Question:

* What is the maximum length for birth year/gender change request reason?

Current direction:

* Keep it short and practical.

> **Suggested direction:**  
> <span style="font-size: 1.2rem;"> Standard Telegram accounts are limited to 1,024 characters so that must be enough.</span>


### Optional profile field values

Status: Closed

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

> **Suggested direction:**  
> <span style="font-size: 1.2rem;"> Education could be either level of education (Highschool, Bachelor, ...) or exact major. For MVP, let's go with level of education and thus all mentioned fields should be enums.</span>


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

Status: Partially Closed

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

> **Suggested direction:**  
> <span style="font-size: 1.2rem;">Cloudflare R2:</span>
> - **Zero egress fees.** A photo-heavy dating app regenerates variants (thumbnail, blurred preview) and re-serves images constantly — S3's per-GB egress cost compounds fast at scale; R2 has none.
> 
> - **S3-compatible API** — the README explicitly wants the data model to not hard-depend on one vendor ("Storage/CDN provider" is listed as swappable), and R2 speaks the S3 API, so MinIO or actual S3 stay viable fallbacks without a rewrite.
> 
> - **Pairs natively with Cloudflare's CDN/Images product** (below), avoiding a storage-provider ↔ CDN-provider integration tax.


### CDN provider

Status: Partially Closed

Question:

* Which CDN should serve user photos?

Current direction:

* Use CDN URLs for image delivery.

> **Suggested direction:**  
> **Cloudflare (Images/CDN)**  
> <span style="font-size: 1.2rem;">Same-vendor pairing with R2 avoids paying egress between storage and CDN, which is where a split-vendor setup quietly gets expensive.</span>
> 
> - **Cloudflare's Images product** does on-the-fly resizing/format conversion, which maps directly onto the README's variant requirements (thumbnail, blurred preview, HEIC→delivery-format conversion) without you building a separate image-processing pipeline.
> 
> - **Broad edge presence** in the Middle East/Central Asia region, relevant for latency to Iran-based users specifically (network routing into Iran is a separate, harder problem no CDN fully solves, but edge proximity still helps where it isn't blocked).

### Photo processing

Status: Closed

Question:

* Where should thumbnail and blurred preview generation happen?

Current direction:

* Generate photo variants after upload.
* Store variant metadata as `PhotoVariant`.

> **Suggested direction:**  
> - **Thumbnail** should be generated **on upload**, via a backend worker/serverless function (not the bot process itself) right after the original image passes validation and lands in object storage.
> 
> - **Blurred preview** should be generated **on-demand at request time**, not pre-generated for every photo at upload. It's only ever needed for a Liked By teaser card, and only for the primary photo at that — pre-blurring all 2–6 photos of every profile on upload wastes storage and compute for variants that may never be viewed. blur-and-cache the primary photo the first time it's actually requested.


### Hidden primary photo behavior

Status: Partially Closed

Decision:

* If admin hides a primary photo, profile validity must be rechecked.

Open:

* Should the system automatically choose another visible photo as primary, or force the user to fix it manually?

Current direction:

* Auto-select another visible photo if available.
* If fewer than 2 visible photos remain, mark profile invalid/incomplete or hidden until fixed.

### Visible photo count for profile completion

Status: Closed

Decision:

* A user can upload at most 6 profile photos.
* Extra uploaded photos are rejected.
* Only visible photos count toward profile completion.
* Hidden or deleted photos do not count toward profile completion.
* A complete profile must have at least 2 visible photos.

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

Status: Closed

Question:

* How should profiles be randomized at scale?

Current direction:

* Start simple for MVP.
* Avoid expensive random database ordering later if traffic grows.

> **Suggested direction:**  
> - **MVP-scale approach:** fetch the eligible pool (already filtered by completion, visibility, account state, gender compatibility, filters, and not-yet-consumed), then shuffle that capped set in application code and serve from it. This keeps the DB doing what it's good at (filtering with indexes) and keeps randomness cheap (shuffling a small in-memory list).
> 
> - **Avoid the same-profiles-first bias**, since a naive `LIMIT` after a non-random `ORDER BY` will always surface the same subset of the eligible pool to different viewers first. A lightweight fix: assign each profile a `random_shuffle_key` (a stored random float or hash) that gets regenerated periodically (e.g. daily via a scheduled job), and order by that key instead of `created_at`. This spreads exposure across the pool without per-request full-table randomization.

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

### Nakh after normal Like

Status: Closed

Decision:

* Sending Nakh to a profile that was already normally liked is not supported in MVP.
* Normal Like consumes the target profile.
* Nakh is sent from Explore before the target is consumed by another final discovery action.
* The old MVP PDF rule that allowed sending Nakh to someone already liked is removed.

### Nakh after Match

Status: Closed

Decision:

* Matched users cannot send Nakh to each other.
* Matched users cannot Like or mark each other Not Interested.
* Matched users move to Chat flow.

### Pending Nakh expiry

Status: Closed

Question:

* How long should unpaid Pending Nakh remain payable?

Current direction:

* Pending payments should expire.
* Exact duration is not finalized.

> **Suggested direction:**  
> A first-time user hasn't loaded their wallet yet, and Explore consumption is permanent — if they can't send Nakh until they've paid, they lose the profile the moment they move on, before they've ever had a reason to top up credits. Allowing a small number of unpaid Pending Nakhes to sit and wait removes that forced-payment-before-you've-seen-value friction, without it becoming unlimited or free.
> 
> - **Cap: 5 concurrent unpaid Pending Nakhes per sender, system-wide** (not per receiver — the one-flow-per-receiver rule already prevents duplicates to the same person). Once a sender has 5 unpaid Pending Nakhes outstanding, they must pay for or resolve at least one (pay, convert to Like, or mark Not Interested) before creating a 6th. 
>
> - **On wallet charge (credit purchase or direct Stars top-up), auto-settle unpaid Pending Nakhes** in the order they were created (FIFO), deducting credits and converting each to a delivered Sent Nakh until either the queue is empty or credits run out. This makes "charge wallet" the natural trigger the user described, rather than requiring the user to go re-tap each pending Nakh individually.
> 
> - **Keep a short backstop expiry — 14 days** — not as the primary control (the 5-slot cap does that job), but purely as hygiene: abandoned accounts or permanently-uninterested users shouldn't hold consumed target profiles in limbo forever. 
>
> - **Reminder schedule still applies, but softened:** since the queue removes urgency, reminders shift from "hurry up and pay" (appropriate for a 24h expiry) to "you have unpaid Nakhes waiting", framed as a nudge rather than a countdown warning.

### Nakh reminder schedule

Status: Closed

Question:

* When should the bot remind users about unpaid Pending Nakh?

Current direction:

* Use one or more scheduled reminders before PendingPayment expiry.
* Exact timing is not finalized.

> **Suggested direction:**  
> <span style="font-size: 1.2rem;">14-day expiry, with a reminder roughly every 2 days.</span>

## 6. Payment and Credit Decisions

### Credit package sizes

Status: Partially Closed

Question:

* What credit packages should users be able to buy?

Current direction:

* Define simple MVP packages before implementation.
* Packages may include discounts.

> **Suggested direction:**  
> <span style="font-size: 1.2rem;">Four tiers, discount escalating with size, with the 50 and 100 tiers carrying the strongest per-credit value and visual "best value" framing to pull purchases upward.</span>
> 
> | Package | Credits | Price (Stars) | Per-credit rate | Discount vs. base | Label |
> |---|---|---|---|---|---|
> | Starter | 10 | 10 | 1.00 | — | — |
> | Plus | 25 | 20 | 0.80 | 20% off | "Popular" |
> | Best Value | 50 | 35 | 0.70 | 30% off | "Best Value" |
> | Ultimate | 100 | 60 | 0.60 | 40% off | "Best Value" (max) |
> 
> - **10 credits @ 10 Stars** sets the anchor rate (1 Star = 1 credit) with zero discount — this is the "just try a Nakh" entry point, deliberately unattractive on a per-unit basis so the discounted tiers look meaningfully better by comparison.
> - **25 credits @ 20 Stars** is the first real discount (20%), positioned as the impulse-buy "Popular" tier for someone who's already sending a Nakh and tops up mid-flow.
> - **50 credits @ 35 Stars** and **100 credits @ 60 Stars** are the intended targets — discounts jump to 30% and 40%, and 100 credits nearly doubles the per-Star value of the entry tier, making it the visually "smart" choice next to the other three.
> - In credit-cost terms (Send Nakh = 2, Chat/Liked-By unlock = 4): 50 credits ≈ 25 Nakhes or 12 unlocks; 100 credits ≈ 50 Nakhes or 25 unlocks — enough runway that a genuinely active user lands on one of the target tiers rather than repeatedly buying the small one.

### Telegram Stars pricing

Status: Partially Closed

Question:

* What is the exact Telegram Stars price for each credit package?

Current direction:

* Pricing must be finalized before payment integration.

> **Suggested direction:**  
> <span style="font-size: 1.2rem;">Same Stars prices as the credit packages defined above — no separate pricing needed here, since Telegram Stars is the sole purchase currency for credit packages.</span>
> 
> | Package | Credits | Stars Price |
> |---|---|---|
> | Starter | 10 | 10 |
> | Plus | 25 | 20 |
> | Best Value | 50 | 35 |
> | Ultimate | 100 | 60 |

### Paid action costs

Status: Closed

Decision:

* Send Nakh: 2 credits
* Unlock one match chat: 4 credits
* Unlock one Liked By profile: 4 credits

### Paid action costs

Status: Closed

Decision:

* Send Nakh: 2 credits
* Unlock one match chat: 4 credits
* Unlock one Liked By profile: 4 credits

### Feature unlock expiry model

Status: Closed

Decision:

* FeatureUnlock supports expiry through `expires_at`.
* FeatureUnlock can expire or be revoked depending on feature type and configuration.
* Liked By profile unlock expires according to configured unlock duration.
* Chat unlock is scoped to one Match and remains active until the Match closes, the unlock is revoked, or a configured expiry is reached.
* Exact expiry durations remain configurable and should not be hardcoded in handlers.
* Nakh is not modeled as a FeatureUnlock. Nakh is a paid action, not persistent feature access.

### Payment idempotency

Status: Closed

Decision:

* Payment callbacks must be idempotent.
* Duplicate Telegram payment callbacks must not double-process credits, unlocks, Nakh delivery, or notifications.

### Refund policy

Status: Closed

Question:

* Are refunds supported in MVP?
* If yes, which cases are refundable?

Current direction:

* Keep `RefundRecord` in the domain model.
* Define exact refund rules later.

> **Suggested direction:**  
> <span style="font-size: 1.2rea m;">No user-initiated refunds in MVP — only system-fault refunds, issued automatically.</span>
> 
> - **Not refundable:** any unlock or Nakh that delivered as intended — expired Liked By/Sent Nakh, rejected Nakh, unmatch, change of mind, or "I didn't mean to buy this." 
> - **Refundable, automatically, no user request needed:** payment succeeded but the corresponding action failed to deliver due to a system fault — e.g. Stars payment confirmed but Pending Nakh delivery blocked because the receiver became banned/deleted/profile-invalid before payment finished, or a duplicate/idempotency failure double-charged credits. 
> - **Mechanism:** use Telegram's built-in Stars refund API for direct-Stars purchases; for credit-package purchases, refund by re-crediting the internal balance rather than reversing the Stars transaction, since credits may already be partially spent elsewhere.
> 
> - **No manual "refund request" flow in MVP**

### Feature unlock after deletion

Status: Closed

Question:

* If a user deletes account and later returns, should previous paid unlocks be restored?

Current direction:

* Keep unlock/payment history for audit.
* Do not automatically restore old feature access unless explicitly decided later.

> **Suggested direction:**  
> <span style="font-size: 1.2rea m;">No. Only safety records are being saved in MVP and not payment history is preserved.</span>
> 

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

Status: Closed

Question:

* What is the maximum length for optional report extra text?

Current direction:

* Add a practical limit before implementation.

> **Suggested direction:**  
> <span style="font-size: 1.2rea m;">Default 1024 char long for normal telegram users.</span>
> 

### Support rate limit

Status: Open

Question:

* How often can a user send support messages?

Current direction:

* Support messages must be rate-limited.
* Exact rate limit is not finalized.

> **Suggested direction:**  
> <span style="font-size: 1.2rea m;">Simple rate limit of 2 unanswerd messages per user.</span>
> 

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

Status: Closed

Question:

* Should user-facing Block exist in MVP, or should UserBlock remain internal/safety-only?

Current direction:

* Keep UserBlock internal for MVP unless product explicitly exposes Block later.

> **Suggested direction:**  
> <span style="font-size: 1.2rea m;">No need for other users to be aware of blocks so keep it internal.</span>
> 

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

Status: Closed

Question:

* When a deleted user returns, should they restart signup fully or recover part of the old profile?

Current direction:

* Allow signup/reactivation with the same Telegram account.
* Do not automatically restore old profile data unless explicitly decided later.
* Keep minimal retained records for audit, payment, report, and safety purposes.

> **Suggested direction:**  
> <span style="font-size: 1.2rea m;">Since safety records are the only data being preserved and linked to unique telegram ID, there should be no means of recovering old profile fields at all in MVP.</span>
> 

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

Status: Closed

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



















