import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { OpaqueTokenStore } from '../security/opaque-token.js';

const TOKEN = /^(v1\.cf\.([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{16})$/u;

/** Stores only an opaque command digest; no reason, review note, user text or identity. */
export class AdminConfirmationTokens {
  private readonly key: Uint8Array;
  public constructor(
    private readonly store: OpaqueTokenStore,
    key: Uint8Array,
    private readonly now: () => number = Date.now,
  ) {
    if (key.byteLength < 32) throw new Error('Admin confirmation key is invalid.');
    this.key = Uint8Array.from(key);
  }
  private signature(value: string): string {
    return createHmac('sha256', this.key)
      .update(value)
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }
  public async issue(binding: string): Promise<string> {
    if (!/^[0-9a-f]{64}$/u.test(binding)) throw new Error('Admin confirmation binding is invalid.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = randomBytes(12).toString('base64url');
      const state = {
        version: 1,
        purpose: 'admin_confirmation',
        binding,
        expiresAt: this.now() + 300_000,
      };
      if (await this.store.putIfAbsent(id, JSON.stringify(state), 300)) {
        const unsigned = `v1.cf.${id}`;
        return `${unsigned}.${this.signature(unsigned)}`;
      }
    }
    throw new Error('Admin confirmation allocation failed.');
  }
  public async matches(token: string, binding: string): Promise<boolean> {
    const match = TOKEN.exec(token);
    if (match === null) return false;
    const supplied = Buffer.from(match[3]!, 'base64url');
    const expected = Buffer.from(this.signature(match[1]!), 'base64url');
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected))
      return false;
    const stored = await this.store.get(match[2]!);
    if (stored === undefined) return false;
    let state: unknown;
    try {
      state = JSON.parse(stored) as unknown;
    } catch {
      return false;
    }
    if (typeof state !== 'object' || state === null || Array.isArray(state)) return false;
    const row = state as Record<string, unknown>;
    return (
      Object.keys(row).length === 4 &&
      row.version === 1 &&
      row.purpose === 'admin_confirmation' &&
      row.binding === binding &&
      typeof row.expiresAt === 'number' &&
      Number.isSafeInteger(row.expiresAt) &&
      row.expiresAt > this.now()
    );
  }
}
