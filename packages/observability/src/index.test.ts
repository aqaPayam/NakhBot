import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

describe('log redaction policy', () => {
  it('redacts prohibited secret-shaped fields', async () => {
    let output = '';
    const sink = new Writable({
      write(chunk: unknown, _encoding, callback) {
        output += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
        callback();
      },
    });
    const logger = pino(
      { redact: { paths: ['webhookSecret', 'chargeId'], censor: '[REDACTED]' } },
      sink,
    );

    logger.info({ webhookSecret: 'secret-value', chargeId: 'charge-value' }, 'safe');
    await new Promise((resolve) => setImmediate(resolve));

    expect(output).not.toContain('secret-value');
    expect(output).not.toContain('charge-value');
    expect(output).toContain('[REDACTED]');
  });
});
