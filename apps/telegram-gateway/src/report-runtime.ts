import { createHash, randomBytes } from 'node:crypto';
import {
  ReportSnapshotKeyRing,
  ReportTokens,
  AesGcmProfileReportSnapshotProtector,
  AesGcmProfileReportSnapshotReader,
  AesGcmPhotoReportSnapshotReader,
  AesGcmPhotoReportSnapshotProtector,
  AesGcmChatReportSnapshotReader,
  AesGcmUnmatchedReportSnapshotReader,
  type UserSessionActor,
  type UserProductLife,
  type OpaqueTokenStore,
} from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { ApplicationError, canSubmitUserReport, normalizeReportText } from '@nakh/domain';
import { CatalogRenderer } from '@nakh/localization';
import {
  createPostgresUserReportServices,
  PostgresGetReportReasonsHandler,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresTelegramUserResolver,
  PostgresUserSessionStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  RedisOwnedOpaqueTokenStore,
  RedisRateLimiter,
  type createRedisConnection,
} from '@nakh/queue-redis';
import { TelegramBotApiMenuClient, TelegramReportSelections } from '@nakh/telegram';
import {
  SignupNavigationTokens,
  signupRecord as record,
  type SignupNavigation as Nav,
} from './signup-navigation.js';

export interface TelegramReportRuntimePort {
  readonly enabled: boolean;
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
  button(
    actor: UserSessionActor,
    telegramUserId: string,
    deliveryId: string,
    photoId?: string,
  ): Promise<string>;
}
function unavailable(): ApplicationError {
  return new ApplicationError('report_unavailable', 'error.report.unavailable', 409);
}
function operation(parts: readonly unknown[]): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify(['telegram-public-report-v1', ...parts]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
/** Public profile and selected-photo reports reuse native evidence capture and
 * media holds. Existing deletion-media execution preserves held thumbnails;
 * administrative reveal remains a separate capability. */
export class TelegramReportRuntime implements TelegramReportRuntimePort {
  public readonly enabled = true;
  private readonly key: Uint8Array;
  private readonly protector: AesGcmProfileReportSnapshotProtector;
  private readonly photoProtector: AesGcmPhotoReportSnapshotProtector;
  public constructor(
    private readonly database: NakhDatabase,
    private readonly botId: string,
    key: Uint8Array,
    private readonly keys: ReportSnapshotKeyRing,
    writeKeyId: string,
    writeKeyVersion: number,
    private readonly client: TelegramBotApiMenuClient,
    private readonly limiter: Pick<RedisRateLimiter, 'consume'>,
    private readonly store: (life: UserProductLife) => OpaqueTokenStore,
  ) {
    this.key = Uint8Array.from(key);
    keys.assertSeparateNavigationKey(this.key);
    const write = keys.writeKey(writeKeyId, writeKeyVersion);
    this.protector = new AesGcmProfileReportSnapshotProtector(
      write.keyId,
      write.keyVersion,
      write.key,
    );
    this.photoProtector = new AesGcmPhotoReportSnapshotProtector(
      write.keyId,
      write.keyVersion,
      write.key,
    );
  }
  private tokens(telegramUserId: string, life: UserProductLife): SignupNavigationTokens {
    return new SignupNavigationTokens(
      this.store(life),
      this.key,
      this.botId,
      telegramUserId,
      life,
      undefined,
      'report',
    );
  }
  private async current(actor: UserSessionActor, telegramUserId: string): Promise<void> {
    const owner = await new PostgresTelegramUserResolver(this.database).resolveProductLife(
      telegramUserId,
    );
    const identity = await new PostgresIdentityStore(this.database).getByTelegramUserId(
      telegramUserId,
    );
    if (
      owner?.userId !== actor.userId ||
      owner.productEpoch !== actor.productEpoch ||
      identity === undefined ||
      !canSubmitUserReport(identity.accountState) ||
      (await new PostgresUserSessionStore(this.database).current(actor, actor.sessionGrantId)) ===
        undefined
    )
      throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
  }
  private async render(telegramUserId: string): Promise<(key: string) => string> {
    const identity = await new PostgresIdentityStore(this.database).getByTelegramUserId(
      telegramUserId,
    );
    const catalog = await new PostgresLocalizationStore(this.database).loadActiveCatalog(
      identity?.uiLocale ?? 'en',
    );
    const renderer = new CatalogRenderer(
      { [catalog.resolvedLocale]: catalog.messages },
      catalog.resolvedLocale,
    );
    return (key) => renderer.render(catalog.resolvedLocale, { key, variables: {} });
  }
  public async onModuleInit(): Promise<void> {
    const readers = {
      profile: new AesGcmProfileReportSnapshotReader(this.keys),
      photo: new AesGcmPhotoReportSnapshotReader(this.keys),
      chat: new AesGcmChatReportSnapshotReader(this.keys),
      unmatched_user: new AesGcmUnmatchedReportSnapshotReader(this.keys),
    };
    const versions = await this.database
      .selectFrom('moderation.report_snapshots')
      .select(['encryption_key_id', 'encryption_key_version'])
      .distinct()
      .execute();
    for (const version of versions) {
      if (
        this.keys.resolve(version.encryption_key_id, version.encryption_key_version) === undefined
      )
        throw new Error('Report snapshot custody unavailable.');
      const row = await this.database
        .selectFrom('moderation.report_snapshots')
        .selectAll()
        .where('encryption_key_id', '=', version.encryption_key_id)
        .where('encryption_key_version', '=', version.encryption_key_version)
        .orderBy('id')
        .limit(1)
        .executeTakeFirstOrThrow();
      readers[row.snapshot_type].decrypt(
        { reportId: row.report_id, evidenceId: row.report_evidence_id },
        {
          schemaVersion: row.schema_version,
          snapshotType: row.snapshot_type,
          keyId: row.encryption_key_id,
          keyVersion: row.encryption_key_version,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          sha256: row.content_sha256,
        },
      );
    }
    const locales = await this.database
      .selectFrom('catalog.locales')
      .select('code')
      .where('is_active', '=', true)
      .execute();
    for (const { code } of locales) {
      const catalog = await new PostgresLocalizationStore(this.database).loadActiveCatalog(code);
      for (const name of [
        'report.title',
        'report.prompt',
        'report.text.prompt',
        'report.button.submit',
        'report.button.cancel',
        'report.submitted',
        'report.ui.reply_submits',
        'report.ui.cancelled',
        'error.report.unavailable',
        'error.m7.rate_limited',
        'signup.ui.expired',
      ])
        if (
          typeof catalog.messages[name] !== 'string' ||
          catalog.messages[name].trim() === '' ||
          /[{}]/u.test(catalog.messages[name])
        )
          throw new Error('Report localization unavailable.');
    }
  }
  public async button(
    actor: UserSessionActor,
    telegramUserId: string,
    deliveryId: string,
    photoId?: string,
  ): Promise<string> {
    const owner = Object.freeze({ ...actor });
    await this.current(owner, telegramUserId);
    return this.tokens(telegramUserId, owner).button({
      actor: owner,
      version: 1,
      screen: 'report',
      action: 'begin',
      code: deliveryId,
      ...(photoId === undefined ? {} : { photoId }),
      group: randomBytes(12).toString('base64url'),
    });
  }
  private services(nav: Nav): ReturnType<typeof createPostgresUserReportServices> {
    if (nav.code === undefined) throw unavailable();
    return createPostgresUserReportServices(
      this.database,
      ReportTokens.forLife(this.store(nav.actor), this.key, nav.actor),
      {
        profile: {
          protector: this.protector,
          reader: new AesGcmProfileReportSnapshotReader(this.keys),
        },
        photo: {
          protector: this.photoProtector,
          reader: new AesGcmPhotoReportSnapshotReader(this.keys),
        },
      },
      { actor: nav.actor, deliveryId: nav.code },
    );
  }
  private async chooseReason(telegramUserId: string, nav: Nav, updateId: number): Promise<void> {
    const tokens = this.tokens(telegramUserId, nav.actor),
      reportTokens = ReportTokens.forLife(this.store(nav.actor), this.key, nav.actor);
    const source = await reportTokens.issueSource(nav.actor.userId, {
      kind: 'delivered_candidate',
      referenceId: nav.code!,
      ...(nav.photoId === undefined ? {} : { photoId: nav.photoId }),
    });
    const requestId = operation([this.botId, telegramUserId, nav.actor, updateId, 'prepare']);
    const prepared = await this.services(nav).prepare.execute(
      {
        actor: nav.actor,
        requestId,
        sourceActionToken: source.token,
        requestedEvidenceTypes: [nav.photoId === undefined ? 'profile' : 'photo'],
      },
      nav.actor,
      nav.actor.productEpoch,
      nav.actor.sessionGrantId,
    );
    const reference = await new TelegramReportSelections(this.store(nav.actor), this.key).put(
      nav.actor.userId,
      prepared,
      requestId,
    );
    const reasons = await new PostgresGetReportReasonsHandler(this.database).execute(
        { actor: nav.actor, requestId },
        nav.actor,
      ),
      t = await this.render(telegramUserId);
    const group = operation([this.botId, nav.actor, updateId, 'reasons'])
      .replaceAll('-', '')
      .slice(0, 16);
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const reason of reasons.items)
      keyboard.push([
        {
          text: t(reason.labelKey),
          callback_data: await tokens.button({
            ...nav,
            reference,
            reason: reason.code,
            action: 'pick',
            group,
          }),
        },
      ]);
    keyboard.push([
      {
        text: t('report.button.cancel'),
        callback_data: await tokens.button({ ...nav, reference, action: 'clear', group }),
      },
    ]);
    await this.current(nav.actor, telegramUserId);
    await this.client.sendMenu(telegramUserId, {
      text: t('report.prompt'),
      replyMarkup: { inline_keyboard: keyboard },
    });
  }
  private async details(telegramUserId: string, nav: Nav, updateId: number): Promise<void> {
    const tokens = this.tokens(telegramUserId, nav.actor),
      t = await this.render(telegramUserId);
    const next = {
      ...nav,
      group: operation([this.botId, nav.actor, updateId, 'submit'])
        .replaceAll('-', '')
        .slice(0, 16),
    };
    const selections = new TelegramReportSelections(this.store(nav.actor), this.key);
    if (
      nav.reference === undefined ||
      (await selections.get(nav.actor.userId, nav.reference)) === undefined
    )
      throw unavailable();
    await this.current(nav.actor, telegramUserId);
    await this.client.sendMenu(telegramUserId, {
      text: t('report.text.prompt'),
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: t('report.button.submit'),
              callback_data: await tokens.button({ ...next, action: 'save' }),
            },
          ],
          [
            {
              text: t('report.button.cancel'),
              callback_data: await tokens.button({ ...next, action: 'clear' }),
            },
          ],
        ],
      },
    });
    const prompt = await this.client.sendPrompt(telegramUserId, t('report.ui.reply_submits'));
    await this.current(nav.actor, telegramUserId);
    await tokens.prompt(prompt, { ...next, action: 'reply' });
  }
  private async submit(
    telegramUserId: string,
    nav: Nav,
    updateId: number,
    text?: string,
  ): Promise<void> {
    if (nav.reference === undefined || nav.reason === undefined) throw unavailable();
    const evidenceIntentToken = await new TelegramReportSelections(
      this.store(nav.actor),
      this.key,
    ).get(nav.actor.userId, nav.reference);
    if (evidenceIntentToken === undefined) throw unavailable();
    const id = operation([this.botId, telegramUserId, nav.actor, updateId, 'submit']);
    const identity = await new PostgresIdentityStore(this.database).getByTelegramUserId(
      telegramUserId,
    );
    await this.services(nav).submit.execute(
      {
        commandId: id,
        requestId: id,
        idempotencyKey: `telegram-report:${id}`,
        commandType: 'moderation.submit-report',
        schemaVersion: 1,
        actor: nav.actor,
        occurredAt: new Date().toISOString(),
        locale: identity?.uiLocale ?? 'en',
        data: {
          evidenceIntentToken,
          reasonCode: nav.reason,
          ...(text === undefined ? {} : { text }),
        },
      },
      nav.actor,
      nav.actor.productEpoch,
      nav.actor.sessionGrantId,
    );
    const t = await this.render(telegramUserId);
    await this.client.sendMenu(telegramUserId, {
      text: t('report.submitted'),
      replyMarkup: { inline_keyboard: [] },
    });
  }
  public async handle(input: unknown): Promise<'unhandled' | 'notice'> {
    const root = record(structuredClone(input)),
      callback = record(root?.callback_query),
      message = record(root?.message),
      data = callback?.data,
      reply = record(message?.reply_to_message);
    const ownCallback = typeof data === 'string' && data.startsWith('m9r:');
    if (!ownCallback && reply === undefined) return 'unhandled';
    const container = callback === undefined ? message : record(callback.message),
      from = record(callback?.from ?? message?.from),
      chat = record(container?.chat),
      bot = record((callback === undefined ? reply : container)?.from);
    if (
      root?.edited_message !== undefined ||
      (callback !== undefined && message !== undefined) ||
      typeof root?.update_id !== 'number' ||
      !Number.isSafeInteger(root.update_id) ||
      root.update_id < 0 ||
      typeof from?.id !== 'number' ||
      !Number.isSafeInteger(from.id) ||
      from.id <= 0 ||
      from.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== from.id ||
      bot?.is_bot !== true ||
      String(bot.id) !== this.botId ||
      (callback !== undefined && (!ownCallback || callback.inline_message_id !== undefined)) ||
      (callback === undefined &&
        (typeof message?.text !== 'string' ||
          !Number.isSafeInteger(reply?.message_id) ||
          Number(reply?.message_id) < 1 ||
          record(reply?.chat)?.type !== 'private' ||
          record(reply?.chat)?.id !== from.id))
    ) {
      if (ownCallback) throw unavailable();
      return 'unhandled';
    }
    const telegramUserId = String(from.id),
      updateId = root.update_id;
    const life = await new PostgresTelegramUserResolver(this.database).resolveProductLife(
      telegramUserId,
    );
    if (life === undefined) {
      if (!ownCallback) return 'unhandled';
      throw unavailable();
    }
    const tokens = this.tokens(telegramUserId, life),
      nav =
        callback === undefined
          ? await tokens.reply(Number(reply?.message_id))
          : await tokens.callback(String(data));
    if (nav === undefined || nav.screen !== 'report') {
      if (!ownCallback) return 'unhandled';
      const t = await this.render(telegramUserId);
      await this.client.sendMenu(telegramUserId, {
        text: t('signup.ui.expired'),
        replyMarkup: { inline_keyboard: [] },
      });
      return 'notice';
    }
    if (callback !== undefined && typeof callback.id === 'string')
      await this.client.answerCallback(callback.id);
    try {
      await this.current(nav.actor, telegramUserId);
      const rate = await this.limiter.consume({
        scope: 'telegram_report',
        subject: nav.actor.userId,
        limit: 20,
        windowSeconds: 60,
      });
      if (!rate.allowed) throw new ApplicationError('rate_limited', 'error.m7.rate_limited', 429);
      const text = callback === undefined ? String(message?.text) : undefined;
      if (text !== undefined) normalizeReportText(text);
      const claim = await tokens.claim(
        nav,
        updateId,
        callback === undefined ? tokens.replyId(Number(reply?.message_id)) : String(data),
        nav,
      );
      if (!claim.accepted) return 'notice';
      if (nav.action === 'begin') await this.chooseReason(telegramUserId, nav, updateId);
      else if (nav.action === 'pick') await this.details(telegramUserId, nav, updateId);
      else if (nav.action === 'save' || nav.action === 'reply')
        await this.submit(telegramUserId, nav, updateId, text);
      else if (nav.action === 'clear') {
        const t = await this.render(telegramUserId);
        await this.client.sendMenu(telegramUserId, {
          text: t('report.ui.cancelled'),
          replyMarkup: { inline_keyboard: [] },
        });
      } else throw unavailable();
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.status >= 500)
        throw new ApplicationError('internal_error', 'error.m7.internal', 500);
      const t = await this.render(telegramUserId);
      await this.client.sendMenu(telegramUserId, {
        text: t(
          error.status === 401
            ? 'signup.ui.expired'
            : error.code === 'rate_limited'
              ? 'error.m7.rate_limited'
              : 'error.report.unavailable',
        ),
        replyMarkup: { inline_keyboard: [] },
      });
    }
    return 'notice';
  }
}

