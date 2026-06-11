# Domain Glossary

This file defines the core product terms used in the Telegram Dating Bot MVP.

The goal is to keep product language consistent before database design and coding.

## 1. Identity and Account Terms

### User

A person known to the system through Telegram.

The system uses an internal user ID as the main identifier.

### Telegram Identity

The external Telegram identity attached to a user.

Includes:

* Telegram user ID
* Telegram username

Telegram user ID is stable. Telegram username is optional and mutable.

### Account

The access and lifecycle layer of a user.

Controls whether the user can use the product normally, partially, or not at all.

### Guest

A Telegram user who has not completed signup.

A Guest is persistent, not anonymous.

On first `/start`, the system creates a User, TelegramIdentity, Account, UserSettings, and GuestPreviewCounter.

Guest users can only preview limited teaser profiles from the Guest Preview Pool.

The guest preview limit is permanent and tied to the Telegram identity/user.

Guest Preview is not normal Explore.

Guest Preview does not use Explore filters, reciprocal gender compatibility, viewer age, viewer city, viewer interested gender, or viewer relationship goal.

### Incomplete User

A user who started signup but has not completed all required profile fields.

Incomplete users follow the same preview limit as guests.

Incomplete users share the same GuestPreviewCounter created during Guest mode.

Starting signup does not reset the preview counter.

Incomplete users use the same Guest Preview Pool as guests.

Partial SignupDraft values are not used to filter Guest Preview.

### Active User

A user whose account state is `active`.

Normal product access requires both:

* `Account.state = active`
* `Profile.completion_status = complete`

An active user may temporarily lose normal discovery access if their profile becomes `invalid`.

In that case, the account remains active, but the user is routed to Fix Profile until profile completion status becomes `complete` again.

### Restricted User

A user limited by moderation.

Restricted users can:

* Open the app
* Edit profile
* Read existing chats
* Contact support

Restricted users cannot:

* Explore
* Like
* Send Nakh
* Send chat messages

### Banned User

A user blocked from using the app.

A banned user can only send one limited appeal/support message.

### Deleted User

A user who deleted the account.

The profile becomes hidden, chats close, and minimal audit, payment, report, and safety records remain.

A deleted user is still the same internal User.

The same Telegram account must not create a clean new User to bypass previous reports, restrictions, bans, payments, safety records, moderation records, or audit history.

If reactivation is allowed, the user reactivates the same account and rebuilds the existing dating profile under the same User.

### Visibility

A user-controlled setting stored as `UserSettings.visibility_enabled`.

If visibility is off, the user cannot appear in Explore and cannot Explore, Like, or send Nakh.

Existing matches, chats, sent Nakh flows, and pending Nakh payments continue.

Visibility off blocks creation of new Pending Nakh or Sent Nakh.

Visibility off does not block completion of Pending Nakh payments that were created before visibility was turned off.

If a receiver turns visibility off after a Pending Nakh was created, the receiver can still receive and view the delivered Sent Nakh after payment succeeds.

Visibility off only blocks new discovery and new Nakh creation.

This exception does not apply to restricted, banned, deleted, or profile-invalid accounts.

Visibility off is not the same as restricted, banned, deleted, or photo hidden.

### UI Language

The language used for bot interface text.

UI language controls:

* Button labels
* Bot messages
* Error texts
* Admin texts
* Payment texts
* Notification texts
* Safety texts

MVP UI language is English.

Persian and other UI languages may be added later through localization records.

UI language is stored as `UserSettings.language_code`.

UI language is not the same as profile spoken languages.

## 2. Profile Terms

### Profile

The dating-visible information of a user.

Includes:

* Name
* Birth year
* Gender
* Interested gender
* Interests
* Location
* Relationship goal
* Photos
* Highlight
* Bio
* Optional details

### Profile Completion

The current validity/completion state of a dating profile.

Profile completion status can be:

* `incomplete`
* `complete`
* `invalid`

Required profile data for a complete profile includes:

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

Saved profile photos are photos currently stored for the profile as visible or hidden profile photos.

Hidden photos count toward the 6-photo saved-photo limit, but do not count toward profile completion.

Only visible photos count toward the 2-photo completion requirement.

When a user deletes a profile photo, the photo is removed from the profile and the stored media object must be permanently deleted from object storage/CDN.

A deleted photo no longer counts as a saved profile photo after its stored media object is deleted.

