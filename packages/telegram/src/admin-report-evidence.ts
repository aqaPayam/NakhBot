import { randomUUID } from 'node:crypto';
import type { GetSelectedReportEvidenceMetadataHandler } from '@nakh/application';
import { ApplicationError, REPORT_EVIDENCE_TYPES, type Actor } from '@nakh/domain';
import type {
  TelegramAdminReportQueueState,
  TelegramReportQueueChoice,
  TelegramReportEvidenceChoice,
} from './admin-report-queue-state.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';
import { requireTelegramAdminSession, type TelegramAdminSessionVerifier } from './admin-session.js';
import { m7Record, requirePrivateM7Actor } from './m7-private-update.js';
import type { M7TextRenderer } from './m7-presentation.js';

type Metadata = Awaited<ReturnType<GetSelectedReportEvidenceMetadataHandler['execute']>>;
export type TelegramSelectedReportEvidence = Readonly<{
  report: TelegramReportQueueChoice;
  evidence: TelegramReportEvidenceChoice;
}>;
function unavailable(): ApplicationError {
  return new ApplicationError('internal_error', 'error.m7.internal', 500);
}
/** Metadata only. Choosing a retained item never authorizes a reveal or a photo mutation. */
export class TelegramAdminReportEvidence {
  public constructor(
    private readonly botId: string,
    private readonly sessions: TelegramAdminSessionVerifier,
    private readonly metadata: Pick<GetSelectedReportEvidenceMetadataHandler, 'execute'>,
    private readonly state: TelegramAdminReportQueueState,
    private readonly delivery: Pick<TelegramAdminTextDelivery, 'text' | 'queueMenu'>,
    private readonly renderer: M7TextRenderer,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^[1-9][0-9]{0,19}$/u.test(botId) || !Number.isSafeInteger(Number(botId)))
      throw new Error('Report evidence bot identity invalid.');
  }
  private async read(actor: Actor, report: TelegramReportQueueChoice): Promise<Metadata> {
    const result = await this.metadata.execute(
      {
        actor: { kind: 'admin', userId: actor.userId },
        requestId: randomUUID(),
        adminActionToken: report.queueActionToken,
        reportId: report.targetId,
        expectedReportVersion: report.expectedVersion,
      },
      actor,
    );
    const row = m7Record(result);
    if (
      row === undefined ||
      Object.keys(row).length !== 2 ||
      result.reportId !== report.targetId ||
      !Array.isArray(result.items) ||
      result.items.length > 5 ||
      result.items.some((item) => {
        const entry = m7Record(item);
        return (
          entry === undefined ||
          Object.keys(entry).length !== 3 ||
          typeof entry.evidenceId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            entry.evidenceId,
          ) ||
          !REPORT_EVIDENCE_TYPES.some((type) => type === entry.evidenceType) ||
          typeof entry.snapshotSchemaVersion !== 'number' ||
          !Number.isSafeInteger(entry.snapshotSchemaVersion) ||
          entry.snapshotSchemaVersion < 1
        );
      }) ||
      new Set(result.items.map((item) => item.evidenceId)).size !== result.items.length
    )
      throw unavailable();
    return result;
  }
  public async check(telegramUserId: string, report: TelegramReportQueueChoice): Promise<void> {
    try {
      const session = await requireTelegramAdminSession(this.sessions, telegramUserId, this.now);
      await this.read(session.actor, report);
      await requireTelegramAdminSession(this.sessions, telegramUserId, this.now, session.actor);
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw unavailable();
    }
  }
  /** Trusted downstream preparation must use this fresh native selection, never decode a client ID. */
  public async selection(
    telegramUserId: string,
    reference: string,
  ): Promise<TelegramSelectedReportEvidence> {
    try {
      const session = await requireTelegramAdminSession(this.sessions, telegramUserId, this.now);
      const evidence = await this.state.evidence(session.actor, reference);
      const report =
        evidence === undefined
          ? undefined
          : await this.state.choice(session.actor, evidence.reportReference);
      if (evidence === undefined || report === undefined)
        throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
      const result = await this.read(session.actor, report);
      if (
        !result.items.some(
          (item) =>
            item.evidenceId === evidence.evidenceId &&
            item.evidenceType === evidence.evidenceType &&
            item.snapshotSchemaVersion === evidence.snapshotSchemaVersion,
        )
      )
        throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
      await requireTelegramAdminSession(this.sessions, telegramUserId, this.now, session.actor);
      if (
        (await this.state.evidence(session.actor, reference)) === undefined ||
        (await this.state.choice(session.actor, evidence.reportReference)) === undefined
      )
        throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
      return { report, evidence };
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw unavailable();
    }
  }
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    const data = m7Record(m7Record(update)?.callback_query)?.data;
    if (typeof data !== 'string' || !/^m7[CJ]:/u.test(data)) return 'unhandled';
    try {
      const context = requirePrivateM7Actor(update, 'callback');
      const match = /^m7([CJ]):([A-Za-z0-9_-]{22})$/u.exec(data);
      if (match === null)
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      const session = await requireTelegramAdminSession(
        this.sessions,
        context.telegramUserId,
        this.now,
      );
      const reference = match[2]!;
      if (match[1] === 'J') {
        const selected = await this.selection(context.telegramUserId, reference);
        await requireTelegramAdminSession(
          this.sessions,
          context.telegramUserId,
          this.now,
          session.actor,
        );
        await this.delivery.text({
          recipient: context.telegramUserId,
          disableLinkPreviews: true,
          text:
            this.renderer.render(session.locale, {
              key: 'admin.report.evidence_selected',
              variables: {},
            }) +
            '\n' +
            this.renderer.render(session.locale, {
              key: `admin.report.evidence_type.${selected.evidence.evidenceType}`,
              variables: {},
            }),
        });
      } else {
        const report = await this.state.choice(session.actor, reference);
        if (report === undefined)
          throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
        const result = await this.read(session.actor, report);
        const rows: (readonly [Readonly<{ text: string; callback_data: string }>])[] = [];
        for (const [index, item] of result.items.entries()) {
          const selected = await this.state.putEvidence(
            session.actor,
            `bot:${this.botId}:update:${context.updateId}:item:${index}`,
            { reportReference: reference, ...item },
          );
          rows.push([
            {
              text: `${index + 1}. ${this.renderer.render(session.locale, { key: `admin.report.evidence_type.${item.evidenceType}`, variables: {} })}`,
              callback_data: `m7J:${selected}`,
            },
          ]);
        }
        await requireTelegramAdminSession(
          this.sessions,
          context.telegramUserId,
          this.now,
          session.actor,
        );
        if ((await this.state.choice(session.actor, reference)) === undefined)
          throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
        for (const row of rows)
          if (
            (await this.state.evidence(session.actor, row[0].callback_data.slice(4))) === undefined
          )
            throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
        const text =
          this.renderer.render(session.locale, {
            key: 'admin.report.evidence_title',
            variables: {},
          }) +
          '\n' +
          this.renderer.render(session.locale, {
            key: rows.length === 0 ? 'admin.report.evidence_empty' : 'admin.report.evidence_choose',
            variables: {},
          });
        if (rows.length === 0)
          await this.delivery.text({
            recipient: context.telegramUserId,
            text,
            disableLinkPreviews: true,
          });
        else
          await this.delivery.queueMenu({
            recipient: context.telegramUserId,
            text,
            disableLinkPreviews: true,
            replyMarkup: { inline_keyboard: rows },
          });
      }
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw unavailable();
    }
  }
}
