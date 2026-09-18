import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { OpaqueTokenStore } from '../security/opaque-token.js';
import type { LikedByKeyset } from './liked-by.js';

const TOKEN_ID = /^[A-Za-z0-9_-]{16}$/u;
const TOKEN = /^(v1\.lb\.([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{16})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const lifetimeSeconds = 900;
const queryVersion = 1;

type CursorState = Readonly<{
  version: 1;
  purpose: 'liked_by_cursor';
  queryVersion: 1;
  receiverUserId: string;
  createdAt: string;
  likeId: string;
  expiresAt: number;
}>;

type ActionState = Readonly<{
  version: 1;
  purpose: 'liked_by_action';
  receiverUserId: string;
  likeId: string;
  expiresAt: number;
}>;

type StoredState = CursorState | ActionState;

function validState(value: unknown): value is StoredState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Readonly<Record<string, unknown>>;
  const common =
    state.version === 1 &&
    typeof state.receiverUserId === 'string' &&
    UUID.test(state.receiverUserId) &&
    typeof state.likeId === 'string' &&
    UUID.test(state.likeId) &&
    typeof state.expiresAt === 'number' &&
    Number.isSafeInteger(state.expiresAt);
  if (!common) return false;
  if (state.purpose === 'liked_by_action') return Object.keys(state).length === 5;
  return (
    state.purpose === 'liked_by_cursor' &&
    Object.keys(state).length === 7 &&
    state.queryVersion === queryVersion &&
    typeof state.createdAt === 'string' &&
    Number.isFinite(Date.parse(state.createdAt)) &&
    new Date(state.createdAt).toISOString() === state.createdAt
  );
}

/** Short, signed, Redis-backed references. Neither Like IDs nor cursor positions reach a client. */
export class LikedByOpaqueReferences {
  private readonly key: Uint8Array;

  public constructor(
    private readonly store: OpaqueTokenStore,
    key: Uint8Array,
    private readonly now: () => number = Date.now,
    private readonly randomId: () => string = () => randomBytes(12).toString('base64url'),
  ) {
    if (key.byteLength < 32) throw new Error('Liked By token key is invalid.');
    this.key = Uint8Array.from(key);
  }

  private signature(unsigned: string): string {
    return createHmac('sha256', this.key)
      .update(unsigned)
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }

  private async issue(state: StoredState): Promise<string> {
    if (!validState(state) || state.expiresAt <= this.now())
      throw new Error('Liked By token state is invalid.');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = this.randomId();
      if (!TOKEN_ID.test(id)) throw new Error('Liked By token identifier is invalid.');
      if (await this.store.putIfAbsent(id, JSON.stringify(state), lifetimeSeconds)) {
        const unsigned = `v1.lb.${id}`;
        return `${unsigned}.${this.signature(unsigned)}`;
      }
    }
    throw new Error('Liked By token allocation failed.');
  }

  public issueCursor(receiverUserId: string, position: LikedByKeyset): Promise<string> {
    return this.issue({
      version: 1,
      purpose: 'liked_by_cursor',
      queryVersion,
      receiverUserId,
      createdAt: position.createdAt.toISOString(),
      likeId: position.likeId,
      expiresAt: this.now() + lifetimeSeconds * 1000,
    });
  }

  public issueAction(receiverUserId: string, likeId: string): Promise<string> {
    return this.issue({
      version: 1,
      purpose: 'liked_by_action',
      receiverUserId,
      likeId,
      expiresAt: this.now() + lifetimeSeconds * 1000,
    });
  }

  private async resolve(token: string, receiverUserId: string): Promise<StoredState | undefined> {
    const match = TOKEN.exec(token);
    if (match === null || !UUID.test(receiverUserId)) return undefined;
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
    if (
      !validState(value) ||
      value.receiverUserId !== receiverUserId ||
      value.expiresAt <= this.now()
    )
      return undefined;
    return value;
  }

  public async resolveCursor(
    token: string,
    receiverUserId: string,
  ): Promise<LikedByKeyset | undefined> {
    const state = await this.resolve(token, receiverUserId);
    if (state?.purpose !== 'liked_by_cursor') return undefined;
    return { createdAt: new Date(state.createdAt), likeId: state.likeId };
  }

  /** Identification only; the action handler must reload Like and capability state. */
  public async resolveAction(token: string, receiverUserId: string): Promise<string | undefined> {
    const state = await this.resolve(token, receiverUserId);
    return state?.purpose === 'liked_by_action' ? state.likeId : undefined;
  }
}
