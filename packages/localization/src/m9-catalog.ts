export const M9_NAKH_TEXTS = {
  'nakh.ui.menu': 'Nakhes',
  'nakh.ui.received': 'Received',
  'nakh.ui.sent': 'Sent',
  'nakh.ui.pending': 'Pending',
  'nakh.ui.history': 'Past pending Nakhes',
  'nakh.ui.empty': 'Nothing here yet.',
  'nakh.ui.item': '{name} · {status}',
  'nakh.ui.detail': '{name}\n{status}\n{when}\n\n{text}',
  'nakh.ui.accept': 'Accept',
  'nakh.ui.close': 'Close Nakh',
  'nakh.ui.view': 'View profile',
  'nakh.ui.edit': 'Edit text',
  'nakh.ui.cancel': 'Cancel pending Nakh',
  'nakh.ui.cancel_info':
    'Choose how to close this pending Nakh. Its place in Explore will not return.',
  'nakh.ui.cancel_like': 'Cancel and Like',
  'nakh.ui.cancel_reject': 'Cancel and Not interested',
  'nakh.ui.edit_prompt':
    'Reply to this message with your new Nakh text (up to 240 characters). To leave this form, send /nakhes.',
  'nakh.ui.saved': 'Your pending Nakh has been updated.',
  'nakh.ui.cancelled': 'Your pending Nakh has been cancelled.',
  'nakh.ui.accepted': 'You have a new Match. Open Matches to chat.',
  'nakh.ui.closed': 'This Nakh is now closed.',
  'nakh.ui.unavailable': 'This Nakh or action is no longer available. Open Nakhes again.',
  'nakh.ui.profile_unavailable':
    'This profile is unavailable right now. You can still check the Nakh status.',
  'nakh.ui.back': 'Back to Nakhes',
  'nakh.ui.next': 'Next page',
  'nakh.ui.expires': 'Expires {when} (UTC)',
  'home.matches': 'Matches',
  'home.fix_profile': 'Fix profile',
  'nakh.ui.status.sent': 'Sent',
  'nakh.ui.status.seen': 'Seen',
  'nakh.ui.status.accepted': 'Accepted',
  'nakh.ui.status.rejected': 'Closed',
  'nakh.ui.status.expired': 'Expired',
  'nakh.ui.status.closed': 'Closed',
  'nakh.ui.status.pending_payment': 'Pending',
  'nakh.ui.status.paid_and_sent': 'Sent',
  'nakh.ui.status.cancelled': 'Cancelled',
  'nakh.ui.status.closed_by_system': 'Closed',
} as const;

export const M9_LIKED_BY_TEXTS = {
  'liked_by.menu': 'Likes',
  'liked_by.unlock.confirm':
    'Spend {credits} credits to view this full profile?\nYour balance: {balance} credits.',
  'liked_by.unlock.credits': 'Unlock for {credits} credits',
  'liked_by.view': 'View profile',
  'liked_by.like_back': 'Like back',
  'liked_by.dismiss': 'Not interested',
  'liked_by.unavailable': 'This Like is no longer available. Open Likes again.',
  'liked_by.queued': 'Your profile view is being prepared.',
  'liked_by.insufficient':
    'You need {credits} credits to unlock this profile. Open Your credits to check your balance.',
  'liked_by.back': 'Back to Likes',
  'liked_by.rejected': 'This Like has been dismissed.',
} as const;

export const M9_FILTER_TEXTS = {
  'filters.title': 'Explore filters',
  'filters.summary':
    'Genders: {genders}\nAge: {min}–{max}\nLocation: {location}\nRelationship goal: {goal}\nChanges save as you tap.',
  'filters.genders': 'Genders',
  'filters.min_age': 'Minimum age',
  'filters.max_age': 'Maximum age',
  'filters.location': 'Location',
  'filters.goal': 'Relationship goal',
  'filters.any': 'Any relationship goal',
  'filters.apply': 'Apply shown filters',
  'filters.saved': 'Explore filters saved.',
  'filters.changed': 'These filters changed. Use the current menu and try again.',
  'filters.invalid':
    'Choose at least one available gender, ages 18–120 in order, and an active location.',
  'filters.preference_adjusted':
    'Your profile preference changed. The next filter change will also save the available genders shown here.',
} as const;

