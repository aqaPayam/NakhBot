import type { ReportSnapshotKeyResolver } from './profile-report-snapshot-reader.js';

export type ReportSnapshotKey = Readonly<{ keyId: string; keyVersion: number; key: Uint8Array }>;

/** Shared retained-evidence format used by capture and the deletion worker.
 * Callers select a write key explicitly; array order never changes authority. */
export class ReportSnapshotKeyRing implements ReportSnapshotKeyResolver {
  private readonly keys = new Map<string, Uint8Array>();
  public constructor(encoded: string) {
    try {
      if (encoded.length > 65536) throw new Error();
      const entries: unknown = JSON.parse(encoded);
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 16) throw new Error();
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error();
        const item = entry as Record<string, unknown>;
        if (
          Object.keys(item).length !== 3 ||
          typeof item.keyId !== 'string' ||
          !/^[A-Za-z0-9_-]{8,160}$/u.test(item.keyId) ||
          !Number.isSafeInteger(item.keyVersion) ||
          Number(item.keyVersion) < 1 ||
          typeof item.key !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/u.test(item.key)
        )
          throw new Error();
        const key = Buffer.from(item.key, 'base64url'),
          id = `${item.keyId}\0${String(item.keyVersion)}`;
        if (key.byteLength !== 32 || key.toString('base64url') !== item.key || this.keys.has(id))
          throw new Error();
        this.keys.set(id, key);
      }
    } catch {
      throw new Error('Report snapshot key configuration unavailable.');
    }
  }
  public resolve(id: string, version: number): Uint8Array | undefined {
    const key = this.keys.get(`${id}\0${version}`);
    return key === undefined ? undefined : Uint8Array.from(key);
  }
  public writeKey(id: string, version: number): ReportSnapshotKey {
    const key = this.resolve(id, version);
    if (key === undefined) throw new Error('Report snapshot write key unavailable.');
    return Object.freeze({ keyId: id, keyVersion: version, key });
  }
  public assertSeparateNavigationKey(key: Uint8Array): void {
    for (const secret of this.keys.values())
      if (Buffer.from(secret).equals(Buffer.from(key)))
        throw new Error('Report snapshot key configuration unavailable.');
  }
  public assertSeparateKeyRing(other: ReportSnapshotKeyRing): void {
    for (const key of this.keys.values()) other.assertSeparateNavigationKey(key);
  }
}
