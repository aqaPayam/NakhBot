# Telegram Dating Bot — Final MVP Product Description

## 1. Product Overview

This product is a Telegram-based dating bot.

The first implementation is fully English. Persian and other languages may be added later, so UI text must be configurable and must not be hardcoded inside bot logic.

### UI Language and Profile Language

UI language and profile spoken languages are separate concepts.

UI language controls bot text such as buttons, messages, errors, payment text, notifications, safety text, and admin text.

For MVP, the only supported UI language is English.

Persian and other UI languages may be added later through localization records.

User-facing text must be loaded through localization keys and must not be hardcoded inside bot handlers.

Profile spoken languages are dating profile fields.

A profile spoken language means a language the user can speak, such as English, Persian, Turkish, Arabic, or another supported language.

Profile spoken languages are selected from the `Language` option list and connected to profiles through `ProfileLanguage`.

Profile spoken languages are not the same as `UserSettings.language_code`.

The app has two main access modes:

- Guest
- User

User account states are:

- Guest
- Incomplete
- Active
- Restricted
- Banned
- Deleted

## 2. Guest Mode

A new person can open the bot and either browse as a Guest or sign up as a User.

On first `/start`, the system creates a persistent guest-level user record.

For a new Telegram user, the system creates:

- User
- TelegramIdentity
- Account with state `guest`
- UserSettings with default values
- GuestPreviewCounter with `preview_count = 0` and `limit_count = 10`

Guest mode is not an anonymous temporary session.

Guest preview limits are tied to the Telegram identity/user and are permanent.

Guest rules:

- Guest can only see limited teaser profile previews.
- Guest can see only 10 profile previews permanently.
- Guest preview is not normal Explore.
- Guest preview does not use Explore filters.
- Guest preview does not use reciprocal gender compatibility.
- Guest preview does not use the viewer’s age, city, interested gender, or relationship goal.
- Guest preview uses the Guest Preview Pool defined below.
- Guest cannot use filters.
- Guest cannot like profiles.
- Guest cannot send Nakh.
- Guest cannot mark profiles as Not Interested.
- Guest cannot match.
- Guest cannot chat.
- Guest cannot use paid features.
- After 10 previews, the bot shows a signup message.
- If a user has an incomplete profile, they are treated like Guest until signup is completed.

When a guest starts signup, `Account.state` becomes `incomplete`.

The GuestPreviewCounter does not reset when the user moves from Guest to Incomplete.

When signup is completed, `Account.state` becomes `active`.

After activation, the GuestPreviewCounter is kept for audit/history but no longer controls normal Explore.

Guest profile preview includes:

- Primary photo
- Name
- Age
- City
- Highlight

### Guest Preview Pool

Guest and Incomplete users see teaser previews from a simple MVP preview pool.

A profile can appear in Guest Preview only if:

- Profile completion status is complete.
- Target user visibility is enabled.
- Target account state is active.
- Target user is not restricted, banned, or deleted.
- Target profile belongs to the MVP-supported country, Iran.
- Target has a visible primary photo.
- Target has not already been consumed by the viewer.

Guest Preview ignores:

- Viewer age
- Viewer city
- Viewer interested gender
- Viewer relationship goal
- Explore filters
- Reciprocal gender compatibility

Guest Preview is randomized inside the eligible teaser pool.

Guest and Incomplete preview consumption is permanent and counts against the same GuestPreviewCounter.

If no Guest Preview profile is available, the bot should show the normal empty preview state and encourage signup.


## 3. User Signup

Minimum age is 18.

MVP age eligibility is approximate because exact birth date is not collected.

Users must first confirm that they are 18+.

Users then enter Gregorian birth year only.

Birth year input validation:

- The input is trimmed before validation.
- Persian/Arabic numerals may be normalized to Western digits before validation.
- After normalization, birth year must be exactly 4 digits.
- Birth year must be a Gregorian year.
- MVP accepted range is:

`1900 <= birth_year <= current_gregorian_year - 18`

- Future years, current year, under-18 years, impossible old years, Jalali years, decimals, full dates, and non-numeric inputs are rejected.
- The stored value must be an integer Gregorian year.

A user is eligible if:

`birth_year <= current_gregorian_year - 18`

The system does not collect exact birth date, so it cannot verify whether the user has already had their 18th birthday in the current year.

There is no age verification in MVP.

Displayed age is approximate and calculated from the current Gregorian year.

Signup order:

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

No phone number or external ID is required beyond Telegram identity.

Telegram profile photo is not used. Users must upload dating profile photos explicitly.

### Required Fields

Required fields:

- Name
- Birth year — Gregorian year only. Age is derived from birth year and is not collected or stored as a separate source-of-truth field.
- Gender
- Interested gender
- Interests
- Country
- Province
- City
- Relationship goal
- 2–6 saved profile photos, with at least 2 visible photos
- One primary photo
- Highlight

Interest rules:

- User must choose at least 5 interests during signup.
- User can add more interests later.
- Maximum number of interests is 20.

Highlight rules:

- Highlight is required.
- Highlight max length is 80 characters.

Bio rules:

- Bio is optional.
- Bio max length is 500 characters.

### Optional Fields

Optional fields:

- Bio
- Additional interests, up to 20 total
- Height
- Job title
- Education
- Smoking preference
- Pets
- Spoken languages
- Exercise/gym
- Religion importance
- Children preference
- Personality tags

### Photo Rules

Photo rules:

- Minimum 2 visible photos are required for profile completion.
- Maximum 6 saved profile photos are allowed per profile.
- Saved profile photos means photos currently stored for that profile as visible or hidden profile photos.
- Hidden photos count toward the 6-photo saved-photo limit, but do not count toward profile completion.
- Only visible photos count toward the 2-photo completion requirement.
- Deleted photos are removed from the profile and their stored media objects must be permanently deleted from object storage/CDN.
- A deleted photo no longer counts as a saved profile photo after its stored media object is deleted.
- The user may upload a replacement photo after deleting an existing photo, as long as the profile has no more than 6 saved profile photos.
- The system must not allow users to create unlimited stored images by repeatedly uploading and deleting photos.
- If a deleted photo is linked to an active report, moderation case, safety case, legal/audit case, or immutable report snapshot, the user-facing photo is removed immediately, but the evidence copy may be retained in restricted moderation/audit storage until retention rules allow deletion.
- User uploads the primary photo first.
- The primary photo is accepted only after successful photo upload validation and required variant generation.
- User can upload additional photos after the primary photo.
- Extra saved photos are rejected.
- One visible photo must always be primary.
- User cannot delete the primary photo before choosing another visible primary photo.
- If photo moderation or deletion causes a profile to fail the visible photo requirement:
  - A never-completed profile remains Incomplete.
  - A previously completed profile becomes Invalid.
- Hidden is not a profile completion status.

> **Ambiguous**  
> <span style="font-size: 1.2rem;">What is the point of hidden profiels? Why should a user be able to hide some of it's photos?</span>

If a previously completed profile becomes Invalid, the user keeps `Account.state = active`.

Invalid profile status does not change the account back to Incomplete.

An active user with an Invalid profile must be routed to Fix Profile until the profile becomes Complete again.
> **Ambiguous**  
> <span style="font-size: 1.2rem;">How should it be routed? Could it not use main features? Where should the routing start?</span>

### Photo Upload Validation

MVP photo upload validation rules:

- Accepted image formats are JPEG, PNG, and WebP.
- HEIC/HEIF may be accepted only if the backend converts it into a supported delivery format before saving it as a profile photo.
- GIF, animated images, videos, stickers, and documents are not valid profile photos.
- Maximum original file size is configurable. MVP default: 10 MB.
- Minimum image resolution is configurable. MVP default: 600x600 pixels.
- Corrupt, unreadable, or non-image files must be rejected.
- Duplicate active photos for the same profile should be rejected based on file hash or normalized image hash when available.
- Telegram profile photos are not used as dating profile photos.
- Telegram file IDs may be used only as temporary upload transport references. The system source of truth is the stored `MediaAsset` in object storage.
- The original uploaded image should be retained in object storage unless deletion or retention rules require removal.
- The app server must not be the permanent photo store.

A photo becomes visible only after:

- The original image passes validation.
> **Ambiguous**  
> <span style="font-size: 1.2rem;">Photo upload validation rules or other types of validation? </span>
- The original image is stored in object storage.
- The required photo variants are generated and stored.
- The profile photo record is created successfully.

Required MVP photo variants:

- Thumbnail
- Blurred preview
> **Ambiguous**  
> <span style="font-size: 1.2rem;">What is the point of thumbnail?</span>

> **Ambiguous**  
> <span style="font-size: 1.2rem;">Is there any need to store blurred preview? Does it make sense to store such photo specially if users can delete photos at any time? Also is there any need to store blurred version of each and every photo of a user? Is it not enough to store only the blurred version of primary photo? Blurred preview is only used to tease user to either pay premium to view full liked by page or start sending Nakh, and such blurred photos could be created upon request (and be saved permanently then).</span>


If variant generation fails:

