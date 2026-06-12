# Business Rules and Invariants

This file defines product rules that must always hold.

These rules cross multiple entities and should not be buried inside individual entity files.

## 1. Account and Access Rules

### Account states

A user account must be in one of these states:

* guest
* incomplete
* active
* restricted
* banned
* deleted

### Guest access

Guest users can:

* View limited teaser profile previews
* Start signup

Guest users cannot:

* Use filters
* Like profiles
* Send Nakh
* Mark Not Interested
* Match
* Chat
* Use paid features

Guest preview is not normal Explore.

Guest preview does not use Explore filters, reciprocal gender compatibility, viewer age, viewer city, viewer interested gender, or viewer relationship goal.

### Guest preview limit

Guest users can see only 10 profile previews permanently.

On first `/start`, a new Telegram user gets:

* User
* TelegramIdentity
* Account with state `guest`
* UserSettings with default values
* GuestPreviewCounter with `preview_count = 0` and `limit_count = 10`

Guest mode is persistent and tied to Telegram identity/user.

Guest mode is not an anonymous temporary session.

The preview counter is shared by guest and incomplete users.

Starting signup does not reset the preview counter.

After signup completion, the account becomes `active` and the preview counter no longer controls normal Explore access.

### Incomplete user access

Incomplete users are treated like guests until signup is completed.

Incomplete users share the same permanent preview counter as guests.

Incomplete users use the same Guest Preview Pool as guests.

Partial signup draft data must not be used to filter Guest Preview.

This means that even if an incomplete user has already entered gender, interested gender, age, city, or relationship goal, those partial values do not affect Guest Preview.

### Guest Preview Pool

Guest Preview is a teaser browsing mode for users whose account state is `guest` or `incomplete`.

Guest Preview is separate from normal Explore.

A target profile can appear in Guest Preview only if:

* Profile completion status is `complete`
* Target user visibility is enabled
* Target account state is `active`
* Target user is not restricted, banned, or deleted
* Target profile belongs to the MVP-supported country, Iran
* Target has a visible primary photo
* Target has not already been consumed by the viewer

Guest Preview does not require:

* Viewer profile completion
* Viewer ExploreFilter
* Viewer age
* Viewer city
* Viewer interested gender
* Viewer relationship goal
* Reciprocal gender compatibility

Guest Preview must not use SignupDraft values as filters.

Guest Preview is randomized inside the eligible teaser pool.

Each shown Guest Preview creates an `ExploreConsumption` record with reason `preview`.

Guest and incomplete users share the same permanent `GuestPreviewCounter`.

After the counter reaches the MVP limit, the bot shows a signup message instead of more previews.

If no eligible Guest Preview target exists before the limit is reached, the bot shows an empty preview state and encourages signup.

### Active user access

Active users can use normal product features if:

* Account state is `active`
* Profile completion status is `complete`
* User visibility is enabled where required

### Invalid active profile access

A user can have:

* `Account.state = active`
* `Profile.completion_status = invalid`

This means the user completed signup before, but the profile later stopped satisfying required profile validity rules.

Invalid profile status must not change `Account.state` back to `incomplete`.

Invalid active profile users can:

* Open the app
* Edit profile
* Fix missing or invalid profile requirements
* Upload or replace required photos
* Access settings
* Contact support/admin
* Read existing matches and chats, unless another account or moderation rule blocks them

Invalid active profile users cannot:

* Appear in Explore
* Explore others
* Like
* Send Nakh
* Use Liked By discovery actions
* Create new discovery interactions

The bot must route invalid active profile users to Fix Profile until `Profile.completion_status` becomes `complete` again.

When all profile completion rules are satisfied again, set `Profile.completion_status = complete`.

The account remains `active` throughout this flow.

### Visibility off

If visibility is off:

* User does not appear in Explore
* User cannot Explore others
* User cannot Like
* User cannot send Nakh

Visibility off does not stop:

* Existing matches
* Existing chats
* Existing sent Nakh flows
* Existing pending Nakh payments

Visibility is controlled only by `UserSettings.visibility_enabled`.

The MVP does not use a separate `VisibilityStatus` enum.

Visibility off blocks creation of new Pending Nakh and new Sent Nakh.

Visibility off does not block payment completion for Pending Nakh records created before visibility was turned off.

If the sender turns visibility off after creating a Pending Nakh, the sender may still complete payment.

If the receiver turns visibility off after a Pending Nakh was created, the receiver may still receive the delivered Sent Nakh after payment succeeds.

Visibility off blocks new discovery and new Nakh creation only. It does not block already-created Pending Nakh payment completion.

This is the only visibility exception.

If the sender becomes restricted, banned, or deleted before payment succeeds, the Pending Nakh cannot be paid or delivered.

If the receiver becomes restricted, banned, deleted, or profile-invalid before payment succeeds, the Pending Nakh cannot be delivered.

Blocked Pending Nakh records should be cancelled, expired, or refunded depending on payment state.


### Restricted user access

Restricted users can:

* Open the app
* Edit profile
* Read existing chats
* Contact support/admin

