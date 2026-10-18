import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { AppConfig } from '@nakh/config';
import {
  CREDIT_PACKAGE_DEFINITIONS,
  PAID_ACTION_PRICES,
  NAKH_CREDIT_COST,
  NAKH_STARS_COST,
} from '@nakh/domain';
import type { NakhDatabase } from './database.js';

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
function unavailable(): never {
  throw new Error('Release reference unavailable.');
}
export function canonicalReference(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map((item: unknown) => canonicalReference(item)).join(',') + ']';
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) unavailable();
  const row = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(row)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalReference(row[key]))
      .join(',') +
    '}'
  );
}
export function referenceDigest(value: unknown): string {
  return createHash('sha256').update(canonicalReference(value)).digest('hex');
}
// Every leaf is reviewed. New runtime settings require an explicit projection;
// neither secrets nor an accidentally added private setting may enter a snapshot.
const fields = `environment serviceName release http.host http.port
 administration.enabled administration.publicOrigin administration.totpKeyRingRef
 administration.mediaEnabled administration.evidenceAccessKeyRef administration.evidenceSecretKeyRef
 administration.actionKeyRef administration.reviewNoteKeyRingRef
 administration.reviewNoteKeyId administration.reviewNoteKeyVersion
 database.url database.poolMax database.statementTimeoutMs database.lockTimeoutMs
 redis.url redis.queuePrefix telegram.botTokenRef telegram.webhookSecret telegram.actionTokenKeyRef
 telegram.likedByDeliveryEnabled telegram.notificationDeliveryEnabled telegram.supportAppealEnabled
 telegram.startDeliveryEnabled telegram.signupEnabled telegram.guestPreviewEnabled telegram.exploreEnabled
 telegram.starsEnabled telegram.starsRefundsEnabled telegram.starsKeyRingRef
 telegram.reportsEnabled telegram.reportSnapshotKeyId telegram.reportSnapshotKeyVersion telegram.chatEnabled
 media.ingestionEnabled media.cachePurgeEnabled media.cleanupEnabled media.orphanReconciliationEnabled media.orphanGraceMs
 media.r2Endpoint media.bucket media.accessKeyRef media.secretKeyRef media.cleanupAccessKeyRef media.cleanupSecretKeyRef
 media.cdnHost media.signingKeyId media.signingKeyRef media.audienceKeyId media.audienceKeyRef
 media.cloudflareZoneId media.cloudflareApiTokenRef media.transportKeyId media.transportKeyRef
 media.clamavHost media.clamavPort media.clamavTimeoutMs
 deletion.workerEnabled deletion.apiEnabled deletion.returnApiEnabled deletion.returnTelegramEnabled
 deletion.freshEntryTelegramEnabled deletion.telegramEnabled deletion.controlKeyRef deletion.confirmationKeyId
 deletion.confirmationKeyRef deletion.cutoverEvidenceHash deletion.evidenceKeyRingRef deletion.accessKeyRef deletion.secretKeyRef
 telemetry.enabled telemetry.exporterEndpoint`
  .trim()
  .split(/\s+/u)
  .sort();