- The upload must not create a visible `ProfilePhoto`.
- The user should be asked to retry the upload.
- Any partially stored media should be cleaned up or marked for cleanup.
- The failed upload must not count toward the active photo limit.

MVP does not include automated NSFW detection, face detection, liveness checks, or identity verification.

Photo moderation is report/admin-based in MVP.

### Restricted Profile Fields

Birth year and gender cannot be changed directly after signup.

User can submit an admin change request for:

- Birth year
- Gender

The request must include a short reason.

Admin can approve or reject the request.

Interested gender can be changed later from:

- Explore filters
- Edit Profile
> **Important Note**  
> <span style="font-size: 1.2rem;">Explore filter is what you choose to see, but not necessarily your preferred gender. Interested gender is what the matching algorithm will be using, but gender filter in explore is simply what you like to see at the moment. These two should not be mistaken. </span>

## 4. Profile Fields

Each dating profile includes:

- Profile ID
- User ID
- Name
- Birth year
- Derived approximate age
- Gender
- Interested gender
- Interests
- Country
- Province
- City
- Relationship goal
- Photos
- Primary photo
- Highlight
- Bio
- Optional profile fields
- Profile completion status
- Created time
- Updated time

Telegram identity, account state, visibility setting, deletion state, and last activity are not profile fields. They belong to identity, account, settings, or user-level records.

Profile completion status values:

- Incomplete
- Complete
- Invalid

A profile can become invalid after completion, for example if moderation hides photos and the visible photo requirement is no longer satisfied.

### Invalid Active Profile

An Invalid profile means the user previously completed signup but the profile later stopped satisfying completion rules.

This can happen, for example, if photo moderation hides or deletes photos and the profile no longer has at least 2 visible photos.

Invalid profile status does not change `Account.state`.

A user with:

- `Account.state = active`
- `Profile.completion_status = invalid`

is still an active account user, but cannot use normal discovery features until the profile is fixed.

The user must be routed to Fix Profile.

Invalid active profile users can:

- Open the app
- Edit Profile
- Upload, replace, or restore required profile data
- Access Settings
- Access Support
- View existing matches and chats, unless another moderation/account rule blocks them

Invalid active profile users cannot:

- Appear in Explore
- Explore others
- Like profiles
- Send Nakh
- Use Liked By discovery actions
- Create new discovery interactions

Once the profile satisfies all completion rules again, set:

`Profile.completion_status = complete`

Normal active-user access then resumes.

### Gender Options for MVP

Gender options:

- Man
- Woman
- Other
- Prefer not to say
> **Disagreement**  
> <span style="font-size: 1.2rem;">There should not be "Prefer not to say"! User could simply use other.</span>

Gender values must be configurable/extensible because more gender options may be added later. For MVP, `Men` shows `Man`, `Women` shows `Woman`, and `Everyone` can show all active visible genders, including `Other` and `Prefer not to say`.

### Interested Gender Options

Interested gender options:

- Men
- Women
- Everyone

### Relationship Goal Options

Relationship goal options:

- Serious relationship
- Casual dating
- Friendship
- Marriage
- Not sure yet

### Location Model

Location is selected through a structured hierarchy:

- Country
- Province / state
- City

MVP supports Iran only.

For MVP:

- Country is Iran.
- Province must be selected from a fixed list.
- City must be selected from a fixed list.
- There is no “Other” city option.
- The data model must support adding other countries, provinces, and cities later.

## 5. Main Menu

For complete active users, main menu includes:

- Explore
- Matches
- Nakhes
- Liked By
- Edit Profile
- Settings

There is no visible Wallet in MVP.

Paid flows appear contextually when the user attempts a paid action.

For active users with Invalid profiles, the normal main menu is replaced by a Fix Profile route.

Invalid profile menu includes:

- Fix Profile
- Edit Profile
- Matches
- Nakhes
- Settings
- Support

Explore and Liked By are hidden or blocked until the profile becomes Complete again.


## 6. Explore

For active complete users, Explore only shows profiles where:

Explore preview shows:

- Primary photo
- Name
- Age
- City
- Highlight

Explore actions:

- Like
- Send Nakh
- Not Interested
- Show More
- Report

Show More opens the full profile.

### Explore Filters

MVP Explore controls:

- Interested gender preference, stored on the profile
- Age range
- City
- Relationship goal

Changing interested gender from Explore filters or Edit Profile updates the same profile-level value.
> **Disagreement**  
> <span style="font-size: 1.2rem;">Nope. Preferred gender should only be changed from edit profile and explore filter simply shows you who you like to see now.</span>

Default age range:

