import type {
  AdminMfaProofVerifier,
  AdminSessionService,
  AdminTotpEnrollments,
  AdminTotpKeyResolver,
} from '@nakh/application';
import {
  createPostgresAdminSessions,
  requireNativeAdminSessions,
  createPostgresTotpAdminSessions,
  PostgresAdminTotpEnrollments,
} from '@nakh/persistence-postgres';
import type { M7ApiAuthenticator } from './m7-api-boundary.js';
import {
  createM7HostOptions,
  type M7HostConfiguration,
  type M7HostApiOptions,
} from './m7-host-services.js';
/** Explicit native-session composition. User authentication never provides an admin fallback.
 * The returned sessions also implement TelegramAdminSessionVerifier structurally. Issuance is
 * server-internal and requires authenticated first-factor actor plus trusted current MFA proof. */
export function createM7SessionHostOptions(
  input: Omit<M7HostConfiguration, 'authenticator'> &
    Readonly<{
      userAuthenticator: M7ApiAuthenticator;
      mfa: AdminMfaProofVerifier;
    }>,
): Readonly<{ host: M7HostApiOptions; sessions: AdminSessionService }> {
  requireNativeAdminSessions(input.database);
  const sessions = createPostgresAdminSessions(input.database, input.mfa);
  const authenticator: M7ApiAuthenticator = {
    authenticate: (query) =>
      query.audience === 'admin'
        ? sessions.authenticate(query)
        : input.userAuthenticator.authenticate(query),
  };
  return Object.freeze({ host: createM7HostOptions({ ...input, authenticator }), sessions });
}

/** Actual authenticator-app composition. First-factor authentication is supplied by the trusted
 * host; native TOTP alone provides administrator sessions. Operator capabilities are not exposed. */
export function createM7TotpSessionHostOptions(
  input: Omit<M7HostConfiguration, 'authenticator'> &
    Readonly<{ userAuthenticator: M7ApiAuthenticator; totpKeys: AdminTotpKeyResolver }>,
): Readonly<{
  host: M7HostApiOptions;
  sessions: AdminSessionService;
  enrollments: AdminTotpEnrollments;
}> {
  const sessions = createPostgresTotpAdminSessions(input.database, input.totpKeys);
  const enrollments = new PostgresAdminTotpEnrollments(input.database, input.totpKeys);
  const authenticator: M7ApiAuthenticator = {
    authenticate: (query) =>
      query.audience === 'admin'
        ? sessions.authenticate(query)
        : input.userAuthenticator.authenticate(query),
  };
  const totp = Object.freeze({
    authenticator,
    sessions,
    enrollments,
    telegramIdentity: async (actorUserId: string): Promise<string | undefined> =>
      (
        await input.database
          .selectFrom('identity.telegram_identities')
          .select('telegram_user_id')
          .where('user_id', '=', actorUserId)
          .executeTakeFirst()
      )?.telegram_user_id,
  });
  const host = Object.freeze({ ...createM7HostOptions({ ...input, authenticator }), totp });
  return Object.freeze({ host, sessions, enrollments });
}
