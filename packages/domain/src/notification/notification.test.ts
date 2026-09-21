import { describe, expect, it } from 'vitest';

import {
  notificationCategory,
  shouldCreateTelegramDelivery,
  type NotificationType,
} from './notification.js';

describe('notification delivery policy', () => {
  const muted = {
    chatEnabled: false,
    likeEnabled: false,
    nakhEnabled: false,
    matchEnabled: false,
  };

  it.each([
    ['new_chat_message', 'chat'],
    ['like_received', 'like'],
    ['liked_by_profile_unlocked', 'like'],
    ['nakh_received', 'nakh'],
    ['pending_nakh_payment_reminder', 'nakh'],
    ['match_created', 'match'],
    ['chat_unlocked', 'match'],
    ['chat_closed', 'match'],
  ] as const)('respects the mutable %s category', (type, category) => {
    expect(notificationCategory(type)).toBe(category);
    expect(shouldCreateTelegramDelivery(type, muted)).toBe(false);
  });

  it.each([
    'safety_notice',
    'payment_success',
    'payment_failure',
    'report_result',
    'admin_notice',
    'ban_warning',
    'restriction_warning',
  ] satisfies readonly NotificationType[])('never mutes critical type %s', (type) => {
    expect(shouldCreateTelegramDelivery(type, muted)).toBe(true);
  });
});
