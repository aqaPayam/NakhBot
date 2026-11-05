import { createHash, randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import type { NakhDatabase } from './database.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POLICY = 'platform.launch-policy-applied.v1',
  MEMBER = 'platform.launch-cohort-granted.v1';
const SUBJECT = '00000000-0000-4000-8000-000000000009';
export type LaunchAudience = Readonly<{
  sourceSha: string;
  environment: 'staging' | 'production';
  telegramBotId: string;
}>;
export type LaunchCohortCommand = LaunchAudience &
  Readonly<{
    requestId: string;
    expectedVersion: number;
    sourceSha: string;
    mode: 'closed' | 'cohort';
    expiresAt: string | null;
    reviewDigest: string;
    members: readonly Readonly<{ userId: string; productEpoch: number }>[];
  }>;
export type LaunchPolicyReceipt = Readonly<{
  policyId: string;
  version: number;
  mode: 'closed' | 'cohort';
  replayed: boolean;
  latest: boolean;
}>;
function unavailable(): never {
  throw new Error('Launch cohort unavailable.');
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((k) => !Object.hasOwn(value, k)))
    unavailable();
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) unavailable();
  return value as Record<string, unknown>;
}
export function captureLaunchCohortCommand(input: unknown): LaunchCohortCommand {
  const value = object(structuredClone(input));
  exact(value, [
    'requestId',
    'expectedVersion',
    'sourceSha',
    'environment',
    'telegramBotId',
    'mode',
    'expiresAt',
    'reviewDigest',
    'members',
  ]);
  if (
    typeof value.requestId !== 'string' ||
    !UUID.test(value.requestId) ||
    !Number.isSafeInteger(value.expectedVersion) ||
    Number(value.expectedVersion) < 0 ||
    Number(value.expectedVersion) >= 2147483647 ||
    typeof value.sourceSha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(value.sourceSha) ||
    (value.mode !== 'closed' && value.mode !== 'cohort') ||
    typeof value.reviewDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.reviewDigest) ||
    !Array.isArray(value.members) ||
    value.members.length > 100
  )
    unavailable();
  const audience = captureLaunchAudience({
    sourceSha: value.sourceSha,
    environment: value.environment,
    telegramBotId: value.telegramBotId,
  });
  const members = value.members
    .map((entry: unknown) => {
      const m = object(entry);
      exact(m, ['userId', 'productEpoch']);
      if (
        typeof m.userId !== 'string' ||
        !UUID.test(m.userId) ||
        !Number.isSafeInteger(m.productEpoch) ||
        Number(m.productEpoch) < 0 ||
        Number(m.productEpoch) > 2147483647
      )
        unavailable();
      return { userId: m.userId.toLowerCase(), productEpoch: Number(m.productEpoch) };
    })
    .sort((a, b) => a.userId.localeCompare(b.userId));
  if (new Set(members.map((m) => m.userId)).size !== members.length) unavailable();
  if (
    value.mode === 'closed'
      ? members.length !== 0 || value.expiresAt !== null
      : members.length < 1 ||
        typeof value.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(value.expiresAt)) ||
        new Date(value.expiresAt).toISOString() !== value.expiresAt
  )
    unavailable();
  return {
    requestId: value.requestId.toLowerCase(),
    expectedVersion: Number(value.expectedVersion),
    ...audience,
    mode: value.mode,
    expiresAt: value.expiresAt as string | null,
    reviewDigest: value.reviewDigest,
    members,
  };
}
type PolicyRow = {
  id: string;
  version: string | null;
  result_code: 'closed' | 'cohort';
  metadata: { operatorId: string; requestDigest: string };
};
async function latest(database: NakhDatabase): Promise<PolicyRow | undefined> {
  return (
    await sql<PolicyRow>`SELECT id,platform.launch_policy_version(id)::text AS version,result_code,metadata
 FROM platform.audit_logs WHERE event_type=${sql.lit(POLICY)} ORDER BY ((metadata->>'version')::bigint) DESC LIMIT 1`.execute(
      database,
    )
  ).rows[0];
}
/** Protected operator capability only. The database trigger denies all runtime
 * purpose logins even if they can append ordinary audits. No public composition. */
