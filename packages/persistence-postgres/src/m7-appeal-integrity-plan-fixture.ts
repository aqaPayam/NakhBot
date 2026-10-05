import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';

export type M7TerminalAppealFixture = Readonly<{
  reviewed: number;
  accepted: number;
  rejected: number;
  acceptedWithoutUnban: number;
  unbans: number;
  restoredStates: number;
}>;

/** Metadata plan fixtures only. The caller owns isolated trigger/FK bypass and rollback.
 * Existing per-number synthetic administrator metadata is supplied by the base fixture.
 * Acceptance never creates an unban: only every fourth appeal has separate command evidence. */
export async function seedM7AppealIntegrityPlans(
  database: NakhDatabase,
  prefix: string,
  volume: number,
  at: Date,
): Promise<M7TerminalAppealFixture> {
  await sql`INSERT INTO identity.account_state_history (id,user_id,previous_state,next_state,reason_code,actor_type,actor_admin_id,changed_at)
    SELECT md5(${prefix} || 'terminal-ban' || n)::uuid,md5(${prefix} || 'terminal-user' || n)::uuid,
      (ARRAY['active','restricted','guest','incomplete'])[(n / 4) % 4 + 1],
      'banned','admin_ban_user','admin',md5(${prefix} || 'admin' || n)::uuid,
      ${at}::timestamptz - interval '20 minutes' + n * interval '1 millisecond'
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO moderation.user_appeals (id,user_id,ban_state_history_id,message_text,status,reviewed_by_admin_id,submitted_at,reviewed_at,version)
    SELECT md5(${prefix} || 'terminal-appeal' || n)::uuid,md5(${prefix} || 'terminal-user' || n)::uuid,
      md5(${prefix} || 'terminal-ban' || n)::uuid,'Synthetic private reviewed appeal',
      CASE WHEN n % 2 = 0 THEN 'accepted' ELSE 'rejected' END,md5(${prefix} || 'admin' || n)::uuid,
      ${at}::timestamptz - interval '15 minutes' + n * interval '1 millisecond',
      ${at}::timestamptz - interval '10 minutes' + n * interval '1 millisecond',2
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO administration.admin_action_logs (id,admin_user_id,command_id,request_id,request_digest,command_code,target_type,target_id,expected_target_version,result,safe_code,reason_digest,correlation_id)
    SELECT md5(${prefix} || 'terminal-review-attempt' || n)::uuid,md5(${prefix} || 'admin' || n)::uuid,
      md5(${prefix} || 'terminal-review-command' || n)::uuid,md5(${prefix} || 'terminal-review-request' || n)::uuid,
      repeat('f',64),'moderation.review-appeal','user_appeal',md5(${prefix} || 'terminal-appeal' || n)::uuid,
      1,'succeeded',CASE WHEN n % 2 = 0 THEN 'appeal_accepted' ELSE 'appeal_rejected' END,
      repeat('a',64),md5(${prefix} || 'terminal-review-correlation' || n)::uuid
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO platform.audit_logs (id,category,event_type,actor_type,actor_admin_id,subject_type,subject_id,result_code,metadata_schema_version,request_id,command_id,occurred_at)
    SELECT md5(${prefix} || 'terminal-review-audit' || n)::uuid,'admin','moderation.appeal-reviewed.v1','admin',
      md5(${prefix} || 'admin' || n)::uuid,'user_appeal',md5(${prefix} || 'terminal-appeal' || n)::uuid,
      CASE WHEN n % 2 = 0 THEN 'appeal_accepted' ELSE 'appeal_rejected' END,1,
      md5(${prefix} || 'terminal-review-request' || n)::uuid,md5(${prefix} || 'terminal-review-command' || n)::uuid,
      ${at}::timestamptz - interval '10 minutes' + n * interval '1 millisecond'
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO identity.account_state_history (id,user_id,previous_state,next_state,reason_code,actor_type,actor_admin_id,changed_at)
    SELECT md5(${prefix} || 'terminal-unban-history' || n)::uuid,md5(${prefix} || 'terminal-user' || n)::uuid,
      'banned',(ARRAY['active','restricted','guest','incomplete'])[(n / 4) % 4 + 1],
      'admin_unban_user','admin',md5(${prefix} || 'admin' || n)::uuid,
      ${at}::timestamptz - interval '5 minutes' + n * interval '1 millisecond'
    FROM generate_series(1,${volume}) n WHERE n % 4 = 0`.execute(database);
  await sql`INSERT INTO administration.admin_action_logs (id,admin_user_id,command_id,request_id,request_digest,command_code,target_type,target_id,expected_target_version,result,safe_code,reason_digest,correlation_id)
    SELECT md5(${prefix} || 'terminal-unban-attempt' || n)::uuid,md5(${prefix} || 'admin' || n)::uuid,
      md5(${prefix} || 'terminal-unban-command' || n)::uuid,md5(${prefix} || 'terminal-unban-request' || n)::uuid,
      repeat('f',64),'moderation.unban-appeal','user_appeal',md5(${prefix} || 'terminal-appeal' || n)::uuid,
      2,'succeeded','account_action_applied',repeat('b',64),md5(${prefix} || 'terminal-unban-correlation' || n)::uuid
    FROM generate_series(1,${volume}) n WHERE n % 4 = 0`.execute(database);
  await sql`INSERT INTO platform.audit_logs (id,category,event_type,actor_type,actor_admin_id,subject_type,subject_id,result_code,metadata_schema_version,request_id,command_id,occurred_at)
    SELECT md5(${prefix} || 'terminal-unban-audit' || n)::uuid,'admin','moderation.account-action.v1','admin',
      md5(${prefix} || 'admin' || n)::uuid,'user',md5(${prefix} || 'terminal-user' || n)::uuid,'unban_user',1,
      md5(${prefix} || 'terminal-unban-request' || n)::uuid,md5(${prefix} || 'terminal-unban-command' || n)::uuid,
      ${at}::timestamptz - interval '5 minutes' + n * interval '1 millisecond'
    FROM generate_series(1,${volume}) n WHERE n % 4 = 0`.execute(database);
  await sql`INSERT INTO notification.notifications (id,user_id,notification_type,category,title_key,body_key)
    SELECT md5(${prefix} || 'terminal-unban-notice' || n)::uuid,md5(${prefix} || 'terminal-user' || n)::uuid,
      'admin_notice','admin','notification.account_unbanned.title','notification.account_unbanned.body'
    FROM generate_series(1,${volume}) n WHERE n % 4 = 0`.execute(database);
  await sql`INSERT INTO moderation.moderation_actions (id,action_type,actor_type,actor_admin_id,target_user_id,audit_log_id,notification_id,command_id,request_id,request_digest,reason_code,occurred_at)
    SELECT md5(${prefix} || 'terminal-unban-action' || n)::uuid,'unban_user','admin',md5(${prefix} || 'admin' || n)::uuid,
      md5(${prefix} || 'terminal-user' || n)::uuid,md5(${prefix} || 'terminal-unban-audit' || n)::uuid,
      md5(${prefix} || 'terminal-unban-notice' || n)::uuid,md5(${prefix} || 'terminal-unban-command' || n)::uuid,
      md5(${prefix} || 'terminal-unban-request' || n)::uuid,repeat('f',64),'admin_unban_user',
      ${at}::timestamptz - interval '5 minutes' + n * interval '1 millisecond'
    FROM generate_series(1,${volume}) n WHERE n % 4 = 0`.execute(database);
  await sql`INSERT INTO moderation.appeal_unbans (appeal_id,action_id,unban_history_id,admin_action_log_id)
    SELECT md5(${prefix} || 'terminal-appeal' || n)::uuid,md5(${prefix} || 'terminal-unban-action' || n)::uuid,
      md5(${prefix} || 'terminal-unban-history' || n)::uuid,md5(${prefix} || 'terminal-unban-attempt' || n)::uuid
    FROM generate_series(1,${volume}) n WHERE n % 4 = 0`.execute(database);
  const row = (
    await sql<Record<keyof M7TerminalAppealFixture, string>>`
    SELECT count(*)::text AS reviewed,
      count(*) FILTER (WHERE appeal.status = 'accepted')::text AS accepted,
      count(*) FILTER (WHERE appeal.status = 'rejected')::text AS rejected,
      count(*) FILTER (WHERE appeal.status = 'accepted' AND unban.appeal_id IS NULL)::text AS "acceptedWithoutUnban",
      count(unban.appeal_id)::text AS unbans,count(DISTINCT history.next_state)::text AS "restoredStates"
    FROM generate_series(1,${volume}) n
    JOIN moderation.user_appeals appeal ON appeal.id = md5(${prefix} || 'terminal-appeal' || n)::uuid
    LEFT JOIN moderation.appeal_unbans unban ON unban.appeal_id = appeal.id
    LEFT JOIN identity.account_state_history history ON history.id = unban.unban_history_id
  `.execute(database)
  ).rows[0]!;
  const expected: M7TerminalAppealFixture = {
    reviewed: volume,
    accepted: Math.floor(volume / 2),
    rejected: volume - Math.floor(volume / 2),
    acceptedWithoutUnban: Math.floor(volume / 2) - Math.floor(volume / 4),
    unbans: Math.floor(volume / 4),
    restoredStates: 4,
  };
  for (const key of Object.keys(expected) as (keyof M7TerminalAppealFixture)[])
    if (Number(row[key]) !== expected[key])
      throw new Error('M7 terminal appeal fixture incomplete.');
  return expected;
}
