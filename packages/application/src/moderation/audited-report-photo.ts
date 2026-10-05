import { createHash } from 'node:crypto';
import { ApplicationError, type Actor } from '@nakh/domain';

/** Internal delivery capability, supplied only by a fresh confirmed evidence execution. */
export type AuditedReportPhotoRequest = Readonly<{
  actor: Actor;
  recipient: string;
  objectRef: string;
  contentSha256: string;
  commandId: string;
  logId: string;
}>;
export interface AuditedReportPhotoStore {
  /** Requires current identity/permission, the exact committed successful audits and physical hold. */
  resolve(
    input: AuditedReportPhotoRequest,
  ): Promise<Readonly<{ storageKey: string; sha256: string }> | undefined>;
}
export interface ReportPhotoObjectReader {
  getObject(key: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const MAX_REPORT_PHOTO_BYTES = 2 * 1024 * 1024;
function unavailable(): ApplicationError {
  return new ApplicationError('forbidden', 'error.m7.unavailable', 403);
}
async function beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error('report_photo_read_timeout'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', cancel!);
  }
}
async function* boundedStream(
  stream: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await beforeAbort(iterator.next(), signal);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    if (iterator.return !== undefined) {
      const closing = iterator.return().catch(() => undefined);
      if (signal.aborted) void closing;
      else await beforeAbort(closing, signal);
    }
  }
}
/** No URL, cache, persistence of bytes or retry. Replays must never invoke this capability. */
export class ReadAuditedReportPhotoHandler {
  public constructor(
    private readonly store: AuditedReportPhotoStore,
    private readonly objects: ReportPhotoObjectReader,
  ) {}
  private async selection(
    input: AuditedReportPhotoRequest,
  ): Promise<Readonly<{ storageKey: string; sha256: string }>> {
    if (
      Object.keys(input).length !== 6 ||
      input.actor.kind !== 'admin' ||
      !UUID.test(input.actor.userId) ||
      !/^[1-9][0-9]{0,19}$/u.test(input.recipient) ||
      !input.objectRef.startsWith('v1.pe.') ||
      !UUID.test(input.objectRef.slice(6)) ||
      !/^[a-f0-9]{64}$/u.test(input.contentSha256) ||
      !UUID.test(input.commandId) ||
      !UUID.test(input.logId)
    )
      throw unavailable();
    const selected = await this.store.resolve(input);
    if (
      selected === undefined ||
      selected.sha256 !== input.contentSha256 ||
      !/^variants\/(?:development|test|staging|production)\/[0-9a-f-]{36}\/thumbnail-v1\.webp$/u.test(
        selected.storageKey,
      )
    )
      throw unavailable();
    return selected;
  }
  public async check(input: AuditedReportPhotoRequest): Promise<void> {
    await this.selection(input);
  }
  public async read(input: AuditedReportPhotoRequest): Promise<Uint8Array> {
    try {
      const selected = await this.selection(input);
      const signal = AbortSignal.timeout(20000);
      const stream = await beforeAbort(this.objects.getObject(selected.storageKey, signal), signal);
      const chunks: Uint8Array[] = [];
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of boundedStream(stream, signal)) {
        signal.throwIfAborted();
        if (!(chunk instanceof Uint8Array)) throw new Error('invalid_report_photo_stream');
        size += chunk.byteLength;
        if (size > MAX_REPORT_PHOTO_BYTES) throw new Error('report_photo_size_invalid');
        const copy = new Uint8Array(chunk);
        hash.update(copy);
        chunks.push(copy);
      }
      signal.throwIfAborted();
      const bytes = Buffer.concat(chunks);
      if (
        size < 12 ||
        hash.digest('hex') !== selected.sha256 ||
        bytes.toString('latin1', 0, 4) !== 'RIFF' ||
        bytes.toString('latin1', 8, 12) !== 'WEBP' ||
        bytes.readUInt32LE(4) !== size - 8
      )
        throw new Error('report_photo_integrity_invalid');
      const current = await this.selection(input);
      if (current.storageKey !== selected.storageKey || current.sha256 !== selected.sha256)
        throw unavailable();
      return new Uint8Array(bytes);
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}