export function releaseConfig(config: AppConfig): Readonly<Record<string, Json>> {
  const flat: Record<string, Json> = {};
  function visit(value: unknown, path: string): void {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, path ? path + '.' + key : key);
    } else if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      flat[path] = value;
    else unavailable();
  }
  visit(config, '');
  if (canonicalReference(Object.keys(flat).sort()) !== canonicalReference(fields)) unavailable();
  if (!/^[a-f0-9]{40}$/u.test(config.release)) unavailable();
  for (const name of fields) {
    if (
      name.endsWith('Ref') &&
      (typeof flat[name] !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/u.test(flat[name]))
    )
      unavailable();
  }
  // Endpoint identity is reviewable; connection passwords, query credentials,
  // webhook secret material and resolved secret values are deliberately absent.
  for (const [name, protocols] of [
    ['database.url', ['postgres:', 'postgresql:']],
    ['redis.url', ['redis:', 'rediss:']],
    ['media.r2Endpoint', ['https:']],
    ['telemetry.exporterEndpoint', ['http:', 'https:']],
  ] as const) {
    const value = flat[name];
    if (typeof value !== 'string') unavailable();
    const url = new URL(value);
    if (!(protocols as readonly string[]).includes(url.protocol)) unavailable();
    flat[name] = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
    };
  }
  delete flat['telegram.webhookSecret'];
  return flat;
}
const option = 'id code label_key is_active display_order';
export const RELEASE_REFERENCE_COLUMNS = Object.freeze({
  'platform.schema_migrations': 'name sha256',
  'catalog.locales': 'code english_name native_name is_active is_default',
  'catalog.ui_texts': 'locale_code text_key value category variables is_active',
  'catalog.gender_options': option,
  'catalog.gender_preferences': option,
  'catalog.gender_preference_members': 'gender_preference_id gender_option_id',
  'catalog.relationship_goals': option,
  'catalog.interests': option,
  'catalog.languages': option,
  'catalog.personality_tags': option,
  'catalog.profile_option_values': option + ' category',
  'catalog.countries': option,
  'catalog.provinces': option + ' country_id',
  'catalog.cities': option + ' province_id',
  'billing.credit_packages':
    'id code title_key credit_amount stars_price badge_key is_active display_order',
  'chat.predefined_question_sets': 'id code title_key is_active display_order version',
  'chat.predefined_questions': 'id question_set_id code text_key is_active display_order version',
  'chat.predefined_answers': 'id question_id code text_key is_active display_order version',
  'moderation.report_reasons': 'id code label_key is_active display_order version',
  'administration.admin_users':
    'id user_id telegram_user_id is_active disabled_at identity_verified_at version',
  'administration.admin_roles': 'code description is_active',
  'administration.admin_permissions': 'code description',
  'administration.admin_role_permissions': 'role_code permission_code',
  'administration.admin_user_roles':
    'admin_user_id role_code assigned_by_admin_id assigned_at revoked_by_admin_id revoked_at',
});
export { sourceMigrationDigests } from './migrations.js';
export type ReleaseReference = Readonly<{
  format: 1;
  environment: AppConfig['environment'];
  service: string;
  sourceSha: string;
  config: Readonly<Record<string, Json>>;
  pricingRules: Json;
  native: Readonly<Record<string, readonly Json[]>>;
}>;
export class PostgresReleaseReferenceStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async capture(
    config: AppConfig,
    migrations: readonly { name: string; sha256: string }[],
  ): Promise<ReleaseReference> {
    const projection = releaseConfig(config),
      expectedMigrations = structuredClone(migrations);
    if (expectedMigrations.length === 0) unavailable();
    const native = await this.database
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (tx) => {
        await sql`SET LOCAL statement_timeout='15s'`.execute(tx);
        const result: Record<string, readonly Json[]> = {};
        let totalBytes = 0;
        for (const [table, columns] of Object.entries(RELEASE_REFERENCE_COLUMNS)) {
          const names = columns.split(' ');
          const selection = sql.join(
            names.map((name) =>
              table === 'billing.credit_packages' &&
              (name === 'credit_amount' || name === 'stars_price')
                ? sql`${sql.ref(name)}::text AS ${sql.ref(name)}`
                : sql.ref(name),
            ),
          );
          const projection = sql`(SELECT ${selection} FROM ${sql.table(table)} LIMIT 50001) projection`;
          const size = (
            await sql<{
              rows: string;
              bytes: string;
            }>`SELECT count(*)::text AS rows,COALESCE(sum(pg_column_size(to_jsonb(projection))),0)::text AS bytes FROM ${projection}`.execute(
              tx,
            )
          ).rows[0];
          if (
            size === undefined ||
            Number(size.rows) > 50000 ||
            !Number.isSafeInteger(Number(size.bytes))
          )
            unavailable();
          totalBytes += Number(size.bytes);
          if (totalBytes > 8 * 1024 * 1024) unavailable();
          const rows = await sql<{
            item: Json;
          }>`SELECT to_jsonb(projection) AS item FROM ${projection}`.execute(tx);
          if (rows.rows.length > 50000) unavailable();
          result[table] = rows.rows
            .map((row) => row.item)
            .sort((a, b) => {
              const x = canonicalReference(a),
                y = canonicalReference(b);
              return x < y ? -1 : x > y ? 1 : 0;
            });
        }
        const expected = [...expectedMigrations].sort((a, b) =>
          canonicalReference(a) < canonicalReference(b) ? -1 : 1,
        );
        if (
          canonicalReference(result['platform.schema_migrations']) !== canonicalReference(expected)
        )
          unavailable();
        return result;
      });
    // Prices come from the same domain exports used by live handlers. Bigints
    // are exact decimal strings, never lossy JSON numbers or invented defaults.
    const pricingRules = JSON.parse(
      JSON.stringify(
        {
          creditPackages: CREDIT_PACKAGE_DEFINITIONS,
          paidActions: PAID_ACTION_PRICES,
          nakh: { credits: NAKH_CREDIT_COST, stars: NAKH_STARS_COST },
        },
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      ),
    ) as Json;
    return {
      format: 1,
      environment: config.environment,
      service: config.serviceName,
      sourceSha: config.release,
      config: projection,
      pricingRules,
      native,
    };
  }
}
export function compareReleaseReference(
  actual: ReleaseReference,
  expected: unknown,
): Readonly<{ matches: boolean; actualDigest: string; expectedDigest: string }> {
  const actualDigest = referenceDigest(actual),
    expectedDigest = referenceDigest(expected);
  return { matches: actualDigest === expectedDigest, actualDigest, expectedDigest };
}
