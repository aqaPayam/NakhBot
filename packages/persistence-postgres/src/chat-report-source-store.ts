import {
  PrepareChatReportEvidenceHandler,
  type ProfileReportSourceStore,
  type ReportEvidenceIntent,
  type ReportSource,
  type ReportTokens,
} from '@nakh/application';
import { canSubmitUserReport } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

/** Participant-only active chat context; no messages, profiles or identity projections are read. */
export async function resolveChatReportSource(
  database: NakhDatabase,
  actorUserId: string,
  source: ReportSource,
  lockSource = false,
): Promise<ReportEvidenceIntent | undefined> {
  if (source.kind !== 'match') return undefined;
  const account = await database
    .selectFrom('identity.accounts')
    .select('state')
    .where('user_id', '=', actorUserId)
    .executeTakeFirst();
  if (account === undefined || !canSubmitUserReport(account.state)) return undefined;
  let query = database
    .selectFrom('chat.chat_sessions as session')
    .innerJoin('matching.matches as match', 'match.id', 'session.match_id')
    .innerJoin('chat.chat_participants as participant', 'participant.chat_session_id', 'session.id')
    .select(['session.id', 'match.user_low_id', 'match.user_high_id'])
    .where('match.id', '=', source.referenceId)
    .where('match.status', '=', 'active')
    .where('session.status', '=', 'active')
    .where('participant.user_id', '=', actorUserId)
    .where((eb) =>
      eb.or([
        eb('match.user_low_id', '=', actorUserId),
        eb('match.user_high_id', '=', actorUserId),
      ]),
    );
  if (lockSource) query = query.forShare();
  const row = await query.executeTakeFirst();
  return row === undefined
    ? undefined
    : {
        source,
        targetUserId: row.user_low_id === actorUserId ? row.user_high_id : row.user_low_id,
        evidence: [{ evidenceType: 'chat', referenceId: row.id }],
      };
}
export class PostgresChatReportSourceStore implements ProfileReportSourceStore {
  public constructor(private readonly database: NakhDatabase) {}
  public resolve(
    actorUserId: string,
    source: ReportSource,
  ): Promise<ReportEvidenceIntent | undefined> {
    return resolveChatReportSource(this.database, actorUserId, source);
  }
}
export class PostgresPrepareChatReportEvidenceHandler extends PrepareChatReportEvidenceHandler {
  public constructor(database: NakhDatabase, tokens: ReportTokens) {
    super(tokens, new PostgresChatReportSourceStore(database));
  }
}
