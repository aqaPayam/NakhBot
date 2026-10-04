import { createHash } from 'node:crypto';
import type {
  TelegramUserResolver,
  RateLimiterPort,
  PrepareSingleReportEvidenceHandler,
  SubmitSingleEvidenceReportHandler,
  GetReportReasonsHandler,
  LocalizedIntent,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { presentM7Error, presentM7Notice } from './m7-presentation.js';
import { m7Record, requirePrivateM7Actor } from './m7-private-update.js';
import type { TelegramReportSelectionStore } from './report-selections.js';
type EvidenceType = Parameters<
  PrepareSingleReportEvidenceHandler['execute']
>[0]['requestedEvidenceTypes'][number];
const evidenceTypes: Readonly<Record<string, EvidenceType>> = {
  p: 'profile',
  o: 'photo',
  c: 'chat',
  m: 'message',
  u: 'unmatched_user',
};
export type TelegramReportResult =
  | Readonly<{ handled: false }>
  | Readonly<{
      handled: true;
      userId: string;
      telegramUserId: string;
      notice: LocalizedIntent;
      form?: Readonly<{
        reference: string;
        reasons: Awaited<ReturnType<GetReportReasonsHandler['execute']>>['items'];
      }>;
    }>;
export function reportCallbackData(type: EvidenceType, sourceActionToken: string): string {
  const code = Object.entries(evidenceTypes).find(([, candidate]) => candidate === type)?.[0];
  if (
    code === undefined ||
    !/^v1\.rs\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u.test(sourceActionToken)
  )
    throw new Error('Report callback invalid.');
  return `m7r:${code}:${sourceActionToken}`;
}
function identity(botId: string, userId: string, updateId: number, purpose: string): string {
  const bytes = createHash('sha256')
    .update(`telegram-report-v1\0${botId}\0${userId}\0${updateId}\0${purpose}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Invoke after webhook authentication. Native handlers own commit-time authorization and replay. */
export class TelegramReportAdapter {
  public constructor(
    private readonly botId: string,
    private readonly users: TelegramUserResolver,
    private readonly useCases: Readonly<{
      prepare: Pick<PrepareSingleReportEvidenceHandler, 'execute'>;
      submit: Pick<SubmitSingleEvidenceReportHandler, 'execute'>;
      reasons: Pick<GetReportReasonsHandler, 'execute'>;
    }>,
    private readonly selections: TelegramReportSelectionStore,
    private readonly limiter: RateLimiterPort,
  ) {
    if (!/^[1-9][0-9]{0,19}$/u.test(botId) || !Number.isSafeInteger(Number(botId)))
      throw new Error('Telegram bot identity invalid.');
  }
  public async handle(update: unknown): Promise<TelegramReportResult> {
    const root = m7Record(update),
      callback = m7Record(root?.callback_query),
      message = m7Record(root?.message);
    const data = callback?.data,
      text = message?.text;
    const isCallback = typeof data === 'string' && data.startsWith('m7r:');
    const isSubmission = typeof text === 'string' && /^\/report(?:\s|$)/u.test(text);
    if (!isCallback && !isSubmission) return { handled: false };
    const context = requirePrivateM7Actor(update, isCallback ? 'callback' : 'message');
    const userId = await this.users.resolveUserId(context.telegramUserId);
    if (userId === undefined)
      throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
    const actor = { kind: 'user' as const, userId },
      requestId = identity(this.botId, userId, context.updateId, 'request');
    try {
      const rate = await this.limiter.consume({
        scope: 'telegram_report',
        subject: userId,
        limit: 20,
        windowSeconds: 60,
      });
      if (!rate.allowed) throw new ApplicationError('rate_limited', 'error.m7.rate_limited', 429);
      if (isCallback) {
        const match = /^m7r:([pocmu]):(v1\.rs\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16})$/u.exec(data);
        if (match === null)
          throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
        const prepared = await this.useCases.prepare.execute(
          {
            actor,
            requestId,
            sourceActionToken: match[2]!,
            requestedEvidenceTypes: [evidenceTypes[match[1]!]!],
          },
          actor,
        );
        const catalog = await this.useCases.reasons.execute({ actor, requestId }, actor);
        const reference = await this.selections.put(userId, prepared, requestId);
        return {
          handled: true,
          userId,
          telegramUserId: context.telegramUserId,
          notice: { key: 'report.prompt', variables: {} },
          form: { reference, reasons: catalog.items },
        };
      }
      const match =
        typeof text === 'string' && text.length <= 5000
          ? /^\/report\s+([A-Za-z0-9_-]{22})\s+([a-z][a-z0-9_]{0,79})(?:\s+([\s\S]*))?$/u.exec(text)
          : null;
      if (match === null)
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      const token = await this.selections.get(userId, match[1]!);
      if (token === undefined)
        throw new ApplicationError('report_unavailable', 'error.report.unavailable', 409);
      const commandId = identity(this.botId, userId, context.updateId, 'command');
      await this.useCases.submit.execute(
        {
          commandId,
          commandType: 'moderation.submit-report',
          schemaVersion: 1,
          actor,
          requestId,
          idempotencyKey: `telegram-report:${commandId}`,
          occurredAt: context.occurredAt,
          locale: 'fa',
          data: {
            evidenceIntentToken: token,
            reasonCode: match[2]!,
            ...(match[3] === undefined ? {} : { text: match[3] }),
          },
        },
        actor,
      );
      return {
        handled: true,
        userId,
        telegramUserId: context.telegramUserId,
        notice: presentM7Notice('report_submitted'),
      };
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.status >= 500)
        throw new ApplicationError('internal_error', 'error.m7.internal', 500);
      return {
        handled: true,
        userId,
        telegramUserId: context.telegramUserId,
        notice: presentM7Error(error),
      };
    }
  }
}
