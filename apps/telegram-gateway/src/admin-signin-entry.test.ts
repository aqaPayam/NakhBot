import { describe, expect, it, vi } from 'vitest';
import { TelegramAdministratorSignIn } from './admin-signin-entry.js';

const now = new Date('2026-11-04T15:00:00Z');
const identity = {
  userId: '00000000-0000-4000-8000-000000000001',
  productEpoch: 3,
  uiLocale: 'fa',
  notBefore: '2026-11-04T14:50:00Z',
};
const actor = {
  kind: 'user' as const,
  userId: identity.userId,
  productEpoch: 3,
  sessionGrantId: '00000000-0000-4000-8000-000000000002',
};
type Command = {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    text: string;
    from: { id: number; is_bot: boolean };
    chat: { id: number; type: string };
  };
};
const command = (): Command => ({
  update_id: 123,
  message: {
    message_id: 15,
    date: now.getTime() / 1000 - 1,
    text: '/admin_signin',
    from: { id: 42, is_bot: false },
    chat: { id: 42, type: 'private' },
  },
});
class Fixture {
  public readonly ports = {
    botId: '12345',
    now: () => now,
    limiter: {
      consume: vi.fn(() => Promise.resolve({ allowed: true, remaining: 4, retryAfterSeconds: 0 })),
    },
    eligible: vi.fn(() => Promise.resolve(identity as typeof identity | undefined)),
    credential: vi.fn(() => Promise.resolve(actor)),
    link: vi.fn(() => Promise.resolve('https://admin.test/#session=private')),
    send: vi.fn(() => Promise.resolve()),
  };
  public readonly entry = new TelegramAdministratorSignIn(this.ports);
}
const fixture = (): Fixture => new Fixture();
describe('private staff sign-in before product admission', () => {
  it('captures one original staff life and a stable retry command without granting MFA', async () => {
    const { ports, entry } = fixture();
    await entry.handle(command());
    await entry.handle(command());
    expect(ports.credential.mock.calls[0]).toEqual(ports.credential.mock.calls[1]);
    expect(ports.link).toHaveBeenCalledWith(actor, 'fa');
    expect(ports.send).toHaveBeenCalledWith('42', 'fa', 'https://admin.test/#session=private');
  });
  it('does not issue a first factor for non-staff or exhausted rate budgets', async () => {
    const { ports, entry } = fixture();
    ports.eligible.mockResolvedValue(undefined);
    await entry.handle(command());
    ports.limiter.consume.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    });
    await entry.handle(command());
    expect(ports.credential).not.toHaveBeenCalled();
    expect(ports.send).not.toHaveBeenCalled();
  });
  it.each(['old', 'future', 'group', 'bot', 'foreign', 'edited', 'unsafe'])(
    'quietly rejects %s provider authority',
    async (mode) => {
      const { ports, entry } = fixture(),
        body = command();
      if (mode === 'old') body.message.date -= 121;
      if (mode === 'future') body.message.date += 10;
      if (mode === 'group') body.message.chat.type = 'group';
      if (mode === 'bot') body.message.from.is_bot = true;
      if (mode === 'foreign') body.message.chat.id = 43;
      if (mode === 'edited') Object.assign(body, { edited_message: {} });
      if (mode === 'unsafe') body.update_id = Number.MAX_SAFE_INTEGER + 1;
      expect(await entry.handle(body)).toBe('notice');
      expect(ports.credential).not.toHaveBeenCalled();
      expect(ports.send).not.toHaveBeenCalled();
    },
  );
  it('rejects a provider command predating staff assignment or a new product life', async () => {
    const { ports, entry } = fixture();
    ports.eligible.mockResolvedValue({ ...identity, notBefore: now.toISOString() });
    await entry.handle(command());
    expect(ports.credential).not.toHaveBeenCalled();
  });
  it('does not promote a captured actor when eligibility changes across issuance', async () => {
    const { ports, entry } = fixture();
    ports.eligible
      .mockResolvedValueOnce(identity)
      .mockResolvedValue({ ...identity, productEpoch: 4 });
    await entry.handle(command());
    expect(ports.link).not.toHaveBeenCalled();
  });
  it('does not hand off a substituted credential', async () => {
    const { ports, entry } = fixture();
    ports.credential.mockResolvedValue({ ...actor, productEpoch: 4 });
    await entry.handle(command());
    expect(ports.send).not.toHaveBeenCalled();
  });
  it('captures provider primitives across asynchronous role lookups', async () => {
    const { ports, entry } = fixture(),
      body = command();
    ports.eligible.mockImplementation(() => {
      body.message.from.id = 99;
      body.update_id = 987;
      return Promise.resolve(identity);
    });
    await entry.handle(body);
    expect(ports.send).toHaveBeenCalledWith('42', 'fa', expect.any(String));
    expect(ports.eligible).toHaveBeenLastCalledWith('42');
  });
  it('does not disclose credential-bearing transport errors', async () => {
    const { ports, entry } = fixture();
    ports.send.mockRejectedValue(new Error('private token'));
    await expect(entry.handle(command())).rejects.not.toThrow('private token');
    await expect(entry.handle(command())).rejects.toMatchObject({ code: 'internal_error' });
  });
});
