import { describe, expect, it } from 'vitest';
import { ApplicationError } from '@nakh/domain';
import {
  presentM7AdminOutcome,
  presentM7Error,
  presentM7Notice,
  renderM7Notice,
} from './m7-presentation.js';

describe('M7 privacy-safe presentation', () => {
  it('discards error content, identifiers and metadata even for expected errors', () => {
    const privateText = 'PRIVATE APPEAL <a href="https://example.com">text</a>';
    for (const error of [
      new Error(privateText),
      new ApplicationError('conflict', privateText, 409, { userId: privateText }),
      new ApplicationError('internal_error', privateText, 500),
    ]) {
      const intent = presentM7Error(error);
      expect(intent.variables).toEqual({});
      expect(JSON.stringify(intent)).not.toContain(privateText);
      expect(intent.key).toMatch(/^error\.m7\./u);
    }
  });
  it('renders only a localized plain-text notice without Telegram markup options', () => {
    const intent = presentM7Notice('appeal_accepted');
    expect(intent).toEqual({ key: 'appeal.accepted', variables: {} });
    expect(renderM7Notice({ render: (_locale, value) => value.key }, 'fa', intent)).toEqual({
      text: 'appeal.accepted',
    });
    expect(presentM7AdminOutcome('rejected')).toEqual({
      key: 'admin.outcome.rejected',
      variables: {},
    });
  });
});
