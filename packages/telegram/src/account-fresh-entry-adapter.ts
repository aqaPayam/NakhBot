import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApplicationError } from '@nakh/domain';
import {
  isUserProductLife,
  type AccountControlActor,
  type AccountControlSessionStore,
  type AccountReturnActivation,
  type LocalizedIntent,
  type RateLimiterPort,
} from '@nakh/application';
import type { TelegramLikedByLifeResolver } from './liked-by-adapter.js';

export type TelegramFreshEntryNotice = Readonly<{
  handled: true;
  userId: string;
  productEpoch: number;
  telegramUserId: string;
  control: AccountControlActor | undefined;
  callbackQueryId: string | undefined;
  notice: LocalizedIntent;
  buttons: ReadonlyArray<Readonly<{ label: LocalizedIntent; callbackData: string }>>;
}>;
const CALLBACK = /^m8e:([yn]):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{22})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
function intent(key: string): LocalizedIntent {
  return { key, variables: {} };
}
function originId(parts: readonly string[]): string {
  const b = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16);
  b[6] = (b[6]! & 15) | 0x50;
  b[8] = (b[8]! & 63) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function grantId(reference: string): string | undefined {
  const b = Buffer.from(reference, 'base64url');
  if (b.length !== 16 || b.toString('base64url') !== reference) return undefined;
  const h = b.toString('hex'),
    id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return UUID.test(id) ? id : undefined;
}
/** An old primary text update can only prepare a new challenge. Activation needs
 * the actual user's separately authenticated, current-life callback. No old grant
 * is retagged and no product session or previous body is returned by this port. */
export class TelegramFreshEntryAdapter {
  private readonly key: Buffer;
  public constructor(
    private readonly botId: string,
    private readonly users: TelegramLikedByLifeResolver,
    private readonly grants: Pick<AccountControlSessionStore, 'issue' | 'current'>,
    private readonly activation: (actor: AccountControlActor) => AccountReturnActivation,
    private readonly limiter: RateLimiterPort,
    key: Uint8Array,
  ) {
    if (
      !/^[1-9][0-9]{0,19}$/u.test(botId) ||
      !Number.isSafeInteger(Number(botId)) ||
      key.byteLength < 32
    )
      throw new Error('Fresh entry configuration is invalid.');
    this.key = createHmac('sha256', key).update('telegram-fresh-entry-callback-v1').digest();
  }
  private tag(userId: string, action: string, reference: string): string {
    return createHmac('sha256', this.key)
      .update(JSON.stringify([this.botId, userId, action, reference]))
      .digest()
      .subarray(0, 16)
      .toString('base64url');
  }
  private button(userId: string, action: 'y' | 'n', id: string): string {
    const ref = Buffer.from(id.replaceAll('-', ''), 'hex').toString('base64url');
    return `m8e:${action}:${ref}:${this.tag(userId, action, ref)}`;
  }
  public async handle(
    update: unknown,
  ): Promise<Readonly<{ handled: false }> | TelegramFreshEntryNotice> {
    const root = record(update),
      callback = record(root?.callback_query),
      message = record(callback?.message ?? root?.message);
    const command =
        callback === undefined &&
        typeof message?.text === 'string' &&
        /^\/start(?:\s|$)/u.test(message.text),
      data = callback?.data;
    if (!command && !(typeof data === 'string' && data.startsWith('m8e:')))
      return { handled: false };
    const parsed = typeof data === 'string' ? CALLBACK.exec(data) : null;
    const from = record(callback?.from ?? message?.from),
      chat = record(message?.chat),
      origin = record(message?.from),
      sender = from?.id;
    if (
      typeof root?.update_id !== 'number' ||
      !Number.isSafeInteger(root.update_id) ||
      root.update_id < 0 ||
      typeof sender !== 'number' ||
      !Number.isSafeInteger(sender) ||
      sender <= 0 ||
      from?.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== sender ||
      (root.message !== undefined && callback !== undefined) ||
      (callback !== undefined &&
        (parsed === null ||
          typeof callback.id !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/u.test(callback.id) ||
          origin?.is_bot !== true ||
          String(origin.id) !== this.botId ||
          typeof message?.message_id !== 'number' ||
          !Number.isSafeInteger(message.message_id) ||
          message.message_id < 1))
    )
      throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
    const reference = parsed === null ? undefined : grantId(parsed[2]!);
    if (parsed !== null && reference === undefined)
      throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
    const updateId = String(root.update_id),
      telegramUserId = String(sender),
      callbackQueryId = callback?.id as string | undefined;
    const resolved = await this.users.resolveProductLife(telegramUserId);
    // Initial registration and deleted-account routing keep their existing paths.
    if (command && (resolved === undefined || resolved.productEpoch === 0))
      return { handled: false };
    if (!isUserProductLife(resolved) || resolved === undefined || resolved.productEpoch < 1)
      throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
    const life = Object.freeze({ userId: resolved.userId, productEpoch: resolved.productEpoch });
    if (
      parsed !== null &&
      !timingSafeEqual(
        Buffer.from(this.tag(life.userId, parsed[1]!, parsed[2]!)),
        Buffer.from(parsed[3]!),
      )
    )
      throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
    const base = { handled: true as const, ...life, telegramUserId, callbackQueryId };
    let control: AccountControlActor | undefined;
    try {
      const rate = await this.limiter.consume({
        scope: 'telegram_fresh_entry',
        subject: life.userId,
        limit: 10,
        windowSeconds: 60,
      });
      if (!rate.allowed)
        return { ...base, control, notice: intent('entry.rate_limited'), buttons: [] };
      const grant = command
        ? await this.grants.issue(
            life,
            originId(['telegram-fresh-entry-origin-v1', this.botId, updateId, life.userId]),
          )
        : await this.grants.current(life, reference!);
      if (
        grant?.userId !== life.userId ||
        grant.productEpoch !== life.productEpoch ||
        !UUID.test(grant.id) ||
        (!command && grant.id !== reference)
      )
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      control = Object.freeze({
        kind: 'user',
        scope: 'account_control',
        ...life,
        controlGrantId: grant.id,
      });
      if (command)
        return {
          ...base,
          control,
          notice: intent('entry.confirm'),
          buttons: [
            {
              label: intent('return.button.confirm'),
              callbackData: this.button(life.userId, 'y', grant.id),
            },
            {
              label: intent('return.button.cancel'),
              callbackData: this.button(life.userId, 'n', grant.id),
            },
          ],
        };
      if (parsed![1] === 'n')
        return { ...base, control, notice: intent('entry.dismissed'), buttons: [] };
      await this.activation(control).activate(life);
      return { ...base, control, notice: intent('entry.completed'), buttons: [] };
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.status >= 500)
        throw new ApplicationError('internal_error', 'error.deletion.unavailable', 500);
      return { ...base, control, notice: intent('entry.unavailable'), buttons: [] };
    }
  }
}
