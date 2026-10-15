import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  AccountControlSessionService,
  type AccountControlGrant,
  type AccountControlSessionStore,
} from './account-control-session.js';

type SessionMocks = {
  [K in keyof AccountControlSessionStore]-?: Mock<NonNullable<AccountControlSessionStore[K]>>;
};
function fixture(): {
  life: { userId: string; productEpoch: number };
  grant: AccountControlGrant;
  store: SessionMocks;
  key: Buffer;
  service: AccountControlSessionService;
} {
  const life = { userId: randomUUID(), productEpoch: 0 };
  const at = new Date();
  const grant: AccountControlGrant = {
    ...life,
    id: randomUUID(),
    issuedAt: at,
    expiresAt: new Date(at.getTime() + 900000),
  };
  const store: SessionMocks = {
    issue: vi.fn<AccountControlSessionStore['issue']>(() => Promise.resolve(grant)),
    current: vi.fn<AccountControlSessionStore['current']>(() => Promise.resolve(grant)),
    currentForReturn: vi.fn<NonNullable<AccountControlSessionStore['currentForReturn']>>(() =>
      Promise.resolve(grant),
    ),
    revoke: vi.fn<AccountControlSessionStore['revoke']>(() => Promise.resolve()),
  };
  const key = Buffer.alloc(32, 103);
  return { life, grant, store, key, service: new AccountControlSessionService(store, key) };
}
describe('opaque limited original-life account controls', () => {
  it('authenticates only original Return scope while ordinary control remains retired', async () => {
    const f = fixture(),
      token = (await f.service.issue(f.life, randomUUID())).accountControlToken;
    f.store.current.mockResolvedValue(undefined);
    expect(
      await f.service.authenticate({ bearerToken: token, audience: 'account_control' }),
    ).toBeUndefined();
    const actor = await f.service.authenticateReturn({
      bearerToken: token,
      audience: 'account_return',
    });
    expect(actor).toEqual({
      ...f.life,
      kind: 'user',
      scope: 'account_return',
      controlGrantId: f.grant.id,
    });
    expect(Object.isFrozen(actor)).toBe(true);
    f.store.currentForReturn.mockResolvedValue(undefined);
    expect(
      await f.service.authenticateReturn({ bearerToken: token, audience: 'account_return' }),
    ).toBeUndefined();
    const oldStore = { issue: f.store.issue, current: f.store.current, revoke: f.store.revoke };
    expect(
      await new AccountControlSessionService(oldStore, f.key).authenticateReturn({
        bearerToken: token,
        audience: 'account_return',
      }),
    ).toBeUndefined();
  });
  it('denies Return ciphertext/audience changes and native identity, epoch or grant substitutions', async () => {
    const f = fixture(),
      token = (await f.service.issue(f.life, randomUUID())).accountControlToken;
    for (const bearerToken of [token + '=', token.replace('v1.ac.', 'v1.us.'), 'invalid'])
      expect(
        await f.service.authenticateReturn({ bearerToken, audience: 'account_return' }),
      ).toBeUndefined();
    expect(
      await f.service.authenticateReturn({
        bearerToken: token,
        audience: 'account_control' as 'account_return',
      }),
    ).toBeUndefined();
    expect(f.store.currentForReturn).not.toHaveBeenCalled();
    for (const change of [{ userId: randomUUID() }, { productEpoch: 1 }, { id: randomUUID() }]) {
      f.store.currentForReturn.mockResolvedValue({ ...f.grant, ...change });
      expect(
        await f.service.authenticateReturn({ bearerToken: token, audience: 'account_return' }),
      ).toBeUndefined();
    }
  });
  it('retains the ciphertext original epoch across a native Return authentication wait', async () => {
    const f = fixture(),
      token = (await f.service.issue(f.life, randomUUID())).accountControlToken;
    let resolve!: (grant: AccountControlGrant) => void;
    f.store.currentForReturn.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const result = f.service.authenticateReturn({ bearerToken: token, audience: 'account_return' });
    f.life.productEpoch = 1;
    resolve(f.grant);
    expect((await result)?.productEpoch).toBe(0);
  });
  it('requires a native grant for every use and never exposes owner or grant in the credential', async () => {
    const f = fixture();
    const issued = await f.service.issue(f.life, randomUUID());
    expect(issued.accountControlToken).not.toContain(f.life.userId);
    expect(issued.accountControlToken).not.toContain(f.grant.id);
    expect(
      await f.service.authenticate({
        bearerToken: issued.accountControlToken,
        audience: 'account_control',
      }),
    ).toEqual({ ...f.life, kind: 'user', scope: 'account_control', controlGrantId: f.grant.id });
    expect(f.store.current).toHaveBeenCalledWith({ ...f.life, grantId: f.grant.id }, f.grant.id);
    vi.mocked(f.store.current).mockResolvedValue(undefined);
    expect(
      await f.service.authenticate({
        bearerToken: issued.accountControlToken,
        audience: 'account_control',
      }),
    ).toBeUndefined();
  });
  it('rejects wrong keys, changed ciphertext, audience substitution and noncanonical encoding before native lookup', async () => {
    const f = fixture(),
      token = (await f.service.issue(f.life, randomUUID())).accountControlToken;
    const other = new AccountControlSessionService(f.store, Buffer.alloc(32, 104));
    expect(
      await other.authenticate({ bearerToken: token, audience: 'account_control' }),
    ).toBeUndefined();
    for (const bearerToken of [
      token + '=',
      token.replace('v1.ac.', 'v1.as.'),
      token.slice(0, -2) + 'zz',
      'invalid',
    ])
      expect(
        await f.service.authenticate({ bearerToken, audience: 'account_control' }),
      ).toBeUndefined();
    expect(
      await f.service.authenticate({ bearerToken: token, audience: 'admin' as 'account_control' }),
    ).toBeUndefined();
    expect(f.store.current).not.toHaveBeenCalled();
  });
  it('captures the original life before awaiting issuance and rejects any native scope substitution', async () => {
    const f = fixture();
    let release!: (grant: AccountControlGrant) => void;
    vi.mocked(f.store.issue).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = f.service.issue(f.life, randomUUID());
    f.life.productEpoch = 1;
    release(f.grant);
    const token = (await pending).accountControlToken;
    expect(
      (await f.service.authenticate({ bearerToken: token, audience: 'account_control' }))
        ?.productEpoch,
    ).toBe(0);
    vi.mocked(f.store.current).mockResolvedValue({ ...f.grant, productEpoch: 1 });
    expect(
      await f.service.authenticate({ bearerToken: token, audience: 'account_control' }),
    ).toBeUndefined();
    vi.mocked(f.store.current).mockResolvedValue({ ...f.grant, userId: randomUUID() });
    expect(
      await f.service.authenticate({ bearerToken: token, audience: 'account_control' }),
    ).toBeUndefined();
  });
  it('requires exact owner and original epoch for revocation and bounds trusted issuance inputs', async () => {
    const f = fixture(),
      token = (await f.service.issue(f.life, randomUUID())).accountControlToken;
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
    expect(() => new AccountControlSessionService(f.store, Buffer.alloc(31))).toThrow();
  });
});

it('separates product and limited controls even with the same master key and rewritten prefixes', async () => {
  const f = fixture();
  const { UserSessionService } = await import('./user-session.js');
  const product = new UserSessionService(f.store, f.key);
  const control = (await f.service.issue(f.life, randomUUID())).accountControlToken;
  const normal = (await product.issue(f.life, randomUUID())).userSessionToken;
  for (const bearerToken of [normal, normal.replace('v1.us.', 'v1.ac.')])
    expect(
      await f.service.authenticate({ bearerToken, audience: 'account_control' }),
    ).toBeUndefined();
  for (const bearerToken of [control, control.replace('v1.ac.', 'v1.us.')])
    expect(await product.authenticate({ bearerToken, audience: 'user' })).toBeUndefined();
  expect(f.store.current).not.toHaveBeenCalled();
});
