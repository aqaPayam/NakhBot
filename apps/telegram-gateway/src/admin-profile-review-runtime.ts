import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ApplicationError } from '@nakh/domain';
import {
  findNativeProfileReviewer,
  PostgresProfileReviewStore,
  isProfileReviewPosition,
  type NakhDatabase,
  type NativeAdminSessionPrincipal,
  type ProfileReviewContext,
  type ProfileReviewPosition,
} from '@nakh/persistence-postgres';
import {
  RedisOpaqueTokenStore,
  RedisRateLimiter,
  type createRedisConnection,
} from '@nakh/queue-redis';
import {
  m7Record as record,
  requirePrivateM7Actor,
  type TelegramBotApiMenuClient,
  type M7TextRenderer,
  type TelegramAdminEvidenceDelivery,
} from '@nakh/telegram';

type Nav = Readonly<{
  v: 1;
  principal: NativeAdminSessionPrincipal;
  expiresAt: number;
  group: string;
  action: 'list' | 'select' | 'read' | 'approve' | 'reject' | 'confirm';
  requestId?: string | undefined;
  decision?: 'approved' | 'rejected' | undefined;
  after?: ProfileReviewPosition | undefined;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function unavailable(): never {
  throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
}
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function valid(input: unknown): input is Nav {
  const n = record(input),
    p = record(n?.principal);
  return (
    !!n &&
    n.v === 1 &&
    Object.keys(n).every((k) =>
      ['v', 'principal', 'expiresAt', 'group', 'action', 'requestId', 'decision', 'after'].includes(
        k,
      ),
    ) &&
    !!p &&
    Object.keys(p).sort().join(',') === 'actorUserId,adminUserId,sessionId' &&
    [p.actorUserId, p.adminUserId, p.sessionId].every(
      (v) => typeof v === 'string' && UUID.test(v),
    ) &&
    typeof n.expiresAt === 'number' &&
    Number.isSafeInteger(n.expiresAt) &&
    n.expiresAt > Date.now() &&
    typeof n.group === 'string' &&
    /^[A-Za-z0-9_-]{16}$/u.test(n.group) &&
    typeof n.action === 'string' &&
    ['list', 'select', 'read', 'approve', 'reject', 'confirm'].includes(n.action) &&
    (n.action === 'list' || (typeof n.requestId === 'string' && UUID.test(n.requestId))) &&
    (n.requestId === undefined || (typeof n.requestId === 'string' && UUID.test(n.requestId))) &&
    (n.decision === undefined || n.decision === 'approved' || n.decision === 'rejected') &&
    (n.action !== 'confirm' || n.decision !== undefined) &&
    (n.after === undefined || isProfileReviewPosition(n.after))
  );
}

/** Encrypted navigation contains only native authority references and selectors.
 * Private reasons/field values stay in PostgreSQL and a single audited delivery. */
export class TelegramAdminProfileReviewRuntime {
  private readonly encryptionKey: Buffer;
  private readonly signingKey: Buffer;
  private readonly tokens: RedisOpaqueTokenStore;
  private readonly limiter: RedisRateLimiter;
  public constructor(
    private readonly database: NakhDatabase,
    redis: ReturnType<typeof createRedisConnection>,
    prefix: string,
    private readonly botId: string,
    key: Uint8Array,
    private readonly client: TelegramBotApiMenuClient,
    private readonly privateDelivery: Pick<TelegramAdminEvidenceDelivery, 'text'>,
    private readonly renderer: M7TextRenderer,
  ) {
    if (key.byteLength !== 32 || !/^[1-9][0-9]{0,19}$/u.test(botId))
      throw new Error('Profile review navigation unavailable.');
    this.encryptionKey = createHmac('sha256', key).update('profile-review-encryption-v1').digest();
    this.signingKey = createHmac('sha256', key).update('profile-review-signing-v1').digest();
    this.tokens = new RedisOpaqueTokenStore(redis, prefix + ':admin-profile');
    this.limiter = new RedisRateLimiter(redis, prefix);
  }
  public async onModuleInit(): Promise<void> {
    if (
      !(await this.database
        .selectFrom('platform.schema_migrations')
        .select('name')
        .where('name', '=', '000167_m9_profile_correction_review.sql')
        .executeTakeFirst())
    )
      throw new Error('Profile review schema unavailable.');
  }
  private t(
    context: ProfileReviewContext,
    key: string,
    variables: Record<string, string | number> = {},
  ): string {
    return this.renderer.render(context.locale, { key, variables });
  }
  private tag(recipient: string, id: string, nonce: string, ciphertext: string): string {
    return createHmac('sha256', this.signingKey)
      .update(JSON.stringify([this.botId, recipient, id, nonce, ciphertext]))
      .digest()
      .subarray(0, 16)
      .toString('base64url');
  }
  private async button(
    recipient: string,
    context: ProfileReviewContext,
    label: string,
    change: Pick<Nav, 'action'> & Partial<Nav>,
  ): Promise<{ text: string; callback_data: string }> {
    const id = randomBytes(12).toString('base64url'),
      nonce = randomBytes(12);
    const state: Nav = {
      ...change,
      v: 1,
      principal: { ...context.principal },
      expiresAt: Math.min(
        Date.now() + 300000,
        context.expiresAt.getTime(),
        context.mfaExpiresAt.getTime(),
      ),
      group: randomBytes(12).toString('base64url'),
    };
    if (!valid(state)) unavailable();
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([this.botId, recipient, id])));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(state), 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64url');
    const encodedNonce = nonce.toString('base64url'),
      mac = this.tag(recipient, id, encodedNonce, ciphertext);
    if (
      !(await this.tokens.putIfAbsent(
        id,
        JSON.stringify({ nonce: encodedNonce, ciphertext, mac }),
        Math.min(300, Math.ceil((state.expiresAt - Date.now()) / 1000)),
      ))
    )
      throw new Error('Profile review navigation storage unavailable.');
    return { text: label, callback_data: `m9u:${id}:${mac}` };
  }
  private async navigation(recipient: string, token: string): Promise<Nav> {
    const match = /^m9u:([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22})$/u.exec(token);
    if (!match) unavailable();
    const saved = await this.tokens.get(match[1]!);
    if (saved === undefined || saved.length > 4096) unavailable();
    try {
      const row = record(JSON.parse(saved) as unknown);
      if (
        !row ||
        Object.keys(row).sort().join(',') !== 'ciphertext,mac,nonce' ||
        typeof row.nonce !== 'string' ||
        typeof row.ciphertext !== 'string' ||
        typeof row.mac !== 'string' ||
        !equal(row.mac, match[2]!) ||
        !equal(row.mac, this.tag(recipient, match[1]!, row.nonce, row.ciphertext))
      )
        unavailable();
      const bytes = Buffer.from(row.ciphertext, 'base64url'),
        nonce = Buffer.from(row.nonce, 'base64url');
      if (nonce.length !== 12 || bytes.length < 17) unavailable();
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, nonce);
      decipher.setAAD(Buffer.from(JSON.stringify([this.botId, recipient, match[1]])));
      decipher.setAuthTag(bytes.subarray(-16));
      const state: unknown = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString('utf8'),
      );
      if (!valid(state)) unavailable();
      return state;
    } catch {
      unavailable();
    }
  }
  private async current(recipient: string, context: ProfileReviewContext): Promise<void> {
    if (!(await findNativeProfileReviewer(this.database, recipient, context.principal)))
      unavailable();
  }
  private async send(
    recipient: string,
    context: ProfileReviewContext,
    text: string,
    keyboard: Array<Array<{ text: string; callback_data: string }>> = [],
  ): Promise<void> {
    await this.current(recipient, context);
    await this.client.sendMenu(recipient, { text, replyMarkup: { inline_keyboard: keyboard } });
  }
  private async notice(
    recipient: string,
    context: ProfileReviewContext,
    key: string,
  ): Promise<void> {
    await this.send(recipient, context, this.t(context, key), [
      [
        await this.button(recipient, context, this.t(context, 'profile.review.back'), {
          action: 'list',
        }),
      ],
    ]);
  }
  private async list(
    recipient: string,
    context: ProfileReviewContext,
    operationId: string,
    after?: ProfileReviewPosition,
  ): Promise<void> {
    const result = await new PostgresProfileReviewStore(this.database, context.principal).list(
      operationId,
      after,
    );
    if (result.result !== 'succeeded' || result.replayed || !result.value) {
      await this.notice(
        recipient,
        context,
        result.replayed ? 'profile.review.processed' : 'profile.review.unavailable',
      );
      return;
    }
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const item of result.value.items)
      rows.push([
        await this.button(
          recipient,
          context,
          this.t(context, 'profile.review.row', {
            field: this.t(
              context,
              item.field === 'birth_year' ? 'profile.edit.birth_year' : 'profile.edit.gender',
            ),
            submitted: item.submittedAt,
          }),
          { action: 'select', requestId: item.id },
        ),
      ]);
    if (result.value.next)
      rows.push([
        await this.button(recipient, context, this.t(context, 'signup.ui.next'), {
          action: 'list',
          after: result.value.next,
        }),
      ]);
    await this.send(
      recipient,
      context,
      this.t(context, 'profile.review.title') +
        (rows.length ? '' : '\n\n' + this.t(context, 'profile.review.empty')),
      rows,
    );
  }
  private async gender(context: ProfileReviewContext, value: string | number): Promise<string> {
    if (typeof value !== 'string') return String(value);
    const option = await this.database
      .selectFrom('catalog.gender_options')
      .select('label_key')
      .where('code', '=', value)
      .executeTakeFirst();
    return option ? this.t(context, option.label_key) : value;
  }
  public async handle(input: unknown): Promise<'unhandled' | 'notice'> {
    const update = structuredClone(input),
      root = record(update),
      message = record(root?.message),
      callback = record(root?.callback_query);
    const command = message?.text === '/admin_changes',
      data =
        typeof callback?.data === 'string' && callback.data.startsWith('m9u:')
          ? callback.data
          : undefined;
    if (!command && data === undefined) return 'unhandled';
    const actor = requirePrivateM7Actor(update, data === undefined ? 'message' : 'callback'),
      recipient = actor.telegramUserId;
    if (
      (message !== undefined && callback !== undefined) ||
      (data !== undefined &&
        (record(record(callback?.message)?.from)?.is_bot !== true ||
          String(record(record(callback?.message)?.from)?.id) !== this.botId ||
          typeof callback?.id !== 'string' ||
          callback.id.length < 1 ||
          callback.id.length > 128))
    )
      unavailable();
    try {
      if (
        !(
          await this.limiter.consume({
            scope: 'telegram_admin_profile_review',
            subject: recipient,
            limit: 30,
            windowSeconds: 60,
          })
        ).allowed
      )
        throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429);
      const nav = data === undefined ? undefined : await this.navigation(recipient, data);
      const context = await findNativeProfileReviewer(this.database, recipient, nav?.principal);
      if (!context) unavailable();
      if (callback !== undefined) await this.client.answerCallback(String(callback.id));
      const operationId = createHash('sha256')
        .update(
          JSON.stringify(
            nav === undefined
              ? [this.botId, recipient, actor.updateId]
              : [this.botId, recipient, nav.group],
          ),
        )
        .digest('hex');
      if (nav === undefined || nav.action === 'list') {
        await this.list(recipient, context, operationId, nav?.after);
        return 'notice';
      }
      if (!nav.requestId) unavailable();
      if (nav.action === 'select') {
        await this.send(recipient, context, this.t(context, 'profile.review.open'), [
          [
            await this.button(recipient, context, this.t(context, 'profile.review.view'), {
              action: 'read',
              requestId: nav.requestId,
            }),
          ],
          [
            await this.button(recipient, context, this.t(context, 'profile.review.back'), {
              action: 'list',
            }),
          ],
        ]);
        return 'notice';
      }
      if (nav.action === 'read') {
        const result = await new PostgresProfileReviewStore(this.database, context.principal).read(
          operationId,
          nav.requestId,
        );
        if (result.result !== 'succeeded' || result.replayed || !result.value) {
          await this.notice(
            recipient,
            context,
            result.replayed ? 'profile.review.processed' : 'profile.review.unavailable',
          );
          return 'notice';
        }
        const body = result.value,
          text = this.t(context, 'profile.review.body', {
            field: this.t(
              context,
              body.field === 'birth_year' ? 'profile.edit.birth_year' : 'profile.edit.gender',
            ),
            old:
              body.field === 'gender'
                ? await this.gender(context, body.oldValue)
                : String(body.oldValue),
            requested:
              body.field === 'gender'
                ? await this.gender(context, body.requestedValue)
                : String(body.requestedValue),
            reason: body.reason,
            status: this.t(context, 'profile.edit.status.' + body.status),
          });
        await this.current(recipient, context);
        await this.privateDelivery.text({ recipient, text, disableLinkPreviews: true });
        const rows: Array<Array<{ text: string; callback_data: string }>> = [];
        if (body.status === 'pending')
          rows.push(
            [
              await this.button(recipient, context, this.t(context, 'profile.review.approve'), {
                action: 'approve',
                requestId: nav.requestId,
              }),
            ],
            [
              await this.button(recipient, context, this.t(context, 'profile.review.reject'), {
                action: 'reject',
                requestId: nav.requestId,
              }),
            ],
          );
        rows.push([
          await this.button(recipient, context, this.t(context, 'profile.review.back'), {
            action: 'list',
          }),
        ]);
        await this.send(recipient, context, this.t(context, 'profile.review.title'), rows);
        return 'notice';
      }
      if (nav.action === 'approve' || nav.action === 'reject') {
        const decision = nav.action === 'approve' ? 'approved' : 'rejected';
        await this.send(
          recipient,
          context,
          this.t(
            context,
            decision === 'approved'
              ? 'profile.review.confirm_approve'
              : 'profile.review.confirm_reject',
          ),
          [
            [
              await this.button(recipient, context, this.t(context, 'profile.review.confirm'), {
                action: 'confirm',
                decision,
                requestId: nav.requestId,
              }),
            ],
            [
              await this.button(recipient, context, this.t(context, 'profile.review.cancel'), {
                action: 'list',
              }),
            ],
          ],
        );
        return 'notice';
      }
      if (nav.decision === undefined) unavailable();
      const result = await new PostgresProfileReviewStore(this.database, context.principal).review(
        operationId,
        nav.requestId,
        nav.decision,
      );
      await this.notice(
        recipient,
        context,
        result.result === 'succeeded' ? 'profile.review.saved' : 'profile.review.unavailable',
      );
      return 'notice';
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.status >= 500) throw error;
      await this.client.sendMenu(recipient, {
        text: this.renderer.render('en', { key: 'profile.review.unavailable', variables: {} }),
        replyMarkup: { inline_keyboard: [] },
      });
      return 'notice';
    }
  }
}
