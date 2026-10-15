import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApplicationError } from '@nakh/domain';
import {
  isAccountControlLife,
  type AccountReturnActor,
  type AccountReturnGrantStore,
  type AccountReturnStore,
  type LocalizedIntent,
  type RateLimiterPort,
} from '@nakh/application';
import type { TelegramAccountControlResolver } from './account-deletion-adapter.js';

export type TelegramAccountReturnNotice = Readonly<{
  handled: true;
  userId: string;
  observedProductEpoch: number;
  telegramUserId: string;
  control: AccountReturnActor | undefined;
  callbackQueryId: string | undefined;
  notice: LocalizedIntent;
  buttons: ReadonlyArray<Readonly<{ label: LocalizedIntent; callbackData: string }>>;
}>;
type Result = Readonly<{ handled: false }> | TelegramAccountReturnNotice;
const CALLBACK = /^m8r:([yn]):([1-9a-z][0-9a-z]{0,6}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{22})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
function intent(key: string): LocalizedIntent {
  return { key, variables: {} };
}
function uuid(parts: readonly string[]): string {
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
/** Authenticated private primary updates only. A signed opaque grant reference
 * carries no User/epoch selector and cannot acquire a replacement life's grant. */
export class TelegramAccountReturnAdapter {
  private readonly key: Buffer;
  public constructor(
    private readonly botId: string,
    private readonly users: TelegramAccountControlResolver,
    private readonly grants: AccountReturnGrantStore,
    private readonly store: (actor: AccountReturnActor) => AccountReturnStore,
    private readonly limiter: RateLimiterPort,
    key: Uint8Array,
  ) {
    if (
      !/^[1-9][0-9]{0,19}$/u.test(botId) ||
      !Number.isSafeInteger(Number(botId)) ||
      key.byteLength < 32
    )
      throw new Error('Return ingress configuration is invalid.');
    this.key = createHmac('sha256', key).update('telegram-account-return-callback-v1').digest();
  }
  private tag(userId: string, action: string, version: string, reference: string): string {
    return createHmac('sha256', this.key)
      .update(JSON.stringify([this.botId, userId, action, version, reference]))
      .digest()
      .subarray(0, 16)
      .toString('base64url');
  }
  private button(userId: string, action: 'y' | 'n', version: number, id: string): string {
    const reference = Buffer.from(id.replaceAll('-', ''), 'hex').toString('base64url'),
      v = version.toString(36);
    return `m8r:${action}:${v}:${reference}:${this.tag(userId, action, v, reference)}`;
  }
  public async handle(update: unknown): Promise<Result> {
    const root = record(update),
      callback = record(root?.callback_query),
      message = record(callback?.message ?? root?.message);
    const command = callback === undefined && message?.text === '/return',
      data = callback?.data;
    if (!command && !(typeof data === 'string' && data.startsWith('m8r:')))
      return { handled: false };
    const parsed = typeof data === 'string' ? CALLBACK.exec(data) : null;
    const from = record(callback?.from ?? message?.from),
      chat = record(message?.chat),
      sender = from?.id,
      origin = record(message?.from);
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
    const version = parsed === null ? undefined : Number.parseInt(parsed[2]!, 36),
      id = parsed === null ? undefined : grantId(parsed[3]!);
    if (
      parsed !== null &&
      (id === undefined ||
        !Number.isSafeInteger(version) ||
        version! < 1 ||
        version! > 2147483647 ||
        version!.toString(36) !== parsed[2])
    )
      throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
    const updateId = String(root.update_id),
      callbackQueryId = callback?.id as string | undefined;
    const telegramUserId = String(sender),
      resolved = await this.users.resolveAccountControlLife(telegramUserId);
    if (
      !isAccountControlLife(resolved) ||
      resolved === undefined ||
      !Number.isSafeInteger(resolved.accountVersion) ||
      resolved.accountVersion < 1 ||
      resolved.accountVersion > 2147483647
    )
      throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
    const life = Object.freeze({ ...resolved });
    if (
      parsed !== null &&
      !timingSafeEqual(
        Buffer.from(this.tag(life.userId, parsed[1]!, parsed[2]!, parsed[3]!)),
        Buffer.from(parsed[4]!),
      )
    )
      throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
    const base = {
      handled: true as const,
      userId: life.userId,
      observedProductEpoch: life.productEpoch,
      telegramUserId,
      callbackQueryId,
    };
    let control: AccountReturnActor | undefined;
    try {
      const rate = await this.limiter.consume({
        scope: 'telegram_account_return',
        subject: life.userId,
        limit: 10,
        windowSeconds: 60,
      });
      if (!rate.allowed)
        return { ...base, control: undefined, notice: intent('return.rate_limited'), buttons: [] };
      let reference = id;
      if (command) {
        const originId = uuid(['telegram-return-origin-v1', this.botId, updateId, life.userId]);
        const issued = await this.grants.issue(
          { userId: life.userId, productEpoch: life.productEpoch },
          originId,
        );
        if (issued?.userId !== life.userId || issued.productEpoch !== life.productEpoch)
          throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
        reference = issued.id;
      }
      const grant =
        reference === undefined
          ? undefined
          : await this.grants.findForReturn(life.userId, reference);
      if (
        !isAccountControlLife(grant) ||
        grant?.userId !== life.userId ||
        grant.id !== reference ||
        !UUID.test(grant.id) ||
        (grant.productEpoch !== life.productEpoch && grant.productEpoch + 1 !== life.productEpoch)
      )
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      control = Object.freeze({
        kind: 'user',
        scope: 'account_return',
        userId: grant.userId,
        productEpoch: grant.productEpoch,
        controlGrantId: grant.id,
      });
      if (command)
        return {
          ...base,
          control,
          notice: intent('return.confirm'),
          buttons: [
            {
              label: intent('return.button.confirm'),
              callbackData: this.button(life.userId, 'y', life.accountVersion, grant.id),
            },
            {
              label: intent('return.button.cancel'),
              callbackData: this.button(life.userId, 'n', life.accountVersion, grant.id),
            },
          ],
        };
      if (parsed![1] === 'n')
        return { ...base, control, notice: intent('return.dismissed'), buttons: [] };
      const commandId = uuid([
        'telegram-return-command-v1',
        this.botId,
        life.userId,
        String(grant.productEpoch),
        grant.id,
        String(version),
      ]);
      const result = await this.store(control).return({
        commandId,
        commandType: 'account.return',
        schemaVersion: 1,
        actor: { kind: 'user', userId: life.userId },
        requestId: commandId,
        idempotencyKey: `telegram-return:${commandId}`,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        channelContext: { channel: 'telegram', channelIdentityId: telegramUserId },
        data: { expectedAccountVersion: version! },
      });
      if (
        result.returned !== true ||
        result.accountVersion !== version! + 1 ||
        typeof result.replayed !== 'boolean'
      )
        throw new Error('Return receipt unavailable.');
      return { ...base, control, notice: intent('return.completed'), buttons: [] };
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.status >= 500)
        throw new ApplicationError('internal_error', 'error.deletion.unavailable', 500);
      return { ...base, control, notice: intent('return.unavailable'), buttons: [] };
    }
  }
}
