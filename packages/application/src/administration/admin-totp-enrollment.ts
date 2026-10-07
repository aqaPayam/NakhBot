import type { Actor } from '@nakh/domain';

export interface AdminTotpEnrollments {
  /** Caller must supply an authenticated first-factor user, never a transport-asserted actor. */
  begin(input: Readonly<{ actor: Actor; invitationToken: string; requestId: string }>): Promise<
    Readonly<{
      enrollmentUri: string;
      expiresAt: string;
    }>
  >;
  confirm(
    input: Readonly<{ actor: Actor; invitationToken: string; requestId: string; code: string }>,
  ): Promise<
    Readonly<{
      status: 'activated';
      replayed: boolean;
    }>
  >;
}