Restricted users cannot:

* Appear in Explore
* Explore others
* Like
* Send Nakh
* Send chat messages

### Banned user access

Banned users cannot use the app normally.

Banned users cannot:

* Explore
* Edit profile
* Like
* Send Nakh
* Match
* Chat
* Use paid features
* Open normal Support
* Create SupportThread
* Create SupportMessage

A banned user can submit one limited ban appeal per ban event.

Ban appeal rules:

* The appeal is stored as `UserAppeal`.
* UserAppeal is the canonical MVP mechanism for banned-user appeal.
* Banned users do not create SupportThread or SupportMessage records.
* One UserAppeal is allowed per ban event.
* The appeal must reference the AccountStateHistory record that changed the account state to `banned`.
* If an appeal already exists for the current ban event, the user can only view the appeal status.
* If the appeal is accepted, admin may unban the user.
* If the appeal is rejected, the user remains banned and cannot submit another appeal for the same ban event.

### Deleted user access

Deleted users do not have normal access.

After deletion:

* Profile becomes hidden
* Chats close
* Minimal audit, report, payment, and safety records remain

A deleted user may later start a reactivation flow using the same Telegram account only if reactivation is allowed.

Reactivation must reuse the same internal User, TelegramIdentity, Account, and existing Profile record.

Deletion does not clear reports, restrictions, bans, payment history, safety history, moderation history, or audit history.

A reactivated user rebuilds the existing dating profile through the signup/profile-completion flow.

Reactivation must not create a clean new User and must not bypass retained safety or moderation history.

## 2. Signup and Profile Rules

### Minimum age

Minimum allowed age is 18.

Users must confirm they are 18+ before entering birth year.

Users enter Gregorian birth year only.

### Birth year validation

Birth year input must be validated before it can be stored.

Validation rules:

* Trim surrounding whitespace.
* Persian/Arabic numerals may be normalized to Western digits before validation.
* After normalization, the input must be exactly 4 digits.
* The value must be interpreted as a Gregorian year.
* The value must satisfy:

`1900 <= birth_year <= current_gregorian_year - 18`

Invalid birth year inputs must be rejected.

Invalid inputs include:

* Future years
* Current year
* Under-18 years
* Impossible old years before 1900
* Jalali years
* Full dates
* Decimals
* Non-numeric input

The stored value must be an integer Gregorian year.

Birth year validation applies to:

* Signup birth year entry
* Admin approval of birth year change requests

Exact birth date is not collected.

Age verification is not included in MVP.

MVP age eligibility is approximate.

A user is eligible if:

`birth_year <= current_gregorian_year - 18`

Because exact birth date is not collected, the system cannot verify whether the user has already had their 18th birthday in the current year.

### Age calculation

Age is derived from Gregorian birth year.

Displayed age is approximate because exact birth date is not collected.

Age should not be stored as a separate source-of-truth field.

Approximate displayed age is calculated as:

`current_gregorian_year - birth_year`

### Signup order

Signup follows this order:

1. Confirm age 18+
2. Name
3. Birth year
4. Gender
5. Interested gender
6. Interests
7. Country, province, and city
8. Relationship goal
9. Upload primary photo
10. Upload additional photos
11. Write highlight
12. Optional bio and optional profile details
13. Confirm profile

### Required profile fields

A profile cannot become complete unless it has:

* Name
* Gregorian birth year
* Gender
* Interested gender
* At least 5 profile interests
* Country
* Province
* City
* Relationship goal
* At least 2 visible photos
* At most 6 saved profile photos
* One visible primary photo
* Highlight

### Interest rules

A profile must have at least 5 interests to become complete.

A profile can have at most 20 interests.

Interests belong to the dating profile, not directly to the user.

### Highlight rules

Highlight is required.

Highlight maximum length is 80 characters.

### Bio rules

Bio is optional.

Bio maximum length is 500 characters.

### Locked profile fields

Birth year cannot be changed directly after signup.

Gender cannot be changed directly after signup.

To change either field, the user must submit a profile change request with a reason.

Admin can approve or reject the request.

### Interested gender

Interested gender can be changed later.

Changing interested gender from Explore filters or Edit Profile updates the same profile-level value.

### Profile and account separation

Profile data and account state must stay separate.

Profile owns dating-visible data.

Account owns access and lifecycle state.

## 3. Media and Photo Rules

### Photo source

Telegram profile photo must not be used as the dating profile photo.

Users must upload dating profile photos explicitly.

### Photo storage

Photos must be stored in object storage.

The app server must not be the permanent image store.

Photos should be served through CDN URLs.

### Photo count

A complete profile must have at least 2 visible photos.

A profile can have at most 6 saved profile photos.

Saved profile photos means visible + hidden profile photos currently stored for that profile.

Hidden photos count toward the 6-photo saved-photo limit, but do not count toward profile completion.

Only visible photos count toward the 2-photo completion requirement.

Extra saved profile photos must be rejected.

The system must not allow users to create unlimited stored images by repeatedly uploading and deleting photos.

### Photo deletion and retention

When a user deletes a profile photo:

* The photo is removed from the profile immediately.
* The stored media object must be permanently deleted from object storage/CDN.
* The deleted photo no longer counts as a saved profile photo after its stored media object is deleted.
* The user may upload a replacement photo if the profile has fewer than 6 saved profile photos.

Exception:

If the photo is linked to an active report, moderation case, safety case, legal/audit case, or immutable report snapshot:

* The user-facing photo is removed immediately.
* The normal profile media object should not remain publicly accessible.
* A restricted evidence copy may be retained in moderation/audit storage.
* The evidence copy must be deleted when retention rules allow deletion.

Deleted photo records should be used only for cleanup tracking, retention tracking, moderation/audit references, or historical traceability.

Deleted photos must not become a loophole for unlimited media storage.


### Primary photo

One visible photo must always be primary.

The first uploaded photo becomes the primary photo.

The user cannot delete the primary photo before choosing another visible primary photo.

A hidden photo cannot be selected as primary by the user.

A hidden photo can become primary only after it is restored to visible status through the allowed moderation/admin restore flow.

### Photo visibility

Photos are not pre-approved.

Uploaded photos become visible immediately.

Users can report photos.

Admin can hide, restore, or delete profile photos.

Admin photo actions mean:

* Hide photo: set the photo status to `hidden`; the photo is removed from user-visible profile surfaces but remains restorable.
* Restore photo: set a hidden photo back to `visible`, if it is allowed by moderation rules.
* Delete photo: set the photo status to `deleted`; the photo is removed from the dating profile and no longer counts as an active profile photo.

Admin photo deletion is soft deletion from the profile. It must not immediately hard-delete the underlying media asset.

Deleted photo records and media metadata may be retained for audit, moderation, reports, appeals, abuse prevention, and safety history.

### Moderated primary photo

If admin hides or deletes a primary photo:

* Another visible photo should become primary if available.
* If no visible primary photo can be assigned, profile validity must be rechecked.
* If the profile was never completed and required photo rules are not satisfied, keep `Profile.completion_status = incomplete`.
* If the profile was previously complete and required photo rules are no longer satisfied, set `Profile.completion_status = invalid`.
* Do not use hidden or deleted as profile completion statuses.

### Blurred previews

Locked Liked By cards require blurred photo previews.

Blurred previews should be generated as photo variants.

## 4. Explore and Consumption Rules

### Explore access

Only users with all of the following can Explore:

* `Account.state = active`
* `Profile.completion_status = complete`
* `UserSettings.visibility_enabled = true`

Restricted, banned, deleted, incomplete, visibility-off, and invalid-profile users cannot Explore.

Users with invalid profiles also cannot appear in Explore.

Guest Preview is not normal Explore and is governed by the Guest Preview Pool rules.

### Explore display

Explore shows one profile at a time.

Explore preview includes:

* Primary photo
* Name
* Age
* City
* Highlight

### Eligible profile rules

A profile can appear in normal Explore only if:

* Profile completion status is `complete`
* User visibility is enabled
* Account state is `active`
* User is not restricted, banned, or deleted
* Profile is compatible with the viewer’s filters
* Profile is reciprocally gender-compatible with the viewer
* Target has not previously been consumed by the viewer

### Explore filters

MVP Explore screen controls include:

* Interested gender
* Age range
* City
* Relationship goal

Interested gender can be changed from the Explore screen, but it is not stored in ExploreFilter.

Changing interested gender from Explore or Edit Profile updates the same profile-level field:

* Profile.interested_gender

ExploreFilter stores only:

* Age range
* Location
* Relationship goal

Default location is the user’s own city.

For MVP, Country is fixed to Iran and is not shown as an Explore filter.

Province is used only to group/select cities.

Explore location filtering is city-level.

Province-wide browsing is not included in MVP.

There is no whole-country filter in MVP.

### Explore gender compatibility

Explore gender compatibility is reciprocal.

A target profile can appear to a viewer only if both conditions are true:

* The viewer’s interested gender includes the target’s gender.
* The target’s interested gender includes the viewer’s gender.

For MVP:

* Men includes Man.
* Women includes Woman.
* Everyone includes all active visible gender options, including Man, Woman, Other, and Prefer not to say.

Gender compatibility must be data-driven.

Future gender options must be addable through configuration or mapping data.

The implementation must not hardcode Explore matching only around Man/Woman.

### Default filters

Default age range is:

* user age minus 5
* user age plus 5

Minimum age is always 18.

Default location is the user’s own city.

There is no whole-country filter in MVP.

Relationship goal filter is optional.

### Profile consumption

A profile is consumed after:

* Preview
* Like
* Not Interested
* Pending Nakh
* Sent Nakh
* Match

Consumed profiles must not be shown again to the same viewer.

### Guest and incomplete consumption

Guest and incomplete users consume profile previews from the Guest Preview Pool.

Each shown Guest Preview creates permanent consumption with reason `preview`.

Consumed Guest Preview targets must not be shown again to the same viewer.

Guest and incomplete users share the same permanent preview counter tied to Telegram identity/user.

