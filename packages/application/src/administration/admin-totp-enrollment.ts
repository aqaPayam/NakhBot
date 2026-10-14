import type { Actor } from '@nakh/domain';
import type { UserSessionActor } from '../security/user-session.js';

export interface AdminTotpEnrollments {
  /** Caller must supply an authenticated first-factor user, never a transport-asserted actor. */
  begin(
    input: Readonly<{
      actor: Actor;
      invitationToken: string;
      requestId: string;
      userSession?: UserSessionActor;
    }>,
  ): Promise<
    Readonly<{
      enrollmentUri: string;
      expiresAt: string;
    }>
  >;
  confirm(
    input: Readonly<{
      actor: Actor;
      invitationToken: string;
      requestId: string;
      code: string;
      userSession?: UserSessionActor;
    }>,
  ): Promise<
    Readonly<{
      status: 'activated';
      replayed: boolean;
    }>
  >;
}