export const M9_REVIEW_TEXTS = {
  'profile.review.title': 'Profile corrections',
  'profile.review.empty': 'No pending profile corrections.',
  'profile.review.row': '{field} · {submitted}',
  'profile.review.open': 'Open this correction request? Viewing its contents is audited.',
  'profile.review.view': 'View request',
  'profile.review.body':
    '{field}\nCurrent: {old}\nRequested: {requested}\nReason: {reason}\nStatus: {status}',
  'profile.review.approve': 'Approve correction',
  'profile.review.reject': 'Reject correction',
  'profile.review.confirm_approve':
    'Approve this correction and change the protected profile field?',
  'profile.review.confirm_reject': 'Reject this correction request?',
  'profile.review.confirm': 'Confirm review',
  'profile.review.cancel': 'Cancel',
  'profile.review.back': 'Back to corrections',
  'profile.review.saved': 'Review saved.',
  'profile.review.processed':
    'This action has already been processed. Open /admin_changes for a fresh menu.',
  'profile.review.unavailable':
    'This administrator action is unavailable. Sign in again or open /admin_changes for a current menu.',
} as const;

export const M9_ACCOUNT_TEXTS = {
  'account.menu.title': 'Settings',
  'account.credits.title': 'Your credits',
  'account.credits.balance': 'Balance: {credits} credits',
  'account.credits.free_add': 'Add 100 free credits',
  'account.credits.free_info':
    'You can add test credits for free, as often as you need. Pending Nakhes you already approved may use these credits automatically.',
  'account.credits.added': 'Added 100 free credits.',
  'account.credits.unavailable':
    'Free credit refills are unavailable. Please open the current menu again.',
  'account.menu.support': 'Support',
  'account.menu.support_help': 'Send /support followed by your message.',
  'account.menu.delete': 'Delete account',
  'account.menu.delete_help': 'Send /delete to review and confirm account deletion.',
  'account.menu.back': 'Back to settings',
} as const;

export const M9_SETTINGS_TEXTS = {
  'account.menu.home': 'Main menu',
  'account.settings.language': 'Language',
  'account.settings.visibility_on': 'Profile visible: On',
  'account.settings.visibility_off': 'Profile visible: Off',
  'account.settings.visibility_info':
    'Visibility controls whether new people can discover your profile. Existing chats remain available.',
  'account.settings.notifications': 'Notifications',
  'account.settings.notification_info':
    'Choose notifications for new activity. Safety and account-service notices remain enabled.',
  'account.settings.chat': 'Chat messages',
  'account.settings.like': 'Likes',
  'account.settings.nakh': 'Nakhes',
  'account.settings.match': 'Matches',
  'account.settings.on': 'On',
  'account.settings.off': 'Off',
  'account.settings.toggle': '{label}: {state}',
  'account.settings.saved': 'Settings saved.',
  'account.settings.changed': 'Your settings changed. Use the refreshed menu.',
  'account.settings.invalid': 'This setting could not be saved. Use the current menu.',
} as const;

