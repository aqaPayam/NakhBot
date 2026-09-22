import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { OpaqueTokenStore } from '../security/opaque-token.js';
import type { PendingNakhKeyset } from './pending-page.js';

const TOKEN_ID = /^[A-Za-z0-9_-]{16}$/u;
const TOKEN = /^(v1\.pn\.([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{16})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const lifetimeSeconds = 900;

type CursorState = Readonly<{
  version: 1;
  purpose: 'pending_nakh_cursor';
  queryVersion: 1;
  senderUserId: string;
  createdAt: string;
  pendingNakhId: string;
  expiresAt: number;
}>;

function validState(value: unknown): value is CursorState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(state).length === 7 &&
    state.version === 1 &&
    state.purpose === 'pending_nakh_cursor' &&
    state.queryVersion === 1 &&
    typeof state.senderUserId === 'string' &&
    UUID.test(state.senderUserId) &&
    typeof state.pendingNakhId === 'string' &&
    UUID.test(state.pendingNakhId) &&
    typeof state.createdAt === 'string' &&
    Number.isFinite(Date.parse(state.createdAt)) &&
    new Date(state.createdAt).toISOString() === state.createdAt &&
    typeof state.expiresAt === 'number' &&
    Number.isSafeInteger(state.expiresAt)
  );
}

function sameReference(left: CursorState, right: CursorState): boolean {
  return (
    left.senderUserId === right.senderUserId &&
    left.createdAt === right.createdAt &&
    left.pendingNakhId === right.pendingNakhId
  );
}

/** Signed, Redis-backed cursor whose position and sender identity never reach the client. */
export class PendingNakhOpaqueReferences {
  private readonly key: Uint8Array;

  public constructor(
    private readonly store: OpaqueTokenStore,
    key: Uint8Array,
    private readonly now: () => number = Date.now,
    private readonly randomId: () => string = () => randomBytes(12).toString('base64url'),
  ) {
    if (key.byteLength < 32) throw new Error('Pending Nakh token key is invalid.');
    this.key = Uint8Array.from(key);
  }

  private signature(unsigned: string): string {
    return createHmac('sha256', this.key)
      .update(unsigned)
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }

  private token(id: string): string {
    const unsigned = `v1.pn.${id}`;
    return `${unsigned}.${this.signature(unsigned)}`;
  }

  private stableId(requestId: string, state: CursorState): string {
    if (!UUID.test(requestId)) throw new Error('Pending Nakh idempotency key is invalid.');
    return createHmac('sha256', this.key)
      .update(
        `pending-nakh-reference-v1\0${requestId}\0${state.senderUserId}\0${state.createdAt}\0${state.pendingNakhId}`,
      )
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }

  public async issueCursor(
    senderUserId: string,
    position: PendingNakhKeyset,
    requestId?: string,
  ): Promise<string> {
    const state: CursorState = {
      version: 1,
      purpose: 'pending_nakh_cursor',
      queryVersion: 1,
      senderUserId,
      createdAt: position.createdAt.toISOString(),
      pendingNakhId: position.pendingNakhId,
      expiresAt: this.now() + lifetimeSeconds * 1000,
    };
    if (!validState(state) || state.expiresAt <= this.now())
      throw new Error('Pending Nakh token state is invalid.');
    const stableId = requestId === undefined ? undefined : this.stableId(requestId, state);
    if (stableId !== undefined) {
      const encoded = JSON.stringify(state);
      if (await this.store.putIfAbsent(stableId, encoded, lifetimeSeconds))
        return this.token(stableId);
      const existing = await this.store.get(stableId);
      if (existing !== undefined) {
        try {
          const parsed = JSON.parse(existing) as unknown;
          if (validState(parsed) && parsed.expiresAt > this.now() && sameReference(parsed, state))
            return this.token(stableId);
        } catch {
          // The deterministic slot is occupied by malformed or conflicting state.
        }
      }
      throw new Error('Pending Nakh token allocation failed.');
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = this.randomId();
      if (!TOKEN_ID.test(id)) throw new Error('Pending Nakh token identifier is invalid.');
      if (await this.store.putIfAbsent(id, JSON.stringify(state), lifetimeSeconds))
        return this.token(id);
    }
    throw new Error('Pending Nakh token allocation failed.');
  }

  public async resolveCursor(
    token: string,
    senderUserId: string,
  ): Promise<PendingNakhKeyset | undefined> {
    const match = TOKEN.exec(token);
    if (match === null || !UUID.test(senderUserId)) return undefined;
    const expected = Buffer.from(this.signature(match[1]!), 'base64url');
    const supplied = Buffer.from(match[3]!, 'base64url');
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected))
      return undefined;
    const stored = await this.store.get(match[2]!);
    if (stored === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(stored) as unknown;
    } catch {
      return undefined;
    }
    if (!validState(value) || value.senderUserId !== senderUserId || value.expiresAt <= this.now())
      return undefined;
    return { createdAt: new Date(value.createdAt), pendingNakhId: value.pendingNakhId };
  }
}
