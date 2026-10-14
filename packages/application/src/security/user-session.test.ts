import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  UserSessionService,
  type UserSessionGrant,
  type UserSessionStore,
} from './user-session.js';

type SessionMocks = { [K in keyof UserSessionStore]: Mock<UserSessionStore[K]> };
function fixture(): {
  life: { userId: string; productEpoch: number };
  grant: UserSessionGrant;
  store: SessionMocks;
  key: Buffer;
  service: UserSessionService;
} {
  const life = { userId: randomUUID(), productEpoch: 0 };
  const at = new Date();
  const grant: UserSessionGrant = {
    ...life,
    id: randomUUID(),
    issuedAt: at,
    expiresAt: new Date(at.getTime() + 900000),
  };
  const store: SessionMocks = {
    issue: vi.fn<UserSessionStore['issue']>(() => Promise.resolve(grant)),
    current: vi.fn<UserSessionStore['current']>(() => Promise.resolve(grant)),
    revoke: vi.fn<UserSessionStore['revoke']>(() => Promise.resolve()),
  };
  const key = Buffer.alloc(32, 103);
  return { life, grant, store, key, service: new UserSessionService(store, key) };
}
describe('opaque original-life user credentials', () => {
  it('requires a native grant for every use and never exposes owner or grant in the credential', async () => {
    const f = fixture();
    const issued = await f.service.issue(f.life, randomUUID());
    expect(issued.userSessionToken).not.toContain(f.life.userId);
    expect(issued.userSessionToken).not.toContain(f.grant.id);
    expect(
      await f.service.authenticate({ bearerToken: issued.userSessionToken, audience: 'user' }),
    ).toEqual({ ...f.life, kind: 'user', sessionGrantId: f.grant.id });
    expect(f.store.current).toHaveBeenCalledWith({ ...f.life, grantId: f.grant.id }, f.grant.id);
    vi.mocked(f.store.current).mockResolvedValue(undefined);
    expect(
      await f.service.authenticate({ bearerToken: issued.userSessionToken, audience: 'user' }),
    ).toBeUndefined();
  });
  it('rejects wrong keys, changed ciphertext, audience substitution and noncanonical encoding before native lookup', async () => {
    const f = fixture(),
      token = (await f.service.issue(f.life, randomUUID())).userSessionToken;
    const other = new UserSessionService(f.store, Buffer.alloc(32, 104));
    expect(await other.authenticate({ bearerToken: token, audience: 'user' })).toBeUndefined();
    for (const bearerToken of [
      token + '=',
      token.replace('v1.us.', 'v1.as.'),
      token.slice(0, -2) + 'zz',
      'invalid',
    ])
      expect(await f.service.authenticate({ bearerToken, audience: 'user' })).toBeUndefined();
    expect(await f.service.authenticate({ bearerToken: token, audience: 'admin' })).toBeUndefined();
    expect(f.store.current).not.toHaveBeenCalled();
  });
  it('captures the original life before awaiting issuance and rejects any native scope substitution', async () => {
    const f = fixture();
    let release!: (grant: UserSessionGrant) => void;
    vi.mocked(f.store.issue).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = f.service.issue(f.life, randomUUID());
    f.life.productEpoch = 1;
    release(f.grant);
    const token = (await pending).userSessionToken;
    expect(
      (await f.service.authenticate({ bearerToken: token, audience: 'user' }))?.productEpoch,
    ).toBe(0);
    vi.mocked(f.store.current).mockResolvedValue({ ...f.grant, productEpoch: 1 });
    expect(await f.service.authenticate({ bearerToken: token, audience: 'user' })).toBeUndefined();
    vi.mocked(f.store.current).mockResolvedValue({ ...f.grant, userId: randomUUID() });
    expect(await f.service.authenticate({ bearerToken: token, audience: 'user' })).toBeUndefined();
  });
  it('requires exact owner and original epoch for revocation and bounds trusted issuance inputs', async () => {
    const f = fixture(),
      token = (await f.service.issue(f.life, randomUUID())).userSessionToken;
    for (const life of [
      { ...f.life, productEpoch: 1 },
      { ...f.life, userId: randomUUID() },
    ])
      await expect(f.service.revoke(life, token, randomUUID())).rejects.toMatchObject({
        status: 401,
      });
    expect(f.store.revoke).not.toHaveBeenCalled();
    const request = randomUUID();
    await f.service.revoke(f.life, token, request);
    expect(f.store.revoke).toHaveBeenCalledWith(f.life, f.grant.id, request);
    for (const productEpoch of [-1, 0.5, 2147483648, NaN])
      await expect(
        f.service.issue({ ...f.life, productEpoch }, randomUUID()),
      ).rejects.toMatchObject({ status: 401 });
    expect(() => new UserSessionService(f.store, Buffer.alloc(31))).toThrow();
  });
});
