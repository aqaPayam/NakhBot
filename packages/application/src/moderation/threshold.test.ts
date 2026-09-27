import { describe, expect, it } from 'vitest';

import type { IdGenerator } from '@nakh/domain';

import {
  EvaluateModerationThresholdHandler,
  type ModerationThresholdStore,
  type ModerationThresholdWrite,
} from './threshold.js';

class SequenceIds implements IdGenerator {
  private next = 0;

  public uuid(): string {
    this.next += 1;
    return `00000000-0000-4000-8000-${String(this.next).padStart(12, '0')}`;
  }
}

describe('M7 threshold coordinator', () => {
  it('allocates every durable side-effect identity before entering persistence', async () => {
    let captured: ModerationThresholdWrite | undefined;
    const store: ModerationThresholdStore = {
      evaluate: (write) => {
        captured = write;
        return Promise.resolve({
          sourceReportId: write.sourceReportId,
          targetUserId: '00000000-0000-4000-8000-000000000099',
          distinctReporterCount: 5,
          outcome: 'create_restriction_episode',
          accountVersion: 2,
          restrictionEpisodeId: write.restrictionEpisodeId,
        });
      },
    };
    const handler = new EvaluateModerationThresholdHandler(store, new SequenceIds());
    const result = await handler.execute({
      sourceReportId: '00000000-0000-4000-8000-000000000101',
      requestId: '00000000-0000-4000-8000-000000000102',
      commandId: '00000000-0000-4000-8000-000000000103',
    });

    expect(
      new Set(Object.values(captured!).filter((value) => typeof value === 'string')).size,
    ).toBe(14);
    expect(result).toMatchObject({
      outcome: 'create_restriction_episode',
      distinctReporterCount: 5,
      accountVersion: 2,
    });
  });

  it('rejects an empty internal report identity before persistence', () => {
    const store: ModerationThresholdStore = {
      evaluate: () => Promise.reject(new Error('must not be called')),
    };
    const handler = new EvaluateModerationThresholdHandler(store, new SequenceIds());
    expect(() =>
      handler.execute({ sourceReportId: '', requestId: 'request', commandId: 'command' }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
  });
});
