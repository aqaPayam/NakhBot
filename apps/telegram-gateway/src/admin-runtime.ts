import type { UserSessionActor } from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { CatalogRenderer, M7_LOCALIZATION_ENTRIES, M9_ADMIN_TEXTS } from '@nakh/localization';
import {
  AdminRuntimeKeys,
  createPostgresTotpAdminSessions,
  createPostgresUserSessions,
  getAdminFirstFactorIdentity,
  loadAdminRuntimeCatalogs,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { RedisOpaqueTokenStore, type createRedisConnection } from '@nakh/queue-redis';
import { TelegramAdminTextDelivery } from '@nakh/telegram';
import { createTelegramAdminSafetyReadIngress } from './admin-safety-read-ingress.js';

export interface AdministratorTelegramPort {
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
  link(actor: UserSessionActor, locale: string): Promise<string | undefined>;
}
class AdministratorTelegramRuntime implements AdministratorTelegramPort {
  private readonly keys: AdminRuntimeKeys;
  private readonly users: ReturnType<typeof createPostgresUserSessions>;
  private readonly ingress: ReturnType<typeof createTelegramAdminSafetyReadIngress>;
  private renderer: CatalogRenderer | undefined;
  private readonly origin: string;
  public constructor(
    config: AppConfig,
    private readonly database: NakhDatabase,
    redis: ReturnType<typeof createRedisConnection>,
    resolve: (reference: string) => string,
  ) {
    if (!config.telegram.signupEnabled)
      throw new Error('Administrator first-factor composition unavailable.');
    this.origin = config.administration.publicOrigin;
    this.keys = new AdminRuntimeKeys({
      totp: resolve(config.administration.totpKeyRingRef),
      notes: resolve(config.administration.reviewNoteKeyRingRef),
      snapshots: resolve(config.deletion.evidenceKeyRingRef),
      action: resolve(config.administration.actionKeyRef),
      navigation: resolve(config.telegram.actionTokenKeyRef),
      noteKeyId: config.administration.reviewNoteKeyId,
      noteKeyVersion: config.administration.reviewNoteKeyVersion,
      snapshotKeyId: config.telegram.reportSnapshotKeyId,
      snapshotKeyVersion: config.telegram.reportSnapshotKeyVersion,
    });
    const botToken = resolve(config.telegram.botTokenRef);
    const bot = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(botToken);
    if (bot === null || !Number.isSafeInteger(Number(bot[1])))
      throw new Error('Administrator bot identity unavailable.');
    this.users = createPostgresUserSessions(database, this.keys.userSessionKey);
    this.ingress = createTelegramAdminSafetyReadIngress({
      database,
      botId: bot[1]!,
      tokens: new RedisOpaqueTokenStore(redis, `${config.redis.queuePrefix}:admin`),
      adminKey: this.keys.actionKey,
      uiEncryptionKey: this.keys.uiEncryptionKey,
      uiReferenceKey: this.keys.uiReferenceKey,
      sessions: createPostgresTotpAdminSessions(database, this.keys.totp),
      renderer: {
        render: (locale, intent) => {
          if (this.renderer === undefined)
            throw new Error('Administrator localization unavailable.');
          return this.renderer.render(locale, intent);
        },
      },
      delivery: new TelegramAdminTextDelivery(botToken),
      reviewNotes: this.keys.reviewNotes,
    });
  }
  public async onModuleInit(): Promise<void> {
    if (
      (await this.database
        .selectFrom('platform.schema_migrations')
        .select('name')
        .where('name', '=', '000158_m9_administrator_signin_presentation.sql')
        .executeTakeFirst()) === undefined
    )
      throw new Error('Administrator schema unavailable.');
    await this.keys.verifyCustody(this.database);
    const catalogs = await loadAdminRuntimeCatalogs(this.database, {
      ...Object.fromEntries(
        M7_LOCALIZATION_ENTRIES.filter((entry) => entry.required).map((entry) => [
          entry.key,
          entry.english,
        ]),
      ),
      ...M9_ADMIN_TEXTS,
    });
    this.renderer = new CatalogRenderer(catalogs.messages, catalogs.defaultLocale);
  }
  public handle(update: unknown): Promise<'unhandled' | 'notice'> {
    return this.ingress.handle(update);
  }
  public async link(actor: UserSessionActor, locale: string): Promise<string | undefined> {
    // Capture before the first role/session lookup; never enrich an old actor with
    // a later Account epoch or issue a new grant while preparing browser entry.
    const original = Object.freeze({
      kind: actor.kind,
      userId: actor.userId,
      productEpoch: actor.productEpoch,
      sessionGrantId: actor.sessionGrantId,
    });
    if ((await getAdminFirstFactorIdentity(this.database, original)) === undefined)
      return undefined;
    const credential = await this.users.exportCurrent(original);
    const url = new URL('/v1/admin/auth/page', this.origin);
    url.searchParams.set('locale', locale);
    url.hash = new URLSearchParams({ session: credential.userSessionToken }).toString();
    return url.href;
  }
}

export function createAdministratorTelegramRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    redis: ReturnType<typeof createRedisConnection>;
    resolveSecret?: (reference: string) => string;
  }>,
): AdministratorTelegramPort | undefined {
  return input.config.administration.enabled
    ? new AdministratorTelegramRuntime(
        input.config,
        input.database,
        input.redis,
        input.resolveSecret ?? resolveSecretReference,
      )
    : undefined;
}
