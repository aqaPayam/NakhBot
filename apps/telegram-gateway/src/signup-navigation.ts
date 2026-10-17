import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OpaqueTokenStore, UserSessionActor } from '@nakh/application';

export type SignupNavigation = Readonly<{
  actor: UserSessionActor;
  version: number;
  screen: string;
  action:
    | 'begin'
    | 'resume'
    | 'pick'
    | 'page'
    | 'save'
    | 'optional'
    | 'clear'
    | 'finish'
    | 'reply'
    | 'preview'
    | 'explore'
    | 'like'
    | 'reject'
    | 'nakh'
    | 'nakh_credits'
    | 'nakh_pending'
    | 'nakh_stars'
    | 'detail';
  code?: string | undefined;
  selection?: readonly string[] | undefined;
  field?: string | undefined;
  country?: string | undefined;
  province?: string | undefined;
  page?: number | undefined;
  group?: string | undefined;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function signupRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
/** Only public selectors, expected versions and a native grant reference belong
 * here. Private form values remain in PostgreSQL. Cache data is MAC verified. */
export class SignupNavigationTokens {
  private readonly key: Buffer;
  private readonly life: Readonly<{ userId: string; productEpoch: number }>;
  public constructor(
    private readonly store: OpaqueTokenStore,
    key: Uint8Array,
    private readonly botId: string,
    private readonly telegramUserId: string,
    life: Readonly<{ userId: string; productEpoch: number }>,
    private readonly now: () => number = Date.now,
  ) {
    if (key.byteLength !== 32) throw new Error('Signup key unavailable.');
    this.key = createHmac('sha256', key).update('nakh-signup-navigation-v1').digest();
    this.life = Object.freeze({ userId: life.userId, productEpoch: life.productEpoch });
  }
  private tag(id: string, body: string): string {
    return createHmac('sha256', this.key)
      .update(
        JSON.stringify([
          this.botId,
          this.telegramUserId,
          this.life.userId,
          this.life.productEpoch,
          id,
          body,
        ]),
      )
      .digest()
      .subarray(0, 16)
      .toString('base64url');
  }
  public replyId(messageId: number): string {
    if (!Number.isSafeInteger(messageId) || messageId < 1)
      throw new Error('Invalid signup prompt.');
    return createHmac('sha256', this.key)
      .update(JSON.stringify(['reply', this.botId, this.telegramUserId, this.life, messageId]))
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }
  private async put(id: string, input: SignupNavigation): Promise<string> {
    const state = structuredClone(input),
      body = JSON.stringify({ expiresAt: this.now() + 900000, state });
    const mac = this.tag(id, body),
      value = JSON.stringify({ body, mac });
    if (
      !this.valid(state) ||
      Buffer.byteLength(value) > 4096 ||
      !(await this.store.putIfAbsent(id, value, 900))
    )
      throw new Error('Signup navigation unavailable.');
    return `m9s:${id}:${mac}`;
  }
  public button(state: SignupNavigation): Promise<string> {
    if (state.action === 'reply') throw new Error('Signup navigation purpose invalid.');
    return this.put(randomBytes(12).toString('base64url'), state);
  }
  public async prompt(messageId: number, state: SignupNavigation): Promise<void> {
    if (state.action !== 'reply') throw new Error('Signup navigation purpose invalid.');
    await this.put(this.replyId(messageId), state);
  }
  /** First transition from one rendered menu wins; retries retain its original
   * provider identity. Other old buttons cannot overwrite a newer selection. */
  public async claim(
    state: SignupNavigation,
    updateId: number,
    callback: string,
    next: SignupNavigation,
  ): Promise<{ accepted: boolean; next: SignupNavigation }> {
    if (state.group === undefined || !/^[A-Za-z0-9_-]{16}$/u.test(state.group) || !this.valid(next))
      throw new Error('Signup menu unavailable.');
    const id = createHmac('sha256', this.key)
      .update(`claim:${state.group}`)
      .digest()
      .subarray(0, 12)
      .toString('base64url');
    const digest = createHash('sha256').update(callback).digest('hex');
    const body = JSON.stringify({ expiresAt: this.now() + 900000, updateId, digest, next });
    const value = JSON.stringify({ body, mac: this.tag(id, body) });
    if (await this.store.putIfAbsent(id, value, 900)) return { accepted: true, next };
    const raw = await this.store.get(id);
    if (raw === undefined) throw new Error('Signup menu unavailable.');
    const envelope = signupRecord(JSON.parse(raw));
    if (
      typeof envelope?.body !== 'string' ||
      typeof envelope.mac !== 'string' ||
      !equal(envelope.mac, this.tag(id, envelope.body))
    )
      throw new Error('Signup menu unavailable.');
    const receipt = signupRecord(JSON.parse(envelope.body));
    if (
      typeof receipt?.expiresAt !== 'number' ||
      receipt.expiresAt <= this.now() ||
      !this.valid(receipt.next)
    )
      throw new Error('Signup menu unavailable.');
    return {
      accepted: receipt.updateId === updateId && receipt.digest === digest,
      next: receipt.next,
    };
  }
  public async callback(data: string): Promise<SignupNavigation | undefined> {
    const match = /^m9s:([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22})$/u.exec(data);
    return match === null ? undefined : this.read(match[1]!, match[2], false);
  }
  public reply(messageId: number): Promise<SignupNavigation | undefined> {
    return this.read(this.replyId(messageId), undefined, true);
  }
  private valid(value: unknown): value is SignupNavigation {
    const row = signupRecord(value),
      actor = signupRecord(row?.actor);
    return (
      row !== undefined &&
      actor !== undefined &&
      Object.keys(row).every((k) =>
        [
          'actor',
          'version',
          'screen',
          'action',
          'code',
          'selection',
          'field',
          'country',
          'province',
          'page',
          'group',
        ].includes(k),
      ) &&
      Object.keys(actor).sort().join(',') === 'kind,productEpoch,sessionGrantId,userId' &&
      actor.kind === 'user' &&
      actor.userId === this.life.userId &&
      actor.productEpoch === this.life.productEpoch &&
      typeof actor.sessionGrantId === 'string' &&
      UUID.test(actor.sessionGrantId) &&
      Number.isSafeInteger(row.version) &&
      Number(row.version) > 0 &&
      typeof row.screen === 'string' &&
      /^[a-z_]{1,50}$/u.test(row.screen) &&
      typeof row.action === 'string' &&
      [
        'begin',
        'resume',
        'pick',
        'page',
        'save',
        'optional',
        'clear',
        'finish',
        'reply',
        'preview',
        'explore',
        'like',
        'reject',
        'nakh',
        'nakh_credits',
        'nakh_pending',
        'nakh_stars',
        'detail',
      ].includes(row.action) &&
      ['code', 'field', 'country', 'province'].every(
        (k) =>
          row[k] === undefined ||
          (typeof row[k] === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(row[k])),
      ) &&
      (row.page === undefined ||
        (Number.isSafeInteger(row.page) && Number(row.page) >= 0 && Number(row.page) <= 10000)) &&
      (row.group === undefined ||
        (typeof row.group === 'string' && /^[A-Za-z0-9_-]{16}$/u.test(row.group))) &&
      (row.selection === undefined ||
        (Array.isArray(row.selection) &&
          row.selection.length <= 20 &&
          new Set(row.selection).size === row.selection.length &&
          row.selection.every(
            (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(v),
          )))
    );
  }
  private async read(
    id: string,
    expected: string | undefined,
    reply: boolean,
  ): Promise<SignupNavigation | undefined> {
    const raw = await this.store.get(id);
    if (raw === undefined || Buffer.byteLength(raw) > 4096) return undefined;
    try {
      const envelope = signupRecord(JSON.parse(raw));
      if (
        typeof envelope?.body !== 'string' ||
        typeof envelope.mac !== 'string' ||
        !equal(envelope.mac, this.tag(id, envelope.body)) ||
        (expected !== undefined && !equal(expected, envelope.mac))
      )
        return undefined;
      const parsed = signupRecord(JSON.parse(envelope.body));
      if (
        typeof parsed?.expiresAt !== 'number' ||
        !Number.isSafeInteger(parsed.expiresAt) ||
        parsed.expiresAt <= this.now() ||
        parsed.expiresAt > this.now() + 900000 ||
        !this.valid(parsed.state) ||
        (parsed.state.action === 'reply') !== reply
      )
        return undefined;
      return parsed.state;
    } catch {
      return undefined;
    }
  }
}
