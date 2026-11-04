import { isUserProductLife, type UserSessionActor } from '@nakh/application';
import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { hasAdminTotpIdentityAndRoles } from './admin-totp-policy.js';
import { PostgresLocalizationStore } from './identity-store.js';

/** No registration, role grant or session issuance occurs during eligibility lookup. */
export async function getAdminTelegramSignInIdentity(
  database: NakhDatabase,
  telegramUserId: string,
): Promise<
  | Readonly<{ userId: string; productEpoch: number; uiLocale: string | null; notBefore: string }>
  | undefined
> {
  const row = (
    await sql<{
      userId: string;
      productEpoch: number;
      uiLocale: string | null;
      notBefore: Date;
    }>`SELECT admin.user_id AS "userId", account.product_epoch AS "productEpoch",
    settings.ui_locale_code AS "uiLocale",
    greatest(account.state_changed_at, admin.identity_verified_at,
      max(assignment.assigned_at)) AS "notBefore"
    FROM administration.admin_users admin
    JOIN identity.telegram_identities identity ON identity.user_id=admin.user_id
      AND identity.telegram_user_id=admin.telegram_user_id
    JOIN identity.accounts account ON account.user_id=admin.user_id AND account.state<>'deleted'
    LEFT JOIN identity.user_settings settings ON settings.user_id=admin.user_id
    JOIN administration.admin_user_roles assignment ON assignment.admin_user_id=admin.id AND assignment.revoked_at IS NULL
    JOIN administration.admin_roles role ON role.code=assignment.role_code AND role.is_active
    JOIN administration.admin_role_permissions permission ON permission.role_code=role.code
    WHERE admin.telegram_user_id=${telegramUserId} AND admin.is_active AND admin.identity_verified_at IS NOT NULL
    GROUP BY admin.id, account.user_id, settings.user_id`.execute(database)
  ).rows[0];
  return row === undefined
    ? undefined
    : Object.freeze({ ...row, notBefore: row.notBefore.toISOString() });
}

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
