import type { AdminMfaProofVerifier, AdminSessionService } from '@nakh/application';
import { createPostgresAdminSessions } from '@nakh/persistence-postgres';
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
  const sessions = createPostgresAdminSessions(input.database, input.mfa);
  const authenticator: M7ApiAuthenticator = {
    authenticate: (query) =>
      query.audience === 'admin'
        ? sessions.authenticate(query)
        : input.userAuthenticator.authenticate(query),
  };
  return Object.freeze({ host: createM7HostOptions({ ...input, authenticator }), sessions });
}
