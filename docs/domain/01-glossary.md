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

Guest users can only preview limited profiles.

The guest preview limit is permanent and tied to the Telegram identity/user.

### Incomplete User

A user who started signup but has not completed all required profile fields.

Incomplete users follow the same preview limit as guests.

Incomplete users share the same GuestPreviewCounter created during Guest mode.

Starting signup does not reset the preview counter.

### Active User

A user with a completed profile and normal product access.

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

### Visibility

A user-controlled setting stored as `UserSettings.visibility_enabled`.

If visibility is off, the user cannot appear in Explore and cannot Explore, Like, or send Nakh.

Existing matches, chats, and pending Nakh payments continue.

Visibility off is not the same as restricted, banned, deleted, or photo hidden.

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
* At most 6 uploaded profile photos
* One visible primary photo
* Highlight

A profile can become `invalid` after it was previously complete, for example if moderation hides photos and fewer than 2 visible photos remain.

### Birth Year

The Gregorian year entered by the user during signup.

Exact birth date is not collected.

Age is derived from Gregorian birth year.

Displayed age is approximate because exact birth date is not collected.

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

The discovery flow where a user sees one eligible profile at a time.

### Explore Filter

User-selected criteria for Explore.

Includes:

* Age range
* Country
* Province
* City
* Relationship goal

Interested gender is stored on the profile, not as a separate temporary filter.

### Eligible Profile

A profile that can appear in Explore.

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

Pending Nakh is visible only to the sender.

Pending Nakh does not:

* Notify the receiver
* Create a normal Like
* Appear in Liked By
* Create a Match

If cancelled before payment, the sender must choose whether to convert it to a normal Like or mark the target as Not Interested.

### Sent Nakh

A Nakh that has been paid for and delivered to the receiver.

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

Internal unit used to pay for paid features.

Paid features include:

* Send Nakh
* Unlock one match chat
* Unlock one liked-by profile

### Telegram Stars

The payment provider used in MVP.

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

### Localization

System for configurable UI text.

MVP uses English, but future Persian and other languages should be supported.

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
