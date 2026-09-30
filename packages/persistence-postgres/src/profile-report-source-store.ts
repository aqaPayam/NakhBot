import {
  PrepareProfileReportEvidenceHandler,
  type ProfileReportSourceStore,
  type ReportEvidenceIntent,
  type ReportSource,
  type ReportTokens,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { canSubmitUserReport } from '@nakh/domain';

/** Shared by preparation and commit-time reauthorization; received Nakh text is never selected. */
export async function resolveProfileReportSource(
  database: NakhDatabase,
  actorUserId: string,
  source: ReportSource,
  lockSource = false,
): Promise<ReportEvidenceIntent | undefined> {
  if (source.kind !== 'received_like' && source.kind !== 'received_nakh') return undefined;
  const reporter = await database
    .selectFrom('identity.accounts')
    .select('state')
    .where('user_id', '=', actorUserId)
    .executeTakeFirst();
  if (reporter === undefined || !canSubmitUserReport(reporter.state)) return undefined;
  let row: Readonly<{ id: string; user_id: string }> | undefined;
  if (source.kind === 'received_like') {
    let query = database
      .selectFrom('interaction.likes as source')
      .innerJoin('profile.profiles as profile', 'profile.user_id', 'source.sender_user_id')
      .select(['profile.id', 'profile.user_id'])
      .where('source.id', '=', source.referenceId)
      .where('source.receiver_user_id', '=', actorUserId)
      .where('source.sender_user_id', '!=', actorUserId);
    if (lockSource) query = query.forShare();
    row = await query.executeTakeFirst();
  } else {
    let query = database
      .selectFrom('nakh.nakhes as source')
      .innerJoin('profile.profiles as profile', 'profile.user_id', 'source.sender_user_id')
      .select(['profile.id', 'profile.user_id'])
      .where('source.id', '=', source.referenceId)
      .where('source.receiver_user_id', '=', actorUserId)
      .where('source.sender_user_id', '!=', actorUserId);
    if (lockSource) query = query.forShare();
    row = await query.executeTakeFirst();
  }
  return row === undefined
    ? undefined
    : {
        source,
        targetUserId: row.user_id,
        evidence: [{ evidenceType: 'profile', referenceId: row.id }],
      };
}
export class PostgresProfileReportSourceStore implements ProfileReportSourceStore {
  public constructor(private readonly database: NakhDatabase) {}
  public resolve(
    actorUserId: string,
    source: ReportSource,
  ): Promise<ReportEvidenceIntent | undefined> {
    return resolveProfileReportSource(this.database, actorUserId, source);
  }
}
export class PostgresPrepareProfileReportEvidenceHandler extends PrepareProfileReportEvidenceHandler {
  public constructor(database: NakhDatabase, tokens: ReportTokens) {
    super(tokens, new PostgresProfileReportSourceStore(database));
  }
}
