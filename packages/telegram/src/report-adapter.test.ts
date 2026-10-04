import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  PrepareSingleReportEvidenceHandler,
  SubmitSingleEvidenceReportHandler,
  GetReportReasonsHandler,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { TelegramReportAdapter, reportCallbackData } from './report-adapter.js';
import { TelegramReportSelections } from './report-selections.js';
const source = 'v1.rs.' + 's'.repeat(16) + '.' + 'a'.repeat(16),
  intent = 'v1.ri.' + 'i'.repeat(16) + '.' + 'b'.repeat(16);
function fixture(): Readonly<{
  adapter: TelegramReportAdapter;
  userId: string;
  prepare: ReturnType<typeof vi.fn<PrepareSingleReportEvidenceHandler['execute']>>;
  submit: ReturnType<typeof vi.fn<SubmitSingleEvidenceReportHandler['execute']>>;
  values: Map<string, string>;
}> {
  const userId = randomUUID(),
    values = new Map<string, string>();
  const selections = new TelegramReportSelections(
    {
      get: (key) => Promise.resolve(values.get(key)),
      putIfAbsent: (key, value) => {
        if (values.has(key)) return Promise.resolve(false);
        values.set(key, value);
        return Promise.resolve(true);
      },
    },
    Buffer.alloc(32, 5),
  );
  const prepare = vi.fn<PrepareSingleReportEvidenceHandler['execute']>().mockResolvedValue({
    evidenceIntentToken: intent,
    evidenceTypes: ['profile'],
    expiresAt: '2026-10-04T00:05:00Z',
  });
  const submit = vi.fn<SubmitSingleEvidenceReportHandler['execute']>().mockResolvedValue({
    reportId: randomUUID(),
    status: 'pending_review',
    submittedAt: '2026-10-04T00:00:00Z',
    replayed: false,
  });
  const reasons = vi
    .fn<GetReportReasonsHandler['execute']>()
    .mockResolvedValue({ items: [{ code: 'other', labelKey: 'report.reason.other' }] });
  return {
    userId,
    values,
    prepare,
    submit,
    adapter: new TelegramReportAdapter(
      '987',
      { resolveUserId: () => Promise.resolve(userId) },
      { prepare: { execute: prepare }, submit: { execute: submit }, reasons: { execute: reasons } },
      selections,
      { consume: () => Promise.resolve({ allowed: true, remaining: 19, retryAfterSeconds: 0 }) },
    ),
  };
}
const callback = (data: string): unknown => ({
  update_id: 1,
  actor: { userId: 'forged' },
  callback_query: {
    data,
    from: { id: 123, is_bot: false },
    message: { chat: { type: 'private', id: 123 } },
  },
});
const submission = (reference: string, text = 'private report prose'): unknown => ({
  update_id: 2,
  actor: { userId: 'forged' },
  message: {
    date: 1791072000,
    text: `/report ${reference} other ${text}`,
    from: { id: 123, is_bot: false },
    chat: { type: 'private', id: 123 },
  },
});
describe('Telegram report boundary', () => {
  it.each(['profile', 'photo', 'chat', 'message', 'unmatched_user'] as const)(
    'prepares %s from only an opaque source and resolved actor',
    async (type) => {
      const f = fixture(),
        data = reportCallbackData(type, source);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      const result = await f.adapter.handle(callback(data));
      expect(f.prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { kind: 'user', userId: f.userId },
          sourceActionToken: source,
          requestedEvidenceTypes: [type],
        }),
        { kind: 'user', userId: f.userId },
      );
      expect(JSON.stringify(result)).not.toContain(intent);
      expect(f.submit).not.toHaveBeenCalled();
    },
  );
  it('keeps selection and command identities stable on retry, drops report identities and prose from receipts', async () => {
    const f = fixture(),
      first = await f.adapter.handle(callback(reportCallbackData('profile', source)));
    if (!first.handled || first.form === undefined) throw new Error('form missing');
    f.prepare.mockResolvedValueOnce({
      evidenceIntentToken: 'v1.ri.' + 'j'.repeat(16) + '.' + 'c'.repeat(16),
      evidenceTypes: ['profile'],
      expiresAt: '2026-10-04T00:05:00Z',
    });
    const retry = await f.adapter.handle(callback(reportCallbackData('profile', source)));
    expect(retry).toEqual(first);
    const receipt = await f.adapter.handle(submission(first.form.reference));
    await f.adapter.handle(submission(first.form.reference));
    expect(f.submit.mock.calls[0]).toEqual(f.submit.mock.calls[1]);
    expect(f.submit.mock.calls[0]?.[0].data).toEqual({
      evidenceIntentToken: intent,
      reasonCode: 'other',
      text: 'private report prose',
    });
    expect(JSON.stringify(receipt)).not.toContain('private report prose');
    expect(JSON.stringify(receipt)).not.toContain('reportId');
    await f.adapter.handle(submission(first.form.reference, 'changed'));
    expect(f.submit.mock.calls[2]?.[0].commandId).toBe(f.submit.mock.calls[0]?.[0].commandId);
  });
  it('binds cached selections to users, rejects malformed private context, and presents only finite failures', async () => {
    const f = fixture();
    const selected = await f.adapter.handle(callback(reportCallbackData('profile', source)));
    if (!selected.handled || selected.form === undefined) throw new Error('form missing');
    const encoded = f.values.values().next().value!;
    f.values.set(f.values.keys().next().value!, encoded.replace(f.userId, randomUUID()));
    await expect(f.adapter.handle(submission(selected.form.reference))).resolves.toMatchObject({
      notice: { key: 'error.m7.unavailable' },
    });
    expect(f.submit).not.toHaveBeenCalled();
    await expect(
      f.adapter.handle({
        update_id: 1,
        callback_query: {
          data: reportCallbackData('profile', source),
          from: { id: 123, is_bot: false },
          message: { chat: { type: 'group', id: 123 } },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    f.prepare.mockRejectedValueOnce(
      new ApplicationError('report_unavailable', 'private details', 409),
    );
    const result = await f.adapter.handle(callback(reportCallbackData('profile', source)));
    expect(JSON.stringify(result)).not.toContain('private details');
    expect(await f.adapter.handle({ edited_message: { text: '/report' } })).toEqual({
      handled: false,
    });
  });
});