export const M9_EDITOR_TEXTS = {
  'profile.edit.title': 'Edit profile',
  'profile.edit.summary':
    'Name: {name}\nBirth year: {year}\nGender: {gender}\nLooking for: {preference}\nInterests: {interests}\nLocation: {location}\nRelationship goal: {goal}\nHighlight: {highlight}',
  'profile.edit.name': 'Name',
  'profile.edit.preference': 'Looking for',
  'profile.edit.interests': 'Interests',
  'profile.edit.location': 'Location',
  'profile.edit.goal': 'Relationship goal',
  'profile.edit.highlight': 'Highlight',
  'profile.edit.optional': 'Optional details',
  'profile.edit.photos': 'Manage photos',
  'profile.edit.photos_help':
    'Send /photos to choose your primary photo, hide or delete photos. Send a new photo here to upload it.',
  'profile.edit.current': '{label}: {value}',
  'profile.edit.empty': 'Not set',
  'profile.edit.reply': 'Reply to this message with your new {label}.',
  'profile.edit.saved': 'Profile saved.',
  'profile.edit.changed': 'Your profile changed. Use the refreshed menu.',
  'profile.edit.invalid':
    'That change could not be saved. Please use the current choices or reply to the latest prompt.',
  'profile.edit.multi':
    'Changes save as you tap. Keep five to twenty interests. Add one before removing if only five are selected; remove one before adding if twenty are selected.',
  'profile.edit.multi_optional':
    'Changes save as you tap. Remove a selection before adding another if the selection limit is reached.',
  'profile.edit.request_change': 'Request birth-year or gender correction',
  'profile.edit.birth_year': 'Birth year',
  'profile.edit.gender': 'Gender',
  'profile.edit.birth_request':
    'Reply with your correct Gregorian birth year on the first line and a short reason below it. This submits a correction request for review.',
  'profile.edit.gender_request':
    'Reply with a short reason for this gender correction. This submits a request for review.',
  'profile.edit.request_sent': 'Your correction request was submitted for review.',
  'profile.edit.requests': 'Correction requests',
  'profile.edit.requests_empty': 'No correction requests for your current account.',
  'profile.edit.request_row': '{field}: {value} — {status}',
  'profile.edit.status.pending': 'Pending',
  'profile.edit.status.approved': 'Approved',
  'profile.edit.status.rejected': 'Rejected',
  'profile.edit.status.cancelled': 'Cancelled',
} as const;
export const M9_SIGNUP_TEXTS = {
  'signup.ui.confirm_age': 'I am at least 18',
  'signup.ui.next': 'Next',
  'signup.ui.back': 'Back',
  'signup.ui.continue': 'Continue',
  'signup.ui.confirm': 'Confirm profile',
  'signup.ui.refresh': 'Check uploads',
  'signup.ui.photos':
    'Send photos here, then check uploads once processing finishes. Choose photos in their upload order.',
  'signup.ui.photo': 'Photo {position}',
  'signup.ui.optional': 'Optional details',
  'signup.ui.remove': 'Remove this answer',
  'signup.ui.height_cm': 'Height (cm)',
  'signup.ui.job': 'Job',
  'signup.ui.education_level_code': 'Education',
  'signup.ui.smoking_preference_code': 'Smoking',
  'signup.ui.pets_preference_code': 'Pets',
  'signup.ui.exercise_frequency_code': 'Exercise',
  'signup.ui.religion_code': 'Religion',
  'signup.ui.children_preference_code': 'Children',
  'signup.ui.language_codes': 'Spoken languages',
  'signup.ui.personality_tag_codes': 'Personality tags',
  'signup.ui.bio': 'Bio',
  'signup.ui.reply': 'Reply to this message with your answer.',
  'signup.ui.choose': 'Choose an answer below.',
  'signup.ui.expired': 'This prompt is no longer current. Send /start to resume.',
  'signup.ui.invalid': 'That answer could not be saved. Please try the current step again.',
  'signup.ui.review':
    'Name: {name}\nBirth year: {year}\nGender: {gender}\nLooking for: {preference}\nInterests: {interests}\nLocation: {location}\nRelationship goal: {goal}\nHighlight: {highlight}\nOptional details:\n{optional}\nPhotos: {photos}',
} as const;
export const M9_PREVIEW_TEXTS = {
  'preview.ui.card': '{name}, approximately {age}\n{city}\n{highlight}',
  'preview.ui.next': 'Next profile',
  'preview.ui.pending':
    'This delivery is awaiting verification. Please use /start to continue signup or contact support if it remains pending.',
  'preview.ui.failed':
    'This profile could not be delivered. Choose Guest Preview again to try another delivery.',
  'preview.ui.handled':
    'This profile was already delivered. Use the buttons on your current card or send /start.',
} as const;

export const M9_PROFILE_TEXTS = {
  'profile.ui.more': 'Show More',
  'profile.ui.details':
    '{name}, approximately {age}\n{location}\nGender: {gender}\nLooking for: {preference}\nRelationship goal: {goal}\nInterests: {interests}\n{highlight}\n{optional}\n{bio}',
  'profile.ui.optional': '{label}: {value}',
  'profile.ui.photo': '{name} · Photo {position} of {total}',
} as const;

