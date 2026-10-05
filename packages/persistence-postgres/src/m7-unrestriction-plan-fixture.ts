import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';
import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';

export type M7UnrestrictionFixture = Readonly<{
  actions: number;
  bound: number;
  digestDrift: number;
}>;

/** Synthetic resolution metadata only, inside caller-owned trigger/FK bypass and rollback.
 * Each unrestriction has a separate command; half intentionally fail its exact digest binding. */
export async function seedM7UnrestrictionPlans(
  database: NakhDatabase,
  prefix: string,
  volume: number,
  at: Date,
): Promise<M7UnrestrictionFixture> {
  await sql`UPDATE moderation.restriction_episodes episode SET resolved_at=${at}::timestamptz+interval '1 minute',
    resolution_reason_code='synthetic_unrestrict' WHERE episode.id IN (
      SELECT md5(${prefix} || 'episode' || n)::uuid FROM generate_series(1,${volume}) n)`.execute(
    database,
  );
  await sql`INSERT INTO identity.account_state_history (id,user_id,previous_state,next_state,reason_code,actor_type,actor_admin_id,changed_at)
    SELECT md5(${prefix} || 'unrestrict-history' || n)::uuid,md5(${prefix} || 'target' || (n % 64))::uuid,
      'restricted','active','synthetic_unrestrict','admin',md5(${prefix} || 'admin' || n)::uuid,
      ${at}::timestamptz+interval '1 minute' FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO administration.admin_action_logs (id,admin_user_id,command_id,request_id,request_digest,command_code,target_type,target_id,expected_target_version,result,safe_code,reason_digest,correlation_id)
    SELECT md5(${prefix} || 'unrestrict-attempt' || n)::uuid,md5(${prefix} || 'admin' || n)::uuid,
      md5(${prefix} || 'unrestrict-command' || n)::uuid,md5(${prefix} || 'unrestrict-request' || n)::uuid,
      CASE WHEN n % 2 = 0 THEN repeat('f',64) ELSE repeat('d',64) END,
      'moderation.apply-account-action','user',md5(${prefix} || 'target' || (n % 64))::uuid,2,
      'succeeded','account_unrestrict_user',repeat('a',64),md5(${prefix} || 'unrestrict-correlation' || n)::uuid
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO platform.audit_logs (id,category,event_type,actor_type,actor_admin_id,subject_type,subject_id,result_code,metadata_schema_version,request_id,command_id,occurred_at)
    SELECT md5(${prefix} || 'unrestrict-audit' || n)::uuid,'admin','moderation.account-action.v1','admin',
      md5(${prefix} || 'admin' || n)::uuid,'user',md5(${prefix} || 'target' || (n % 64))::uuid,'unrestrict_user',1,
      md5(${prefix} || 'unrestrict-request' || n)::uuid,md5(${prefix} || 'unrestrict-command' || n)::uuid,
      ${at}::timestamptz+interval '1 minute' FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO notification.notifications (id,user_id,notification_type,category,title_key,body_key)
    SELECT md5(${prefix} || 'unrestrict-notice' || n)::uuid,md5(${prefix} || 'target' || (n % 64))::uuid,
      'admin_notice','admin','notification.account_unrestricted.title','notification.account_unrestricted.body'
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO moderation.moderation_actions (id,action_type,actor_type,actor_admin_id,target_user_id,restriction_episode_id,audit_log_id,notification_id,command_id,request_id,request_digest,reason_code,occurred_at)
    SELECT md5(${prefix} || 'unrestrict-action' || n)::uuid,'unrestrict_user','admin',md5(${prefix} || 'admin' || n)::uuid,
      md5(${prefix} || 'target' || (n % 64))::uuid,md5(${prefix} || 'episode' || n)::uuid,
      md5(${prefix} || 'unrestrict-audit' || n)::uuid,md5(${prefix} || 'unrestrict-notice' || n)::uuid,
      md5(${prefix} || 'unrestrict-command' || n)::uuid,md5(${prefix} || 'unrestrict-request' || n)::uuid,
      repeat('f',64),'synthetic_unrestrict',${at}::timestamptz+interval '1 minute'
    FROM generate_series(1,${volume}) n`.execute(database);
  const row = (
    await sql<{ actions: string; bound: string; digestDrift: string }>`
    WITH fixture AS MATERIALIZED (
      SELECT n,md5(${prefix} || 'unrestrict-action' || n)::uuid AS action_id,
        md5(${prefix} || 'episode' || n)::uuid AS episode_id,
        md5(${prefix} || 'unrestrict-attempt' || n)::uuid AS attempt_id FROM generate_series(1,${volume}) n
    ), actions AS MATERIALIZED (
      SELECT probe.* FROM (${MODERATION_INTEGRITY_SOURCES.actions}) probe
      WHERE probe.id IN (SELECT action_id FROM fixture)
    ), episodes AS MATERIALIZED (
      SELECT probe.* FROM (${MODERATION_INTEGRITY_SOURCES.episodes}) probe
      WHERE probe.id IN (SELECT episode_id FROM fixture)
    ), attempts AS MATERIALIZED (
      SELECT probe.* FROM (${MODERATION_INTEGRITY_SOURCES.admin_logs}) probe
      WHERE probe.id IN (SELECT attempt_id FROM fixture)
    )
    SELECT count(*)::text AS actions,
      count(*) FILTER(WHERE action."hasAttempt" AND episode."hasResolutionAttempt" AND attempt."hasAction")::text AS bound,
      count(*) FILTER(WHERE NOT action."hasAttempt" AND NOT episode."hasResolutionAttempt" AND NOT attempt."hasAction")::text AS "digestDrift"
    FROM fixture
    JOIN actions action ON action.id=fixture.action_id
    JOIN episodes episode ON episode.id=fixture.episode_id
    JOIN attempts attempt ON attempt.id=fixture.attempt_id
    WHERE action."hasAudit" AND action."hasAccountHistory" AND action."hasNotice" AND action."reportMatches"
      AND episode."hasOneSystemAction" AND episode."hasAdmissionWitness" AND episode."sourceMatches"
      AND episode."hasRestrictionHistory" AND episode."hasRestrictionAudit" AND episode."hasRestrictionNotice"
      AND attempt."hasAccess"`.execute(database)
  ).rows[0]!;
  const result = {
    actions: Number(row.actions),
    bound: Number(row.bound),
    digestDrift: Number(row.digestDrift),
  };
  if (
    result.actions !== volume ||
    result.bound !== Math.floor(volume / 2) ||
    result.digestDrift !== volume - Math.floor(volume / 2)
  )
    throw new Error('M7 unrestriction fixture incomplete.');
  return result;
}
