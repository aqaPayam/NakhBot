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
  let query = database
    .selectFrom('matching.unmatch_records as unmatch')
    .innerJoin('matching.matches as match', 'match.id', 'unmatch.match_id')
    .innerJoin('chat.chat_sessions as session', 'session.match_id', 'match.id')
    .innerJoin('chat.chat_participants as participant', 'participant.chat_session_id', 'session.id')
    .select(['match.id', 'match.user_low_id', 'match.user_high_id'])
    .where('match.id', '=', source.referenceId)
    .where('match.status', '=', 'unmatched')
    .where('session.status', '=', 'closed')
    .where('session.closed_reason', '=', 'unmatch')
    .where('participant.user_id', '=', actorUserId)
    .where((eb) =>
      eb.or([
        eb('match.user_low_id', '=', actorUserId),
        eb('match.user_high_id', '=', actorUserId),
      ]),
    );
  if (lockSource) query = query.forShare();
  const row = await query.executeTakeFirst();
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