export class PostgresLaunchCohortControl {
  private readonly operatorId: string;
  public constructor(
    private readonly database: NakhDatabase,
    operator: Readonly<{ operatorId: string }>,
  ) {
    if (!UUID.test(operator.operatorId)) unavailable();
    this.operatorId = operator.operatorId.toLowerCase();
  }
  /** Read an exact original receipt after review expiry, with no possibility of
   * applying or renewing its policy. Uncertain effects remain independently reconcilable. */
  public async receipt(value: unknown): Promise<LaunchPolicyReceipt | null> {
    const command = captureLaunchCohortCommand(value);
    const digest = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    return this.database
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        await sql`SET TRANSACTION READ ONLY`.execute(tx);
        const current = await latest(tx);
        if (current && current.version === null) unavailable();
        const prior = (
          await sql<PolicyRow>`SELECT id,platform.launch_policy_version(id)::text AS version,result_code,metadata
        FROM platform.audit_logs WHERE id=${command.requestId}::uuid`.execute(tx)
        ).rows[0];
        if (!prior) return null;
        if (
          prior.version === null ||
          prior.metadata.operatorId !== this.operatorId ||
          prior.metadata.requestDigest !== digest
        )
          unavailable();
        return {
          policyId: prior.id,
          version: Number(prior.version),
          mode: prior.result_code,
          replayed: true,
          latest: current?.id === prior.id,
        };
      });
  }
  public async apply(value: unknown, admissionExpiresAt?: string): Promise<LaunchPolicyReceipt> {
    const command = captureLaunchCohortCommand(value);
    const admissionDeadline =
      admissionExpiresAt === undefined ? undefined : Date.parse(admissionExpiresAt);
    if (
      admissionDeadline !== undefined &&
      (!Number.isFinite(admissionDeadline) ||
        new Date(admissionDeadline).toISOString() !== admissionExpiresAt)
    )
      unavailable();
    const digest = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    try {
      return await this.database.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('nakh-launch-cohort'))`.execute(tx);
        const current = await latest(tx);
        if (current && current.version === null) unavailable();
        const prior = (
          await sql<PolicyRow>`SELECT id,platform.launch_policy_version(id)::text AS version,result_code,metadata
    FROM platform.audit_logs WHERE id=${command.requestId}::uuid`.execute(tx)
        ).rows[0];
        if (prior) {
          if (
            prior.version === null ||
            prior.metadata.operatorId !== this.operatorId ||
            prior.metadata.requestDigest !== digest
          )
            unavailable();
          return {
            policyId: prior.id,
            version: Number(prior.version),
            mode: prior.result_code,
            replayed: true,
            latest: current?.id === prior.id,
          };
        }
        const version = current ? Number(current.version) : 0;
        if (version !== command.expectedVersion) unavailable();
        const ids = command.members.map((member) => member.userId);
        if (ids.length) {
          const users = await tx
            .selectFrom('identity.users')
            .select('id')
            .where('id', 'in', ids)
            .orderBy('id')
            .forUpdate()
            .execute();
          if (users.length !== ids.length) unavailable();
          const accounts = await tx
            .selectFrom('identity.accounts')
            .select(['user_id', 'product_epoch', 'state'])
            .where('user_id', 'in', ids)
            .orderBy('user_id')
            .forUpdate()
            .execute();
          if (
            accounts.length !== ids.length ||
            command.members.some(
              (member) =>
                !accounts.some(
                  (account) =>
                    account.user_id === member.userId &&
                    account.product_epoch === member.productEpoch &&
                    account.state !== 'deleted',
                ),
            )
          )
            unavailable();
        }
        const at = (
          await sql<{
            at: string;
          }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`.execute(
            tx,
          )
        ).rows[0]!.at;
        // Waiting for advisory/member locks never renews an earlier review.
        if (admissionDeadline !== undefined && Date.parse(at) >= admissionDeadline) unavailable();
        if (command.expiresAt !== null) {
          const valid = (
            await sql<{
              valid: boolean;
            }>`SELECT ${command.expiresAt}::timestamptz>${at}::timestamptz AND ${command.expiresAt}::timestamptz<=${at}::timestamptz+interval '24 hours' AS valid`.execute(
              tx,
            )
          ).rows[0]!.valid;
          if (!valid) unavailable();
        }
        await tx
          .insertInto('platform.audit_logs')
          .values({
            id: command.requestId,
            category: 'security',
            event_type: POLICY,
            actor_type: 'system',
            actor_user_id: null,
            actor_admin_id: null,
            subject_type: 'launch_policy',
            subject_id: SUBJECT,
            result_code: command.mode,
            metadata_schema_version: 1,
            metadata: {
              operatorId: this.operatorId,
              requestDigest: digest,
              reviewDigest: command.reviewDigest,
              sourceSha: command.sourceSha,
              environment: command.environment,
              telegramBotId: command.telegramBotId,
              version: version + 1,
              cohortSize: ids.length,
              expiresAt: command.expiresAt,
            },
            command_id: command.requestId,
            request_id: command.requestId,
            occurred_at: new Date(at),
          })
          .execute();
        if (ids.length)
          await tx
            .insertInto('platform.audit_logs')
            .values(
              command.members.map((member) => ({
                id: randomUUID(),
                category: 'security',
                event_type: MEMBER,
                actor_type: 'system',
                actor_user_id: null,
                actor_admin_id: null,
                subject_type: 'user',
                subject_id: member.userId,
                result_code: 'admitted',
                metadata_schema_version: 1,
                metadata: { policyId: command.requestId, productEpoch: member.productEpoch },
                command_id: command.requestId,
                request_id: command.requestId,
                occurred_at: new Date(at),
              })),
            )
            .execute();
        return {
          policyId: command.requestId,
          version: version + 1,
          mode: command.mode,
          replayed: false,
          latest: true,
        };
      });
    } catch (error) {
      const code =
        error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (typeof code === 'string' && /^[A-Z0-9]{5}$/u.test(code)) {
        // Native errors may contain private values. Retain SQLSTATE only.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`Launch cohort unavailable (${code}).`);
      }
      return unavailable();
    }
  }
}
/** One fresh native observation per admission; absent, stopped, expired,
 * foreign-source and original-life membership never authorize product access. */