Guest and incomplete preview consumption does not require normal Explore filters or reciprocal gender compatibility.

### No results

If no eligible profile exists, show the Nobody Found state.

## 5. Like, Liked By, and Not Interested Rules

### Normal Like

A normal Like is free.

A normal Like is permanent in MVP.

Users cannot undo, cancel, or withdraw a normal Like.

A normal Like appears in the receiver’s Liked By section.

A normal Like can create a Match if the receiver has already liked the sender.

A liked profile remains consumed and must not appear again to the same sender.

If a user regrets a Like after a Match is created, the correct action is Unmatch, not Like cancellation.

### Liked By

Liked By shows actionable received normal Likes.

Liked By does not include Nakh senders.

Liked By is not a separate stored card entity.

Liked By must be derived from:

* Like
* FeatureUnlock
* Match
* UserPairState
* NotInterested
* Liker account state
* Liker profile completion status

A received Like appears in Liked By only if all of these are true:

* The Like status is `active`.
* No Match exists for the pair.
* UserPairState is not `matched`, `unmatched`, or `blocked`.
* The current user has not marked the liker as Not Interested.
* The liker account state is `active`.
* The liker profile completion status is `complete`.
* The liker is not restricted, banned, or deleted.

Visibility off does not remove an already-sent Like from Liked By.

If a liker turns visibility off after sending a Like, the Like may still appear in the receiver’s Liked By section as long as the liker account is active and the liker profile remains complete.

If the liker becomes restricted, banned, deleted, or profile-invalid, the liker must not appear as an actionable Liked By card.

### Liked By count

Liked By count includes only actionable received Likes.

Liked By count does not include:

* Nakh senders
* Matched users
* Unmatched users
* Blocked users
* Users marked as Not Interested by the receiver
* Restricted users
* Banned users
* Deleted users
* Profile-invalid users
* Closed Likes

An expired Liked By unlock does not remove the Like from the count.

### Locked Liked By view

Before unlock, the user can see:

* Number of actionable Likes
* Locked liked-by cards
* Blurred preview image

Before unlock, the user cannot see:

* Full profile
* Profile details

### Liked By unlock

Each liked-by profile is unlocked separately.

Unlocking one liked-by profile does not unlock other liked-by profiles.

Unlocking creates a `FeatureUnlock` with type `liked_by_profile_unlock`.

After unlock, the user can:

* View the full profile while the unlock is active
* Like Back
* Mark Not Interested

### Liked By unlock expiry

Liked By profile unlock expires according to configured unlock duration.

The expiry duration must be configurable and must not be hardcoded in handlers.

When a Liked By profile unlock expires:

* Full profile access is removed.
* If the original Like is still actionable, the card returns to locked state.
* The user may unlock the same liked-by profile again.
* The expired unlock remains as payment/audit history.
* No refund is given because the unlock expired normally.

Expired unlock does not remove the Like.

Expired unlock does not remove the card from the Liked By count if the Like is still actionable.

### Like Back from Liked By

If user Likes Back from Liked By, a Match is created.

When Like Back creates a Match:

* The original received Like is closed with status `closed_by_match`.
* UserPairState becomes `matched`.
* The pair moves to Matches.
* The liked-by card is removed from normal Liked By.
* The FeatureUnlock remains only as payment/audit history.

After Match, the pair exits discovery actions.

### Not Interested

Not Interested is permanent.

A target marked as Not Interested should not appear again.

Not Interested can come from:

* Explore
* Liked By
* Cancelled Pending Nakh
* Unmatch

### Not Interested from Liked By

If user marks an unlocked Liked By profile as Not Interested:

* Create NotInterested pair record with source `liked_by`.
* Hide/close that liked-by card from default view.
* Do not notify the target.
* Keep any existing FeatureUnlock only as payment/audit history.

### Unmatch effect on Liked By

If users later unmatch:

* Old Likes must not return to Liked By.
* Relevant Like records are closed with status `closed_by_unmatch`.
* UserPairState becomes `unmatched`.
* The pair must not appear again in Liked By, Explore, Nakh, or Match flows.
* Existing FeatureUnlock records remain only as payment/audit history.

### Like cancellation

There is no user-facing Unlike or Like cancellation in MVP.

Normal users cannot cancel a Like in MVP.

If `LikeStatus.cancelled` is kept, it is reserved only for admin/system correction.

## 6. Nakh Rules

### Nakh meaning

Nakh is a paid stronger signal.

Nakh is separate from normal Like.

### Nakh flow uniqueness

Only one Nakh flow is allowed per sender/receiver pair.

A Nakh flow starts when:

* PendingNakh is created
* Sent Nakh is created directly using existing credits

After a Nakh flow exists, the sender cannot create another PendingNakh or Sent Nakh for the same receiver.

This rule still applies if the PendingNakh later becomes:

* expired
* abandoned
* cancelled
* blocked
* payment failed
* payment cancelled

This rule also applies if the Sent Nakh later becomes:

* seen
* accepted
* rejected
* closed
* expired

PendingNakh and Nakh must be checked together when enforcing this rule.

