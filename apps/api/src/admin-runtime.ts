import type { DynamicModule } from '@nestjs/common';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { ReportTokenFactory } from '@nakh/application';
import { M7_LOCALIZATION_ENTRIES, M9_ADMIN_TEXTS } from '@nakh/localization';
import {
  AdminRuntimeKeys,
  getAdminFirstFactorIdentity,
  loadAdminRuntimeCatalogs,
  type AdminRuntimeCatalogs,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  createRedisConnection,
  RedisOpaqueTokenStore,
  RedisUserOpaqueTokenStores,
} from '@nakh/queue-redis';
import { createM7TotpSessionHostOptions } from './m7-session-host-services.js';
import { M7HostApiModule } from './m7-host-api.js';
import { AdministratorPageModule } from './admin-signin-page.js';

export class AdministratorApiRuntime {
  public readonly imports: DynamicModule[];
  private catalogs: AdminRuntimeCatalogs | undefined;
  private readonly keys: AdminRuntimeKeys;
  private readonly redis: ReturnType<typeof createRedisConnection>;
  public constructor(
    config: AppConfig,
    private readonly database: NakhDatabase,
    resolve: (reference: string) => string,
  ) {
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
    this.redis = createRedisConnection(config.redis.url);
    const owned = new RedisUserOpaqueTokenStores(this.redis, config.redis.queuePrefix);
    const composition = createM7TotpSessionHostOptions({
      database,
      totpKeys: this.keys.totp,
      reportTokens: new ReportTokenFactory(owned, this.keys.userSessionKey),
      adminTokens: new RedisOpaqueTokenStore(this.redis, `${config.redis.queuePrefix}:admin`),
      adminKey: this.keys.actionKey,
      safetyTokens: owned,
      safetyKey: this.keys.userSessionKey,
      capabilities: this.keys.capabilities,
      reviewNotes: this.keys.reviewNotes,
      accountReturnApprovalEnabled:
        config.deletion.returnApiEnabled || config.deletion.returnTelegramEnabled,
    });
    const totp = composition.host.totp;
    if (totp === undefined) throw new Error('Administrator authentication unavailable.');
    this.imports = [
      M7HostApiModule.register(composition.host),
      AdministratorPageModule.register({
        authenticator: totp.authenticator,
        eligible: async (actor) =>
          (await getAdminFirstFactorIdentity(database, actor)) !== undefined,
        catalogs: () => {
          if (this.catalogs === undefined)
            throw new Error('Administrator localization unavailable.');
          return this.catalogs;
        },
      }),
    ];
  }
  public async onModuleInit(): Promise<void> {
    const ledger = await this.database
      .selectFrom('platform.schema_migrations')
      .select('name')
      .where('name', '=', '000158_m9_administrator_signin_presentation.sql')
      .executeTakeFirst();
    if (ledger === undefined) throw new Error('Administrator schema unavailable.');
    await this.keys.verifyCustody(this.database);
    this.catalogs = await loadAdminRuntimeCatalogs(this.database, {
      ...Object.fromEntries(
        M7_LOCALIZATION_ENTRIES.filter((entry) => entry.required).map((entry) => [
          entry.key,
          entry.english,
        ]),
      ),
      ...M9_ADMIN_TEXTS,
    });
    await this.redis.ping();
  }
  public async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}

export function createAdministratorApiRuntime(
  config: AppConfig,
  database: NakhDatabase,
  resolve: (reference: string) => string = resolveSecretReference,
): AdministratorApiRuntime | undefined {
  return config.administration.enabled
    ? new AdministratorApiRuntime(config, database, resolve)
    : undefined;
}
