import {
  PrepareProfileReportEvidenceHandler,
  type ProfileReportSourceStore,
  type ReportEvidenceIntent,
  type ReportSource,
  type ReportTokens,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';

/** Shared by preparation and commit-time reauthorization. Historical received Likes remain evidence. */
export async function resolveProfileReportSource(
  database: NakhDatabase,
  actorUserId: string,
  source: ReportSource,
): Promise<ReportEvidenceIntent | undefined> {
  if (source.kind !== 'received_like') return undefined;
  const row = await database
    .selectFrom('interaction.likes as source')
    .innerJoin('profile.profiles as profile', 'profile.user_id', 'source.sender_user_id')
    .select(['profile.id', 'profile.user_id'])
    .where('source.id', '=', source.referenceId)
    .where('source.receiver_user_id', '=', actorUserId)
    .where('source.sender_user_id', '!=', actorUserId)
    .executeTakeFirst();
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
