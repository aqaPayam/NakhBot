import {
  PrepareSingleReportEvidenceHandler,
  type ReportEvidenceIntent,
  type ReportSource,
  type ReportTokens,
} from '@nakh/application';
import { canSubmitUserReport } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

/** Restricted message context only. Preparation never reads message content. */
export async function resolveMessageReportSource(
  database: NakhDatabase,
  actorUserId: string,
  source: ReportSource,
  lockSource = false,
): Promise<ReportEvidenceIntent | undefined> {
  if (source.kind !== 'message' || source.photoId !== undefined) return undefined;
  const account = await database
    .selectFrom('identity.accounts')
    .select('state')
    .where('user_id', '=', actorUserId)
    .executeTakeFirst();
  if (account === undefined || !canSubmitUserReport(account.state)) return undefined;
  const query = database
    .selectFrom('chat.chat_messages as message')
    .innerJoin('chat.chat_sessions as session', 'session.id', 'message.chat_session_id')
    .innerJoin('matching.matches as match', 'match.id', 'session.match_id')
    .innerJoin('chat.chat_participants as participant', 'participant.chat_session_id', 'session.id')
    .select([
      'message.id',
      'session.id as session_id',
      'match.id as match_id',
      'match.user_low_id',
      'match.user_high_id',
    ])
    .where('message.id', '=', source.referenceId)
    .where('participant.user_id', '=', actorUserId)
    .where((eb) =>
      eb.or([
        eb('match.user_low_id', '=', actorUserId),
        eb('match.user_high_id', '=', actorUserId),
      ]),
    );
  let row = await query.executeTakeFirst();
  if (row === undefined) return undefined;
  if (lockSource) {
    // Match -> session -> message agrees with lifecycle closure and M6 cleanup.
    await database
      .selectFrom('matching.matches')
      .select('id')
      .where('id', '=', row.match_id)
      .forShare()
      .executeTakeFirstOrThrow();
    await database
      .selectFrom('chat.chat_sessions')
      .select('id')
      .where('id', '=', row.session_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    row = await query.forShare().executeTakeFirst();
    if (row === undefined) return undefined;
  }
  return {
    source,
    targetUserId: row.user_low_id === actorUserId ? row.user_high_id : row.user_low_id,
    evidence: [{ evidenceType: 'message', referenceId: row.id }],
  };
}
export class PostgresPrepareMessageReportEvidenceHandler extends PrepareSingleReportEvidenceHandler {
  public constructor(database: NakhDatabase, tokens: ReportTokens) {
    super(
      tokens,
      { resolve: (actor, source) => resolveMessageReportSource(database, actor, source) },
      'message',
    );
  }
}
