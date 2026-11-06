import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OpaqueTokenStore } from '../security/opaque-token.js';
import type { UserProductLife, UserSessionActor } from '../security/user-session.js';
import type { LikedByKeyset } from './liked-by.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN = /^(v1\.lb\.([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{16})$/u;
type State = Readonly<{
  version: 2;
  purpose: 'liked_by_action' | 'liked_by_cursor';
  receiverUserId: string;
  productEpoch: number;
  sessionGrantId: string;
  likeId: string;
  expiresAt: number;
  queryVersion?: 1;
  createdAt?: string;
}>;
export type CapturedLikedByReference = Readonly<{
  actor: UserSessionActor;
  likeId: string;
  purpose: 'liked_by_action' | 'liked_by_cursor';
  position?: LikedByKeyset;
}>;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function valid(value: unknown): value is State {
  const s = object(value);
  if (
    !s ||
    s.version !== 2 ||
    typeof s.receiverUserId !== 'string' ||
    !UUID.test(s.receiverUserId) ||
    !Number.isSafeInteger(s.productEpoch) ||
    Number(s.productEpoch) < 0 ||
    typeof s.sessionGrantId !== 'string' ||
    !UUID.test(s.sessionGrantId) ||
    typeof s.likeId !== 'string' ||
    !UUID.test(s.likeId) ||
    !Number.isSafeInteger(s.expiresAt)
  )
    return false;
  if (s.purpose === 'liked_by_action')
    return (
      Object.keys(s).sort().join(',') ===
      'expiresAt,likeId,productEpoch,purpose,receiverUserId,sessionGrantId,version'
    );
  return (
    s.purpose === 'liked_by_cursor' &&
    Object.keys(s).sort().join(',') ===
      'createdAt,expiresAt,likeId,productEpoch,purpose,queryVersion,receiverUserId,sessionGrantId,version' &&
    s.queryVersion === 1 &&
    typeof s.createdAt === 'string' &&
    Number.isFinite(Date.parse(s.createdAt)) &&
    new Date(s.createdAt).toISOString() === s.createdAt
  );
}
function same(a: State, b: State): boolean {
  return (
    a.purpose === b.purpose &&
    a.receiverUserId === b.receiverUserId &&
    a.productEpoch === b.productEpoch &&
    a.sessionGrantId === b.sessionGrantId &&
    a.likeId === b.likeId &&
    a.createdAt === b.createdAt &&
    a.queryVersion === b.queryVersion
  );
}
function unavailable(): never {
  throw new Error('Liked By reference unavailable.');
}

/** V2 payloads seal the original grant as well as the opaque slot. The outer
 * callback shape stays compatible with the narrow Telegram relays. Legacy
 * references use a different MAC domain and cannot be silently upgraded. */
