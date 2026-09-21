export type NotificationType =
  | 'like_received'
  | 'nakh_received'
  | 'match_created'
  | 'new_chat_message'
  | 'chat_unlocked'
  | 'liked_by_profile_unlocked'
  | 'report_result'
  | 'restriction_warning'
  | 'ban_warning'
  | 'payment_success'
  | 'payment_failure'
  | 'pending_nakh_payment_reminder'
  | 'admin_notice'
  | 'safety_notice'
  | 'chat_closed';

export type NotificationCategory =
  'chat' | 'like' | 'nakh' | 'match' | 'safety' | 'payment' | 'admin' | 'ban' | 'restriction';

export type NotificationPreferences = Readonly<{
  chatEnabled: boolean;
  likeEnabled: boolean;
  nakhEnabled: boolean;
  matchEnabled: boolean;
}>;

export function notificationCategory(type: NotificationType): NotificationCategory {
  switch (type) {
    case 'new_chat_message':
      return 'chat';
    case 'like_received':
    case 'liked_by_profile_unlocked':
      return 'like';
    case 'nakh_received':
    case 'pending_nakh_payment_reminder':
      return 'nakh';
    case 'match_created':
    case 'chat_unlocked':
    case 'chat_closed':
      return 'match';
    case 'safety_notice':
      return 'safety';
    case 'payment_success':
    case 'payment_failure':
      return 'payment';
    case 'report_result':
    case 'admin_notice':
      return 'admin';
    case 'ban_warning':
      return 'ban';
    case 'restriction_warning':
      return 'restriction';
  }
}

export function shouldCreateTelegramDelivery(
  type: NotificationType,
  preferences: NotificationPreferences,
): boolean {
  switch (notificationCategory(type)) {
    case 'chat':
      return preferences.chatEnabled;
    case 'like':
      return preferences.likeEnabled;
    case 'nakh':
      return preferences.nakhEnabled;
    case 'match':
      return preferences.matchEnabled;
    case 'safety':
    case 'payment':
    case 'admin':
    case 'ban':
    case 'restriction':
      return true;
  }
}
