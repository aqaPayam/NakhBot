import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  AdminActionAuthorizationService,
  type AdminAuthorizationFacts,
  type AdminAuthorizationStore,
} from '../administration/admin-authorization.js';
import {
  GetM7OperationalHealthHandler,
  PrepareM7OperationalHealthHandler,
  M7_OPERATIONAL_HEALTH_PERMISSIONS,
} from './operational-health.js';
const actor = { kind: 'admin' as const, userId: randomUUID() },
  adminUserId = randomUUID();
const sample = {
  sampledAt: '2026-10-05T12:00:00.000Z',
  oldestPendingReportAgeSeconds: 10,
  oldestInReviewAgeSeconds: 0,
  thresholdMismatchCount: 1,
  adminLogMismatchCount: 2,
  snapshotIntegrityFailureCount: 3,
  supportLimitMismatchCount: 4,
  appealUniquenessMismatchCount: 5,
};
function fixture(): Readonly<{
  authorization: AdminActionAuthorizationService;
  values: Map<string, string>;
  measure: Mock<() => Promise<typeof sample>>;
  set: (value: Partial<AdminAuthorizationFacts>) => void;
  expire: () => void;
  prepare: PrepareM7OperationalHealthHandler;
  get: GetM7OperationalHealthHandler;
}> {
  let current: AdminAuthorizationFacts = {
    adminUserId,
    actorUserId: actor.userId,
    adminActive: true,
    activePermissions: [...M7_OPERATIONAL_HEALTH_PERMISSIONS],
  };
  let now = 1000000;
  const facts: AdminAuthorizationStore = {
    loadCurrent: () => Promise.resolve(current),
    loadByTelegramIdentity: () => Promise.resolve(current),
  };
  const values = new Map<string, string>();
  const authorization = new AdminActionAuthorizationService(
    facts,
    {
      get: (id) => Promise.resolve(values.get(id)),
      putIfAbsent: (id, value) => {
        if (values.has(id)) return Promise.resolve(false);
        values.set(id, value);
        return Promise.resolve(true);
      },
    },
    Buffer.alloc(32, 7),
    () => now,
  );
  const measure = vi.fn(() => Promise.resolve({ ...sample }));
  return {
    authorization,
    values,
    measure,
    set: (value: Partial<AdminAuthorizationFacts>) => {
      current = { ...current, ...value };
    },
    expire: () => {
      now += 1000000;
    },
    prepare: new PrepareM7OperationalHealthHandler(
      { get: () => Promise.resolve({ adminUserId, telegramUserId: '9000000001' }) },
      facts,
      authorization,
    ),
    get: new GetM7OperationalHealthHandler(facts, authorization, { measure }),
  };
}
describe('operational health current composite authority', () => {
  it('issues an opaque global capability and reads only fixed aggregates concurrently', async () => {
    const f = fixture(),
      query = { actor, requestId: randomUUID() };
    const { adminActionToken } = await f.prepare.execute(query, actor);
    expect(adminActionToken).not.toContain(actor.userId);
    expect(f.measure).not.toHaveBeenCalled();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => f.get.execute({ ...query, adminActionToken }, actor)),
    );
    expect(results).toEqual(Array.from({ length: 10 }, () => sample));
    expect(f.values.size).toBe(1);
  });
  it.each(M7_OPERATIONAL_HEALTH_PERMISSIONS)(
    'requires %s both at preparation and on later read',
    async (missing) => {
      const f = fixture(),
        query = { actor, requestId: randomUUID() };
      const token = await f.prepare.execute(query, actor);
      f.set({ activePermissions: M7_OPERATIONAL_HEALTH_PERMISSIONS.filter((p) => p !== missing) });
      await expect(f.prepare.execute(query, actor)).rejects.toMatchObject({ status: 403 });
      await expect(f.get.execute({ ...query, ...token }, actor)).rejects.toMatchObject({
        status: 403,
      });
      expect(f.measure).not.toHaveBeenCalled();
    },
  );
  it.each(['revoked', 'disabled', 'expired', 'cache-loss'] as const)(
    'withholds sampled data after %s during the read',
    async (change) => {
      const f = fixture(),
        query = { actor, requestId: randomUUID() },
        token = await f.prepare.execute(query, actor);
      f.measure.mockImplementation(() => {
        if (change === 'revoked') f.set({ activePermissions: ['view_reports'] });
        if (change === 'disabled') f.set({ adminActive: false });
        if (change === 'expired') f.expire();
        if (change === 'cache-loss') f.values.clear();
        return Promise.resolve({ ...sample });
      });
      await expect(f.get.execute({ ...query, ...token }, actor)).rejects.toMatchObject({
        status: 403,
      });
    },
  );
  it('rejects borrowed identity and target-specific capability before sampling', async () => {
    const f = fixture(),
      query = { actor, requestId: randomUUID() },
      token = await f.prepare.execute(query, actor);
    await expect(
      f.get.execute({ ...query, ...token }, { kind: 'admin', userId: randomUUID() }),
    ).rejects.toMatchObject({ status: 401 });
    const adminActionToken = await f.authorization.issue({
      actorUserId: actor.userId,
      telegramUserId: '9000000001',
      scope: {
        commandCode: 'moderation.operational-health',
        requiredPermission: 'view_reports',
        targetType: 'moderation_health',
        targetId: randomUUID(),
        expectedTargetVersion: 1,
      },
    });
    await expect(f.get.execute({ ...query, adminActionToken }, actor)).rejects.toMatchObject({
      status: 403,
    });
    expect(f.measure).not.toHaveBeenCalled();
  });
  it.each([
    { ...sample, supportLimitMismatchCount: 0.5 },
    { ...sample, thresholdMismatchCount: -1 },
    { ...sample, adminLogMismatchCount: NaN },
    { ...sample, sampledAt: 'invalidZ' },
    { ...sample, privateText: 'must never leave' },
  ])('rejects malformed or expanded aggregates', async (value) => {
    const f = fixture(),
      query = { actor, requestId: randomUUID() },
      token = await f.prepare.execute(query, actor);
    f.measure.mockResolvedValue(value);
    await expect(f.get.execute({ ...query, ...token }, actor)).rejects.toMatchObject({
      status: 500,
    });
  });
});
