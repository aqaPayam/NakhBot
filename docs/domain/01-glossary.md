# Domain Glossary

This glossary defines the product vocabulary used throughout the NakhBot MVP. Behavioral requirements belong to `06-business-rules-and-invariants.md`.

## Identity, access, and settings

### User

The persistent internal identity for one person known through Telegram. A User survives account deletion only to preserve Telegram identity, the permanent guest-preview limit, and required safety continuity.

### TelegramIdentity

The external Telegram account linked one-to-one to a User. The Telegram user ID is stable; the username is optional and mutable.

### Account

The current access and lifecycle state of a User: `guest`, `incomplete`, `active`, `restricted`, `banned`, or `deleted`.

### Guest

A persistent Telegram user who has not started or completed signup. A Guest may use only Guest Preview and signup.

### Incomplete user

A user who started signup but has not confirmed a complete profile. Incomplete users have the same preview permissions and permanent counter as Guests.

### Active user

A user whose Account state is `active`. Normal discovery additionally requires a complete Profile and enabled visibility.

### Invalid active profile

The combination `Account.state = active` and `Profile.completion_status = invalid`. The account remains active, but new discovery interactions are unavailable until the Profile is fixed.

### Restricted user

A user temporarily limited by a safety or moderation action. A restriction is not a ban.

### Banned user

A user denied normal product access by an admin decision. One appeal is allowed for each distinct ban event.

### Deleted user

A retained identity whose ordinary product data was permanently purged after account deletion. If return is allowed, the person starts a new signup without restored product history.

### Visibility

A user-controlled discovery setting. Turning visibility off pauses new discovery in both directions without closing existing Matches, chats, delivered Nakhes, or already-created Pending Nakhes.

### UI language

The locale used for bot buttons, messages, errors, payments, notifications, safety, and admin text. It is separate from the languages displayed on a dating Profile.

## Profile and location

### Profile

The current dating-visible information for a User: name, Gregorian birth year, gender, relationship preference, interests, location, relationship goal, photos, highlight, bio, and optional details.

### Profile completion

The Profile's validity state: `incomplete`, `complete`, or `invalid`. It is separate from Account state.

### Birth year

The user's Gregorian year of birth. Exact birth date and a stored age are not part of the MVP; displayed age is approximate.

### Gender option

A data-driven value describing a user's gender. MVP codes are `man`, `woman`, and `other`.

### Relationship gender preference

The Profile-level gender preference used for reciprocal discovery eligibility. It is edited only through Edit Profile and is separate from the current Explore gender filter.

### Explore gender filter

A browsing preference that narrows the currently eligible target genders. It cannot broaden the Profile's reciprocal relationship preference.

### Reciprocal compatibility

The condition that the viewer's relationship preference includes the target's gender and the target's relationship preference includes the viewer's gender.

### Interest

A selectable, data-driven Profile tag. Interests are not free text.

### Relationship goal

The kind of connection a user is seeking, represented by a controlled value.

### Highlight

A required short Profile statement.

### Bio

An optional longer Profile description.

### Profile spoken language

A data-driven language the user can speak. It is not the bot UI locale.

### Locked Profile field

A field that requires an admin-reviewed change request after signup. MVP locked fields are birth year and gender.

### Country, province, and city

The structured location hierarchy. The MVP country is Iran; province and city are selected from versioned seed data.

## Discovery and interactions

### Guest Preview

The limited teaser browsing flow for Guest and Incomplete users. It is not normal Explore and does not use viewer Profile data or Explore filters.

### Explore

The normal one-profile-at-a-time discovery flow for active users with complete Profiles and enabled visibility.

### Eligible Profile

A target Profile that passes access, visibility, completion, location/filter, reciprocal compatibility, pair-state, and consumption checks.

### Profile Preview

The compact card containing primary photo, name, approximate age, city, and highlight.

### Profile consumption

A record that a viewer was shown or acted on a target. A consumed target does not return to that viewer during the current account lifetime.

### Like

A free, directional signal. A Like cannot be withdrawn by a normal user.

### Liked By

A derived inbox of actionable received Likes. It is not a stored card entity and never contains Nakh senders.

### Liked By unlock

A paid, Like-scoped FeatureUnlock that reveals one received Like's full Profile while that Like remains actionable.

### Not Interested

A permanent-within-account-lifetime directional rejection that consumes the target and prevents rediscovery by the sender.

### User pair state

A symmetric summary for a normalized pair. The stored MVP states are `matched`, `unmatched`, and `blocked`; no record means no pair state.

### Internal block

A safety-only `blocked` pair state created by moderation. It is neither visible nor available as a user action.

## Nakh, Match, and chat

### Nakh

“Nakh” (نخ دادن) is a paid directional signal containing an opening text and the sender's Profile.

### NakhFlow

The permanent-within-account-lifetime anchor for a sender/receiver Nakh attempt. It enforces at most one directional Nakh flow for that pair.

### Pending Nakh

The unpaid phase of a NakhFlow. It is visible only to the sender and has not been delivered.

### Sent Nakh

The paid Nakh record delivered to the receiver's Nakhes inbox.

### Nakhes

The product area containing received and sent Nakhes plus sender-only Pending Nakhes.

### Match

A unique pair relationship created by mutual Likes or acceptance of a Sent Nakh.

### Unmatch

A user action that permanently closes the Match relationship and its chat for that pair.

### Chat

An internal Telegram-bot relay associated one-to-one with a Match. It is not a native Telegram direct message.

### Predefined chat

The free chat mode in which participants select localized, data-driven questions and answers.

### Chat unlock

A paid, Match-scoped FeatureUnlock that allows both participants to send free text while the Match remains active.

## Payments and notifications

### Credit

The internal app unit used for paid actions. A credit is not a Telegram Star.

### Credit package

A configured bundle of internal credits purchased with Telegram Stars.

### Pending payment

A product action or package purchase awaiting provider confirmation.

### Payment record

The internal lifecycle record for one Telegram Stars invoice/payment attempt.

### Provider event

The raw, uniquely identified Telegram payment callback used for audit and idempotency.

### FeatureUnlock

A paid access grant scoped to one actionable Like or one active Match. Nakh delivery is a paid action, not a FeatureUnlock.

### Refund

An automatic correction for a system fault after successful funding. The MVP has no user-requested refund flow.

### Notification

A durable in-app event with read state. Telegram delivery is a separate asynchronous attempt.

## Safety, support, and operations

### Report

A complaint by one User about another User with a reason, optional text, evidence references, and immutable snapshots where required.

### Report snapshot

An immutable copy of relevant Profile, photo, or message context captured at report time.

### Moderation review

The admin review of a Report or safety case.

### Moderation action

A recorded action such as restrict, ban, hide photo, restore photo, delete photo, or dismiss Report.

### Support thread

A support conversation available to non-banned users.

### Ban appeal

A UserAppeal linked to one specific transition into `banned`.

### Media asset

Metadata and storage identity for an original uploaded image in object storage.

### Profile photo

A Profile's use of a MediaAsset, including primary position, ordering, and moderation status.

### Thumbnail

The required upload-time image variant used for efficient bot cards and lists.

### Blurred preview

An on-demand cached variant of the current primary photo used on locked Liked By cards.

### Localization key

A stable code used to load user-facing text for a locale.

### Audit log

An append-only trace of an important state-changing event.

### Safety retention

The minimum identity, moderation, abuse-prevention, or evidence data retained after deletion. It must not restore ordinary product history.

