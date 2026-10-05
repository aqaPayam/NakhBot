import type { ConfirmedEvidenceReveals } from '@nakh/application';
import { ApplicationError, type Actor } from '@nakh/domain';
import { m7Record, requirePrivateM7Actor } from './m7-private-update.js';
import { presentM7AdminOutcome, renderM7Notice, type M7TextRenderer } from './m7-presentation.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
export type {
  TelegramAdminSessionVerifier,
  VerifiedTelegramAdminSession,
} from './admin-session.js';
type RevealCommand = Parameters<ConfirmedEvidenceReveals['execute']>[0];
type RevealedContent = NonNullable<
  Awaited<ReturnType<ConfirmedEvidenceReveals['execute']>>['value']
>['content'];
export interface TelegramConfirmedEvidenceCommands {
  /** Actor-bound stored command after explicit native confirmation; short reference contains no IDs. */
  resolve(actor: Actor, reference: string): Promise<RevealCommand | undefined>;
}
export interface TelegramAdminEvidenceDelivery {
  /** Plain text only; implementation must disable parse modes and link previews. No telemetry prose. */
  text(
    input: Readonly<{ recipient: string; text: string; disableLinkPreviews: true }>,
  ): Promise<void>;
  /** Resolve retained bytes through the configured authorized delivery path; never expose a URL/ref in text. */
  retainedPhoto(
    input: Readonly<{ actor: Actor; recipient: string; objectRef: string; contentSha256: string }>,
  ): Promise<void>;
}
export function chunkM7EvidenceText(text: string): readonly string[] {
  if (text.length < 1 || text.length > 16000)
    throw new ApplicationError('internal_error', 'error.m7.internal', 500);
  const chunks: string[] = [];
  let current = '';
  for (const point of text) {
    if (current.length + point.length > 3500) {
      chunks.push(current);
      current = '';
    }
    current += point;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}
function contentText(content: Exclude<RevealedContent, { evidenceType: 'photo' }>): string {
  switch (content.evidenceType) {
    case 'profile':
      return [content.displayName, String(content.birthYear), content.bio]
        .filter((line) => line !== undefined)
        .join('\n');
    case 'message':
      return content.content;
    case 'chat':
      return [content.status, content.closedAt].filter((line) => line !== undefined).join('\n');
    case 'unmatched_user':
      return [content.unmatchedAt, content.reportWindowExpiresAt].join('\n');
  }
}
/** Invoke only behind authenticated webhook ingress. Native execution commits both required audits
 * before returning content. Replays never authorize content delivery, even if a port supplies a value. */
export class TelegramAdminEvidenceAdapter {
  public constructor(
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly commands: TelegramConfirmedEvidenceCommands,
    private readonly reveals: Pick<ConfirmedEvidenceReveals, 'execute'>,
    private readonly delivery: TelegramAdminEvidenceDelivery,
    private readonly renderer: M7TextRenderer,
    private readonly now: () => Date = () => new Date(),
  ) {}
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const data = m7Record(m7Record(update)?.callback_query)?.data;
    if (typeof data !== 'string' || !data.startsWith('m7e:')) return 'unhandled';
    try {
      const context = requirePrivateM7Actor(update, 'callback');
      const match = /^m7e:([A-Za-z0-9_-]{22,40})$/u.exec(data);
      if (match === null)
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      const session = await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
      );
      const command = await this.commands.resolve(session.actor, match[1]!);
      if (
        command === undefined ||
        command.actor.kind !== 'admin' ||
        command.actor.userId !== session.actor.userId
      )
        throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
      const result = await this.reveals.execute(command, session.actor);
      // A session can be revoked or MFA can expire while the database call waits for a lock.
      const deliverySession = await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
        session.actor,
      );
      const notice = renderM7Notice(
        this.renderer,
        deliverySession.locale,
        presentM7AdminOutcome(result.result),
      );
      for (const text of chunkM7EvidenceText(notice.text))
        await this.delivery.text({
          recipient: context.telegramUserId,
          text,
          disableLinkPreviews: true,
        });
      if (result.result === 'succeeded' && !result.replayed && result.value !== undefined) {
        const content = result.value.content;
        if (content.evidenceType === 'photo') {
          await requireTelegramAdminSession(
            this.sessions,
            context.telegramUserId,
            this.now,
            session.actor,
          );
          await this.delivery.retainedPhoto({
            actor: session.actor,
            recipient: context.telegramUserId,
            objectRef: content.evidenceObjectRef,
            contentSha256: content.contentSha256,
          });
        } else
          for (const text of chunkM7EvidenceText(contentText(content))) {
            await requireTelegramAdminSession(
              this.sessions,
              context.telegramUserId,
              this.now,
              session.actor,
            );
            await this.delivery.text({
              recipient: context.telegramUserId,
              text,
              disableLinkPreviews: true,
            });
          }
      }
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}
