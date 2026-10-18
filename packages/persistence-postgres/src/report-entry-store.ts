import { sql, type RawBuilder } from 'kysely';
import { reportUnavailable, type UserProductLife, type UserSessionActor } from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresUserSessionStore, requireCurrentUserSession } from './user-session-store.js';

export type ReportEntryConversation = Readonly<{
  matchId: string;
  chatSessionId: string;
  kind: 'match' | 'unmatched';
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** Metadata only: the caller owns this original Account life. Native report
 * preparation independently checks the chosen incident and evidence permission. */
export function reportEntryStatement(
  life: UserProductLife,
  after?: string,
): RawBuilder<ReportEntryConversation> {
  if (
    !UUID.test(life.userId) ||
    !Number.isSafeInteger(life.productEpoch) ||
    life.productEpoch < 0 ||
    life.productEpoch > 2147483647 ||
    (after !== undefined && !UUID.test(after))
  )
    throw reportUnavailable();
  return sql<ReportEntryConversation>`SELECT pair.id AS "matchId",chat.id AS "chatSessionId",
    CASE WHEN live.id IS NOT NULL AND session.id IS NOT NULL THEN 'match' ELSE 'unmatched' END AS kind
    FROM matching.match_reference_anchors pair
    JOIN chat.chat_reference_anchors chat ON chat.match_id=pair.id
    JOIN identity.accounts reporter ON reporter.user_id=${life.userId}::uuid
      AND reporter.product_epoch=${life.productEpoch} AND reporter.state IN ('active','restricted')
    LEFT JOIN matching.current_match_lives live ON live.id=pair.id AND live.status='active'
    LEFT JOIN chat.chat_sessions session ON session.id=chat.id AND session.status='active'
    LEFT JOIN matching.unmatch_records ended ON ended.match_id=pair.id
    WHERE ((pair.user_low_id=${life.userId}::uuid AND pair.low_product_epoch=${life.productEpoch})
      OR (pair.user_high_id=${life.userId}::uuid AND pair.high_product_epoch=${life.productEpoch}))
    AND ((live.id IS NOT NULL AND session.id IS NOT NULL) OR
      (ended.unmatched_at<=clock_timestamp() AND ended.report_window_expires_at>clock_timestamp()
       AND EXISTS(SELECT 1 FROM matching.match_lifecycle_facts fact WHERE fact.id=pair.id AND fact.status='unmatched')))
    ${after === undefined ? sql`` : sql`AND pair.id>${after}::uuid`}
    ORDER BY pair.id LIMIT 21`;
}

/** A deliberate fresh safety entry may issue an independent authentication proof.
 * It never updates the old grant or primary-entry activation. Its host must emit
 * only report-domain capabilities; no generic credential or product menu. */
export class PostgresReportEntryStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async open(
    input: UserProductLife,
    requestId: string,
  ): Promise<UserSessionActor | undefined> {
    const life = Object.freeze({ userId: input.userId, productEpoch: input.productEpoch });
    if (!UUID.test(requestId)) throw reportUnavailable();
    if ((await reportEntryStatement(life).execute(this.database)).rows.length === 0)
      return undefined;
    const grant = await new PostgresUserSessionStore(this.database).issue(life, requestId);
    if (grant === undefined) return undefined;
    const actor: UserSessionActor = Object.freeze({
      kind: 'user',
      ...life,
      sessionGrantId: grant.id,
    });
    if ((await this.page(actor)).length === 0) return undefined;
    return actor;
  }
  public async page(
    input: UserSessionActor,
    after?: string,
  ): Promise<readonly ReportEntryConversation[]> {
    const actor = Object.freeze({ ...input });
    return this.database.transaction().execute(async (tx) => {
      await requireCurrentUserSession(tx, actor.userId, actor);
      return (await reportEntryStatement(actor, after).execute(tx)).rows;
    });
  }
}