- User age minus 5 to user age plus 5
- Minimum age is always 18

Default location:

- User’s own city

For MVP, Country is fixed to Iran and is not shown as an Explore filter.

Province is used only to group/select cities.

Explore location filtering is city-level.

Province-wide browsing is not included in MVP.

No whole-country filter is included in MVP.

Relationship goal filter is optional.

Interested gender can be changed from Explore filters and from Edit Profile.

Explore filters may later be expanded with:

- Smoking preference
- Children preference
- Personality test results
- Lifestyle preferences
- Other profile attributes

### Explore Selection Rules

Explore only shows profiles where:

- Profile completion status is complete
- User visibility is enabled
> **Ambiguous**  
> <span style="font-size: 1.2rem;">We have not defined visibility up to this point. Is it modifiable by user or set by satisfying the rules?</span>
- Account state is active
- User is not restricted, banned, or deleted
- Profile matches viewer filters
- Profile is gender-compatible with the viewer
- Target has not already been consumed by the viewer

Profile selection rules:

- A profile is consumed and not shown again after preview, Like, Not Interested, Pending Nakh, Sent Nakh, or Match.
- Randomization is applied inside the eligible profile pool.
- If no profile matches, show “Nobody found.”
- These Explore Selection Rules apply to normal Explore for active complete users.
- Guest and Incomplete users do not use normal Explore. They use the Guest Preview Pool defined in Guest Mode.

### Explore Gender Compatibility

Explore gender compatibility is reciprocal.

A target profile is gender-compatible only if both conditions are true:

- The viewer’s interested gender includes the target’s gender.
- The target’s interested gender includes the viewer’s gender.

Gender compatibility must be data-driven and extensible.

> **Important Note**  
> <span style="font-size: 1.2rem;">Having this rule, matching and exploring become the same actions. Matching should follow such rule but I'm not too sure about exploring! Needs further discussion</span>

The implementation must not hardcode gender matching only for Man/Woman.

For MVP:

- Men includes Man.
- Women includes Woman.
- Everyone includes all active visible gender options, including Man, Woman, Other, and Prefer not to say.

Future gender options must be addable by updating configuration or mapping data, not by rewriting Explore logic.

### Not Interested

Not Interested is stored permanently.

A profile marked as Not Interested is not shown again.

### Like

Like is stored permanently.

A liked profile is not shown again.

Users cannot undo, cancel, or withdraw a normal Like in MVP.

The target user receives a notification.

The liker appears in the target user’s Liked By section.

If both users like each other, a match is created.

After a Match, the pair exits discovery actions and cannot Like each other again.

## 7. Liked By

Liked By shows actionable received normal Likes.

Liked By only contains normal Likes.

Nakh senders do not appear in Liked By.

Liked By is not a separate stored card entity.

Liked By is a derived inbox view based on:

- Like
- FeatureUnlock
- Match
- UserPairState
- NotInterested
- Liker account state
- Liker profile completion status

A received Like appears in Liked By only if all of these are true:

- The Like status is `active`.
- No Match exists for the pair.
- UserPairState is not `matched`, `unmatched`, or `blocked`.
- The current user has not marked the liker as Not Interested.
- The liker account state is `active`.
- The liker profile completion status is `complete`.
- The liker is not restricted, banned, or deleted.

Visibility off does not remove an already-sent Like from Liked By.

If a liker turns visibility off after sending a Like, the Like may still appear in the receiver’s Liked By section as long as the liker account is active and the liker profile remains complete.
> **Ambiguous**  
> <span style="font-size: 1.2rem;">If a liker is invisible, how could it be active at the same time?</span>

If the liker becomes restricted, banned, deleted, or profile-invalid, the liker must not appear as an actionable Liked By card.

Unpaid view:

- Show the count of actionable received Likes.
- Show locked liked-by cards.
- Show blurred preview image.
- Do not show full profile.
- Do not show profile details.

Liked By count includes only actionable received Likes.

Liked By count does not include:

- Nakh senders
- matched users
- unmatched users
- blocked users
- users marked as Not Interested by the receiver
- restricted users
- banned users
- deleted users
- profile-invalid users
- closed Likes

Unlock rules:

- Each liked-by profile is unlocked separately.
- Unlock is paid using Telegram Stars/credits.
- Unlocking one liked-by profile does not unlock other liked-by profiles.
- Unlocking creates a `FeatureUnlock` with type `liked_by_profile_unlock`.
- After unlocking a liked-by profile, the user can view the full profile while the unlock is active.
- Liked By profile unlock has an expiry time.
- Exact expiry duration is configurable.
- After unlocking, user can Like Back or mark as Not Interested.

