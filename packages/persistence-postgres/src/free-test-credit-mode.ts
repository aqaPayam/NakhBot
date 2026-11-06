import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';
import { captureLaunchAudience, type LaunchAudience } from './launch-cohort-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EVENT = 'platform.free-credit-test-mode-applied.v1';
function denied(): never {
  throw new Error('Free test credit control unavailable.');
}
export type FreeTestCreditModeCommand = LaunchAudience &
  Readonly<{
    requestId: string;
    expectedVersion: number;
    enabled: boolean;
    cohortPolicyId: string | null;
    expiresAt: string | null;
  }>;
export function captureFreeTestCreditModeCommand(value: unknown): FreeTestCreditModeCommand {
  const c: unknown = structuredClone(value);
  if (c === null || typeof c !== 'object' || Array.isArray(c)) denied();
  const r = c as Record<string, unknown>;
  const keys = [
    'requestId',
    'expectedVersion',
    'enabled',
    'cohortPolicyId',
    'expiresAt',
    'sourceSha',
    'environment',
    'telegramBotId',
  ];
  if (Object.keys(r).length !== keys.length || keys.some((k) => !Object.hasOwn(r, k))) denied();
  const audience = captureLaunchAudience({
    sourceSha: r.sourceSha,
    environment: r.environment,
    telegramBotId: r.telegramBotId,
  });
  if (
    audience.environment !== 'staging' ||
    typeof r.requestId !== 'string' ||
    !UUID.test(r.requestId) ||
    !Number.isSafeInteger(r.expectedVersion) ||
    Number(r.expectedVersion) < 0 ||
    Number(r.expectedVersion) >= 2147483647 ||
    typeof r.enabled !== 'boolean'
  )
    denied();
  if (
    r.enabled
      ? typeof r.cohortPolicyId !== 'string' ||
        !UUID.test(r.cohortPolicyId) ||
        typeof r.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(r.expiresAt)) ||
        new Date(r.expiresAt).toISOString() !== r.expiresAt
      : r.cohortPolicyId !== null || r.expiresAt !== null
  )
    denied();
  return Object.freeze({
    ...audience,
    requestId: r.requestId,
    expectedVersion: Number(r.expectedVersion),
    enabled: r.enabled,
    cohortPolicyId: r.cohortPolicyId as string | null,
    expiresAt: r.expiresAt as string | null,
  });
}
export function freeTestCreditModeDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(captureFreeTestCreditModeCommand(value)))
    .digest('hex');
}
/** Only the protected database owner can append this authority; runtime logins cannot. */
export class PostgresFreeTestCreditModeControl {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly operatorId: string,
  ) {
    if (!UUID.test(operatorId)) denied();
  }
  public async apply(input: unknown): Promise<
    Readonly<{
      modeId: string;
      version: number;
      enabled: boolean;
      replayed: boolean;
      latest: boolean;
    }>
  > {
    const c = captureFreeTestCreditModeCommand(input),
      digest = freeTestCreditModeDigest(c);
    return this.database.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('nakh-launch-cohort'))`.execute(tx);
      const owner = (
        await sql<{ allowed: boolean }>`SELECT current_user=pg_get_userbyid(relowner)
        AND session_user=pg_get_userbyid(relowner) AS allowed FROM pg_class WHERE oid='platform.audit_logs'::regclass`.execute(
          tx,
        )
      ).rows[0];
      if (owner?.allowed !== true) denied();
      const current = (
        await sql<{
          id: string;
          version: number | null;
        }>`SELECT id,platform.free_credit_test_mode_version(id) AS version
        FROM platform.audit_logs WHERE event_type=${EVENT} ORDER BY ((metadata->>'version')::integer) DESC LIMIT 1`.execute(
          tx,
        )
      ).rows[0];
      if (current && current.version === null) denied();
      const prior = await tx
        .selectFrom('platform.audit_logs')
        .selectAll()
        .where('id', '=', c.requestId)
        .executeTakeFirst();
      if (prior) {
        const version = (
          await sql<{
            version: number | null;
          }>`SELECT platform.free_credit_test_mode_version(${prior.id}::uuid) AS version`.execute(
            tx,
          )
        ).rows[0]?.version;
        if (
          version == null ||
          prior.metadata.operatorId !== this.operatorId ||
          prior.metadata.requestDigest !== digest
        )
          denied();
        return {
          modeId: prior.id,
          version,
          enabled: prior.result_code === 'enabled',
          replayed: true,
          latest: current?.id === prior.id,
        };
      }
      if ((current && current.version === null) || (current?.version ?? 0) !== c.expectedVersion)
        denied();
      const now = (
        await sql<{
          now: Date;
        }>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`.execute(tx)
      ).rows[0]!.now;
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id: c.requestId,
          category: 'security',
          event_type: EVENT,
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          subject_type: 'free_credit_test_mode',
          subject_id: '00000000-0000-4000-8000-000000000010',
          result_code: c.enabled ? 'enabled' : 'disabled',
          metadata_schema_version: 1,
          metadata: {
            operatorId: this.operatorId,
            sourceSha: c.sourceSha,
            environment: c.environment,
            telegramBotId: c.telegramBotId,
            version: c.expectedVersion + 1,
            cohortPolicyId: c.cohortPolicyId,
            expiresAt: c.expiresAt,
            requestDigest: digest,
          },
          request_id: c.requestId,
          command_id: c.requestId,
          occurred_at: now,
        })
        .execute();
      return {
        modeId: c.requestId,
        version: c.expectedVersion + 1,
        enabled: c.enabled,
        replayed: false,
        latest: true,
      };
    });
  }
}