export function createTelegramReportRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    redis: ReturnType<typeof createRedisConnection>;
    resolveSecret?: (reference: string) => string;
  }>,
): TelegramReportRuntimePort {
  if (!input.config.telegram.reportsEnabled)
    return {
      enabled: false,
      handle: () => Promise.resolve('unhandled'),
      button: () => Promise.reject(unavailable()),
    };
  const resolve = input.resolveSecret ?? resolveSecretReference,
    token = resolve(input.config.telegram.botTokenRef),
    match = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(token);
  if (match === null || !Number.isSafeInteger(Number(match[1])))
    throw new Error('Report credentials unavailable.');
  const encoded = resolve(input.config.telegram.actionTokenKeyRef),
    key = Buffer.from(encoded, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== encoded)
    throw new Error('Report credentials unavailable.');
  return new TelegramReportRuntime(
    input.database,
    match[1]!,
    key,
    new ReportSnapshotKeyRing(resolve(input.config.deletion.evidenceKeyRingRef)),
    input.config.telegram.reportSnapshotKeyId,
    input.config.telegram.reportSnapshotKeyVersion,
    new TelegramBotApiMenuClient(token),
    new RedisRateLimiter(input.redis, input.config.redis.queuePrefix),
    (life) => new RedisOwnedOpaqueTokenStore(input.redis, input.config.redis.queuePrefix, life),
  );
}
