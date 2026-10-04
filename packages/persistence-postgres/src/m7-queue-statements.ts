import { sql, type RawBuilder } from 'kysely';
import type { SupportThreadStatus, AppealStatus } from '@nakh/contracts';
import type { SafetyMetadataPosition } from '@nakh/application';
export type SupportQueueRow = Readonly<{
  id: string;
  status: SupportThreadStatus;
  version: number;
  created_at: Date;
  last_message_at: Date;
  cursor_time: string;
}>;
export type AppealQueueRow = Readonly<{
  id: string;
  status: AppealStatus;
  version: number;
  submitted_at: Date;
  cursor_time: string;
}>;
export function supportMetadataStatement(
  status: SupportThreadStatus,
  limit: number,
  after?: SafetyMetadataPosition,
): RawBuilder<SupportQueueRow> {
  const position =
    after === undefined
      ? sql`TRUE`
      : sql`(thread.created_at, thread.id) > (${after.at}::timestamptz, ${after.id}::uuid)`;
  return sql<SupportQueueRow>`SELECT thread.id, thread.status, thread.version, thread.created_at, thread.last_message_at,
    to_char(thread.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM support.support_threads thread WHERE thread.status = ${status} AND ${position} ORDER BY thread.created_at, thread.id LIMIT ${limit + 1}`;
}
export function appealMetadataStatement(
  status: AppealStatus,
  limit: number,
  after?: SafetyMetadataPosition,
): RawBuilder<AppealQueueRow> {
  const position =
    after === undefined
      ? sql`TRUE`
      : sql`(appeal.submitted_at, appeal.id) > (${after.at}::timestamptz, ${after.id}::uuid)`;
  return sql<AppealQueueRow>`SELECT appeal.id, appeal.status, appeal.version, appeal.submitted_at,
    to_char(appeal.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM moderation.user_appeals appeal WHERE appeal.status = ${status} AND ${position} ORDER BY appeal.submitted_at, appeal.id LIMIT ${limit + 1}`;
}
