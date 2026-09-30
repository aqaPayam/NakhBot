import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SubmitReportCommand } from '@nakh/contracts';
import { SubmitProfileReportHandler } from './submit-profile-report.js';

describe('profile report submission boundary', () => {
  it('authenticates before replay and permits identical durable receipts after token expiry', async () => {
    const actor = { kind: 'user' as const, userId: randomUUID() };
    const command: SubmitReportCommand = {
      commandType: 'moderation.submit-report',
      schemaVersion: 1,
      commandId: randomUUID(),
      requestId: randomUUID(),
      actor,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { evidenceIntentToken: 'expired', reasonCode: 'harassment', text: '  cafe\u0301  ' },
    };
    const result = {
      reportId: randomUUID(),
      status: 'pending_review' as const,
      submittedAt: command.occurredAt,
      replayed: true,
    };
    const replay = vi.fn(() => Promise.resolve(result)),
      submit = vi.fn(() => Promise.resolve(result));
    const resolveIntent = vi.fn(() => Promise.resolve(undefined));
    const handler = new SubmitProfileReportHandler(
      { resolveIntent },
      { replay, submit },
      { uuid: randomUUID },
    );
    await expect(
      handler.execute(command, { ...actor, userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(replay).not.toHaveBeenCalled();
    await expect(handler.execute(command, actor)).resolves.toEqual(result);
    expect(replay).toHaveBeenCalledWith(
      expect.objectContaining({ normalizedText: 'café', actorUserId: actor.userId }),
    );
    expect(resolveIntent).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    const noReplay = new SubmitProfileReportHandler(
      { resolveIntent },
      { replay: () => Promise.resolve(undefined), submit },
      { uuid: randomUUID },
    );
    await expect(noReplay.execute(command, actor)).rejects.toMatchObject({
      code: 'report_unavailable',
    });
    await expect(
      noReplay.execute({ ...command, data: { ...command.data, text: 'x'.repeat(1025) } }, actor),
    ).rejects.toMatchObject({ code: 'report_text_invalid' });
    expect(submit).not.toHaveBeenCalled();
  });
});
