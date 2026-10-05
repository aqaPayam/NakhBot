import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';

/** Plan fixtures only: isolated trigger/FK bypass and rollback belong to the caller.
 * Missing captures/system decisions are deliberate drift, not native command evidence.
 * Photo/encrypted payload branches need separate volume scenarios. */
export async function seedM7IntegrityPlans(
  database: NakhDatabase,
  prefix: string,
  volume: number,
  at: Date,
): Promise<void> {
  await sql`INSERT INTO moderation.report_evidence (id,report_id,evidence_type,profile_id)
    SELECT md5(${prefix} || 'evidence' || n)::uuid, md5(${prefix} || 'report' || n)::uuid,
      'profile',md5(${prefix} || 'profile' || n)::uuid FROM generate_series(1,${volume}) n`.execute(
    database,
  );
  await sql`INSERT INTO administration.admin_users (id,user_id,telegram_user_id,is_active,disabled_at,identity_verified_at)
    SELECT md5(${prefix} || 'admin' || n)::uuid,md5(${prefix} || 'admin-user' || n)::uuid,
      9000000000000+n,true,NULL,${at}::timestamptz FROM generate_series(1,${volume}) n`.execute(
    database,
  );
  await sql`INSERT INTO identity.telegram_identities (user_id,telegram_user_id,first_seen_at,last_seen_at)
    SELECT md5(${prefix} || 'admin-user' || n)::uuid,9000000000000+n,${at}::timestamptz,${at}::timestamptz
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO moderation.restriction_episodes (id,target_user_id,source_report_id,status,distinct_reporter_count,started_at,resolved_at,resolved_by_admin_id,resolution_reason_code)
    SELECT md5(${prefix} || 'episode' || n)::uuid,md5(${prefix} || 'target' || (n % 64))::uuid,
      md5(${prefix} || 'report' || n)::uuid,'resolved',5,${at}::timestamptz,${at}::timestamptz,
      md5(${prefix} || 'admin' || n)::uuid,'synthetic_fixture' FROM generate_series(1,${volume}) n`.execute(
    database,
  );
  // Synthetic historical bindings only: current Report decisions do not reconstruct admission.
  await sql`INSERT INTO moderation.threshold_admission_witnesses
    (restriction_episode_id,reporter_user_id,report_id,submitted_at)
    WITH representatives AS MATERIALIZED (
      SELECT target_user_id,reporter_user_id,id,submitted_at,
        row_number() OVER(PARTITION BY target_user_id ORDER BY reporter_user_id) AS ordinal
      FROM (SELECT DISTINCT ON(target_user_id,reporter_user_id) target_user_id,reporter_user_id,id,submitted_at
        FROM moderation.reports WHERE submitted_at > ${at}::timestamptz - interval '30 days'
          AND submitted_at <= ${at}::timestamptz
        ORDER BY target_user_id,reporter_user_id,submitted_at,id) selected
    )
    SELECT episode.id,picked.reporter_user_id,picked.id,picked.submitted_at
    FROM moderation.restriction_episodes episode
    JOIN representatives picked ON picked.target_user_id=episode.target_user_id AND picked.ordinal<=5
    WHERE episode.id IN (SELECT md5(${prefix} || 'episode' || n)::uuid FROM generate_series(1,${volume}) n)`.execute(
    database,
  );
  await sql`INSERT INTO platform.audit_logs (id,category,event_type,actor_type,actor_admin_id,subject_type,subject_id,result_code,metadata_schema_version,request_id,command_id,occurred_at)
    SELECT md5(${prefix} || 'audit' || n)::uuid,'admin','synthetic.plan.v1','admin',md5(${prefix} || 'admin' || n)::uuid,
      'user',md5(${prefix} || 'target' || (n % 64))::uuid,'succeeded',1,
      md5(${prefix} || 'action-request' || n)::uuid,md5(${prefix} || 'action-command' || n)::uuid,${at}::timestamptz
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO administration.admin_action_logs (id,admin_user_id,command_id,request_id,request_digest,command_code,target_type,target_id,result,safe_code,reason_digest,correlation_id)
    SELECT md5(${prefix} || 'attempt' || n)::uuid,md5(${prefix} || 'admin' || n)::uuid,
      md5(${prefix} || 'action-command' || n)::uuid,md5(${prefix} || 'action-request' || n)::uuid,repeat('d',64),
      'moderation.apply-account-action','user',md5(${prefix} || 'target' || (n % 64))::uuid,
      'succeeded','succeeded',repeat('e',64),md5(${prefix} || 'correlation' || n)::uuid
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO identity.account_state_history (id,user_id,previous_state,next_state,reason_code,actor_type,actor_admin_id,changed_at)
    SELECT md5(${prefix} || 'history' || n)::uuid,md5(${prefix} || 'target' || (n % 64))::uuid,
      'active','restricted','synthetic_fixture','admin',md5(${prefix} || 'admin' || n)::uuid,${at}::timestamptz
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO identity.account_state_history (id,user_id,previous_state,next_state,reason_code,actor_type,changed_at)
    SELECT md5(${prefix} || 'ban' || n)::uuid,md5(${prefix} || 'user' || (n % 257))::uuid,
      'active','banned','synthetic_fixture','system',${at}::timestamptz
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO notification.notifications (id,user_id,notification_type,category,title_key,body_key)
    SELECT md5(${prefix} || 'notice' || n)::uuid,md5(${prefix} || 'target' || (n % 64))::uuid,
      'restriction_warning','restriction','synthetic.title','synthetic.body'
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO moderation.moderation_actions (id,action_type,actor_type,actor_admin_id,target_user_id,source_report_id,restriction_episode_id,audit_log_id,notification_id,command_id,request_id,request_digest,reason_code,occurred_at)
    SELECT md5(${prefix} || 'action' || n)::uuid,'restrict_user','admin',md5(${prefix} || 'admin' || n)::uuid,
      md5(${prefix} || 'target' || (n % 64))::uuid,md5(${prefix} || 'report' || n)::uuid,
      md5(${prefix} || 'episode' || n)::uuid,md5(${prefix} || 'audit' || n)::uuid,
      md5(${prefix} || 'notice' || n)::uuid,md5(${prefix} || 'action-command' || n)::uuid,
      md5(${prefix} || 'action-request' || n)::uuid,repeat('d',64),'synthetic_fixture',${at}::timestamptz
    FROM generate_series(1,${volume}) n`.execute(database);
  // Exercise every original threshold chain at volume. These are synthetic metadata, not
  // admission evidence: the deliberately invalid resolved episodes above remain drift.
  await sql`INSERT INTO platform.audit_logs (id,category,event_type,actor_type,subject_type,subject_id,result_code,metadata_schema_version,metadata,request_id,command_id,occurred_at)
    SELECT md5(${prefix} || 'threshold-audit' || n)::uuid,'security','moderation.threshold-restriction.v1','system',
      'user',md5(${prefix} || 'target' || (n % 64))::uuid,'restricted',1,
      jsonb_build_object('reasonCode','distinct_reporter_threshold','distinctReporterCount',5),
      md5(${prefix} || 'threshold-request' || n)::uuid,md5(${prefix} || 'threshold-command' || n)::uuid,${at}::timestamptz
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO identity.account_state_history (id,user_id,previous_state,next_state,reason_code,actor_type,changed_at)
    SELECT md5(${prefix} || 'threshold-history' || n)::uuid,md5(${prefix} || 'target' || (n % 64))::uuid,
      'active','restricted','distinct_reporter_threshold','system',${at}::timestamptz
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO notification.notifications (id,user_id,notification_type,category,title_key,body_key,deduplication_key)
    SELECT md5(${prefix} || 'threshold-notice' || n)::uuid,md5(${prefix} || 'target' || (n % 64))::uuid,
      'restriction_warning','restriction','notification.restriction_warning.title','notification.restriction_warning.body',
      'moderation-threshold:' || md5(${prefix} || 'episode' || n)::uuid::text || ':restriction'
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO notification.notification_deliveries (id,notification_id,channel)
    SELECT md5(${prefix} || 'threshold-delivery' || n)::uuid,md5(${prefix} || 'threshold-notice' || n)::uuid,'telegram'
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO moderation.moderation_actions (id,action_type,actor_type,target_user_id,source_report_id,restriction_episode_id,audit_log_id,notification_id,command_id,request_id,request_digest,reason_code,occurred_at)
    SELECT md5(${prefix} || 'threshold-action' || n)::uuid,'restrict_user','system',
      md5(${prefix} || 'target' || (n % 64))::uuid,md5(${prefix} || 'report' || n)::uuid,
      md5(${prefix} || 'episode' || n)::uuid,md5(${prefix} || 'threshold-audit' || n)::uuid,
      md5(${prefix} || 'threshold-notice' || n)::uuid,md5(${prefix} || 'threshold-command' || n)::uuid,
      md5(${prefix} || 'threshold-request' || n)::uuid,repeat('f',64),'distinct_reporter_threshold',${at}::timestamptz
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO interaction.user_pair_states (user_low_id,user_high_id,state,reason_code,changed_at)
    SELECT LEAST(md5(${prefix} || 'pair-a' || n)::uuid,md5(${prefix} || 'pair-b' || n)::uuid),
      GREATEST(md5(${prefix} || 'pair-a' || n)::uuid,md5(${prefix} || 'pair-b' || n)::uuid),
      'blocked','synthetic_fixture',${at}::timestamptz FROM generate_series(1,${volume}) n`.execute(
    database,
  );
  await sql`INSERT INTO matching.matches (id,user_low_id,user_high_id,source,source_nakh_id,status,created_at,closed_at)
    SELECT md5(${prefix} || 'match' || n)::uuid,
      LEAST(md5(${prefix} || 'pair-a' || n)::uuid,md5(${prefix} || 'pair-b' || n)::uuid),
      GREATEST(md5(${prefix} || 'pair-a' || n)::uuid,md5(${prefix} || 'pair-b' || n)::uuid),
      'nakh_accept',md5(${prefix} || 'nakh' || n)::uuid,'closed',${at}::timestamptz,${at}::timestamptz
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO interaction.likes (id,sender_user_id,receiver_user_id,status,created_at,closed_at)
    SELECT md5(${prefix} || 'like' || n)::uuid,md5(${prefix} || 'pair-a' || n)::uuid,
      md5(${prefix} || 'pair-b' || n)::uuid,'cancelled_by_system',${at}::timestamptz,${at}::timestamptz
    FROM generate_series(1,${volume}) n`.execute(database);
  await sql`INSERT INTO interaction.feature_unlocks (id,payer_user_id,feature_type,like_id,match_id,payment_record_id,status,revoked_at,revoked_reason)
    SELECT md5(${prefix} || 'unlock' || n)::uuid,md5(${prefix} || 'pair-a' || n)::uuid,
      CASE WHEN n % 4 = 2 THEN 'liked_by_profile_unlock' ELSE 'chat_unlock' END,
      CASE WHEN n % 4 = 2 THEN md5(${prefix} || 'like' || n)::uuid ELSE NULL END,
      CASE WHEN n % 4 <> 2 THEN md5(${prefix} || 'match' || n)::uuid ELSE NULL END,
      md5(${prefix} || 'payment' || n)::uuid,
      CASE WHEN n % 2 = 0 THEN 'active' ELSE 'revoked' END,
      CASE WHEN n % 2 = 0 THEN NULL ELSE ${at}::timestamptz END,
      CASE WHEN n % 2 = 0 THEN NULL ELSE 'synthetic_fixture' END
    FROM generate_series(1,${volume}) n`.execute(database);
}