If the photo is linked to an active report, moderation case, safety case, legal/audit case, or immutable report snapshot, the user-facing photo is removed immediately, but the evidence copy may be retained in restricted moderation/audit storage until retention rules allow deletion.

A profile can become `invalid` after it was previously complete, for example if moderation hides photos and fewer than 2 visible photos remain.


### Invalid Active Profile

An invalid active profile is a profile that was previously complete but later stopped satisfying required profile rules.

The account remains active.

This state is represented as:

* `Account.state = active`
* `Profile.completion_status = invalid`

The user is not treated as Guest or Incomplete.

The user must fix the profile before using discovery features again.

Invalid active profile users cannot Explore, appear in Explore, Like, send Nakh, or create new discovery interactions.

They can still edit/fix the profile and access existing matches or chats unless another account or moderation rule blocks them.


### Birth Year

The Gregorian year entered by the user during signup.

Exact birth date is not collected.

Age is derived from Gregorian birth year.

Displayed age is approximate because exact birth date is not collected.

MVP age eligibility is approximate.

A user is eligible if:

`birth_year <= current_gregorian_year - 18`

The system cannot verify exact 18+ status because exact birth date is not collected.

### Gender

The user’s own gender.

MVP options:

* Man
* Woman
* Other
* Prefer not to say

### Interested Gender

The gender preference used for matching and Explore.

MVP options:

* Men
* Women
* Everyone

This is one profile-level field. Changing it from Explore filters or Edit Profile updates the same value.

### Gender Compatibility

Gender compatibility is used by Explore and matching-related discovery flows.

Gender compatibility is reciprocal.

A target profile is gender-compatible with a viewer only if:

* The viewer’s interested gender includes the target’s gender.
* The target’s interested gender includes the viewer’s gender.

Interested gender should be treated as a configurable preference mapping to one or more gender options.

For MVP:

* Men includes Man.
* Women includes Woman.
* Everyone includes all active visible gender options, including Man, Woman, Other, and Prefer not to say.

Future gender options must be addable without rewriting Explore logic.

### Interest

A selectable dating profile tag.

Interests belong to the dating profile, not directly to the user.

A complete profile must have at least 5 interests.

A profile can have at most 20 interests.

### Relationship Goal

The user’s dating goal.

MVP options:

* Serious relationship
* Casual dating
* Friendship
* Marriage
* Not sure yet

### Highlight

Required short profile text.

Maximum length: 80 characters.

### Bio

Optional longer profile text.

Maximum length: 500 characters.

### Optional Profile Details

Extra profile data that can be skipped.

Includes:

* Height
* Job title
* Education
* Smoking preference
* Pets
* Languages
* Exercise/gym
* Religion importance
* Children preference
* Personality tags

### Profile Spoken Language

A language the user can speak and display on their dating profile.

Profile spoken languages are selectable profile options.

They belong to the dating profile, not directly to the user account.

Profile spoken languages must be selected from supported `Language` records.

Profile spoken languages must not be stored as free text.

Profile spoken languages are not the same as UI language.

### Locked Profile Fields

Profile fields that cannot be changed directly after signup.

Locked fields:

* Birth year
* Gender

Users can submit an admin-reviewed change request for these fields.

## 3. Location Terms

### Location

Structured user location.

The hierarchy is:

* Country
* Province
* City

### Country

Top-level location.

MVP supports Iran only.

### Province

Fixed selectable subdivision under country.

### City

Fixed selectable city under province.

There is no free-text city and no “Other” city option in MVP.

## 4. Discovery and Interaction Terms

### Explore

The normal discovery flow where an active complete user sees one eligible profile at a time.

Guest Preview is separate from normal Explore.

### Explore Filter

User-selected criteria for Explore.

Includes:

* Age range
* City
* Relationship goal

For MVP, Country is fixed to Iran and is not shown as an Explore filter.

Province is used only to group/select cities.

Explore location filtering is city-level.

Province-wide browsing and whole-country browsing are not included in MVP.

Interested gender is stored on the profile, not as a separate temporary filter.

### Guest Preview

The limited teaser preview mode for Guest and Incomplete users.

Guest Preview shows real complete active visible profiles, but it does not use normal Explore filters or reciprocal gender compatibility.

Guest Preview uses a simple eligible teaser pool.

A profile can appear in Guest Preview only if:

* Profile completion status is `complete`
* Target user visibility is enabled
* Target account state is `active`
* Target user is not restricted, banned, or deleted
* Target profile belongs to Iran for MVP
* Target has a visible primary photo
* Target has not already been consumed by the viewer

