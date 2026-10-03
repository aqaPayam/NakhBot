import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GetReportReasonsQuerySchema, ReportReasonCatalogSchema } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import { M7ApiBoundary } from './m7-api-boundary.js';

const user = { kind: 'user' as const, userId: randomUUID() };
describe('authenticated restricted-data API boundary', () => {
  it('authenticates only bounded bearer credentials and passes the explicit audience', async () => {
    const authenticate = vi.fn(() => Promise.resolve(user));
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
    ).toEqual(user);
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
    const boundary = new M7ApiBoundary({ authenticate: () => Promise.resolve(user) });
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
    const boundary = new M7ApiBoundary({ authenticate: () => Promise.resolve(user) });
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
