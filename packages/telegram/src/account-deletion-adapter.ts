import { createHash } from 'node:crypto';
import { ApplicationError } from '@nakh/domain';
import type {
  AccountControlActor,
  AccountControlSessionStore,
  AccountDeletionStore,
  LocalizedIntent,
  RateLimiterPort,
} from '@nakh/application';
export type TelegramAccountControlLife = Readonly<{
  userId: string;
  productEpoch: number;
  accountVersion: number;
}>;
export interface TelegramAccountControlResolver {
  resolveAccountControlLife(
    telegramUserId: string,
  ): Promise<TelegramAccountControlLife | undefined>;
}
export type TelegramAccountDeletionNotice = Readonly<{
  handled: true;
  userId: string;
  productEpoch: number;
  telegramUserId: string;
  control: AccountControlActor | undefined;
  callbackQueryId: string | undefined;
  notice: LocalizedIntent;
  buttons: ReadonlyArray<Readonly<{ label: LocalizedIntent; callbackData: string }>>;
}>;
export type TelegramAccountDeletionResult =
  Readonly<{ handled: false }> | TelegramAccountDeletionNotice;
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
function intent(key: string): LocalizedIntent {
  return { key, variables: {} };
}
function statusIntent(
  status: Awaited<ReturnType<AccountDeletionStore['status']>>,
): LocalizedIntent {
  return intent(
    status === undefined
      ? 'deletion.not_requested'
      : status.phase !== 'completed'
        ? 'deletion.progress'
        : status.returnDecision === 'allowed'
          ? 'deletion.completed'
          : 'deletion.completed_denied',
  );
}
function uuid(parts: readonly string[]): string {
  const bytes = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const CALLBACK = /^m8d:([yn]):([1-9a-z][0-9a-z]{0,6}):([A-Za-z0-9_-]{43})$/u;
/** Only authenticated Telegram primary ingress may call this adapter. Limited
 * native grants deliberately survive tombstone; they never mint product access. */
export class TelegramAccountDeletionAdapter {
  public constructor(
    private readonly botId: string,
    private readonly users: TelegramAccountControlResolver,
    private readonly controls: Pick<AccountControlSessionStore, 'issue'>,
    private readonly store: (control: AccountControlActor) => AccountDeletionStore,
    private readonly limiter: RateLimiterPort,
  ) {
    if (!/^[1-9][0-9]{0,19}$/u.test(botId) || !Number.isSafeInteger(Number(botId)))
      throw new Error('Telegram bot identity invalid.');
  }
  public async handle(update: unknown): Promise<TelegramAccountDeletionResult> {
    const root = record(update),
      callback = record(root?.callback_query),
      message = record(callback?.message ?? root?.message);
    const text = typeof message?.text === 'string' ? message.text : '';
    const command = callback === undefined ? /^\/(delete|delete_status)$/u.exec(text) : null;
    const data = callback?.data;
    if (command === null && !(typeof data === 'string' && data.startsWith('m8d:')))
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
    const version = parsed === null ? undefined : Number.parseInt(parsed[2]!, 36);
    if (
      version !== undefined &&
      (!Number.isSafeInteger(version) ||
        version < 1 ||
        version > 2147483647 ||
        version.toString(36) !== parsed![2])
    )
      throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
    const telegramUserId = String(sender),
      resolved = await this.users.resolveAccountControlLife(telegramUserId);
    if (resolved === undefined)
      throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
    // Capture before rate-limit/native waits. Never resolve a replacement life.
    const life = Object.freeze({
      userId: resolved.userId,
      productEpoch: resolved.productEpoch,
      accountVersion: resolved.accountVersion,
    });
    const originId = uuid([
      'telegram-account-control-v1',
      this.botId,
      String(root.update_id),
      life.userId,
    ]);
    let control: AccountControlActor | undefined;
    const base = {
      handled: true as const,
      userId: life.userId,
      productEpoch: life.productEpoch,
      telegramUserId,
      callbackQueryId: callback?.id as string | undefined,
    };
    try {
      const rate = await this.limiter.consume({
        scope: 'telegram_account_control',
        subject: life.userId,
        limit: 10,
        windowSeconds: 60,
      });
      if (!rate.allowed)
        return {
          ...base,
          control: undefined,
          notice: intent('deletion.rate_limited'),
          buttons: [],
        };
      // Stable origin ID intentionally omits epoch. Replayed old updates cannot
      // obtain new-life authority: native issuance retains the original grant fact.
      const grant = await this.controls.issue(
        { userId: life.userId, productEpoch: life.productEpoch },
        originId,
      );
      if (
        grant === undefined ||
        grant.userId !== life.userId ||
        grant.productEpoch !== life.productEpoch
      )
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      control = Object.freeze({
        kind: 'user',
        scope: 'account_control',
        userId: life.userId,
        productEpoch: life.productEpoch,
        controlGrantId: grant.id,
      });
      const store = this.store(control),
        actor = { kind: 'user' as const, userId: life.userId };
      if (command?.[1] === 'delete') {
        const proof = await store.prepare({
          actor,
          requestId: originId,
          expectedAccountVersion: life.accountVersion,
        });
        return {
          ...base,
          control,
          notice: intent('deletion.confirm'),
          buttons: [
            {
              label: intent('deletion.button.confirm'),
              callbackData: `m8d:y:${proof.expectedAccountVersion.toString(36)}:${proof.confirmationToken}`,
            },
            {
              label: intent('deletion.button.cancel'),
              callbackData: `m8d:n:${proof.expectedAccountVersion.toString(36)}:${proof.confirmationToken}`,
            },
          ],
        };
      }
      if (command?.[1] === 'delete_status') {
        const status = await store.status({ actor, requestId: originId });
        return { ...base, control, notice: statusIntent(status), buttons: [] };
      }
      const action = parsed![1] === 'y' ? 'account.delete' : 'account.cancel-deletion',
        token = parsed![3]!;
      const commandId = uuid([
        'telegram-deletion-action-v1',
        this.botId,
        life.userId,
        String(life.productEpoch),
        action,
        parsed![2]!,
        token,
      ]);
      const common = {
        commandId,
        schemaVersion: 1 as const,
        actor,
        requestId: commandId,
        idempotencyKey: `telegram-deletion:${commandId}`,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        channelContext: { channel: 'telegram' as const, channelIdentityId: telegramUserId },
        data: { confirmationToken: token, expectedAccountVersion: version! },
      };
      if (action === 'account.delete') {
        const result = await store.request({ ...common, commandType: action });
        return { ...base, control, notice: statusIntent(result.status), buttons: [] };
      }
      await store.cancel({ ...common, commandType: action });
      return { ...base, control, notice: intent('deletion.cancelled'), buttons: [] };
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.status >= 500)
        throw new ApplicationError('internal_error', 'error.deletion.unavailable', 500);
      return { ...base, control, notice: intent('deletion.unavailable'), buttons: [] };
    }
  }
}
