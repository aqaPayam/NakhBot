import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createLogger, LOG_REDACT_PATHS } from './index.js';

describe('log redaction policy', () => {
  it('redacts prohibited secret-shaped fields', async () => {
    let output = '';
    const sink = new Writable({
      write(chunk: unknown, _encoding, callback) {
        output += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
        callback();
      },
    });
    const logger = createLogger({ service: 'test' }, sink);

    logger.info(
      {
        webhookSecret: 'secret-value',
        chargeId: 'charge-value',
        userId: 'private-user-id',
        command: { data: { name: 'Private Name', requestedValue: 1999 } },
        profile: { bio: 'Private bio', highlight: 'Private highlight' },
      },
      'safe',
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(output).not.toContain('secret-value');
    expect(output).not.toContain('charge-value');
    expect(output).not.toContain('private-user-id');
    expect(output).not.toContain('Private Name');
    expect(output).not.toContain('Private bio');
    expect(output).not.toContain('Private highlight');
    expect(output).toContain('[REDACTED]');
  });

  it('keeps the central policy explicit for every M1 private field family', () => {
    expect(LOG_REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'command.data',
        'telegramUserId',
        'username',
        'userId',
        'name',
        'bio',
        'highlight',
        'draftData',
        'requestedValue',
        'reason',
      ]),
    );
  });
});