export const M9_REPORT_TEXTS = {
  'report.ui.reply_submits':
    'Reply to this message to submit your report with details. To submit without details, use Submit report above.',
  'report.ui.cancelled': 'This report was cancelled. No report was submitted.',
} as const;

export const M9_CHAT_TEXTS = {
  'chat.list.title': 'Chats',
  'chat.list.empty': 'No active chats.',
  'chat.history.self': 'You',
  'chat.history.peer': 'Match',
  'chat.history.older': 'Older messages',
  'chat.history.refresh': 'Refresh messages',
  'chat.button.back': 'Back',
  'chat.button.confirm': 'Confirm',
  'chat.button.cancel': 'Cancel',
  'chat.unmatch.confirm': 'End this Match and close the chat permanently?',
  'chat.unlock.confirm': 'Spend {credits} credits to unlock text chat for both participants?',
  'chat.message.sent': 'Message sent.',
  'chat.relay.open': 'Open chat',
  'chat.relay.resume': 'Open /start, then Chats, to continue this conversation.',
  'chat.relay.reply': 'Reply to this message or open the chat.',
  'chat.report.conversation': 'Report conversation',
  'chat.report.message': 'Report message {number}',
  'chat.report.ended': 'Ended chats',
  'chat.report.ended_empty': 'No ended chats are currently eligible for reporting.',
} as const;

export const M9_ADMIN_TEXTS = {
  'admin.auth.open': 'Administrator sign-in',
  'admin.auth.title': 'Sign in as an administrator',
  'admin.auth.instructions':
    'Open this page from your private bot menu. Use your authenticator app. Enrollment also requires a separate operator invitation.',
  'admin.auth.invitation': 'Operator invitation',
  'admin.auth.begin': 'Set up authenticator',
  'admin.auth.seed': 'Manual authenticator setup key',
  'admin.auth.code': 'Six-digit authenticator code',
  'admin.auth.confirm': 'Confirm enrollment',
  'admin.auth.signin': 'Sign in',
  'admin.auth.activated':
    'Enrollment is complete. Wait for the next authenticator code, then sign in.',
  'admin.auth.signed_in':
    'Signed in. Return to the bot and send /admin_reports, /admin_support, /admin_appeals or /admin_changes.',
  'admin.auth.signed_out': 'You are signed out.',
  'admin.auth.signout': 'Sign out',
  'admin.auth.unavailable':
    'Unable to complete this action. Use a current authenticator code, or open a new sign-in link from the bot.',
  'admin.auth.expired': 'This sign-in link is no longer current. Return to the bot for a new one.',
} as const;

export const M9_PURCHASE_TEXTS = {
  'purchase.title': 'Review purchase',
  'purchase.packages': 'Buy credits',
  'purchase.package': '{credits} credits for {stars} Telegram Stars',
  'purchase.nakh': 'One Nakh for {stars} Telegram Stars',
  'purchase.terms_title': 'Nakh purchase terms ({version})',
  'purchase.units':
    'Credits are internal Nakh product units, not money, cryptocurrency or a withdrawable balance.',
  'purchase.delivery':
    'The full price is shown in Telegram Stars. Value is delivered only after Telegram confirms payment. Approving this screen alone does not charge you.',
  'purchase.pending':
    'Pending Nakhes you already authorized may spend newly added credits automatically.',
  'purchase.correction':
    'If a verified system fault prevents delivery, we will correct the purchase or refund the affected Stars payment. Contact support about any missing or disputed purchase.',
  'purchase.contact':
    'Purchase and refund support: @{support} (https://t.me/{support}). Telegram support cannot resolve purchases from this bot.',
  'purchase.rights': 'These terms do not limit any rights you have under applicable law.',
  'purchase.confirm': 'I agree: open Telegram payment',
  'purchase.consent':
    'By choosing the confirmation button, you confirm that you have read and agree to these purchase terms and the exact offer above.',
  'purchase.cancel': 'Cancel purchase',
  'purchase.back': 'Back to credits',
  'purchase.cancelled': 'Purchase cancelled. No new invoice was requested.',
  'purchase.unavailable':
    'This purchase is no longer available. Open your credits menu again. For an existing payment, use /paysupport.',
} as const;