Unlock expiry rules:

- When a Liked By profile unlock expires, full profile access is removed.
- If the original Like is still actionable, the card returns to locked state.
- The user may unlock the same liked-by profile again.
- Expired unlock does not remove the Like.
- Expired unlock does not remove the card from the Liked By count.
- No refund is given when an unlock expires.
> **Ambiguous**  
> <span style="font-size: 1.2rem;">Why should there be an expiry? Is there really any need to have this feature or is it simply cash grab?</span>

Like Back rules:

- If user Likes Back from Liked By, a Match is created.
- The original received Like is closed with status `closed_by_match`.
> **Ambiguous**  
> <span style="font-size: 1.2rem;">Why should a like have status?</span>
- The pair moves to Matches.
- The liked-by card is removed from normal Liked By.
- The FeatureUnlock remains only as payment/audit history.

Not Interested rules from Liked By:

- If user marks an unlocked Liked By profile as Not Interested, create a NotInterested record with source `liked_by`.
- The liked-by card is closed and not shown again.
- The target user is not notified.
- Any existing FeatureUnlock remains only as payment/audit history.

Unmatch rules:

- If users later unmatch, old Likes must not return to Liked By.
- Relevant Like records are closed with status `closed_by_unmatch`.
- UserPairState becomes `unmatched`.
- The pair must not appear again in Liked By, Explore, Nakh, or Match flows.
- Existing FeatureUnlock records remain only as payment/audit history.

Like cancellation:

- There is no user-facing Unlike or Like cancellation in MVP.
- `LikeStatus.cancelled` is reserved only for admin/system correction if kept in implementation.
- Normal users cannot cancel a Like in MVP.

Liked By unlock cost:

- Unlock one liked-by profile: 4 credits

## 8. Nakh

Nakh means “نخ دادن”: a stronger paid signal where the sender sends an opening text plus their profile.

Nakh is sent from Explore.

Nakh rules:

- Nakh is a paid stronger signal sent from Explore with an opening text.
- Nakh is separate from normal Like.
- Nakh does not create a normal Like automatically.
- Sent Nakh appears in the receiver’s Nakhes section, not in Liked By.
- Pending Nakh is visible only to the sender.
- Pending Nakh does not notify the receiver.
- Pending Nakh does not appear in Liked By or receiver’s Nakhes.
- Pending Nakh consumes the target profile.
- Only one Nakh flow is allowed per sender/receiver pair.
- A Nakh flow starts when either a Pending Nakh is created or a Sent Nakh is created directly using existing credits.
- After a Nakh flow exists for a sender/receiver pair, the sender cannot create another Pending Nakh or Sent Nakh for the same receiver.
- This rule applies even if the Pending Nakh later expires, is abandoned, is cancelled, or has failed/cancelled payment.
- This rule also applies if the Sent Nakh is rejected, accepted, closed, or expired.
- Nakh text max length is 240 characters.
- Sent Nakh expires after 14 days.
- If rejected, sender cannot send another Nakh to the same target.
- If rejected, internal Nakh status is `rejected`.
- UI should show rejected Nakh as Closed.
- Internal `closed` status is reserved for generic non-rejection closure cases.

### Nakh Payment Flow

When a user chooses to send Nakh from Explore:

* If the user chooses to spend credits and has enough credits, the system spends credits and creates a paid Sent Nakh immediately.
* If the user chooses direct Telegram Stars payment, the system creates or uses a PendingPayment for `send_nakh` until Telegram confirms payment.
* If the user does not have enough credits and chooses to continue, the system creates a Pending Nakh and a related PendingPayment for `send_nakh`.
* Pending Nakh is an unpaid Nakh attempt, not a delivered Nakh.
* Pending Nakh is visible only to the sender.
* Pending Nakh does not notify the receiver.
* Pending Nakh does not appear in the receiver’s Nakhes.
* Pending Nakh does not appear in Liked By.
* Pending Nakh does not create a Match.
* Pending Nakh can be paid later.
* Pending Nakh text can be edited before payment.
* Spending existing credits and paying Telegram Stars directly must both result in the same final Sent Nakh behavior.
* When payment succeeds, the Pending Nakh becomes paid and the system creates the delivered Sent Nakh.
* The target profile is consumed when Pending Nakh is created or Sent Nakh is sent.
* Creating a Pending Nakh permanently consumes the sender’s one allowed Nakh flow for that receiver.
* If the Pending Nakh expires, is abandoned, is cancelled, or payment fails/cancels, the sender still cannot create another Nakh flow for the same receiver.
* The target profile is not shown again, even if payment is completed later.

