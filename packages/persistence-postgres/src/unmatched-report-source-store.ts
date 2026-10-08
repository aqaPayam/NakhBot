import { sql } from 'kysely';
import {
  PrepareSingleReportEvidenceHandler,
  type ProfileReportSourceStore,
  type ReportEvidenceIntent,
  type ReportSource,
  type ReportTokens,
} from '@nakh/application';
import { canSubmitUserReport } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

/** The immutable unmatch fact owns the deadline; opaque context cannot extend it. */
export async function resolveUnmatchedReportSource(
  database: NakhDatabase,
  actorUserId: string,
  source: ReportSource,
  lockSource = false,
): Promise<ReportEvidenceIntent | undefined> {
  if (source.kind !== 'unmatched') return undefined;
  const account = await database
    .selectFrom('identity.accounts')
    .select('state')
    .where('user_id', '=', actorUserId)
    .executeTakeFirst();
  if (account === undefined || !canSubmitUserReport(account.state)) return undefined;
  const query = database
    .selectFrom('matching.unmatch_records as unmatch')
    .innerJoin('matching.matches as match', 'match.id', 'unmatch.match_id')
    .select(['match.id', 'match.user_low_id', 'match.user_high_id'])
    .where('match.id', '=', source.referenceId)
    .where('match.status', '=', 'unmatched')
    .where(
      sql<boolean>`(
      EXISTS (
        SELECT 1 FROM chat.chat_sessions session
        JOIN chat.chat_participants participant ON participant.chat_session_id=session.id
        WHERE session.match_id=match.id AND session.status='closed'
          AND session.closed_reason='unmatch' AND participant.user_id=${actorUserId}::uuid
      ) OR EXISTS (
        SELECT 1 FROM chat.chat_reference_anchors anchor
        JOIN identity.account_deletion_chat_receipts receipt ON receipt.chat_session_id=anchor.id
        WHERE anchor.match_id=match.id AND receipt.final_batch
          AND receipt.closed_reason='unmatch' AND receipt.closed_at=unmatch.unmatched_at
          AND match.closed_at=unmatch.unmatched_at
          AND NOT EXISTS (SELECT 1 FROM chat.chat_sessions session WHERE session.id=anchor.id)
      )
    )`,
    )
    .where((eb) =>
      eb.or([
        eb('match.user_low_id', '=', actorUserId),
        eb('match.user_high_id', '=', actorUserId),
      ]),
    );
  // Lock the immutable deadline owner, including when the live chat has been archived.
  const row = await (lockSource ? query.forShare('unmatch') : query).executeTakeFirst();
  if (row === undefined) return undefined;
  // Separate statement AFTER lock acquisition, with PostgreSQL microsecond precision.
  const window = await database
    .selectFrom('matching.unmatch_records')
    .select('match_id')
    .where('match_id', '=', row.id)
    .where('unmatched_at', '<=', sql<Date>`clock_timestamp()`)
    .where('report_window_expires_at', '>', sql<Date>`clock_timestamp()`)
    .executeTakeFirst();
  return window === undefined
    ? undefined
    : {
        source,
        targetUserId: row.user_low_id === actorUserId ? row.user_high_id : row.user_low_id,
        evidence: [{ evidenceType: 'unmatched_user', referenceId: row.id }],
      };
}
export class PostgresUnmatchedReportSourceStore implements ProfileReportSourceStore {
  public constructor(private readonly database: NakhDatabase) {}
  public resolve(
    actorUserId: string,
    source: ReportSource,
  ): Promise<ReportEvidenceIntent | undefined> {
    return resolveUnmatchedReportSource(this.database, actorUserId, source);
  }
}
export class PostgresPrepareUnmatchedReportEvidenceHandler extends PrepareSingleReportEvidenceHandler {
  public constructor(database: NakhDatabase, tokens: ReportTokens) {
    super(tokens, new PostgresUnmatchedReportSourceStore(database), 'unmatched_user');
  }
}