### Pending Nakh

Pending Nakh is an unpaid Nakh attempt.

Pending Nakh is visible only to the sender.

Pending Nakh does not:

* Notify the receiver
* Create normal Like
* Appear in Liked By
* Appear in receiver’s Nakhes
* Create Match

Pending Nakh does consume the target profile.

Pending Nakh also consumes the sender’s one allowed Nakh flow for that receiver.

### Pending Nakh payment

If the sender does not have enough credits:

* Create PendingNakh
* Create PendingPayment
* Allow editing Nakh text before payment
* Do not notify receiver

Before completing Pending Nakh payment, the system must recheck sender and receiver eligibility.

Sender eligibility fails if sender account is restricted, banned, or deleted.

Receiver eligibility fails if receiver account is restricted, banned, deleted, or receiver profile is invalid.

Sender visibility off does not fail eligibility if the Pending Nakh was created before sender visibility was turned off.

Receiver visibility off does not fail eligibility if the Pending Nakh was created before receiver visibility was turned off.

Receiver visibility off only prevents the receiver from appearing in new Explore results. It does not block delivery of an already-created Pending Nakh after payment succeeds.

### Pending Nakh cancellation

If sender cancels unpaid Pending Nakh, ask whether to:

* Convert to normal Like
* Mark as Not Interested

If converted to normal Like:

* Create Like
* Notify target
* Show sender in target’s Liked By
* Create Match if reverse Like exists

If converted to Not Interested:

* Create NotInterested
* Do not notify target
* Keep target consumed

### Sent Nakh

Sent Nakh is created only after payment succeeds or credits are successfully spent.

Sent Nakh appears in receiver’s Nakhes.

Sent Nakh does not appear in receiver’s Liked By.

### Nakh delivery

When Nakh is successfully sent:

* Deduct credits or confirm payment
* Create Nakh
* Notify receiver
* Show Nakh in receiver’s Nakhes

### Nakh limits

Only one Nakh flow is allowed per sender/receiver pair across both PendingNakh and Nakh.

Nakh text maximum length is 240 characters.

Nakh expires after 14 days.

### Nakh receiver actions

Receiver can:

* View profile
* Accept Nakh
* Reject
* Report

### Nakh rejection

Receiver rejection must be stored internally as `Nakh.status = rejected`.

The UI must display rejected Nakh as Closed.

`Nakh.status = closed` must not be used for receiver rejection.

`Nakh.status = closed` is reserved for generic non-rejection closure cases, such as admin/moderation/system closure, where the Nakh is terminated without being accepted, rejected, or expired.

If receiver rejects Nakh:

* Set `Nakh.status = rejected`
* Set `Nakh.rejected_at`
* Do not set `Nakh.closed_at`
* Sender cannot send another Nakh to the same target
* Receiver should stop seeing sender in this flow

### Nakh acceptance

If receiver accepts a sent Nakh:

* Create Match
* Notify both users
* Create ChatSession
* Stop discovery actions between the pair

## 7. Match and Unmatch Rules

### Match creation

A Match can be created by:

* Mutual normal Like
* Accepted Nakh

### Match uniqueness

A pair of users should not have duplicate active Matches.

The pair should be normalized to prevent duplicate pair records.

### Match effects

After Match:

* Users cannot Like each other again
* Users cannot send Nakh to each other
* Users cannot mark each other Not Interested
* Users cannot appear to each other in Explore
* ChatSession is created

### UserPairState usage

UserPairState is a symmetric pair-level summary only.

Allowed UserPairState values for MVP:

* none
* matched
* unmatched
* blocked

UserPairState must not store directional actions.

The following directional actions must be read from their source records:

* Profile viewed or consumed: ExploreConsumption
* Like: Like
* Not Interested: NotInterested
* Pending Nakh: PendingNakh
* Sent Nakh: Nakh

A normalized pair state can be used to prevent invalid future actions after Match or Unmatch.

### Match notification

When a Match is created:

* Both users receive a notification
* Internal bot relay chat becomes available

### Unmatch

Either matched user can unmatch.

When unmatch happens:

* Match becomes unmatched
* Chat closes visually for both users
* Other side receives a chat closed message
* Pair should not match again

### Unmatch as rejection

Unmatch acts like rejection.

After unmatch, the pair should not return to discovery, Like, Nakh, or Match flows.

### Post-unmatch report window

After unmatch, either user can report the other for 24 hours.

After the 24-hour window expires, the special unmatched-user report access should close.

### Post-unmatch report evidence

If a user reports another user through the post-unmatch report flow:

* The report evidence type must be `unmatched_user`.
* The report evidence must reference the exact `UnmatchRecord`.
* The report is valid only inside the 24-hour report window stored on that UnmatchRecord.
* The report must be rejected if the reporter or reported user is not one of the two users involved in that UnmatchRecord.

### Message retention after unmatch

After unmatch:

* Chat closes visually
* Last 50 messages may be retained internally
* Report snapshots may preserve relevant messages for moderation

## 8. Chat Rules

### Chat creation

Chat exists only after Match.