Visibility-off users cannot create a new Pending Nakh or new Sent Nakh.

A sender whose visibility is off may complete payment for a Pending Nakh that was created before the sender turned visibility off.

A receiver whose visibility is off may still receive a Sent Nakh if the Pending Nakh was created before the receiver turned visibility off.

Completing an existing Pending Nakh payment while either side has visibility off is allowed because the Nakh attempt was initiated while the receiver was visible in Explore.
> **Ambiguous**  
> <span style="font-size: 1.2rem;">What if a user decides to send Nakh to one of his liked by users? And what if strangly enough the liker is invisible?</span>

Visibility off blocks new discovery and new Nakh creation only. It does not block already-created Pending Nakh payment completion.

This exception applies only to visibility off.

Nakh pricing:

- Send Nakh credit cost: 2 credits.
- Send Nakh direct Telegram Stars price is configurable.
- Direct Telegram Stars payment for Nakh does not create a FeatureUnlock.

Pending Nakh payment cannot be completed or delivered if the sender becomes restricted, banned, or deleted before payment succeeds.

Pending Nakh payment also cannot be delivered if the receiver becomes restricted, banned, deleted, or profile-invalid before payment succeeds.

In those cases, the Pending Nakh should be blocked, cancelled, expired, or refunded depending on payment state.

### Pending Nakh Cancellation

If the sender cancels unpaid Pending Nakh, they must choose either:

- Convert it to a normal Like
- Mark the target as Not Interested

If converted to Like, the receiver is notified and the sender appears in Liked By.

If converted to Not Interested, the receiver is not notified and the target remains consumed.
Cancellation does not restore the sender’s ability to send Nakh to the same receiver later.

Unpaid Pending Nakh should expire. Exact expiry duration and reminder schedule are configurable/open decisions.

### Nakh Receiver Actions

Nakh receiver actions:

* View profile
* Accept Nakh
* Reject
* Report

### Nakh Statuses

Pending Nakh and Sent Nakh use separate status groups because they have different product meanings.

Pending Nakh statuses:

- Pending Payment
- Paid and Sent
- Cancelled
- Expired
- Abandoned

Sent Nakh statuses:

- Sent
- Seen
- Accepted
- Rejected
- Closed
- Expired

Pending Payment is not a Sent Nakh status.

Receiver rejection must be stored internally as `rejected`.

UI should show rejected Nakh as “Closed.”

The internal `closed` status is reserved for generic non-rejection closure cases, such as admin/moderation/system closure.

### Nakhes Menu

Nakhes menu shows:

- Sent Nakhes
- Received Nakhes
- Current Sent Nakh status
- Sender-side Pending Nakh payments
- Expired Nakhes
- Closed Nakhes

Pending Nakh payments are visible only to the sender and are not shown in the receiver’s Nakhes.

## 9. Matches

A match is created when:

- Both users like each other.
- A paid Sent Nakh can create a Match only if the receiver accepts the Nakh.

When a match happens:

- Both users receive notification.
- Internal bot relay chat is created.
- Users can unmatch.
- After Match, the pair exits discovery actions. They cannot Like, send Nakh, mark Not Interested, or appear to each other in Explore again.

### Unmatch Rules

Unmatch rules:

- Chat closes visually for both users.
- Both users should not match again.
- Unmatch acts like rejection.
- The other side receives a chat closed message.
- After unmatch, either user can still report the other person for 24 hours.
- Last 50 messages may be retained internally for moderation and report review.

## 10. Chat

Chat is internal bot relay chat, not native Telegram DM.

Free matched users:

- Cannot type freely.
- Can only choose predefined questions.
- Can only choose predefined answers.
- Cannot send photos.
- Cannot send stickers.
- Cannot send emojis.
- Cannot send custom text.

### Chat Unlock

Chat unlock is paid per Match.

One successful chat unlock payment unlocks free-text chat for both users in that specific Match.

If either matched user unlocks chat, both users can type freely in that Match.

The other matched user does not need to pay again for the same Match.

The user who pays is recorded as the unlock payer.

Chat unlock access is granted to the Match, not only to the payer.

After unlock, both matched users can send free-text messages in that Match.

Chat unlock does not expire in MVP.

Chat unlock rules:

- Only text messages are allowed.
- No photo messages.
- Only the last 50 visible messages per chat remain available in normal chat view. Reported messages must be snapshotted before cleanup when needed for moderation.
- After unlock, users can share phone number, Telegram ID, or other contact info.
- Show one safety warning when chat unlocks.
- Chat unlock remains active until the Match is unmatched, closed by admin/moderation, or closed because of account deletion or ban.

