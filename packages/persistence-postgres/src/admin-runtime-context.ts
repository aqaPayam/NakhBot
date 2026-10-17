import { isUserProductLife, type UserSessionActor } from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { hasAdminTotpIdentityAndRoles } from './admin-totp-policy.js';
import { PostgresLocalizationStore } from './identity-store.js';

/** A captured native first factor is required even to offer the login handoff.
 * No lookup here issues a grant or chooses a newer product life. MFA issuance
 * still rechecks current identity and permissions under its own native locks. */
export async function getAdminFirstFactorIdentity(
  database: NakhDatabase,
  actor: UserSessionActor,
): Promise<Readonly<{ userId: string; telegramUserId: string }> | undefined> {
  if (
    !isUserProductLife(actor) ||
    actor.kind !== 'user' ||
    typeof actor.sessionGrantId !== 'string'
  )
    return undefined;
  const captured = {
    userId: actor.userId,
    productEpoch: actor.productEpoch,
    sessionGrantId: actor.sessionGrantId,
  };
  const sessions = new PostgresUserSessionStore(database);
  if ((await sessions.current(captured, captured.sessionGrantId)) === undefined) return undefined;
  const admin = await database
    .selectFrom('administration.admin_users')
    .select(['id', 'telegram_user_id'])
    .where('user_id', '=', captured.userId)
    .executeTakeFirst();
  if (
    admin === undefined ||
    !(await hasAdminTotpIdentityAndRoles(database, admin.id)) ||
    (await sessions.current(captured, captured.sessionGrantId)) === undefined
  )
    return undefined;
  return Object.freeze({ userId: captured.userId, telegramUserId: admin.telegram_user_id });
}

export type AdminRuntimeCatalogs = Readonly<{
  defaultLocale: string;
  messages: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>;
export async function loadAdminRuntimeCatalogs(
  database: NakhDatabase,
  expected: Readonly<Record<string, string>>,
): Promise<AdminRuntimeCatalogs> {
  const locales = await database
    .selectFrom('catalog.locales')
    .select(['code', 'is_default'])
    .where('is_active', '=', true)
    .execute();
  const defaultLocale = locales.find((locale) => locale.is_default)?.code;
  if (defaultLocale === undefined) throw new Error('Administrator localization unavailable.');
  const messages: Record<string, Readonly<Record<string, string>>> = {};
  const variables = (text: string): string =>
    [...new Set([...text.matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((m) => m[1]))].sort().join(',');
  for (const { code } of locales) {
    const catalog = await new PostgresLocalizationStore(database).loadActiveCatalog(code);
    for (const [name, english] of Object.entries(expected)) {
      const text = catalog.messages[name];
      if (typeof text !== 'string' || text.trim() === '' || variables(text) !== variables(english))
        throw new Error('Administrator localization unavailable.');
    }
    messages[code] = Object.freeze({ ...catalog.messages });
  }
  return Object.freeze({ defaultLocale, messages: Object.freeze(messages) });
}
