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
    'Signed in. Return to the bot and send /admin_reports, /admin_support or /admin_appeals.',
  'admin.auth.signed_out': 'You are signed out.',
  'admin.auth.signout': 'Sign out',
  'admin.auth.unavailable':
    'Unable to complete this action. Use a current authenticator code, or open a new sign-in link from the bot.',
  'admin.auth.expired': 'This sign-in link is no longer current. Return to the bot for a new one.',
} as const;