Chat unlock cost:

- Unlock one match chat: 4 credits

### Predefined Chat

Predefined chat includes 10 default question sets.

Each question has predefined answers.

Questions and answers must be data-driven, not hardcoded in chat logic.

Admins/developers must be able to add, remove, or edit predefined questions and answers later.

Default question topics:

1. What are you looking for here?
2. Ideal first date
3. Chat frequency
4. Introvert/extrovert
5. Weekend habits
6. Calls or texting
7. Important values
8. Meeting in person
9. Relationship pace
10. Current life focus

## 11. Payments and Credits

Payment provider:

- Telegram Stars

Visible Wallet:

- Not shown in main menu for MVP.

Backend still needs:

- Credit balance
- Credit transactions
- Telegram Stars payment records
- Feature unlock records
- Pending payment records

Paid actions:

- Send Nakh
- Unlock chat for one match
- Unlock one liked-by profile

Paid actions can be completed either by spending existing internal credits or through direct Telegram Stars payment. Both payment paths must be idempotent and must not create duplicate credits, unlocks, Nakh delivery, or notifications.

FeatureUnlock is used for Liked By unlock and Chat unlock. Nakh is a paid action, not a persistent feature unlock.

For Chat unlock, FeatureUnlock records the payer and the unlocked Match.

The payer is not the only beneficiary. Both users in the Match receive unlocked chat access.

MVP credit costs:

- Send Nakh: 2 credits
- Unlock one match chat: 4 credits
- Unlock one liked-by profile: 4 credits

These MVP costs are product defaults.

Implementation must load paid-action costs from SystemConfig or code-level configuration, not hardcode them inside bot handlers, payment handlers, or feature services.


Direct Telegram Stars prices:

- Direct Stars price for Send Nakh is configurable.
- Direct Stars price for unlocking one match chat is configurable.
- Direct Stars price for unlocking one Liked By profile is configurable.
- Direct Stars prices do not have to equal credit costs.

Credit packages:

- User can buy credit packages using Telegram Stars.
- Credit packages add internal app credits to the user credit balance.
- Credit packages may include discounts compared with paying Stars directly for each action.
- Exact package sizes, Stars prices, and discount rules are not finalized in MVP specification.

When user attempts a paid action, bot shows a contextual purchase/unlock screen.

## 12. Visibility

Visibility can be turned on/off in Settings.

Visibility is user-controlled and separate from account state and profile completion status.

Visibility off:

- User does not appear in Explore.
- User cannot Explore others.
- User cannot Like.
- User cannot send Nakh.
- Existing matches and chats continue.
- Existing sent Nakh flows continue.
- Existing pending payment Nakhes remain available for payment.

## 13. Reporting

Users can report others.

There is no user-facing Block action in MVP.

If a user has a safety issue, they should use Report.

Admins review reports and decide whether to restrict, ban, dismiss, or take another supported moderation action.

Report reasons:

- Fake profile
- Harassment
- Inappropriate photo
- Spam or scam
- Under 18
- Offensive behavior
- Other

Reports can include optional extra text.

Users can report:

- Profile
- Photo
- Chat/message context when available
- Unmatched user within 24 hours after unmatch

Report handling:

- Every report goes to admin review.
- One report alone does not automatically restrict or ban a user.
- If a target user receives reports from 5 or more unique reporters within a rolling 30-day window, and those reports are still unresolved, the target user is automatically restricted until admin review.
- Report threshold counting is user-level, not evidence-level.
- Profile reports, photo reports, chat/message reports, and unmatched-user reports all count toward the same target-user threshold.
- Multiple reports from the same reporter against the same target user count as 1 reporter for threshold purposes.
- Only unresolved reports count toward the automatic restriction threshold.
- Unresolved report statuses are `submitted` and `pending_review`.
- Reports with status `dismissed`, `closed`, or `actioned` do not count toward triggering a new automatic restriction.
- If admin dismisses reports, those reports stop counting toward the automatic restriction threshold.
- If admin action is taken, the handled reports stop counting toward a new automatic restriction.
- Automatic restriction does not automatically ban the user. Ban requires admin decision.
- Admin decides the final action: dismiss and unrestrict, keep restricted, ban, or take another moderation action.
- Reports involving chat/message evidence should create snapshots so evidence is not lost after edits or message cleanup.

## 14. Restricted, Banned, Deleted

### Restricted User

Restricted user can:

- Open app
- Edit profile
- Read existing chats
- Contact support/admin

Restricted user cannot:

- Appear in Explore
- Explore others
- Like
- Send Nakh
- Send chat messages

### Banned User

Banned user:

- Cannot use the app normally.
- Cannot open normal Support.
- Can submit one limited ban appeal per ban event.
- The ban appeal is stored as `UserAppeal`, not as `SupportThread` or `SupportMessage`.
- If an appeal for the current ban event already exists, the user can only see the appeal status.
- If the appeal is accepted, admin may unban the user.
- If the appeal is rejected, the user remains banned and cannot submit another appeal for the same ban event.

### Account Deletion

User can delete account.

After account deletion:

- Profile becomes hidden.
- Chats close.
- Account enters `deleted` state.
- Minimal audit, report, payment, moderation, and safety records are retained.
- The same Telegram account remains attached to the same internal User.
- Deletion does not clear reports, restrictions, bans, payment history, safety history, or audit history.
- A deleted user may later reactivate the same account if reactivation is allowed.
- Reactivation rebuilds the existing dating profile under the same User; it does not create a clean new User or erase retained history.

## 15. Admin Moderation

MVP admin should be Telegram admin commands, not a web panel.

Admin can:

- View reports
- View user profile
- Ban user
- Unban user
- Restrict user
- Unrestrict user
- Hide photo
- Restore photo
- Delete photo
- Dismiss report
- Review birth year change requests
- Review gender change requests
- Review support threads
- Review ban appeals

Photos are not pre-approved.

Photos become visible immediately after upload.

Users can report photos.

Admin can hide, restore, or delete profile photos.

Admin photo deletion is soft deletion from the dating profile. It sets the profile photo status to `deleted`, removes the photo from user-visible profile surfaces, and excludes it from active photo limits and profile completion.

Admin photo deletion must not immediately hard-delete the underlying media asset. The media/audit record may be retained for moderation, reports, appeals, abuse prevention, and safety history.

For severe violations, admin can also restrict or ban the user separately from the photo action.

Admins should see chat messages only if:

- A report is submitted
- Chat review is needed for moderation

For reported chats, freeze a snapshot of recent messages.

## 16. Notifications

Notification center keeps history with read/unread status.

Notification types:

- Like received
- Nakh received
- Match created
- New chat message
- Chat unlocked
- Liked-by profile unlocked
- Report result
- Restriction/ban warning
- Payment success/failure
- Pending Nakh payment reminder

Important notifications are also sent as Telegram messages.

Users can mute normal notifications.

Users cannot mute:

- Safety notices
- Payment notices
- Admin notices
- Ban notices
- Restriction notices

> **Ambiguous**  
> <span style="font-size: 1.2rem;">How do notifications work? Are they real-time?</span>

## 17. Settings

Settings includes:

- Visibility on/off
- Notification settings
- Edit Profile
- Delete account
- Support
- Language later

Support:

- Non-banned users can send messages to admin/support through `SupportThread`.
- Support should be rate-limited.
- Banned users cannot use normal Support.
- Banned users can only submit a ban appeal through `UserAppeal`.

## 18. Start Behavior

When user sends `/start`:

If new Telegram user:

- Show Guest / Sign Up

If incomplete profile:

- Show Continue Signup / Browse as Guest

If complete active user:

- Show main menu

If restricted:

- Show restricted menu

If banned:

- Show ban appeal screen.
- If no `UserAppeal` exists for the current ban event, allow one appeal submission.
- If a `UserAppeal` already exists for the current ban event, show appeal status only.
- Do not show normal Support.

If deleted:

- If `AccountDeletionRecord.reactivation_allowed = true`, show account reactivation flow.
- If reactivation is not allowed, show deleted-account support/appeal message.
- Reactivation uses the same internal User, same TelegramIdentity, same Account, and existing Profile record.
- Retained report, moderation, payment, safety, and audit history must still apply after reactivation.

## 19. Product Tone

MVP is English only.

Tone should be casual and light, but not cringe.

Future Persian version can be funnier and more local.

UI text must be configurable for future localization.

## 20. Open Decisions

The following decisions must be finalized before implementation or before production launch, depending on scope:

- Interest seed list
- Iran province/city seed list
- Optional profile field enum/config values
- Name max length
- Change request reason max length
- Pending Nakh expiry duration
- Pending Nakh reminder schedule
- Liked By unlock expiry duration
- Credit package sizes
- Telegram Stars pricing
- Refund policy
- Storage/CDN provider
- Admin Telegram IDs

After these decisions are finalized, tunable product values must be stored in SystemConfig or code-level configuration.

README is not the source of truth for config keys.

SystemConfig is the source of truth for MVP product constants that may change after launch.
