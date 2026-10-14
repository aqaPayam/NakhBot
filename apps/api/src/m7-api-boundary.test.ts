import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GetReportReasonsQuerySchema, ReportReasonCatalogSchema } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import { M7ApiBoundary } from './m7-api-boundary.js';

const user = { kind: 'user' as const, userId: randomUUID() };
const sessionGrantId = randomUUID();
describe('authenticated restricted-data API boundary', () => {
  it('rejects actor-only credentials and client-selected life metadata', async () => {
    const request = { headers: { authorization: 'Bearer privatecredential' } };
    await expect(
      new M7ApiBoundary({ authenticate: () => Promise.resolve(user) }).user(request),
    ).rejects.toMatchObject({ status: 401 });
    const boundary = new M7ApiBoundary({
      authenticate: () => Promise.resolve({ ...user, productEpoch: 0, sessionGrantId }),
    });
    const verified = await boundary.user(request);
    expect(() =>
      boundary.parse(
        GetReportReasonsQuerySchema,
        { actor: verified, requestId: randomUUID() },
        verified,
      ),
    ).toThrow();
    const execute = vi.fn(() => Promise.resolve({ items: [] }));
    await expect(
      boundary.userResult(ReportReasonCatalogSchema, { ...verified }, execute),
    ).rejects.toMatchObject({ status: 401 });
    expect(execute).not.toHaveBeenCalled();
  });
  it('revalidates the original bearer after awaited work and withholds results after revocation or life changes', async () => {
    for (const changed of [
      undefined,
      { ...user, productEpoch: 1, sessionGrantId },
      { ...user, productEpoch: 0, sessionGrantId: randomUUID() },
    ]) {
      const authenticate = vi
        .fn()
        .mockResolvedValueOnce({ ...user, productEpoch: 0, sessionGrantId })
        .mockResolvedValueOnce(changed);
      const boundary = new M7ApiBoundary({ authenticate });
      const request = { headers: { authorization: 'Bearer originalcredential' } };
      const verified = await boundary.user(request);
      await expect(
        boundary.userResult(ReportReasonCatalogSchema, verified, async () => {
          await Promise.resolve();
          request.headers.authorization = 'Bearer replacementcredential';
          return { items: [] };
        }),
      ).rejects.toMatchObject({ status: 401 });
      expect(authenticate).toHaveBeenLastCalledWith({
        bearerToken: 'originalcredential',
        audience: 'user',
      });
    }
  });
  it('authenticates only bounded bearer credentials and passes the explicit audience', async () => {
    const authenticate = vi.fn(() => Promise.resolve({ ...user, productEpoch: 0, sessionGrantId }));
    const boundary = new M7ApiBoundary({ authenticate });
    for (const authorization of [
      undefined,
      'Basic private',
      'Bearer short',
      `Bearer ${'x'.repeat(4097)}`,
      ['Bearer privatecredential'],
    ])
      await expect(boundary.actor({ headers: { authorization } }, 'user')).rejects.toMatchObject({
        code: 'unauthorized',
      });
    expect(authenticate).not.toHaveBeenCalled();
    expect(
      await boundary.actor({ headers: { authorization: 'Bearer privatecredential' } }, 'user'),
    ).toEqual({ ...user, productEpoch: 0, sessionGrantId });
    expect(authenticate).toHaveBeenCalledWith({
      bearerToken: 'privatecredential',
      audience: 'user',
    });
  });
  it('denies missing identities, wrong audiences and malformed verifier identities', async () => {
    for (const identity of [
      undefined,
      { kind: 'admin' as const, userId: randomUUID() },
      { ...user, userId: 'invalid' },
    ])
      await expect(
        new M7ApiBoundary({ authenticate: () => Promise.resolve(identity) }).actor(
          { headers: { authorization: 'Bearer privatecredential' } },
          'user',
        ),
      ).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('rejects forged actors, unknown fields and malformed request IDs before invoking a handler', () => {
    const boundary = new M7ApiBoundary({
      authenticate: () => Promise.resolve({ ...user, productEpoch: 0, sessionGrantId }),
    });
    const query = { actor: user, requestId: randomUUID() };
    expect(boundary.parse(GetReportReasonsQuerySchema, query, user)).toEqual(query);
    for (const value of [
      { ...query, privateText: 'restricted' },
      { ...query, requestId: 'invalid' },
      { ...query, actor: { ...user, userId: randomUUID() } },
    ])
      expect(() => boundary.parse(GetReportReasonsQuerySchema, value, user)).toThrow(
        ApplicationError,
      );
  });
  it('rejects content or identities accidentally added to an otherwise valid response', async () => {
    const boundary = new M7ApiBoundary({
      authenticate: () => Promise.resolve({ ...user, productEpoch: 0, sessionGrantId }),
    });
    const response = { items: [{ code: 'harassment', labelKey: 'report.reason.harassment' }] };
    expect(
      await boundary.result(ReportReasonCatalogSchema, () => Promise.resolve(response)),
    ).toEqual(response);
    await expect(
      boundary.result(ReportReasonCatalogSchema, () =>
        Promise.resolve({ ...response, reportText: 'private' }),
      ),
    ).rejects.toMatchObject({ code: 'internal_error', message: 'error.m7.internal' });
  });
  it('discards restricted messages, error details and causes from handlers and authenticators', async () => {
    const privateText = 'PRIVATE CHAT AND TOKEN';
    const boundary = new M7ApiBoundary({
      authenticate: () => Promise.reject(new Error(privateText)),
    });
    await expect(
      boundary.actor({ headers: { authorization: 'Bearer privatecredential' } }, 'user'),
    ).rejects.toMatchObject({ code: 'internal_error', message: 'error.m7.internal' });
    for (const error of [
      new Error(privateText),
      new ApplicationError('report_unavailable', privateText, 409, { text: privateText }),
    ]) {
      try {
        await boundary.result(ReportReasonCatalogSchema, () => Promise.reject(error));
      } catch (safe) {
        expect(safe).toBeInstanceOf(ApplicationError);
        expect((safe as ApplicationError).details).toBeUndefined();
        expect((safe as Error).cause).toBeUndefined();
        expect((safe as Error).message).not.toContain(privateText);
      }
    }
  });
});
