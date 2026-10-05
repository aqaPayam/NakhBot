import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ReadAuditedReportPhotoHandler, AuditedReportPhotoRequest } from '@nakh/application';
import { TelegramAdminRetainedPhotoDelivery } from './admin-retained-photo-delivery.js';
import type { TelegramAdminSessionVerifier } from './admin-session.js';
function fixture(): {
  input: AuditedReportPhotoRequest;
  current: ReturnType<typeof vi.fn<TelegramAdminSessionVerifier['current']>>;
  read: ReturnType<typeof vi.fn<ReadAuditedReportPhotoHandler['read']>>;
  check: ReturnType<typeof vi.fn<ReadAuditedReportPhotoHandler['check']>>;
  fetcher: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
  delivery: TelegramAdminRetainedPhotoDelivery;
} {
  const now = new Date(),
    actor = { kind: 'admin' as const, userId: randomUUID() };
  const input = {
    actor,
    recipient: '123',
    objectRef: `v1.pe.${randomUUID()}`,
    contentSha256: 'a'.repeat(64),
    commandId: randomUUID(),
    logId: randomUUID(),
  };
  const current = vi.fn<TelegramAdminSessionVerifier['current']>().mockResolvedValue({
    actor,
    telegramUserId: '123',
    locale: 'en',
    expiresAt: new Date(now.getTime() + 300000),
    mfaExpiresAt: new Date(now.getTime() + 300000),
  });
  const read = vi
      .fn<ReadAuditedReportPhotoHandler['read']>()
      .mockResolvedValue(new Uint8Array([1, 2, 3])),
    check = vi.fn<ReadAuditedReportPhotoHandler['check']>().mockResolvedValue(undefined);
  const fetcher = vi
    .fn<(url: string, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))),
    );
  return {
    input,
    current,
    read,
    check,
    fetcher,
    delivery: new TelegramAdminRetainedPhotoDelivery(
      '123:synthetic',
      { current },
      { read, check },
      fetcher,
      () => now,
    ),
  };
}
describe('protected retained photo transport', () => {
  it('uploads only verified bytes to the fixed Bot API without IDs, keys, URLs, caption or cached file handle', async () => {
    const f = fixture();
    await f.delivery.retainedPhoto(f.input);
    expect(f.read).toHaveBeenCalledWith(f.input);
    expect(f.check).toHaveBeenCalledWith(f.input);
    expect(f.current).toHaveBeenCalledTimes(2);
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/bot123:synthetic/sendPhoto');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
    });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    const body = init!.body as FormData;
    expect([...body.keys()]).toEqual(['chat_id', 'protect_content', 'photo']);
    expect(body.get('chat_id')).toBe('123');
    expect(body.get('protect_content')).toBe('true');
    const file = body.get('photo') as File;
    expect(file.name).toBe('evidence.webp');
    expect(file.type).toBe('image/webp');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('checks actor-bound MFA before reading and again after slow storage', async () => {
    const f = fixture();
    const session = await f.current('123');
    f.current.mockResolvedValueOnce(undefined);
    await expect(f.delivery.retainedPhoto(f.input)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.read).not.toHaveBeenCalled();
    f.current.mockResolvedValueOnce(session).mockResolvedValueOnce(undefined);
    await expect(f.delivery.retainedPhoto(f.input)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.fetcher).not.toHaveBeenCalled();
    f.current.mockResolvedValue({ ...session!, actor: { kind: 'admin', userId: randomUUID() } });
    await expect(f.delivery.retainedPhoto(f.input)).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('requires final native authorization and never retries failed or ambiguous uploads', async () => {
    const f = fixture();
    f.check.mockRejectedValueOnce(new Error('private storage diagnostic'));
    await expect(f.delivery.retainedPhoto(f.input)).rejects.toMatchObject({ status: 500 });
    expect(f.fetcher).not.toHaveBeenCalled();
    for (const payload of [
      { ok: false, description: 'private error' },
      { ok: true, result: { message_id: 0 } },
    ]) {
      f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(payload)));
      await expect(f.delivery.retainedPhoto(f.input)).rejects.toMatchObject({
        status: 500,
        message: 'error.m7.internal',
      });
    }
    f.fetcher.mockRejectedValueOnce(new Error('private provider diagnostic'));
    await expect(f.delivery.retainedPhoto(f.input)).rejects.toMatchObject({ status: 500 });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
});
