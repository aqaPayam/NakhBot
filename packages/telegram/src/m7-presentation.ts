import type { AdminActionResult, LocalizedIntent } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

export type M7Notice =
  | 'report_submitted'
  | 'support_prompt'
  | 'support_sent'
  | 'support_waiting'
  | 'support_closed'
  | 'appeal_prompt'
  | 'appeal_submitted'
  | 'appeal_in_review'
  | 'appeal_accepted'
  | 'appeal_rejected';

const noticeKeys: Readonly<Record<M7Notice, string>> = {
  report_submitted: 'report.submitted',
  support_prompt: 'support.prompt',
  support_sent: 'support.sent',
  support_waiting: 'support.waiting',
  support_closed: 'support.closed',
  appeal_prompt: 'appeal.prompt',
  appeal_submitted: 'appeal.submitted',
  appeal_in_review: 'appeal.in_review',
  appeal_accepted: 'appeal.accepted',
  appeal_rejected: 'appeal.rejected',
};

export function presentM7Notice(notice: M7Notice): LocalizedIntent {
  return { key: noticeKeys[notice], variables: {} };
}

export function presentM7AdminOutcome(result: AdminActionResult): LocalizedIntent {
  switch (result) {
    case 'succeeded':
      return { key: 'admin.outcome.succeeded', variables: {} };
    case 'rejected':
      return { key: 'admin.outcome.rejected', variables: {} };
    case 'failed':
      return { key: 'admin.outcome.failed', variables: {} };
  }
}

/** Selects safe prose from finite codes, never from exception messages or details. */
export function presentM7Error(error: unknown): LocalizedIntent {
  let key = 'error.m7.internal';
  if (error instanceof ApplicationError) {
    switch (error.code) {
      case 'rate_limited':
        key = 'error.m7.rate_limited';
        break;
      case 'support_unanswered_limit':
        key = 'error.support.unanswered_limit';
        break;
      case 'support_text_invalid':
        key = 'error.support.text_invalid';
        break;
      case 'appeal_text_invalid':
        key = 'error.appeal.text_invalid';
        break;
      case 'report_text_invalid':
        key = 'error.report.text_invalid';
        break;
      case 'admin_reason_invalid':
        key = 'error.admin.reason_invalid';
        break;
      case 'version_conflict':
      case 'idempotency_conflict':
        key = 'error.m7.stale_action';
        break;
      case 'invalid_request':
        key = 'error.m7.invalid_request';
        break;
      default:
        if (error.status < 500) key = 'error.m7.unavailable';
    }
  }
  return { key, variables: {} };
}

export type M7TextRenderer = Readonly<{ render(locale: string, intent: LocalizedIntent): string }>;

/** Plain Telegram text: no parse mode, content interpolation, links or restricted identifiers. */
export function renderM7Notice(
  renderer: M7TextRenderer,
  locale: string,
  notice: LocalizedIntent,
): Readonly<{ text: string }> {
  return { text: renderer.render(locale, notice) };
}
