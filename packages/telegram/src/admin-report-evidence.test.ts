import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationError, REPORT_EVIDENCE_TYPES } from '@nakh/domain';
import type { GetSelectedReportEvidenceMetadataHandler, OpaqueTokenStore } from '@nakh/application';
import { TelegramAdminReportEvidence } from './admin-report-evidence.js';
import { TelegramAdminReportQueueState } from './admin-report-queue-state.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';
import type { TelegramAdminSessionVerifier } from './admin-session.js';

class Harness {
  public now = new Date();
  public revoked = false;
  public actor = { kind: 'admin' as const, userId: randomUUID() };
  public rows = new Map<string, string>();
  public tokens: OpaqueTokenStore = {
    get: (key) => Promise.resolve(this.rows.get(key)),
    putIfAbsent: (key, value) => {
      const absent = !this.rows.has(key);
      if (absent) this.rows.set(key, value);
      return Promise.resolve(absent);
    },
  };
  public sessions = {
    current: vi.fn<TelegramAdminSessionVerifier['current']>().mockImplementation(() =>
      Promise.resolve(
        this.revoked
          ? undefined
          : {
              actor: this.actor,
              telegramUserId: '123',
              locale: 'en',
              expiresAt: new Date(this.now.getTime() + 300000),
              mfaExpiresAt: new Date(this.now.getTime() + 300000),
            },
      ),
    ),
  };
  public state = new TelegramAdminReportQueueState(
    this.tokens,
    new Uint8Array(32).fill(1),
    new Uint8Array(32).fill(2),
    () => this.now.getTime(),
  );
  public report = {
    kind: 'report' as const,
    queueActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    targetId: randomUUID(),
    expectedVersion: 3,
    status: 'closed',
  };
  public items = REPORT_EVIDENCE_TYPES.map((evidenceType) => ({
    evidenceId: randomUUID(),
    evidenceType,
    snapshotSchemaVersion: 1,
  }));
  public metadata = vi
    .fn<GetSelectedReportEvidenceMetadataHandler['execute']>()
    .mockImplementation(() =>
      Promise.resolve({ reportId: this.report.targetId, items: this.items }),
    );
  public menu = vi.fn<TelegramAdminTextDelivery['queueMenu']>().mockResolvedValue(undefined);
  public text = vi.fn<TelegramAdminTextDelivery['text']>().mockResolvedValue(undefined);
  public adapter = new TelegramAdminReportEvidence(
    '99',
    this.sessions,
    { execute: this.metadata },
    this.state,
    { queueMenu: this.menu, text: this.text },
    { render: (_locale, intent) => intent.key },
    () => this.now,
  );
  public async list(): Promise<string[]> {
    const reference = await this.state.putChoice(this.actor, 'report', this.report);
    await this.adapter.handle(callback(`m7C:${reference}`));
    return this.menu.mock.lastCall![0].replyMarkup.inline_keyboard.map(
      (row) => row[0].callback_data,
    );
  }
}
function callback(data: string): Record<string, unknown> {
  return {
    update_id: 2,
    callback_query: {
      from: { id: 123, is_bot: false },
      message: { chat: { id: 123, type: 'private' } },
      data,
    },
  };
}
describe('private selected report evidence metadata picker', () => {
  it('preserves photo controls while offering a separate available evidence read', async () => {
    const f = new Harness(),
      selections = await f.list();
    const photo = vi.fn().mockResolvedValue(true),
      read = vi.fn().mockResolvedValue(true);
    const adapter = new TelegramAdminReportEvidence(
      '99',
      f.sessions,
      { execute: f.metadata },
      f.state,
      { queueMenu: f.menu, text: f.text },
      { render: (_locale, intent) => intent.key },
      () => f.now,
      { present: photo },
      { present: read },
    );
    const choice = selections.find((_, index) => f.items[index]!.evidenceType === 'photo')!;
    await adapter.handle(callback(choice));
    expect(photo).toHaveBeenCalledWith('123', choice.slice(4));
    expect(read).toHaveBeenCalledWith('123', choice.slice(4));
    expect(f.text).not.toHaveBeenCalled();
  });
  it('uses all five bounded types with opaque choices, then rechecks exact native selection without opening content', async () => {
    const f = new Harness();
    const selections = await f.list();
    expect(selections).toHaveLength(5);
    expect(f.metadata.mock.calls[0]![0]).toMatchObject({
      reportId: f.report.targetId,
      expectedReportVersion: 3,
      adminActionToken: f.report.queueActionToken,
    });
    const menu = f.menu.mock.lastCall![0];
    for (const [index, data] of selections.entries()) {
      expect(data).toMatch(/^m7J:[A-Za-z0-9_-]{22}$/u);
      expect(await f.adapter.selection('123', data.slice(4))).toEqual({
        report: f.report,
        evidence: {
          reportReference: await f.state.putChoice(f.actor, 'report', f.report),
          ...f.items[index]!,
        },
      });
      await f.adapter.handle(callback(data));
      expect(f.text.mock.lastCall![0]).toMatchObject({
        disableLinkPreviews: true,
        text: `admin.report.evidence_selected\nadmin.report.evidence_type.${f.items[index]!.evidenceType}`,
      });
    }
    for (const hidden of [
      f.actor.userId,
      f.report.targetId,
      f.report.queueActionToken,
      ...f.items.map((item) => item.evidenceId),
    ]) {
      expect(JSON.stringify(menu)).not.toContain(hidden);
      expect(JSON.stringify([...f.rows.values()])).not.toContain(hidden);
      expect(JSON.stringify(f.text.mock.calls)).not.toContain(hidden);
    }
  });
  it('keeps the first concurrent choice without refresh and rejects a changed item for the same provider operation', async () => {
    const f = new Harness();
    const reference = await f.state.putChoice(f.actor, 'report', f.report);
    await Promise.all(
      Array.from({ length: 10 }, () => f.adapter.handle(callback(`m7C:${reference}`))),
    );
    const first = f.menu.mock.calls[0]![0];
    expect(
      f.menu.mock.calls.every(([menu]) => JSON.stringify(menu) === JSON.stringify(first)),
    ).toBe(true);
    f.items[0] = { ...f.items[0]!, evidenceId: randomUUID() };
    await expect(f.adapter.handle(callback(`m7C:${reference}`))).rejects.toMatchObject({
      code: 'idempotency_conflict',
      status: 409,
    });
    expect(f.menu).toHaveBeenCalledTimes(10);
  });
  it('separates actor and cache purposes and rejects expiry even when stored ciphertext remains', async () => {
    const f = new Harness();
    const [data] = await f.list();
    const reference = data!.slice(4);
    const choice = await f.state.evidence(f.actor, reference);
    expect(await f.state.choice(f.actor, reference)).toBeUndefined();
    expect(await f.state.evidence(f.actor, choice!.reportReference)).toBeUndefined();
    expect(
      await f.state.evidence({ kind: 'admin', userId: randomUUID() }, reference),
    ).toBeUndefined();
    const before = f.rows.size;
    f.now = new Date(f.now.getTime() + 300000);
    await expect(f.adapter.selection('123', reference)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(f.rows.size).toBe(before);
    expect(f.text).not.toHaveBeenCalled();
  });
  it('rejects borrowed or corrupted references and cached identity/type/schema substitution', async () => {
    const f = new Harness();
    const [data] = await f.list();
    const reference = data!.slice(4);
    f.items[0] = { ...f.items[0]!, snapshotSchemaVersion: 2 };
    await expect(f.adapter.selection('123', reference)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    f.rows.set(`telegram-admin-report-queue:evidence:${reference}`, '{}');
    await expect(f.adapter.selection('123', reference)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(f.text).not.toHaveBeenCalled();
  });
  it('propagates current native stale or revoked authority and never sends an old selected result', async () => {
    const f = new Harness();
    const [data] = await f.list();
    for (const [code, status] of [
      ['version_conflict', 409],
      ['forbidden', 403],
    ] as const) {
      f.metadata.mockRejectedValueOnce(new ApplicationError(code, 'error.m7.unavailable', status));
      await expect(f.adapter.handle(callback(data!))).rejects.toMatchObject({ code, status });
    }
    expect(f.text).not.toHaveBeenCalled();
    f.revoked = true;
    await expect(f.adapter.handle(callback(data!))).rejects.toMatchObject({ status: 401 });
  });
  it('rechecks session and both cache records after a native read waits', async () => {
    const f = new Harness();
    const reference = await f.state.putChoice(f.actor, 'report', f.report);
    f.metadata.mockImplementationOnce(() => {
      f.revoked = true;
      return Promise.resolve({ reportId: f.report.targetId, items: f.items });
    });
    await expect(f.adapter.handle(callback(`m7C:${reference}`))).rejects.toMatchObject({
      status: 401,
    });
    expect(f.menu).not.toHaveBeenCalled();
    f.revoked = false;
    const [data] = await f.list();
    f.metadata.mockImplementationOnce(() => {
      f.rows.delete(`telegram-admin-report-queue:choice:${reference}`);
      return Promise.resolve({ reportId: f.report.targetId, items: f.items });
    });
    await expect(f.adapter.selection('123', data!.slice(4))).rejects.toMatchObject({
      code: 'version_conflict',
    });
  });
  it('rejects malformed native output, unbounded or duplicate choices and unexpected content before delivery', async () => {
    const f = new Harness();
    const reference = await f.state.putChoice(f.actor, 'report', f.report);
    const result = { reportId: f.report.targetId, items: f.items };
    for (const bad of [
      { ...result, reportId: randomUUID() },
      { ...result, content: 'Secret prose' },
      { ...result, items: [...f.items, f.items[0]!] },
      { ...result, items: [f.items[0]!, f.items[0]!] },
      { ...result, items: [{ ...f.items[0]!, content: 'Secret prose' }] },
      { ...result, items: [{ ...f.items[0]!, evidenceType: 'unknown' }] },
    ]) {
      f.metadata.mockResolvedValueOnce(bad as typeof result);
      await expect(f.adapter.handle(callback(`m7C:${reference}`))).rejects.toMatchObject({
        code: 'internal_error',
        status: 500,
      });
    }
    expect(f.menu).not.toHaveBeenCalled();
    expect(f.text).not.toHaveBeenCalled();
  });
  it('handles an empty native list without creating a selection and sanitizes failed delivery', async () => {
    const f = new Harness();
    const reference = await f.state.putChoice(f.actor, 'report', f.report);
    f.items = [];
    expect(await f.adapter.handle(callback(`m7C:${reference}`))).toBe('notice');
    expect(f.text.mock.lastCall![0].text).toContain('admin.report.evidence_empty');
    expect(f.menu).not.toHaveBeenCalled();
    f.text.mockRejectedValueOnce(new Error('Provider secret'));
    await expect(f.adapter.handle(callback(`m7C:${reference}`))).rejects.toMatchObject({
      code: 'internal_error',
      message: 'error.m7.internal',
    });
    expect(await f.adapter.handle(callback(`m7T:${reference}`))).toBe('unhandled');
    await expect(f.adapter.handle(callback('m7J:bad'))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    const group = callback(`m7C:${reference}`);
    (group.callback_query as { message: { chat: { type: string } } }).message.chat.type = 'group';
    await expect(f.adapter.handle(group)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
