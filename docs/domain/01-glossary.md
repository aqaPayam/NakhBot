# Glossary

This file defines the core product terms used in the Telegram Dating Bot MVP.

## Identity and Account

### User

A person known to the system through Telegram.

The system uses an internal user ID as the primary identifier.

### Telegram Identity

The external Telegram identity attached to a user.

Includes:

* Telegram user ID
* Telegram username

Telegram username is optional and can change.

### Account

The access and lifecycle layer of a user.

Controls whether the user can use the app normally, partially, or not at all.

### Guest

A Telegram user who has not completed signup.

A guest can only preview limited profiles.

### Incomplete User

A user who started signup but has not completed all required profile fields.

Incomplete users follow guest browsing limits.

### Active User

A fully signed-up user who can use normal product features.

### Restricted User

A user limited by moderation.

Can:

* Open app
* Edit profile
* Read existing chats
* Contact support

Cannot:

* Explore
* Like
* Send Nakh
* Send chat messages

### Banned User

A user blocked from using the app.

Can only send one limited appeal/support message.

### Deleted User

A user who deleted their account.

The profile is hidden and chats are closed, but minimal audit, report, payment, and safety records remain.

## Profile

### Profile

The dating-visible information of a user.

Includes:

* Name
* Birth year
* Gender
* Interested gender
* Interests
* Location
* Photos
* Highlight
* Bio
* Optional fields

### Profile Completion

Whether all required profile fields are valid.

Required profile fields include:

* Name
* Birth year
* Gender
* Interested gender
* Interests
* Country
* Province
* City
* Relationship goal
* 2–6 photos
* One primary photo
* Highlight

### Visibility

A user-controlled setting.

If visibility is off:

* User does not appear in Explore
* User cannot Explore
* User cannot Like
* User cannot send Nakh
* Existing matches and chats continue

Visibility off is not the same as restriction.

### Signup Progress

The current step of a user during registration.

This is workflow state, not final profile data.

## Media and Location

### Media Asset

Stored metadata for an uploaded file.

Usually a user photo.

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

A blurred photo used in locked Liked By cards.

### Object Storage

External storage for uploaded photos.

The app server must not be the permanent image store.

### CDN URL

Public delivery URL used to show photos efficiently.

### Location

Structured profile location.

Includes:

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

There is no free-text “Other” city in MVP.

## Explore and Interactions

### Explore

The discovery flow where an active visible user sees one eligible profile at a time.

### Explore Filter

Criteria used to limit Explore results.

Includes:

* Age range
* Country
* Province
* City
* Relationship goal

Interested gender is stored on the profile, not only inside Explore filters.

### Eligible Profile

A profile that can appear in Explore.

Must be:

* Complete
* Visible
* Active
* Non-restricted
* Non-banned
* Compatible with filters
* Not previously consumed by the viewer

### Profile Preview

The short profile card shown in Guest mode or Explore.

Includes:

* Primary photo
* Name
* Age
* City
* Highlight

### Full Profile

The expanded profile view shown after Show More or paid/unlocked access.

### Profile Consumption

A permanent record that a viewer has already seen or acted on a target profile.

Consumed profiles are not shown again.

### Like

A free weak signal from one user to another.

The receiver sees the sender in Liked By.

### Liked By

The section showing users who sent normal Likes to the current user.

Liked By does not include Nakh senders.

### Liked By Unlock

A paid unlock that lets the receiver view one specific liked-by profile fully.

### Not Interested

A permanent negative action from one user toward another.

The target should not appear again.

## Nakh

### Nakh

A paid stronger signal sent from Explore with an opening text.

Nakh appears in the receiver’s Nakhes, not in Liked By.

### Pending Nakh

An unpaid Nakh attempt.

Pending Nakh is visible only to the sender.

It does not:

* Notify the receiver
* Create a Like
* Appear in Liked By
* Create a Match

### Sent Nakh

A paid Nakh delivered to the receiver.

### Nakhes

The section where users see Nakh-related items.

Includes:

* Sent Nakhes
* Received Nakhes
* Pending payment Nakhes
* Expired Nakhes
* Closed Nakhes

### Nakh Receiver Action

The receiver’s action on a received Nakh.

Possible actions:

* View profile
* Accept / Like back
* Reject
* Report

## Match and Chat

### Match

A relationship state between two users.

Created by:

* Mutual Like
* Accepted Nakh
* Nakh Like Back

### Unmatch

A user action that closes the match and chat.

Unmatch prevents future matching between the same pair.

### Chat

Internal bot relay chat created after a match.

It is not Telegram direct messaging.

### Predefined Chat

Free chat mode where users can only select predefined questions and answers.

### Chat Unlock

Paid per-match unlock.

If one side unlocks chat, both sides can send text messages in that match.

### Chat Safety Warning

A one-time warning shown when chat is unlocked.

After chat unlock, users may share contact information at their own risk.

## Payments and Credits

### Credit

Internal unit used to pay for paid actions.

Paid actions:

* Send Nakh
* Unlock one match chat
* Unlock one liked-by profile

### Telegram Stars

Telegram’s payment provider used for MVP payments.

### Credit Balance

The user’s current available credits.

### Credit Transaction

A record of every credit change.

Examples:

* Purchase
* Spend
* Refund
* Admin adjustment

### Credit Package

A purchasable bundle of credits.

Exact package sizes are not finalized yet.

### Pending Payment

A payment required to complete an unpaid action.

### Feature Unlock

A paid access record for one scoped feature.

Examples:

* One liked-by profile unlock
* One match chat unlock

### Payment Record

Internal record of a payment attempt and result.

### Payment Provider Event

Raw payment callback/event received from Telegram Stars.

Used for audit and idempotency.

### Idempotency

Rule that the same payment callback must not be processed twice.

## Notifications

### Notification

A stored message/event shown in notification history.

### Notification Delivery

The act of sending an important notification through Telegram.

### Read/Unread State

Whether the user has opened or acknowledged a notification.

### Mute Setting

User preference to mute normal notifications.

Cannot mute:

* Safety notices
* Payment notices
* Admin notices
* Ban notices
* Restriction notices

## Reporting and Moderation

### Report

A user-submitted complaint against another user, profile, photo, chat, message, or recently unmatched user.

### Report Reason

The selected reason for a report.

Examples:

* Fake profile
* Harassment
* Inappropriate photo
* Spam or scam
* Under 18
* Offensive behavior
* Other

### Report Evidence

Attached context for a report.

Examples:

* Profile
* Photo
* Chat
* Message
* Unmatched user

### Report Snapshot

Frozen copy of relevant data at report time.

Used to preserve evidence even if live data changes later.

### Moderation Review

Admin review process for reports or safety issues.

### Moderation Action

Admin/safety action.

Examples:

* Restrict user
* Ban user
* Unban user
* Hide photo
* Restore photo
* Dismiss report

### Restricted Pending Review

Temporary restricted state caused by report threshold before final admin decision.

### Admin User

Telegram user allowed to use admin commands.

### Admin Action Log

Record of admin actions for traceability.

### Support Message

Message sent by a user to admin/support.

### Appeal

Limited support message available to banned users.

## Localization, Jobs, and Audit

### Localization

System for configurable UI text.

MVP uses English.

Persian and other languages may be added later.

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
* Clean old chat messages
* Retry notification delivery

### Audit Log

Permanent trace of important system actions.

Used for:

* Account changes
* Payment events
* Moderation actions
* Safety events
* Admin actions

### Data Retention Record

Record of minimal data retained after account deletion.