export function captureLaunchAudience(input: unknown): LaunchAudience {
  const value = object(structuredClone(input));
  exact(value, ['sourceSha', 'environment', 'telegramBotId']);
  if (
    typeof value.sourceSha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(value.sourceSha) ||
    (value.environment !== 'staging' && value.environment !== 'production') ||
    typeof value.telegramBotId !== 'string' ||
    !/^[1-9][0-9]{0,15}$/u.test(value.telegramBotId) ||
    !Number.isSafeInteger(Number(value.telegramBotId))
  )
    unavailable();
  return Object.freeze({
    sourceSha: value.sourceSha,
    environment: value.environment,
    telegramBotId: value.telegramBotId,
  });
}
export class PostgresLaunchCohortAdmission {
  private readonly audience: LaunchAudience;
  public constructor(
    private readonly database: NakhDatabase,
    audience: LaunchAudience,
  ) {
    this.audience = captureLaunchAudience(audience);
  }
  public async allows(userId: string): Promise<boolean> {
    if (!UUID.test(userId)) return false;
    try {
      return (
        (await launchCohortAdmissionStatement(userId, this.audience).execute(this.database)).rows[0]
          ?.allowed === true
      );
    } catch {
      return false;
    }
  }
}

export function launchCohortAdmissionStatement(
  userId: string,
  audience: LaunchAudience,
): RawBuilder<{ allowed: boolean }> {
  return sql<{ allowed: boolean }>`WITH policy AS MATERIALIZED (
   SELECT id,result_code,metadata FROM platform.audit_logs WHERE event_type=${sql.lit(POLICY)}
   ORDER BY ((metadata->>'version')::bigint) DESC LIMIT 1)
   SELECT EXISTS(SELECT 1 FROM policy JOIN platform.audit_logs member ON (member.metadata->>'policyId')::uuid=policy.id
    AND member.subject_id=${userId}::uuid AND member.event_type=${sql.lit(MEMBER)}
    JOIN identity.accounts account ON account.user_id=member.subject_id
    WHERE policy.result_code='cohort' AND policy.metadata->>'sourceSha'=${audience.sourceSha}
     AND policy.metadata->>'environment'=${audience.environment} AND policy.metadata->>'telegramBotId'=${audience.telegramBotId}
     AND (policy.metadata->>'expiresAt')::timestamptz>clock_timestamp()
     AND platform.launch_policy_version(policy.id) IS NOT NULL
     AND platform.launch_member_epoch(member.id)=account.product_epoch AND account.state<>'deleted')
   OR EXISTS(SELECT 1 FROM policy
    JOIN platform.audit_logs invitation ON invitation.event_type='platform.trial-invitation-created.v1'
     AND (invitation.metadata->>'policyId')::uuid=policy.id
    JOIN platform.audit_logs claim ON claim.event_type='platform.trial-invitation-redeemed.v1'
     AND (claim.metadata->>'invitationId')::uuid=invitation.id AND claim.subject_id=${userId}::uuid
    JOIN identity.accounts account ON account.user_id=claim.subject_id
    WHERE policy.result_code='cohort' AND policy.metadata->>'sourceSha'=${audience.sourceSha}
     AND policy.metadata->>'environment'='staging' AND ${audience.environment}='staging'
     AND policy.metadata->>'telegramBotId'=${audience.telegramBotId}
     AND platform.launch_policy_version(policy.id) IS NOT NULL
     AND (policy.metadata->>'expiresAt')::timestamptz>clock_timestamp()
     AND platform.trial_invitation_policy(invitation.id)=policy.id
     AND (invitation.metadata->>'expiresAt')::timestamptz>clock_timestamp()
     AND platform.trial_claim_epoch(claim.id)=account.product_epoch AND account.state<>'deleted') AS allowed`;
}
