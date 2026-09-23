import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { OpaqueTokenStore } from '../security/opaque-token.js';
import type { NakhKeyset, NakhPageDirection } from './delivered-page.js';

const TOKEN_ID = /^[A-Za-z0-9_-]{16}$/u;
const TOKEN = /^(v1\.nk\.([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{16})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const lifetimeSeconds = 900;

type CursorState = Readonly<{
  version: 1;
  purpose: 'nakh_cursor';
  queryVersion: 1;
  viewerUserId: string;
  direction: NakhPageDirection;
  sentAt: string;
  nakhId: string;
  expiresAt: number;
}>;

function validState(value: unknown): value is CursorState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(state).length === 8 &&
    state.version === 1 &&
    state.purpose === 'nakh_cursor' &&
    state.queryVersion === 1 &&
    typeof state.viewerUserId === 'string' &&
    UUID.test(state.viewerUserId) &&
    (state.direction === 'sent' || state.direction === 'received') &&
    typeof state.nakhId === 'string' &&
    UUID.test(state.nakhId) &&
    typeof state.sentAt === 'string' &&
    Number.isFinite(Date.parse(state.sentAt)) &&
    new Date(state.sentAt).toISOString() === state.sentAt &&
    typeof state.expiresAt === 'number' &&
    Number.isSafeInteger(state.expiresAt)
  );
}

export class NakhOpaqueReferences {
  private readonly key: Uint8Array;

  public constructor(
    private readonly store: OpaqueTokenStore,
    key: Uint8Array,
    private readonly now: () => number = Date.now,
    private readonly randomId: () => string = () => randomBytes(12).toString('base64url'),
  ) {
    if (key.byteLength < 32) throw new Error('Nakh token key is invalid.');
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
    const unsigned = `v1.nk.${id}`;
    return `${unsigned}.${this.signature(unsigned)}`;
  }

  private stableId(requestId: string, state: CursorState): string {
    if (!UUID.test(requestId)) throw new Error('Nakh idempotency key is invalid.');
    return createHmac('sha256', this.key)
      .update(
        `nakh-reference-v1\0${requestId}\0${state.viewerUserId}\0${state.direction}\0${state.sentAt}\0${state.nakhId}`,
      )
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }

  public async issueCursor(
    viewerUserId: string,
    direction: NakhPageDirection,
    position: NakhKeyset,
    requestId?: string,
  ): Promise<string> {
    const state: CursorState = {
      version: 1,
      purpose: 'nakh_cursor',
      queryVersion: 1,
      viewerUserId,
      direction,
      sentAt: position.sentAt.toISOString(),
      nakhId: position.nakhId,
      expiresAt: this.now() + lifetimeSeconds * 1_000,
    };
    if (!validState(state) || state.expiresAt <= this.now())
      throw new Error('Nakh token state is invalid.');
    const ids =
      requestId === undefined
        ? Array.from({ length: 3 }, () => this.randomId())
        : [this.stableId(requestId, state)];
    for (const id of ids) {
      if (!TOKEN_ID.test(id)) throw new Error('Nakh token identifier is invalid.');
      if (await this.store.putIfAbsent(id, JSON.stringify(state), lifetimeSeconds))
        return this.token(id);
      const existing = await this.store.get(id);
      if (existing !== undefined)
        try {
          const parsed = JSON.parse(existing) as unknown;
          if (
            validState(parsed) &&
            parsed.expiresAt > this.now() &&
            parsed.viewerUserId === state.viewerUserId &&
            parsed.direction === state.direction &&
            parsed.sentAt === state.sentAt &&
            parsed.nakhId === state.nakhId
          )
            return this.token(id);
        } catch {
          // Try another random slot, or fail the deterministic slot below.
        }
      if (requestId !== undefined) break;
    }
    throw new Error('Nakh token allocation failed.');
  }

  public async resolveCursor(
    token: string,
    viewerUserId: string,
    direction: NakhPageDirection,
  ): Promise<NakhKeyset | undefined> {
    const match = TOKEN.exec(token);
    if (match === null || !UUID.test(viewerUserId)) return undefined;
    const expected = Buffer.from(this.signature(match[1]!), 'base64url');
    const supplied = Buffer.from(match[3]!, 'base64url');
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected))
      return undefined;
    const stored = await this.store.get(match[2]!);
    if (stored === undefined) return undefined;
    try {
      const state = JSON.parse(stored) as unknown;
      if (
        !validState(state) ||
        state.viewerUserId !== viewerUserId ||
        state.direction !== direction ||
        state.expiresAt <= this.now()
      )
        return undefined;
      return { sentAt: new Date(state.sentAt), nakhId: state.nakhId };
    } catch {
      return undefined;
    }
  }
}
