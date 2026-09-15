import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { OpaqueTokenStore, OwnPhotoAction } from '@nakh/application';

export type TelegramPhotoActionTokenState = Readonly<{
  telegramUserId: string;
  expectedProfileVersion: number;
  action: OwnPhotoAction;
}>;

type StoredState = TelegramPhotoActionTokenState & Readonly<{ expiresAt: number }>;

const TOKEN_ID = /^[A-Za-z0-9_-]{16}$/u;
const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u;

function validAction(value: unknown): value is OwnPhotoAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const action = value as Readonly<Record<string, unknown>>;
  if (action.type === 'select_primary' || action.type === 'delete')
    return (
      Object.keys(action).length === 2 &&
      typeof action.photoId === 'string' &&
      UUID.test(action.photoId)
    );
  if (
    action.type !== 'reorder' ||
    Object.keys(action).length !== 2 ||
    !Array.isArray(action.orderedPhotoIds)
  )
    return false;
  const ids = action.orderedPhotoIds;
  return (
    ids.length >= 1 &&
    ids.length <= 6 &&
    new Set(ids).size === ids.length &&
    ids.every((id) => typeof id === 'string' && UUID.test(id))
  );
}

function parseState(value: string): StoredState {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Telegram action state is invalid.');
  const state = parsed as Readonly<Record<string, unknown>>;
  if (
    Object.keys(state).length !== 4 ||
    typeof state.telegramUserId !== 'string' ||
    !/^[1-9][0-9]{0,19}$/u.test(state.telegramUserId) ||
    typeof state.expectedProfileVersion !== 'number' ||
    !Number.isSafeInteger(state.expectedProfileVersion) ||
    state.expectedProfileVersion < 1 ||
    typeof state.expiresAt !== 'number' ||
    !Number.isSafeInteger(state.expiresAt) ||
    !validAction(state.action)
  )
    throw new Error('Telegram action state is invalid.');
  return state as StoredState;
}

export class TelegramPhotoActionTokens {
  private readonly key: Uint8Array;

  public constructor(
    private readonly store: OpaqueTokenStore,
    key: Uint8Array,
    private readonly now: () => number = Date.now,
    private readonly randomId: () => string = () => randomBytes(12).toString('base64url'),
  ) {
    if (key.byteLength < 32) throw new Error('Telegram action-token key is invalid.');
    this.key = Uint8Array.from(key);
  }

  public async issue(state: TelegramPhotoActionTokenState, ttlSeconds = 900): Promise<string> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3600)
      throw new Error('Telegram action-token lifetime is invalid.');
    const stored: StoredState = { ...state, expiresAt: this.now() + ttlSeconds * 1000 };
    parseState(JSON.stringify(stored));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = this.randomId();
      if (!TOKEN_ID.test(id)) throw new Error('Telegram action-token identifier is invalid.');
      if (await this.store.putIfAbsent(id, JSON.stringify(stored), ttlSeconds)) {
        const unsigned = `v1.pm.${id}`;
        const signature = createHmac('sha256', this.key)
          .update(unsigned)
          .digest()
          .subarray(0, 12)
          .toString('base64url');
        return `${unsigned}.${signature}`;
      }
    }
    throw new Error('Telegram action-token allocation failed.');
  }

  public async resolve(
    token: string,
    telegramUserId: string,
  ): Promise<TelegramPhotoActionTokenState | undefined> {
    const match = /^(v1\.pm\.([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{16})$/u.exec(token);
    if (match === null) return undefined;
    const expected = createHmac('sha256', this.key).update(match[1]!).digest().subarray(0, 12);
    const supplied = Buffer.from(match[3]!, 'base64url');
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected))
      return undefined;
    const value = await this.store.get(match[2]!);
    if (value === undefined) return undefined;
    const state = parseState(value);
    if (state.expiresAt <= this.now() || state.telegramUserId !== telegramUserId) return undefined;
    return {
      telegramUserId: state.telegramUserId,
      expectedProfileVersion: state.expectedProfileVersion,
      action: state.action,
    };
  }
}
