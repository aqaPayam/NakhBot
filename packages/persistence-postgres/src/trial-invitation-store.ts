import { createHash } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import type { NakhDatabase } from './database.js';
import { captureLaunchAudience, type LaunchAudience } from './launch-cohort-store.js';

const TOKEN = /^[A-Za-z0-9_-]{32}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

export function trialCreditCandidates(audience: LaunchAudience): RawBuilder<{
  claimId: string;
  userId: string;
  productEpoch: number;
}> {
  const a = captureLaunchAudience(audience);
  return sql`WITH policy AS MATERIALIZED (SELECT id,result_code,metadata FROM platform.audit_logs
    WHERE event_type='platform.launch-policy-applied.v1' ORDER BY ((metadata->>'version')::bigint) DESC LIMIT 1)
    SELECT claim.id AS "claimId",claim.subject_id AS "userId",account.product_epoch AS "productEpoch"
    FROM policy JOIN platform.audit_logs invitation ON invitation.event_type='platform.trial-invitation-created.v1'
      AND (invitation.metadata->>'policyId')::uuid=policy.id
    JOIN platform.audit_logs claim ON claim.event_type='platform.trial-invitation-redeemed.v1'
      AND (claim.metadata->>'invitationId')::uuid=invitation.id
    JOIN identity.accounts account ON account.user_id=claim.subject_id
    WHERE ${a.environment}='staging' AND policy.result_code='cohort'
      AND policy.metadata->>'environment'='staging' AND policy.metadata->>'sourceSha'=${a.sourceSha}
      AND policy.metadata->>'telegramBotId'=${a.telegramBotId}
      AND platform.launch_policy_version(policy.id) IS NOT NULL
      AND (policy.metadata->>'expiresAt')::timestamptz>clock_timestamp()
      AND platform.trial_invitation_policy(invitation.id)=policy.id
      AND (invitation.metadata->>'expiresAt')::timestamptz>clock_timestamp()
      AND platform.trial_claim_epoch(claim.id)=account.product_epoch AND account.state='active'
    ORDER BY claim.id LIMIT 10`;
}

/** The operator supplies a random shareable secret; only its hash is retained.
 * Native owner guards, current policy and total ten-seat limit remain authoritative. */
export class PostgresTrialInvitationStore {
  private readonly audience: LaunchAudience;
  public constructor(
    private readonly database: NakhDatabase,
    audience: LaunchAudience,
  ) {
    this.audience = captureLaunchAudience(audience);
  }
  public async create(
    input: Readonly<{
      requestId: string;
      policyId: string;
      token: string;
      capacity: number;
      expiresAt: string;
    }>,
  ): Promise<void> {
    if (
      this.audience.environment !== 'staging' ||
      !UUID.test(input.requestId) ||
      !UUID.test(input.policyId) ||
      !TOKEN.test(input.token) ||
      !Number.isSafeInteger(input.capacity) ||
      input.capacity < 1 ||
      input.capacity > 10 ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      new Date(input.expiresAt).toISOString() !== input.expiresAt
    )
      throw Error('Private trial invitation unavailable.');
    const hash = createHash('sha256').update(input.token).digest('hex');
    await this.database.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('nakh-launch-cohort'))`.execute(tx);
      const policy = await tx
        .selectFrom('platform.audit_logs')
        .selectAll()
        .where('id', '=', input.policyId)
        .executeTakeFirst();
      if (
        policy?.metadata['sourceSha'] !== this.audience.sourceSha ||
        policy.metadata['environment'] !== this.audience.environment ||
        policy.metadata['telegramBotId'] !== this.audience.telegramBotId
      )
        throw Error('Private trial invitation unavailable.');
      const metadata = {
        policyId: input.policyId,
        tokenHash: hash,
        capacity: input.capacity,
        expiresAt: input.expiresAt,
      };
      const previous = await tx
        .selectFrom('platform.audit_logs')
        .selectAll()
        .where('id', '=', input.requestId)
        .executeTakeFirst();
      if (previous !== undefined) {
        if (
          previous.event_type !== 'platform.trial-invitation-created.v1' ||
          previous.subject_id !== input.policyId ||
          Object.keys(previous.metadata).length !== 4 ||
          Object.entries(metadata).some(([key, value]) => previous.metadata[key] !== value)
        )
          throw Error('Private trial invitation unavailable.');
        return;
      }
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id: input.requestId,
          category: 'security',
          event_type: 'platform.trial-invitation-created.v1',
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          subject_type: 'launch_policy',
          subject_id: input.policyId,
          result_code: 'ready',
          metadata_schema_version: 1,
          metadata,
          command_id: input.requestId,
          request_id: input.requestId,
          occurred_at: new Date(),
        })
        .execute();
    });
  }
  public async redeem(
    token: string,
    life: Readonly<{ userId: string; productEpoch: number }>,
  ): Promise<boolean> {
    if (
      this.audience.environment !== 'staging' ||
      !TOKEN.test(token) ||
      !UUID.test(life.userId) ||
      !Number.isSafeInteger(life.productEpoch) ||
      life.productEpoch < 0 ||
      life.productEpoch > 2147483647
    )
      return false;
    const result = await sql<{ admitted: boolean }>`SELECT platform.redeem_trial_invitation(
      ${token},${life.userId}::uuid,${life.productEpoch}::integer,
      ${this.audience.sourceSha},${this.audience.telegramBotId}) AS admitted`.execute(
      this.database,
    );
    return result.rows[0]?.admitted === true;
  }
}
