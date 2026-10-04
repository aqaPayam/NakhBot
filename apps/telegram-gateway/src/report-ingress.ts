import { ApplicationError } from '@nakh/domain';
import type { TelegramReportAdapter, TelegramReportResult } from '@nakh/telegram';
export interface TelegramReportIngressPort {
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
}
export class TelegramReportIngress implements TelegramReportIngressPort {
  public constructor(
    private readonly adapter: Pick<TelegramReportAdapter, 'handle'>,
    private readonly deliver: (
      result: Extract<TelegramReportResult, { handled: true }>,
    ) => Promise<void>,
  ) {}
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    try {
      const result = await this.adapter.handle(update);
      if (!result.handled) return 'unhandled';
      await this.deliver(result);
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}
