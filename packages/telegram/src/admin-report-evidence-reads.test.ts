import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@nakh/domain';
import type {
  ConfirmedEvidenceReveals,
  OpaqueTokenStore,
  PrepareSelectedReportEvidenceRevealHandler,
} from '@nakh/application';
import { TelegramAdminReportEvidenceReads } from './admin-report-evidence-reads.js';
import { TelegramAdminSafetyMutationVault } from './admin-safety-mutation-vault.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';
import type { TelegramAdminSessionVerifier } from './admin-session.js';

class Harness {
  public now = new Date();
  public actor = { kind: 'admin' as const, userId: randomUUID() };
  public revoked = false;
  public rows = new Map<string, string>();
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
  public tokens: OpaqueTokenStore = {
    get: (key) => Promise.resolve(this.rows.get(key)),
    putIfAbsent: (key, value) => {
      const absent = !this.rows.has(key);
      if (absent) this.rows.set(key, value);
      return Promise.resolve(absent);
    },
  };
  public vault = new TelegramAdminSafetyMutationVault(
    'report-evidence',
    this.tokens,
    new Uint8Array(32).fill(1),
    new Uint8Array(32).fill(2),
    () => this.now.getTime(),
  );
  public actions = vi
    .fn<PrepareSelectedReportEvidenceRevealHandler['execute']>()
    .mockResolvedValue({
      adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    });
  public prepare = vi
    .fn<ConfirmedEvidenceReveals['prepare']>()
    .mockResolvedValue(`v1.cf.${'c'.repeat(16)}.${'d'.repeat(16)}`);
  public execute = vi.fn<ConfirmedEvidenceReveals['execute']>().mockImplementation(() =>
    Promise.resolve({
      logId: randomUUID(),
      result: 'succeeded',
      safeCode: 'evidence_revealed',
      recordedAt: this.now,
      replayed: false,
      value: undefined,
    }),
  );
  public text = vi.fn<TelegramAdminTextDelivery['text']>().mockResolvedValue(undefined);
  public menu = vi
    .fn<TelegramAdminTextDelivery['reportEvidenceMenu']>()
    .mockResolvedValue(undefined);
  public adapter = new TelegramAdminReportEvidenceReads(
    this.sessions,
    { execute: this.actions },
    { prepare: this.prepare, execute: this.execute },
    this.vault,
    new Uint8Array(32).fill(2),
    { text: this.text, reportEvidenceMenu: this.menu },
    { render: (_locale, intent) => intent.key },
    { text: this.text, retainedPhoto: () => Promise.resolve() },
    () => this.now,
  );
  public input = {
    choice: {
      report: {
        kind: 'report' as const,
        targetId: randomUUID(),
        queueActionToken: `v1.ad.${'e'.repeat(16)}.${'f'.repeat(16)}`,
        expectedVersion: 1,
      },
      evidence: {
        reportReference: 'g'.repeat(22),
        evidenceId: randomUUID(),
        evidenceType: 'photo' as const,
        snapshotSchemaVersion: 1,
      },
    },
    reason: '  Review selected request  ',
    operationId: 'operation',
    occurredAt: this.now.toISOString(),
  };
}
function callback(reference: string, code = 'K', sender = 123): unknown {
  return {
    update_id: 3,
    callback_query: {
      data: `m7${code}:${reference}`,
      from: { id: sender, is_bot: false },
      message: { chat: { type: 'private', id: sender } },
    },
  };
}
describe('separately confirmed Report evidence read', () => {
  it('converges concurrent preparation, binds immutable evidence and retries the exact saved command', async () => {
    const f = new Harness();
    const refs = await Promise.all(
      Array.from({ length: 20 }, () => f.adapter.prepare('123', f.input)),
    );
    expect(new Set(refs).size).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.actions.mock.calls[0]![0]).toMatchObject({
      reportId: f.input.choice.report.targetId,
      expectedReportVersion: 1,
      evidenceId: f.input.choice.evidence.evidenceId,
    });
    expect(f.prepare.mock.calls[0]![0].data).toMatchObject({
      reason: 'Review selected request',
    });
    expect(f.menu.mock.calls[0]![0].text).toContain('admin.report.evidence_read_effect');
    const raw = JSON.stringify([...f.rows.values()]);
    for (const secret of [
      f.input.choice.report.targetId,
      f.actor.userId,
      'Review selected request',
    ])
      expect(raw).not.toContain(secret);
    const selected = await f.vault.resolve(f.actor, refs[0]!);
    expect(await f.vault.confirmed(f.actor, refs[0]!)).toBeUndefined();
    await Promise.all(Array.from({ length: 20 }, () => f.adapter.handle(callback(refs[0]!))));
    expect(f.execute).toHaveBeenCalledTimes(20);
    for (const call of f.execute.mock.calls) expect(call).toEqual([selected!.command, f.actor]);
    await expect(f.adapter.handle(callback(refs[0]!, 'Q'))).rejects.toMatchObject({
      code: 'version_conflict',
    });
  });
  it('delivers content only on the first native success and fails closed if the session changes after execution', async () => {
    const f = new Harness(),
      ref = await f.adapter.prepare('123', f.input);
    const result: Awaited<ReturnType<ConfirmedEvidenceReveals['execute']>> = {
      logId: randomUUID(),
      result: 'succeeded',
      safeCode: 'evidence_revealed',
      recordedAt: f.now,
      replayed: false,
      value: {
        evidenceId: f.input.choice.evidence.evidenceId,
        snapshotSchemaVersion: 1,
        accessedAt: f.now.toISOString(),
        content: {
          evidenceType: 'message',
          messageId: randomUUID(),
          messageType: 'text',
          content: 'Restricted evidence text',
          createdAt: f.now.toISOString(),
        },
      },
    };
    f.execute.mockResolvedValue({ ...result, replayed: true }).mockResolvedValueOnce(result);
    await Promise.all(Array.from({ length: 10 }, () => f.adapter.handle(callback(ref))));
    expect(
      f.text.mock.calls.filter(([input]) => input.text === 'Restricted evidence text'),
    ).toHaveLength(1);
    const other = new Harness(),
      next = await other.adapter.prepare('123', other.input);
    other.execute.mockImplementation(() => {
      other.revoked = true;
      return Promise.resolve(result);
    });
    await expect(other.adapter.handle(callback(next))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(other.text).not.toHaveBeenCalled();
  });
  it('denies changed evidence, Report version and reason retries, cross-purpose state and mixed confirm/cancel winners', async () => {
    const f = new Harness(),
      ref = await f.adapter.prepare('123', f.input),
      selected = (await f.vault.resolve(f.actor, ref))!;
    await expect(
      f.adapter.prepare('123', { ...f.input, reason: 'Changed reason' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      f.adapter.prepare('123', {
        ...f.input,
        choice: { ...f.input.choice, report: { ...f.input.choice.report, expectedVersion: 2 } },
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      f.adapter.prepare('123', {
        ...f.input,
        choice: {
          ...f.input.choice,
          evidence: { ...f.input.choice.evidence, evidenceId: randomUUID() },
        },
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    for (const purpose of [
      'support',
      'appeal-review',
      'appeal-unban',
      'report-assignment',
      'report-decision',
      'report-account',
      'report-photo',
    ] as const) {
      const vault = new TelegramAdminSafetyMutationVault(
        purpose,
        f.tokens,
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
      f.rows.set(
        `telegram-admin-${purpose}-mutation:${ref}`,
        f.rows.get(`telegram-admin-report-evidence-mutation:${ref}`)!,
      );
      await expect(vault.resolve(f.actor, ref)).resolves.toBeUndefined();
    }
    await expect(
      f.vault.retainPrepared(
        f.actor,
        {
          ...selected,
          command: {
            ...selected.command,
            data: { ...selected.command.data, ...{ expectedTargetVersion: 1 } },
          },
        },
        'extra',
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        f.vault.decide(f.actor, ref, index % 2 ? 'confirm' : 'cancel'),
      ),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(10);
  });
  it('binds private sessions, cancels without executing and fails closed on expiry/cache loss', async () => {
    const f = new Harness(),
      ref = await f.adapter.prepare('123', { ...f.input, reason: '😀'.repeat(1024) });
    expect(f.menu.mock.calls[0]![0].text.length).toBeLessThanOrEqual(3500);
    await expect(f.adapter.handle(callback(ref, 'K', 124))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await f.adapter.handle(callback(ref, 'Q'));
    await expect(f.adapter.handle(callback(ref))).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect(f.execute).not.toHaveBeenCalled();
    const other = new Harness(),
      second = await other.adapter.prepare('123', other.input);
    other.now = new Date(other.now.getTime() + 300000);
    await expect(other.adapter.handle(callback(second))).rejects.toMatchObject({
      code: 'forbidden',
    });
    const lost = new Harness(),
      third = await lost.adapter.prepare('123', lost.input);
    lost.rows.clear();
    await expect(lost.adapter.handle(callback(third))).rejects.toMatchObject({ code: 'forbidden' });
    expect(lost.execute).not.toHaveBeenCalled();
  });
  it('rechecks session before preview and confirmation and sanitizes native/provider failures', async () => {
    const f = new Harness();
    f.prepare.mockImplementation(() => {
      f.revoked = true;
      return Promise.resolve(`v1.cf.${'c'.repeat(16)}.${'d'.repeat(16)}`);
    });
    await expect(f.adapter.prepare('123', f.input)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.menu).not.toHaveBeenCalled();
    const other = new Harness(),
      ref = await other.adapter.prepare('123', other.input);
    other.revoked = true;
    await expect(other.adapter.handle(callback(ref))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(other.execute).not.toHaveBeenCalled();
    other.revoked = false;
    other.execute.mockRejectedValue(new Error('private credentials/prose'));
    await expect(other.adapter.handle(callback(ref))).rejects.toMatchObject({
      message: 'error.m7.internal',
    });
    await expect(other.adapter.handle(callback(ref, 'h'))).resolves.toBe('unhandled');
    await expect(other.adapter.handle(callback('malformed'))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('supported evidence read availability', () => {
  it('preserves all five types, immutable target binding and safe native rejection', async () => {
    const f = new Harness();
    for (const evidenceType of ['profile', 'photo', 'chat', 'message', 'unmatched_user'] as const) {
      const choice = { ...f.input.choice, evidence: { ...f.input.choice.evidence, evidenceType } };
      expect(await f.adapter.available('123', choice)).toBe(true);
      await f.adapter.prepare('123', { ...f.input, choice, operationId: evidenceType });
      expect(f.prepare.mock.lastCall![0].data).toMatchObject({
        evidenceId: choice.evidence.evidenceId,
      });
      expect(f.prepare.mock.lastCall![0].data).not.toHaveProperty('expectedTargetVersion');
    }
    f.actions.mockRejectedValueOnce(
      new ApplicationError('report_unavailable', 'error.m7.unavailable', 409),
    );
    expect(await f.adapter.available('123', f.input.choice)).toBe(false);
    f.actions.mockRejectedValueOnce(new Error('Private reader configuration'));
    await expect(f.adapter.available('123', f.input.choice)).rejects.toMatchObject({
      status: 500,
      message: 'error.m7.internal',
    });
  });
});
