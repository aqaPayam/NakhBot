# Telegram Dating Bot — Final MVP Product Description

## 1. Product Overview

This product is a Telegram-based dating bot.

The first implementation is fully English. Persian and other languages may be added later, so UI text must be configurable and must not be hardcoded inside bot logic.

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
- 2–6 photos
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
- Languages
- Exercise/gym
- Religion importance
- Children preference
- Personality tags

### Photo Rules

Photo rules:

- Minimum 2 visible photos are required for profile completion.
- Maximum 6 active profile photos are allowed.
- Active profile photos means visible + hidden photos.
- Deleted photos do not count toward the 6-photo active limit.
- Hidden photos count toward the 6-photo active limit, but do not count toward profile completion.
- Only visible photos count toward the 2-photo completion requirement.
- User uploads the primary photo first.
- User can upload additional photos after the primary photo.
- Extra active photos are rejected.
- One visible photo must always be primary.
- User cannot delete the primary photo before choosing another visible primary photo.
- If photo moderation or deletion causes a profile to fail the visible photo requirement:

- A never-completed profile remains Incomplete.
- A previously completed profile becomes Invalid.
- Hidden is not a profile completion status.

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

### Gender Options for MVP

Gender options:

- Man
- Woman
- Other
- Prefer not to say

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

The target user receives a notification.

The liker appears in the target user’s Liked By section.

If both users like each other, a match is created.

## 7. Liked By

Liked By shows people who liked the user.

Liked By only contains normal Likes. Nakh senders do not appear in Liked By.

Unpaid view:

- Show number of likes.
- Show locked liked-by cards.
- Show blurred preview image.
- Do not show full profile.
- Do not show profile details.

Unlock rules:

- Each liked-by profile is unlocked separately.
- Unlock is paid using Telegram Stars/credits.
- Unlocking one liked-by profile does not unlock other liked-by profiles.
- After unlocking a liked-by profile, user can view the full profile.
- Liked By profile unlock has an expiry time. Exact expiry duration is configurable.
- After unlocking, user can Like Back or mark as Not Interested.
- If user Likes Back, a match is created.
- If user marks Not Interested, the liked-by profile is closed and not shown again.

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
- Only one Nakh can be sent per sender/receiver pair.
- Nakh text max length is 240 characters.
- Sent Nakh expires after 14 days.
- If rejected, sender cannot send another Nakh to the same target.
- UI should show rejected Nakh as Closed.

### Nakh Payment Flow

When a user chooses to send Nakh from Explore:

* If the user has enough credits, the system spends credits and creates a paid Sent Nakh immediately.
* If the user does not have enough credits, the system creates a Pending Nakh and a related Pending Payment.
* Pending Nakh is an unpaid Nakh attempt, not a delivered Nakh.
* Pending Nakh is visible only to the sender.
* Pending Nakh does not notify the receiver.
* Pending Nakh does not appear in the receiver’s Nakhes.
* Pending Nakh does not appear in Liked By.
* Pending Nakh does not create a Match.
* Pending Nakh can be paid later.
* Pending Nakh text can be edited before payment.
* Existing credits and direct Telegram Stars payment must both result in the same final Sent Nakh behavior.
* When payment succeeds, the Pending Nakh becomes paid and the system creates the delivered Sent Nakh.
* The target profile is consumed when Pending Nakh is created or Sent Nakh is sent.
* The target profile is not shown again, even if payment is completed later.

Visibility-off users cannot create a new Pending Nakh or new Sent Nakh.

A visibility-off user may complete payment for a Pending Nakh that was created before visibility was turned off.

Completing an existing Pending Nakh payment while visibility is off is allowed because the Nakh attempt was initiated before visibility was turned off.

This exception applies only to visibility off.

Nakh cost:

- Send Nakh: 2 credits

Pending Nakh payment cannot be completed or delivered if the sender becomes restricted, banned, or deleted before payment succeeds.

Pending Nakh payment also cannot be delivered if the receiver becomes restricted, banned, deleted, or profile-invalid before payment succeeds.

In those cases, the Pending Nakh should be blocked, cancelled, expired, or refunded depending on payment state.

### Pending Nakh Cancellation

If the sender cancels unpaid Pending Nakh, they must choose either:

- Convert it to a normal Like
- Mark the target as Not Interested

If converted to Like, the receiver is notified and the sender appears in Liked By.

If converted to Not Interested, the receiver is not notified and the target remains consumed.

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

Internally, rejected can be stored as rejected.

UI should show rejected Nakh as “Closed.”

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

MVP costs:

- Send Nakh: 2 credits
- Unlock one match chat: 4 credits
- Unlock one liked-by profile: 4 credits

Credit packages:

- User can buy credit packages.
- Credit packages may include discounts.
- Exact package sizes and discount rules are not finalized in MVP specification.

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

- One report goes to admin review.
- Five unique reporters restrict the target until admin review. This does not automatically ban the user. Ban requires admin decision.
- Admin decides final action.
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

- Cannot use app.
- Can send one limited appeal/support message.

### Account Deletion

User can delete account.

After account deletion:

- Profile becomes hidden.
- Chats close.
- User may later create a new profile with the same Telegram account.
- Minimal audit, report, payment, and safety records are retained.

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
- Dismiss report
- Review birth year change requests
- Review gender change requests
- Review appeals/support messages

Photos are not pre-approved.

Photos become visible immediately after upload.

Users can report photos.

Admin can hide photos or restrict/ban the user.

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

## 17. Settings

Settings includes:

- Visibility on/off
- Notification settings
- Edit Profile
- Delete account
- Support
- Language later

Support:

- User can send message to admin/support.
- Support should be rate-limited.

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

- Show ban/appeal message

If deleted:

- Show reactivation/signup flow based on retained audit rules

## 19. Product Tone

MVP is English only.

Tone should be casual and light, but not cringe.

Future Persian version can be funnier and more local.

UI text must be configurable for future localization.

## 20. Open Decisions

Open decisions before implementation:

- Interest seed list
- Iran province/city seed list
- Optional profile field enum values
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
