import {
  GetReportReasonsHandler,
  reportUnavailable,
  type ReportReasonCatalogStore,
} from '@nakh/application';
import type { ReportReasonCatalog } from '@nakh/contracts';
import { canSubmitUserReport } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
export class PostgresReportReasonCatalogStore implements ReportReasonCatalogStore {
  public constructor(private readonly database: NakhDatabase) {}
  public list(actorUserId: string): Promise<ReportReasonCatalog> {
    return this.database.transaction().execute(async (transaction) => {
      const account = await transaction
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', actorUserId)
        .forShare()
        .executeTakeFirst();
      if (account === undefined || !canSubmitUserReport(account.state)) throw reportUnavailable();
      const rows = await transaction
        .selectFrom('moderation.report_reasons')
        .select(['code', 'label_key'])
        .where('is_active', '=', true)
        .orderBy('display_order')
        .orderBy('code')
        .limit(51)
        .execute();
      if (rows.length > 50) throw new Error('Report reason catalog exceeds its bounded size.');
      return { items: rows.map((row) => ({ code: row.code, labelKey: row.label_key })) };
    });
  }
}
export class PostgresGetReportReasonsHandler extends GetReportReasonsHandler {
  public constructor(database: NakhDatabase) {
    super(new PostgresReportReasonCatalogStore(database));
  }
}
