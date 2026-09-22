import type { GetPendingNakhPageQuery, PendingNakhPage } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

import type { PendingNakhOpaqueReferences } from './pending-tokens.js';

export type PendingNakhKeyset = Readonly<{ createdAt: Date; pendingNakhId: string }>;

/** Internal sender-owned projection. Receiver identifiers never cross the application boundary. */
export type SenderPendingNakhRow = Readonly<{
  pendingNakhId: string;
  targetName: string;
  text: string;
  createdAt: Date;
  expiresAt: Date;
  version: number;
}>;

export type SenderPendingNakhReadPage = Readonly<{
  totalCount: number;
  rows: readonly SenderPendingNakhRow[];
  hasMore: boolean;
}>;

export interface PendingNakhReadStore {
  readSenderPage(
    query: GetPendingNakhPageQuery,
    after?: PendingNakhKeyset,
  ): Promise<SenderPendingNakhReadPage>;
}

type References = Pick<PendingNakhOpaqueReferences, 'resolveCursor' | 'issueCursor'>;

export class GetPendingNakhPageHandler {
  public constructor(
    private readonly store: PendingNakhReadStore,
    private readonly references: References,
  ) {}

  public async execute(query: GetPendingNakhPageQuery): Promise<PendingNakhPage> {
    if (query.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const after =
      query.cursor === undefined
        ? undefined
        : await this.references.resolveCursor(query.cursor, query.actor.userId);
    if (query.cursor !== undefined && after === undefined)
      throw new ApplicationError('invalid_request', 'error.nakh.cursor_invalid', 400);
    const page = await this.store.readSenderPage(query, after);
    const items = page.rows.map((row) => ({
      pendingNakhId: row.pendingNakhId,
      targetName: row.targetName,
      text: row.text,
      status: 'pending_payment' as const,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      version: row.version,
    }));
    if (!page.hasMore) return { totalCount: page.totalCount, items };
    const last = page.rows.at(-1);
    if (last === undefined) throw new ApplicationError('internal_error', 'error.internal', 500);
    return {
      totalCount: page.totalCount,
      items,
      nextCursor: await this.references.issueCursor(
        query.actor.userId,
        { createdAt: last.createdAt, pendingNakhId: last.pendingNakhId },
        query.requestId,
      ),
    };
  }
}
