import type { GetReportReasonsQuery, ReportReasonCatalog } from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
export interface ReportReasonCatalogStore {
  list(actorUserId: string): Promise<ReportReasonCatalog>;
}
export class GetReportReasonsHandler {
  public constructor(private readonly store: ReportReasonCatalogStore) {}
  public execute(query: GetReportReasonsQuery, actor: Actor): Promise<ReportReasonCatalog> {
    if (actor.kind !== 'user' || query.actor.kind !== 'user' || actor.userId !== query.actor.userId)
      throw new ApplicationError('unauthorized', 'error.identity.unauthorized', 401);
    return this.store.list(actor.userId);
  }
}