No Match means no ChatSession.

### Chat type

Chat is internal bot relay chat.

It is not native Telegram direct messaging.

### Free chat mode

Before chat unlock, users cannot type freely.

Free matched users can only send:

* Predefined questions
* Predefined answers

Free matched users cannot send:

* Custom text
* Photos
* Stickers
* Media
* Emojis as custom free messages

### Predefined chat data

Predefined questions and answers must be data-driven.

They must not be hardcoded inside chat logic.

Default predefined topics:

* Relationship intent
* Ideal first date
* Chat frequency
* Introvert/extrovert
* Weekend habits
* Calls or texting
* Important values
* Meeting in person
* Relationship pace
* Current life focus

### Chat unlock

Chat unlock is paid per Match.

One successful chat unlock payment unlocks free-text chat for both users in that specific Match.

If either matched user unlocks chat, both users can send text in that Match.

The other matched user does not need to pay again for the same Match.

Chat unlock does not expire in MVP.

Chat unlock remains active until:

* The Match is unmatched
* The Match is closed by admin/moderation
* The chat is closed because of account deletion or ban
* The unlock is revoked by admin/moderation

### Unlocked chat limits

After chat unlock:

* Text messages are allowed
* Photo messages are not allowed
* Sticker messages are not allowed
* Media messages are not allowed

### Contact sharing after unlock

After chat unlock, users may share:

* Phone number
* Telegram ID
* Other contact information

A safety warning must be shown once when chat unlocks.

### Chat message retention

Only the last 50 visible messages per chat should remain available in normal chat view.

Older messages may be archived or cleaned by background job.

Reported messages must be snapshotted before cleanup when needed for moderation.

### Restricted user chat access

Restricted users can read existing chats.

Restricted users cannot send chat messages.

### Deleted or banned user chat effect

If an account is deleted or banned, related chats should close visually according to account lifecycle rules.

## 9. Payment and Credit Rules

### Payment provider

MVP payment provider is Telegram Stars.

### Credits

Credits are the internal unit used for paid actions.

Paid actions include:

* Send Nakh
* Unlock one match chat
* Unlock one Liked By profile

### Credit balance

Each user has one credit balance.

Every credit balance change must create a CreditTransaction.

### Paid feature costs

MVP costs:

* Send Nakh: 2 credits
* Unlock one match chat: 4 credits
* Unlock one Liked By profile: 4 credits

### Credit packages

Users can buy credit packages.

Exact package sizes and discount rules are not finalized yet.

### Contextual purchase

Wallet is not shown in the MVP main menu.

Paid flows appear contextually when the user attempts a paid action.

### Paid action funding

Paid actions can be funded in either of these ways:

* Spending existing internal credits
* Direct Telegram Stars payment

Paid actions are:

* Send Nakh
* Unlock one match chat
* Unlock one Liked By profile

Both funding paths must result in the same final domain action.

Direct Telegram Stars payment must not create different product behavior from credit-based payment.

Payment callbacks must be idempotent and must not double-process credits, unlocks, Nakh delivery, or notifications.

Payment type and paid action reason must stay separate:

* `payment_type` describes the payment path.
* `paid_action_reason` describes the paid action being completed.

Payment types:

* `buy_credit_package`
* `direct_paid_action`
* `pay_pending_action`

Paid action reasons:

* `send_nakh`
* `unlock_chat`
* `unlock_liked_by_profile`

Credit package purchases are not paid actions.

Credit package purchases use `payment_type = buy_credit_package`.

Direct Telegram Stars payment for Send Nakh uses `payment_type = direct_paid_action` and `paid_action_reason = send_nakh`.

Direct Telegram Stars payment for chat unlock uses `payment_type = direct_paid_action` and `paid_action_reason = unlock_chat`.

Direct Telegram Stars payment for Liked By unlock uses `payment_type = direct_paid_action` and `paid_action_reason = unlock_liked_by_profile`.

A payment for an existing PendingPayment uses `payment_type = pay_pending_action`; the action is resolved from the PendingPayment reason.

### Pending payment

A PendingPayment is created when a paid action cannot be completed immediately.

Pending payments should expire.

Pending payment completion must apply the related paid action exactly once.

### Payment idempotency

Payment callbacks must be idempotent.

The same provider payment event must not be processed twice.

Duplicate payment callbacks must not create:

* Duplicate credits
* Duplicate unlocks
* Duplicate Nakh delivery
* Duplicate notifications

### Credit spending

Credit spending must be transactional with the paid action.

For example, sending paid Nakh must:

* Check credit balance
* Deduct credits
* Create CreditTransaction
* Create Nakh
* Create receiver notification

The operation should either fully succeed or fully fail.

### Feature unlocks

FeatureUnlock is used for scoped paid access.

FeatureUnlock is used for:

* Liked By profile unlock
* Chat unlock

FeatureUnlock is not needed for sent Nakh.

Nakh is a paid action, not persistent access.

For MVP, `liked_by_profile_unlock` can expire, but `chat_unlock` does not expire.

