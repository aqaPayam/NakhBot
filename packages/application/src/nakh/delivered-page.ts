import type {
  GetNakhDetailQuery,
  GetReceivedNakhPageQuery,
  GetSentNakhStatusPageQuery,
  NakhDetail,
  NakhStatus,
  ReceivedNakhPage,
  SentNakhStatusPage,
} from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

import type { NakhOpaqueReferences } from './nakh-tokens.js';

export type NakhPageDirection = 'sent' | 'received';
export type NakhKeyset = Readonly<{ sentAt: Date; nakhId: string }>;
export type AuthorizedNakhRow = Readonly<{
  nakhId: string;
  direction: NakhPageDirection;
  counterpartyName: string;
  text: string;
  status: NakhStatus;
  sentAt: Date;
  expiresAt: Date;
  version: number;
}>;
export type AuthorizedNakhReadPage = Readonly<{
  totalCount: number;
  rows: readonly AuthorizedNakhRow[];
  hasMore: boolean;
}>;

export interface DeliveredNakhReadStore {
  readPage(
    viewerUserId: string,
    direction: NakhPageDirection,
    limit: number,
    after?: NakhKeyset,
  ): Promise<AuthorizedNakhReadPage>;
  readDetail(viewerUserId: string, nakhId: string): Promise<AuthorizedNakhRow>;
}

type References = Pick<NakhOpaqueReferences, 'resolveCursor' | 'issueCursor'>;

function item(row: AuthorizedNakhRow): SentNakhStatusPage['items'][number] {
  return {
    nakhId: row.nakhId,
    counterpartyName: row.counterpartyName,
    text: row.text,
    status: row.status,
    sentAt: row.sentAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    version: row.version,
  };
}

export class GetNakhPageHandler {
  public constructor(
    private readonly store: DeliveredNakhReadStore,
    private readonly references: References,
  ) {}

  public async sent(query: GetSentNakhStatusPageQuery): Promise<SentNakhStatusPage> {
    return this.page(query, 'sent');
  }

  public async received(query: GetReceivedNakhPageQuery): Promise<ReceivedNakhPage> {
    return this.page(query, 'received');
  }

  private async page(
    query: GetSentNakhStatusPageQuery | GetReceivedNakhPageQuery,
    direction: NakhPageDirection,
  ): Promise<SentNakhStatusPage> {
    if (query.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const after =
      query.cursor === undefined
        ? undefined
        : await this.references.resolveCursor(query.cursor, query.actor.userId, direction);
    if (query.cursor !== undefined && after === undefined)
      throw new ApplicationError('invalid_request', 'error.nakh.cursor_invalid', 400);
    const page = await this.store.readPage(query.actor.userId, direction, query.limit, after);
    const items = page.rows.map(item);
    if (!page.hasMore) return { totalCount: page.totalCount, items };
    const last = page.rows.at(-1);
    if (last === undefined) throw new ApplicationError('internal_error', 'error.internal', 500);
    return {
      totalCount: page.totalCount,
      items,
      nextCursor: await this.references.issueCursor(
        query.actor.userId,
        direction,
        { sentAt: last.sentAt, nakhId: last.nakhId },
        query.requestId,
      ),
    };
  }
}

export class GetNakhDetailHandler {
  public constructor(private readonly store: DeliveredNakhReadStore) {}

  public async execute(query: GetNakhDetailQuery): Promise<NakhDetail> {
    if (query.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const row = await this.store.readDetail(query.actor.userId, query.nakhId);
    return { ...item(row), direction: row.direction };
  }
}