export class SessionLikedByOpaqueReferences {
  private readonly key: Buffer;
  private readonly life: UserProductLife;
  private readonly actor: UserSessionActor | undefined;
  private constructor(
    private readonly store: OpaqueTokenStore,
    key: Uint8Array,
    life: UserProductLife,
    private readonly now: () => number,
    actor?: UserSessionActor,
  ) {
    this.key = Buffer.from(key);
    this.life = Object.freeze({ ...life });
    this.actor = actor === undefined ? undefined : Object.freeze({ ...actor });
  }
  public static forLife(
    store: OpaqueTokenStore,
    key: Uint8Array,
    life: UserProductLife,
    now: () => number = Date.now,
  ): SessionLikedByOpaqueReferences {
    if (
      key.byteLength < 32 ||
      !UUID.test(life.userId) ||
      !Number.isSafeInteger(life.productEpoch) ||
      life.productEpoch < 0
    )
      unavailable();
    const scoped = createHmac('sha256', key)
      .update(`liked-by-session-references-v2\0${life.userId}\0${life.productEpoch}`)
      .digest();
    return new SessionLikedByOpaqueReferences(store, scoped, life, now);
  }
  public forSession(actor: UserSessionActor): SessionLikedByOpaqueReferences {
    if (
      actor.kind !== 'user' ||
      actor.userId !== this.life.userId ||
      actor.productEpoch !== this.life.productEpoch ||
      !UUID.test(actor.sessionGrantId)
    )
      unavailable();
    return new SessionLikedByOpaqueReferences(this.store, this.key, this.life, this.now, actor);
  }
  private token(id: string): string {
    const unsigned = `v1.lb.${id}`;
    return (
      unsigned +
      '.' +
      createHmac('sha256', this.key).update(unsigned).digest().subarray(0, 12).toString('base64url')
    );
  }
  private tag(id: string, body: string): string {
    return createHmac('sha256', this.key)
      .update(`liked-by-session-state-v2\0${id}\0${body}`)
      .digest('base64url');
  }
  private async read(id: string): Promise<State | undefined> {
    const raw = await this.store.get(id);
    if (raw === undefined || Buffer.byteLength(raw) > 2048) return undefined;
    try {
      const envelope = object(JSON.parse(raw) as unknown);
      if (
        !envelope ||
        Object.keys(envelope).sort().join(',') !== 'body,mac' ||
        typeof envelope.body !== 'string' ||
        typeof envelope.mac !== 'string' ||
        !equal(envelope.mac, this.tag(id, envelope.body))
      )
        return undefined;
      const state: unknown = JSON.parse(envelope.body);
      return valid(state) &&
        state.receiverUserId === this.life.userId &&
        state.productEpoch === this.life.productEpoch &&
        state.expiresAt > this.now()
        ? state
        : undefined;
    } catch {
      return undefined;
    }
  }
  private async resolve(token: string): Promise<State | undefined> {
    const match = TOKEN.exec(token);
    return match === null || !equal(token, this.token(match[2]!))
      ? undefined
      : this.read(match[2]!);
  }
  private async issue(
    receiverUserId: string,
    likeId: string,
    position: LikedByKeyset | undefined,
    idempotencyKey: string | undefined,
  ): Promise<string> {
    const actor = this.actor;
    if (
      !actor ||
      receiverUserId !== actor.userId ||
      !UUID.test(likeId) ||
      (idempotencyKey !== undefined && !UUID.test(idempotencyKey))
    )
      unavailable();
    const state: State = {
      version: 2,
      purpose: position === undefined ? 'liked_by_action' : 'liked_by_cursor',
      receiverUserId,
      productEpoch: actor.productEpoch,
      sessionGrantId: actor.sessionGrantId,
      likeId,
      expiresAt: this.now() + 900000,
      ...(position === undefined
        ? {}
        : { queryVersion: 1 as const, createdAt: position.createdAt.toISOString() }),
    };
    if (!valid(state)) unavailable();
    const stable =
      idempotencyKey === undefined
        ? undefined
        : createHmac('sha256', this.key)
            .update(
              JSON.stringify([
                'liked-by-session-id-v2',
                idempotencyKey,
                state.purpose,
                actor.sessionGrantId,
                likeId,
                state.createdAt ?? null,
              ]),
            )
            .digest()
            .subarray(0, 12)
            .toString('base64url');
    for (let n = 0; n < (stable === undefined ? 3 : 1); n++) {
      const id = stable ?? randomBytes(12).toString('base64url'),
        body = JSON.stringify(state);
      if (await this.store.putIfAbsent(id, JSON.stringify({ body, mac: this.tag(id, body) }), 900))
        return this.token(id);
      if (stable !== undefined) {
        const previous = await this.read(id);
        if (previous && same(previous, state)) return this.token(id);
      }
    }
    unavailable();
  }
  public issueAction(
    receiverUserId: string,
    likeId: string,
    idempotencyKey?: string,
  ): Promise<string> {
    return this.issue(receiverUserId, likeId, undefined, idempotencyKey);
  }
  public issueCursor(
    receiverUserId: string,
    position: LikedByKeyset,
    idempotencyKey?: string,
  ): Promise<string> {
    return this.issue(receiverUserId, position.likeId, position, idempotencyKey);
  }
  /** Identification only. The host must check this exact captured native grant;
   * capture never issues, renews or chooses a replacement user session. */
  public async capture(token: string): Promise<CapturedLikedByReference | undefined> {
    const state = await this.resolve(token);
    if (!state) return undefined;
    return {
      actor: {
        kind: 'user',
        userId: state.receiverUserId,
        productEpoch: state.productEpoch,
        sessionGrantId: state.sessionGrantId,
      },
      likeId: state.likeId,
      purpose: state.purpose,
      ...(state.purpose === 'liked_by_cursor'
        ? { position: { createdAt: new Date(state.createdAt!), likeId: state.likeId } }
        : {}),
    };
  }
  public async resolveAction(token: string, receiverUserId: string): Promise<string | undefined> {
    const result = await this.capture(token);
    return this.actor &&
      receiverUserId === this.actor.userId &&
      result?.purpose === 'liked_by_action' &&
      result.actor.sessionGrantId === this.actor.sessionGrantId
      ? result.likeId
      : undefined;
  }
  public async resolveCursor(
    token: string,
    receiverUserId: string,
  ): Promise<LikedByKeyset | undefined> {
    const result = await this.capture(token);
    return this.actor &&
      receiverUserId === this.actor.userId &&
      result?.purpose === 'liked_by_cursor' &&
      result.actor.sessionGrantId === this.actor.sessionGrantId
      ? result.position
      : undefined;
  }
}