Direct Telegram Stars payment for Nakh must not create a FeatureUnlock.

Only chat unlock and Liked By profile unlock create FeatureUnlock records.

### Liked By unlock

Unlocking one Liked By profile unlocks only that specific profile.

It does not unlock other Liked By profiles.

### Chat unlock

Unlocking one match chat unlocks that specific match chat for both matched users.

Only one successful chat unlock payment is needed per Match.

The paying user is the chat unlock payer.

The payer does not become the only beneficiary.

Chat unlock is Match-scoped:

* Store who paid.
* Store which Match was unlocked.
* Allow both Match participants to send free-text messages after unlock.
* Do not charge the second participant for the same Match.
* Do not check chat text permission by payer user ID alone.

The other matched user does not need to pay again.

If one side unlocks chat, both sides can send text in that Match.

Chat unlock does not expire in MVP.

### Payment audit

Payment lifecycle events must be auditable.

Payment audit should cover:

* Payment creation
* Payment success
* Payment failure
* Credit purchase
* Credit spending
* Refund or correction
* Provider callback processing

## 10. Notification Rules

### Notification history

Notifications must be stored.

Notification center keeps notification history with read/unread state.

### Telegram delivery

Important notifications should also be delivered through Telegram messages.

### Normal Like notification

Normal Like creates a notification for the receiver.

The sender appears in receiver’s Liked By.

### Nakh notification

Only paid Sent Nakh creates a receiver notification.

Pending Nakh creates no receiver notification.

Sent Nakh appears in receiver’s Nakhes, not Liked By.

### Match notification

When a Match is created:

* Both users receive a notification
* Chat becomes available

### Chat message notification

New chat messages can create notifications for the receiver.

Chat notifications should respect mute settings unless the message is safety/admin-related.

### Chat unlock notification

When chat is unlocked:

* Both users may be notified
* Chat mode changes to unlocked text
* Safety warning should be shown once

### Liked By unlock notification

When a user unlocks one Liked By profile, the unlock result should be recorded.

Notification may be shown to the unlocking user.

### Payment notification

Payment success and failure notices must be shown to the payer.

Payment notices cannot be muted.

### Safety and admin notices

These notification types cannot be muted:

* Safety notices
* Payment notices
* Admin notices
* Ban notices
* Restriction notices

### Normal notification mute

Users can mute normal notifications.

Normal mute can apply to:

* Chat notifications
* Like notifications
* Nakh notifications
* Match notifications

### Notification delivery retry

Failed notification delivery should be retryable when appropriate.

Delivery attempts should be tracked separately from the stored notification.

## 11. Reporting, Moderation, and Admin Rules

### Reportable targets

Users can report:

* Profile
* Photo
* Chat/message context
* Recently unmatched user within the allowed report window

### Report reasons

Default report reasons:

* Fake profile
* Harassment
* Inappropriate photo
* Spam or scam
* Under 18
* Offensive behavior
* Other

Reports may include optional extra text.

### Report review

Every report goes to admin review.

A report alone does not automatically ban a user.

### No user block in MVP

Users cannot block other users in MVP.

Admins do not have a pair-level block action in MVP.

Safety issues should be handled through Reports.

After report review, admin can use the existing moderation actions: restrict user, unrestrict user, ban user, unban user, hide photo, restore photo, dismiss report, or review related support/appeal/change requests.

Future user-facing block functionality can be added later if needed, but it is not part of the MVP.

### Report threshold

The automatic report threshold is a temporary safety restriction, not a ban.

A target user is automatically restricted when all of the following are true:

* The target user has reports from 5 or more unique reporters.
* The reports were created within the rolling report threshold window.
* The report threshold window is 30 days for MVP.
* The reports are unresolved.

The threshold counts unique reporters, not total report count.

Multiple reports from the same reporter against the same target user count as 1 reporter for threshold purposes.

The threshold is counted at target-user level.

The threshold is not counted separately by evidence type.

Reports against the target user's profile, photos, chat/message context, and recently unmatched-user context all count toward the same target-user threshold.

Only unresolved reports count toward the threshold.

Unresolved report statuses are:

* `submitted`
* `pending_review`

These report statuses do not count toward triggering a new automatic restriction:

* `dismissed`
* `closed`
* `actioned`

When the threshold is reached:

* The target account becomes `restricted`.
* A restriction warning should be sent to the target user.
* A moderation/admin review should be created or flagged for priority review.
* The automatic restriction remains until admin decision.

Admin decision can:

* Dismiss the reports and unrestrict the user.
* Keep the user restricted.
* Ban the user.
* Take another moderation action.

If admin dismisses reports, those reports stop counting toward the automatic restriction threshold.

If admin action is taken, the handled reports stop counting toward a new automatic restriction.

Reports do not automatically ban users.

Ban always requires admin decision.

### No automatic ban

There is no automatic ban in MVP.

Ban requires admin decision.

### Report snapshots

Reports should preserve relevant context at report time.

Snapshots may include:

* Profile data
* Photo data
* Chat messages
* Message context

Report snapshots should be immutable.

### Chat review privacy

