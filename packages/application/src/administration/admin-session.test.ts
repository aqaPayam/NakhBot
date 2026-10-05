import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AdminSessionService,
  type VerifiedAdminMfaProof,
  type AdminSessionStore,
} from './admin-session.js';
const actor = { kind: 'user' as const, userId: randomUUID() },
  telegramUserId = '9000000001';
describe('server-verified admin session boundary', () => {
  it('retains only a bearer hash and projects fixed opaque credentials', async () => {
    const proof: VerifiedAdminMfaProof = {
      actorUserId: actor.userId,
      telegramUserId,
      proofId: randomUUID(),
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 300000),
    };
    const current = {
      actor: { kind: 'admin' as const, userId: actor.userId },
      telegramUserId,
      locale: 'en',
      expiresAt: new Date(Date.now() + 900000),
      mfaExpiresAt: proof.expiresAt,
    };
    const issue = vi.fn<AdminSessionStore['issue']>(() => Promise.resolve(current)),
      lookup = vi.fn(() => Promise.resolve(current)),
      revoke = vi.fn(() => Promise.resolve());
    const verify = vi.fn(() => Promise.resolve(proof));
    const sessions = new AdminSessionService({ issue, current: lookup, revoke }, { verify });
    const result = await sessions.issue({
      actor,
      telegramUserId,
      requestId: randomUUID(),
      proof: 'private-factor-assertion',
    });
    expect(Object.keys(result).sort()).toEqual(['adminSessionToken', 'expiresAt', 'mfaExpiresAt']);
    expect(result.adminSessionToken).toMatch(/^v1\.as\.[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(issue.mock.calls)).not.toContain(result.adminSessionToken);
    expect(JSON.stringify(issue.mock.calls)).not.toContain('private-factor-assertion');
    expect(issue.mock.calls[0]?.[0].tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      await sessions.authenticate({ bearerToken: result.adminSessionToken, audience: 'admin' }),
    ).toEqual(current.actor);
    expect(await sessions.current(telegramUserId)).toEqual(current);
    lookup.mockClear();
    expect(
      await sessions.authenticate({ bearerToken: result.adminSessionToken, audience: 'user' }),
    ).toBeUndefined();
    expect(
      await sessions.authenticate({ bearerToken: 'v1.ad.invalid', audience: 'admin' }),
    ).toBeUndefined();
    expect(await sessions.current('0')).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rejects substituted server proof identity and sanitizes factor-provider failures', async () => {
    const issue = vi.fn(() => Promise.resolve(undefined));
    const verify = vi.fn(() =>
      Promise.resolve({
        actorUserId: randomUUID(),
        telegramUserId,
        proofId: randomUUID(),
        verifiedAt: new Date(),
        expiresAt: new Date(),
      }),
    );
    const service = new AdminSessionService(
      { issue, current: () => Promise.resolve(undefined), revoke: () => Promise.resolve() },
      { verify },
    );
    const input = { actor, telegramUserId, requestId: randomUUID(), proof: 'private-otp' };
    await expect(service.issue(input)).rejects.toMatchObject({ status: 401 });
    expect(issue).not.toHaveBeenCalled();
    verify.mockImplementation(() => Promise.reject(new Error('private-secret-diagnostic')));
    await expect(service.issue(input)).rejects.toMatchObject({
      status: 500,
      message: 'error.m7.internal',
    });
    await expect(
      service.issue({ ...input, actor: { ...actor, kind: 'admin' } }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