Each shown Guest Preview counts against the permanent GuestPreviewCounter.

### Eligible Profile

A profile that can appear in normal Explore for an active complete user.

A profile is eligible only if:

* Profile completion status is `complete`
* User visibility is enabled
* Account state is `active`
* User is not restricted, banned, or deleted
* Profile is compatible with the viewer’s filters
* Profile is reciprocally gender-compatible with the viewer
* Target has not previously been consumed by the viewer

### Profile Preview

The short profile card shown in Guest mode or Explore.

Includes:

* Primary photo
* Name
* Age
* City
* Highlight

### Full Profile

The expanded profile view shown after “Show More” or after paid/unlocked access.

### Profile Consumption

A permanent record that a viewer has seen or acted on a target profile.

Consumed profiles are not shown again.

Consumption can happen through:

* Preview
* Like
* Not Interested
* Pending Nakh
* Sent Nakh
* Match

### Like

A free weak signal from one user to another.

A normal Like appears in the receiver’s Liked By section.

### Liked By

The section showing users who sent normal Likes to the current user.

Nakh senders do not appear in Liked By.

### Liked By Unlock

A paid unlock that lets the receiver view one specific liked-by profile fully.

Unlocking one liked-by profile does not unlock other liked-by profiles.

Liked By unlock expires according to configured unlock duration.

### Not Interested

A permanent negative action from one user toward another.

The target should not appear again.

## 5. Nakh, Match, and Chat Terms

### Nakh

A paid stronger signal sent from Explore with an opening text.

A sent Nakh appears in the receiver’s Nakhes section, not in Liked By.

### Pending Nakh

An unpaid Nakh attempt.
A Pending Nakh is the start of the sender’s single allowed Nakh flow for that receiver.

Pending Nakh is visible only to the sender.

Pending Nakh does not:

* Notify the receiver
* Create a normal Like
* Appear in Liked By
* Create a Match

If cancelled before payment, the sender must choose whether to convert it to a normal Like or mark the target as Not Interested.
Cancelled, expired, abandoned, failed-payment, or cancelled-payment Pending Nakh records still consume the sender’s one allowed Nakh flow for that receiver.

### Sent Nakh

A Nakh that has been paid for and delivered to the receiver.
A Sent Nakh may be created directly from credits or by converting an existing Pending Nakh after payment succeeds.

The receiver sees it in Nakhes.

### Nakhes

The section where users see Nakh-related records.

Includes:

* Sent Nakhes
* Received Nakhes
* Pending payment Nakhes
* Expired Nakhes
* Closed Nakhes

### Nakh Receiver Action

The action taken by the receiver of a sent Nakh.

Possible actions:

* View profile
* Accept Nakh
* Reject
* Report

### Match

A relationship state between two users.

A Match can be created by:

* Mutual normal Like
* Accepted Nakh

### Unmatch

An action that closes the match and chat.

After unmatch:

* The chat closes visually
* The users should not match again
* Either user can report the other for 24 hours

### Chat

Internal bot relay chat created after a Match.

It is not native Telegram direct messaging.

### Predefined Chat

The free chat mode.

Users can only choose predefined questions and predefined answers.

### Chat Unlock

A paid per-Match unlock.

One successful chat unlock payment unlocks free-text chat for both users in that specific Match.

If one side unlocks chat, both users can send free text in that Match.

The other matched user does not need to pay again for the same Match.

Chat unlock does not expire in MVP.

Chat unlock remains active until the Match is unmatched, closed by admin/moderation, or closed because of account deletion or ban.

Only text messages are allowed.

### Chat Safety Warning

A one-time warning shown when chat unlocks.

After unlock, users may share phone numbers, Telegram IDs, or other contact information.

## 6. Payment Terms

### Credit

Internal app unit used to pay for paid actions.

Paid actions include:

* Send Nakh
* Unlock one match chat
* Unlock one liked-by profile

Credits are different from Telegram Stars.

Users can buy credit packages with Telegram Stars, then spend credits inside the app.

### Telegram Stars

The payment provider used in MVP.

Telegram Stars can be used in two ways:

* Direct payment for one paid action
* Purchase of an internal credit package

Direct Telegram Stars prices and internal credit costs are separate product settings.

### Credit Balance

The user’s current available credits.

### Credit Transaction

A record of every credit change.

Examples:

* Purchase
* Spend on Nakh
* Spend on chat unlock
* Spend on liked-by unlock
* Refund
* Admin adjustment

### Credit Package

A purchasable bundle of credits.

Exact package sizes and discount rules are not finalized yet.

### Pending Payment

An unpaid payment required to complete an action.

Examples:

* Pending Nakh payment
* Pending chat unlock
* Pending liked-by unlock
* Credit package purchase

### Feature Unlock

A paid access record for one scoped feature.

Examples:

* One liked-by profile unlock
* One match chat unlock

FeatureUnlock is not used for Nakh.

Nakh is a paid action that creates a sent interaction, not persistent feature access.

### Payment Record

Internal record of a payment attempt and result.

### Payment Provider Event

Raw Telegram Stars payment callback/event.

Used for audit and idempotency.

### Idempotency

The rule that the same payment callback must not be processed twice.

Duplicate payment callbacks must not create duplicate credits, duplicate unlocks, or duplicate notifications.

## 7. Moderation, Admin, and Support Terms

### Report

A complaint submitted by a user.

A report may target:

* Profile
* Photo
* Chat/message context
* Recently unmatched user

### Report Reason

The selected reason for a report.

Default reasons:

* Fake profile
* Harassment
* Inappropriate photo
* Spam or scam
* Under 18
* Offensive behavior
* Other

### Report Evidence

Context attached to a report.

Examples:

* Profile
* Photo
* Chat
* Message
* Unmatched user

### Report Snapshot

Frozen copy of reported context at report time.

Used so evidence is not lost after edits or chat cleanup.

### Moderation Review

Admin review process for reports or safety cases.

### Moderation Action

Action taken by admin or moderation logic.

Examples:

* Restrict user
* Unrestrict user
* Ban user
* Unban user
* Hide photo
* Restore photo
* Delete photo
* Dismiss report

### Admin User

A Telegram user allowed to use admin commands.

### Admin Role

A role assigned to an admin user.

Examples:

* Super admin
* Moderator
* Support

### Admin Permission

A specific permission granted through an admin role.

Examples:

* View reports
* Restrict user
* Ban user
* Hide photo
* Restore photo
* Delete photo
* Review support

### Admin Action Log

Trace of admin actions.

Every admin action must be logged.

### Support Thread

A support conversation between a user and support/admin.

### Support Message

An individual message inside a support thread.

Support messages must be rate-limited.

### Appeal

A limited message/action available to banned users.

## 8. Media, Localization, Jobs, and Audit Terms

### Media Asset

Stored uploaded file metadata.

Usually represents a user photo stored in object storage.

User-deleted media assets must be permanently deleted from object storage/CDN unless they must be retained as restricted moderation, safety, legal, audit, or report evidence.

### Profile Photo

A media asset attached to a dating profile.

### Primary Photo

The main visible photo of a profile.

Every complete profile must have one primary photo.

### Additional Photo

A non-primary profile photo.

### Photo Variant

A generated version of a photo.

Examples:

* Thumbnail
* Blurred preview

### Blurred Preview

Blurred image shown in locked Liked By cards.

### Object Storage

External storage for uploaded photos.

The app server should not be the permanent image store.

### CDN URL

Public delivery URL used to serve media efficiently.

### Hidden Photo

A photo hidden by moderation/admin.

Hidden photos should not appear to users.

### Deleted Profile Photo

A profile photo removed from the user-visible dating profile.

Deleted profile photos do not count toward profile completion.

Deleted profile photos do not count toward the active profile photo limit.

Admin deletion of a profile photo is soft deletion from the dating profile, not immediate physical deletion of the underlying media asset.

Deleted photo records and media metadata may be retained for audit, moderation, reports, appeals, abuse prevention, and safety history.

### Localization

System for configurable UI text.

MVP uses English UI text.

Persian and other UI languages should be supported later by adding localization records.

Localization is used for user-facing bot text, not for profile spoken-language selection.

### UI Text Key

Stable key used by code to load user-facing text.

Examples:

* Button labels
* Bot messages
* Error texts
* Admin messages
* Payment messages

### Background Job

Scheduled or async task.

Examples:

* Expire Nakh
* Expire pending payment
* Send pending payment reminder
* Cleanup chat messages
* Retry notification delivery

### Audit Log

Permanent trace of important actions.

Used for account, profile, payment, moderation, safety, and admin events.

### Data Retention Record

Record of minimal data retained after account deletion.