Admins should see chat messages only when:

* A report is submitted
* Chat review is needed for moderation

Reported chat messages should be snapshotted.

### Photo moderation

Photos are not pre-approved.

Photos become visible immediately after upload.

Admin can hide, restore, or delete profile photos.

If a hidden or deleted photo is primary, another visible photo should become primary if available.

If required photo rules are no longer satisfied after photo moderation or admin photo deletion:

* A never-completed profile stays `incomplete`.
* A previously complete profile becomes `invalid`.

### Admin interface

MVP admin interface is Telegram admin commands.

No web admin panel is required for MVP.

### Admin capabilities

Admin can:

* View reports
* View user profile
* Restrict user
* Unrestrict user
* Ban user
* Unban user
* Hide photo
* Restore photo
* Delete photo
* Dismiss report
* Review birth year change requests
* Review gender change requests
* Review appeals/support messages

### Admin logging

Every admin action must be logged.

Admin logs should include:

* Admin user
* Action type
* Target user/entity
* Timestamp
* Metadata when needed

## 12. Deletion, Retention, and Audit Rules

### Account deletion

Users can delete their account.

After deletion:

* Profile becomes hidden
* Chats close
* Account enters deleted state
* Minimal audit, report, payment, and safety records remain

### Reactivation

A deleted user may later reactivate the same account with the same Telegram account only if `AccountDeletionRecord.reactivation_allowed = true`.

Reactivation uses the same internal User, same TelegramIdentity, same Account, and same Profile record.

Reactivation changes `Account.state` from `deleted` to `incomplete` until the rebuilt profile satisfies all required completion rules.

During reactivation, dating-visible profile fields may be cleared, overwritten, or re-entered through the signup/profile-completion flow.

Retained reports, restrictions, bans, payment records, safety records, moderation records, audit logs, and deletion records remain attached to the same User.

Reactivation must not create a clean new User, must not create a second active Profile for the same User, and must not erase retained safety or moderation history.

### Data retention

After deletion, retain only minimal records needed for:

* Payment safety
* Report history
* Abuse prevention
* Auditability
* Legal/accounting traceability

### Audit requirements

Important state-changing actions must be auditable.

Audit should cover:

* Account state changes
* Profile deletion
* Payment events
* Credit spending
* Feature unlocks
* Report submission
* Restriction
* Ban
* Photo hiding
* Photo restoration
* Photo deletion
* Chat closure
* Admin actions

## 13. Localization and Config Rules

### User-facing text

User-facing bot text should not be hardcoded inside handlers.

Text should be loaded through localization keys.

### MVP language

MVP language is English.

Persian and other languages may be added later.

### Localization coverage

Localization should cover:

* Button labels
* Bot messages
* Error texts
* Admin texts
* Payment texts
* Notification texts
* Safety texts

### UI language vs profile spoken languages

UI language and profile spoken languages are separate.

UI language controls bot interface text and is stored through `UserSettings.language_code`.

MVP UI language is English.

Persian and other UI languages may be added later through localization records.

Profile spoken languages are dating profile fields.

Profile spoken languages are selected from supported `Language` records and connected to profiles through `ProfileLanguage`.

Profile spoken languages must not be stored as free text.

Changing UI language must not change profile spoken languages.

Changing profile spoken languages must not change UI language.

### Product constants

Product constants must not be scattered through handlers, payment code, background jobs, or feature services.

SystemConfig or code-level configuration must be the source of truth for tunable MVP constants.

Configurable constants include:

* Report threshold unique reporter count
* Report threshold window days

Access and signup:

* Guest preview limit
* Minimum signup age
* Name max length
* Change request reason max length

Profile completion:

* Minimum profile photos
* Maximum profile photos
* Minimum interests
* Maximum interests
* Highlight max length
* Bio max length

Nakh:

* Nakh text max length
* Nakh cost
* Sent Nakh expiry duration
* Pending Nakh expiry duration
* Pending Nakh reminder schedule

Liked By:

* Liked By unlock cost
* Liked By unlock expiry duration

Chat:

* Chat unlock cost

Payments and credits:

* Credit package options
* Telegram Stars pricing
* Refund policy

Media:

* Media storage provider
* Media CDN provider
* Maximum photo file size
* Allowed photo MIME types

Admin bootstrap:

* Bootstrap admin Telegram IDs

Rules:

* Handlers must read product constants from SystemConfig or code-level configuration.
* Background jobs must read tunable schedules and expiry durations from SystemConfig or code-level configuration.
* Payment and credit services must read costs, package options, Stars pricing, and refund policy from SystemConfig or code-level configuration.
* README may describe product behavior, but it must not be treated as the config-key registry.

## 14. Notes

* These rules are product invariants.
* Database schema, constraints, and indexes must enforce these rules where possible.
* Application services must enforce rules that cannot be fully enforced at database level.
* Permission checks should be centralized.
* Payment and credit operations must be transactional.
* Nakh, Like, Match, and Chat rules must stay consistent across Explore, Liked By, Nakhes, and Chat flows.
* The final database design must be checked against this file before coding starts.










