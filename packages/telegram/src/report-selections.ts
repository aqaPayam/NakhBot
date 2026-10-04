import { createHmac } from 'node:crypto';
import type { OpaqueTokenStore, PrepareSingleReportEvidenceHandler } from '@nakh/application';
type Prepared = Awaited<ReturnType<PrepareSingleReportEvidenceHandler['execute']>>;
export interface TelegramReportSelectionStore {
  put(userId: string, prepared: Prepared, operationId: string): Promise<string>;
  get(userId: string, reference: string): Promise<string | undefined>;
}
/** A 24-hour UI receipt reference never extends the underlying intent's five-minute grant.
 * First allocation wins on callback retry; native submission replay remains authoritative. */
export class TelegramReportSelections implements TelegramReportSelectionStore {
  private readonly key: Uint8Array;
  public constructor(
    private readonly store: OpaqueTokenStore,
    key: Uint8Array,
  ) {
    if (key.byteLength < 32) throw new Error('Report selection key invalid.');
    this.key = Uint8Array.from(key);
  }
  public async put(userId: string, prepared: Prepared, operationId: string): Promise<string> {
    const reference = createHmac('sha256', this.key)
      .update(`telegram-report-selection-v1\0${userId}\0${operationId}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    await this.store.putIfAbsent(
      `telegram-report:${reference}`,
      JSON.stringify({ userId, evidenceIntentToken: prepared.evidenceIntentToken }),
      86400,
    );
    if ((await this.get(userId, reference)) === undefined)
      throw new Error('Report selection unavailable.');
    return reference;
  }
  public async get(userId: string, reference: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9_-]{22}$/u.test(reference)) return undefined;
    const encoded = await this.store.get(`telegram-report:${reference}`);
    if (encoded === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(encoded) as unknown;
    } catch {
      return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const row = value as Readonly<Record<string, unknown>>;
    return Object.keys(row).length === 2 &&
      row.userId === userId &&
      typeof row.evidenceIntentToken === 'string' &&
      /^v1\.ri\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u.test(row.evidenceIntentToken)
      ? row.evidenceIntentToken
      : undefined;
  }
}
