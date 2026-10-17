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
