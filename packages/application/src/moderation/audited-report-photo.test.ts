import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ReadAuditedReportPhotoHandler,
  MAX_REPORT_PHOTO_BYTES,
  type AuditedReportPhotoRequest,
  type AuditedReportPhotoStore,
} from './audited-report-photo.js';

function fixture(): {
  bytes: Buffer;
  input: AuditedReportPhotoRequest;
  resolve: ReturnType<typeof vi.fn<AuditedReportPhotoStore['resolve']>>;
  getObject: ReturnType<
    typeof vi.fn<(key: string, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>>
  >;
  reader: ReadAuditedReportPhotoHandler;
} {
  const bytes = Buffer.alloc(32);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8);
  const input: AuditedReportPhotoRequest = {
    actor: { kind: 'admin', userId: randomUUID() },
    recipient: '123',
    objectRef: `v1.pe.${randomUUID()}`,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    commandId: randomUUID(),
    logId: randomUUID(),
  };
  const resolve = vi.fn<AuditedReportPhotoStore['resolve']>().mockResolvedValue({
    storageKey: `variants/test/${randomUUID()}/thumbnail-v1.webp`,
    sha256: input.contentSha256,
  });
  const getObject = vi
    .fn<(key: string, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>>()
    .mockImplementation(() =>
      Promise.resolve(
        (async function* () {
          yield await Promise.resolve(bytes.subarray(0, 15));
          yield bytes.subarray(15);
        })(),
      ),
    );
  return {
    bytes,
    input,
    resolve,
    getObject,
    reader: new ReadAuditedReportPhotoHandler({ resolve }, { getObject }),
  };
}
describe('audited retained photo bytes', () => {
  it('enforces the storage deadline even when an iterator ignores cancellation', async () => {
    const f = fixture(),
      controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const next = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => undefined));
    const close = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }));
    f.getObject.mockResolvedValue({ [Symbol.asyncIterator]: () => ({ next, return: close }) });
    try {
      const pending = f.reader.read(f.input);
      const rejected = expect(pending).rejects.toMatchObject({
        status: 500,
        message: 'error.m7.internal',
      });
      await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
      controller.abort();
      await rejected;
      expect(timeout).toHaveBeenCalledWith(20000);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });
  it('binds the exact successful audit, checks after storage and returns only bounded verified bytes', async () => {
    const f = fixture();
    expect(await f.reader.read(f.input)).toEqual(new Uint8Array(f.bytes));
    expect(f.resolve.mock.calls).toEqual([[f.input], [f.input]]);
    expect(f.getObject).toHaveBeenCalledWith(
      (await f.resolve(f.input))!.storageKey,
      expect.any(AbortSignal),
    );
    await f.reader.check(f.input);
    expect(f.getObject).toHaveBeenCalledTimes(1);
  });
  it('denies malformed, borrowed or unavailable bindings before object access', async () => {
    const f = fixture();
    for (const input of [
      { ...f.input, actor: { kind: 'user' as const, userId: randomUUID() } },
      { ...f.input, recipient: '-123' },
      { ...f.input, commandId: 'invalid' },
      { ...f.input, objectRef: 'https://private.invalid/key' },
      { ...f.input, contentSha256: '0' },
      { ...f.input, logId: 'invalid' },
      { ...f.input, extra: 'authority' },
    ])
      await expect(f.reader.read(input)).rejects.toMatchObject({ code: 'forbidden' });
    f.resolve.mockResolvedValue(undefined);
    await expect(f.reader.read(f.input)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.getObject).not.toHaveBeenCalled();
  });
  it('denies a changed hold or permission while object loading waits', async () => {
    for (const change of ['revoked', 'replaced'] as const) {
      const f = fixture();
      const original = (await f.resolve(f.input))!;
      f.resolve
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(
          change === 'revoked'
            ? undefined
            : { ...original, storageKey: `variants/test/${randomUUID()}/thumbnail-v1.webp` },
        );
      await expect(f.reader.read(f.input)).rejects.toMatchObject({ code: 'forbidden' });
      expect(f.getObject).toHaveBeenCalledTimes(1);
    }
  });
  it('closes bad streams and sanitizes oversized, truncated, wrong digest, non-WebP and provider failures', async () => {
    for (const scenario of [
      'oversized',
      'empty',
      'truncated',
      'digest',
      'format',
      'failed',
    ] as const) {
      const f = fixture();
      let closed = false;
      const bad =
        scenario === 'oversized'
          ? Buffer.alloc(MAX_REPORT_PHOTO_BYTES + 1)
          : scenario === 'empty'
            ? Buffer.alloc(0)
            : scenario === 'truncated'
              ? f.bytes.subarray(0, 20)
              : Buffer.from(f.bytes);
      if (scenario === 'digest') bad[31] = 1;
      if (scenario === 'format') {
        bad.write('JPEG');
        f.resolve.mockResolvedValue({
          storageKey: `variants/test/${randomUUID()}/thumbnail-v1.webp`,
          sha256: createHash('sha256').update(bad).digest('hex'),
        });
      }
      const input =
        scenario === 'format'
          ? { ...f.input, contentSha256: createHash('sha256').update(bad).digest('hex') }
          : f.input;
      f.getObject.mockImplementation(() =>
        Promise.resolve(
          (async function* () {
            try {
              if (scenario === 'failed') throw new Error('secret-object-key');
              yield await Promise.resolve(bad);
            } finally {
              closed = true;
            }
          })(),
        ),
      );
      await expect(f.reader.read(input)).rejects.toMatchObject({
        status: 500,
        message: 'error.m7.internal',
      });
      expect(closed).toBe(true);
    }
  });
});
