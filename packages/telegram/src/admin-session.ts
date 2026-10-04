import { ApplicationError, type Actor } from '@nakh/domain';

export type VerifiedTelegramAdminSession = Readonly<{
  actor: Actor;
  telegramUserId: string;
  locale: string;
  expiresAt: Date;
  mfaExpiresAt: Date;
}>;
export interface TelegramAdminSessionVerifier {
  /** Server-owned current session/MFA and Telegram binding, never fields from an update. */
  current(telegramUserId: string): Promise<VerifiedTelegramAdminSession | undefined>;
}
export async function requireTelegramAdminSession(
  sessions: TelegramAdminSessionVerifier,
  telegramUserId: string,
  now: () => Date,
  expectedActor?: Actor,
): Promise<VerifiedTelegramAdminSession> {
  const session = await sessions.current(telegramUserId);
  const time = now().getTime();
  if (
    session === undefined ||
    session.actor.kind !== 'admin' ||
    session.telegramUserId !== telegramUserId ||
    !Number.isFinite(time) ||
    ![session.expiresAt.getTime(), session.mfaExpiresAt.getTime()].every(
      (expiry) => Number.isFinite(expiry) && expiry > time,
    ) ||
    (expectedActor !== undefined && session.actor.userId !== expectedActor.userId)
  )
    throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
  return session;
}
