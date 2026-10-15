import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { ApplicationError } from '@nakh/domain';
import {
  AccountControlSessionService,
  isAccountControlLife,
  type AccountControlLife,
  type AccountControlGrant,
  type AccountControlSessionStore,
  type AccountControlActor,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';

const ISSUED = 'identity.account-control-issued.v1',
  REVOKED = 'identity.account-control-revoked.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_LIFETIME_MS = 15 * 60 * 1000;
type GrantRow = { id: string; userId: string; issuedAt: Date; metadata: unknown; now: Date };
function grant(
  row: GrantRow | undefined,
  life: AccountControlLife,
): AccountControlGrant | undefined {
  if (
    row === undefined ||
    row.userId !== life.userId ||
    typeof row.metadata !== 'object' ||
    row.metadata === null ||
    Array.isArray(row.metadata)
  )
    return undefined;
  const metadata = row.metadata as Readonly<Record<string, unknown>>;
  if (
    Object.keys(metadata).length !== 2 ||
    metadata.productEpoch !== life.productEpoch ||
    typeof metadata.expiresAt !== 'string'
  )
    return undefined;
  const expiresAt = new Date(metadata.expiresAt);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.toISOString() !== metadata.expiresAt ||
    !(row.issuedAt instanceof Date) ||
    expiresAt.getTime() - row.issuedAt.getTime() < 1000 ||
    expiresAt.getTime() - row.issuedAt.getTime() > MAX_LIFETIME_MS ||
    (expiresAt.getTime() - row.issuedAt.getTime()) % 1000 !== 0
  )
    return undefined;
  return {
    id: row.id,
    userId: row.userId,
    productEpoch: life.productEpoch,
    issuedAt: row.issuedAt,
    expiresAt,
  };
}
function unauthorized(): ApplicationError {
  return new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
}
async function lockLife(
  database: NakhDatabase,
  life: AccountControlLife,
  allowDeleted: boolean,
): Promise<boolean> {
  if (!isAccountControlLife(life)) return false;
  await database
    .selectFrom('identity.users')
    .select('id')
    .where('id', '=', life.userId)
    .forNoKeyUpdate()
    .execute();
  const account = await database
    .selectFrom('identity.accounts')
    .select(['state', 'product_epoch'])
    .where('user_id', '=', life.userId)
    .forUpdate()
    .executeTakeFirst();
  return (
    account !== undefined &&
    account.product_epoch === life.productEpoch &&
    (allowDeleted || account.state !== 'deleted')
  );
}
async function revoked(
  database: NakhDatabase,
  life: AccountControlLife,
  grantId: string,
): Promise<boolean> {
  return (
    await sql<{ revoked: boolean }>`SELECT EXISTS(SELECT 1 FROM platform.audit_logs
    WHERE id=${grantId}::uuid AND actor_user_id=${life.userId}::uuid
      AND identity.account_control_authority_revoked(id)) AS revoked`.execute(database)
  ).rows[0]!.revoked;
}
/** Limited account-control grants intentionally survive tombstone in the same
 * product epoch; their distinct tag cannot authenticate any product session.
 * Security grants are canonical append-only audit facts. No bearer or token hash
 * is stored. Revocation facts and native Account state/epoch independently fence use. */
export class PostgresAccountControlSessionStore implements AccountControlSessionStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly lifetimeSeconds = 900,
  ) {
    if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 900)
      throw new Error('Account control lifetime invalid.');
  }
  public async issue(
    life: AccountControlLife,
    requestId: string,
  ): Promise<AccountControlGrant | undefined> {
    if (!isAccountControlLife(life) || !UUID.test(requestId)) return undefined;
    return this.database.transaction().execute(async (tx) => {
      if (!(await lockLife(tx, life, true))) return undefined;
      const existing =
        await sql<GrantRow>`SELECT id,actor_user_id AS "userId",occurred_at AS "issuedAt",
        metadata,clock_timestamp() AS now FROM platform.audit_logs
        WHERE category='security' AND event_type=${ISSUED} AND actor_type='user'
          AND actor_user_id=${life.userId}::uuid AND actor_admin_id IS NULL
          AND subject_type='account_control' AND subject_id=id AND result_code='issued'
          AND metadata_schema_version=1 AND command_id=${requestId}::uuid AND request_id=${requestId}::uuid
`.execute(tx);
      if (existing.rows.length > 0) {
        if (existing.rows.length !== 1) throw unauthorized();
        const previous = grant(existing.rows[0], life);
        if (
          previous === undefined ||
          previous.issuedAt > existing.rows[0]!.now ||
          previous.expiresAt <= existing.rows[0]!.now ||
          (await revoked(tx, life, previous.id))
        )
          return undefined;
        return previous;
      }
      const at = (
        await sql<{ at: Date }>`SELECT date_trunc('milliseconds',clock_timestamp()) AS at`.execute(
          tx,
        )
      ).rows[0]!.at;
      const id = randomUUID(),
        expiresAt = new Date(at.getTime() + this.lifetimeSeconds * 1000);
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id,
          category: 'security',
          event_type: ISSUED,
          actor_type: 'user',
          actor_user_id: life.userId,
          actor_admin_id: null,
          subject_type: 'account_control',
          subject_id: id,
          result_code: 'issued',
          metadata_schema_version: 1,
          metadata: { productEpoch: life.productEpoch, expiresAt: expiresAt.toISOString() },
          request_id: requestId,
          command_id: requestId,
          occurred_at: at,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { id, ...life, issuedAt: at, expiresAt };
    });
  }
  public async current(
    life: AccountControlLife,
    grantId: string,
  ): Promise<AccountControlGrant | undefined> {
    if (!isAccountControlLife(life) || !UUID.test(grantId)) return undefined;
    const row = (
      await sql<GrantRow>`SELECT issued.id,issued.actor_user_id AS "userId",issued.occurred_at AS "issuedAt",
      issued.metadata,clock_timestamp() AS now FROM platform.audit_logs issued
      JOIN identity.accounts account ON account.user_id=issued.actor_user_id
      WHERE issued.id=${grantId}::uuid AND issued.category='security' AND issued.event_type=${ISSUED}
        AND issued.actor_type='user' AND issued.actor_user_id=${life.userId}::uuid AND issued.actor_admin_id IS NULL
        AND issued.subject_type='account_control' AND issued.subject_id=issued.id AND issued.result_code='issued'
        AND issued.metadata_schema_version=1 AND account.product_epoch=${life.productEpoch}
        AND identity.account_control_epoch(issued.id)=${life.productEpoch}
        AND NOT identity.account_control_authority_revoked(issued.id)`.execute(this.database)
    ).rows[0];
    const current = grant(row, life);
    return row !== undefined &&
      current !== undefined &&
      current.issuedAt <= row.now &&
      current.expiresAt > row.now
      ? current
      : undefined;
  }
  public async findForReturn(
    userId: string,
    grantId: string,
  ): Promise<AccountControlGrant | undefined> {
    if (!UUID.test(userId) || !UUID.test(grantId)) return undefined;
    const row = (
      await sql<{ epoch: number | null }>`SELECT identity.account_control_epoch(id) AS epoch
      FROM platform.audit_logs WHERE id=${grantId}::uuid AND actor_user_id=${userId}::uuid`.execute(
        this.database,
      )
    ).rows[0];
    if (row?.epoch === null || row?.epoch === undefined) return undefined;
    return this.currentForReturn({ userId, productEpoch: row.epoch }, grantId);
  }
  public async currentForReturn(
    life: AccountControlLife,
    grantId: string,
  ): Promise<AccountControlGrant | undefined> {
    if (!isAccountControlLife(life) || life.productEpoch >= 2147483647 || !UUID.test(grantId))
      return undefined;
    const row = (
      await sql<GrantRow>`SELECT issued.id,issued.actor_user_id AS "userId",
      issued.occurred_at AS "issuedAt",issued.metadata,clock_timestamp() AS now
      FROM platform.audit_logs issued JOIN identity.accounts account ON account.user_id=issued.actor_user_id
      WHERE issued.id=${grantId}::uuid AND issued.actor_user_id=${life.userId}::uuid
        AND identity.account_return_grant_valid(issued.id,${life.userId}::uuid,${life.productEpoch}::integer,clock_timestamp(),true)
        AND ((account.product_epoch=${life.productEpoch} AND account.state='deleted')
          OR (account.product_epoch=${life.productEpoch + 1} AND account.state<>'deleted' AND EXISTS (
            SELECT 1 FROM platform.audit_logs returned WHERE returned.event_type='account.returned.v1'
              AND returned.actor_user_id=${life.userId}::uuid AND returned.metadata->>'controlGrantId'=${grantId}
              AND returned.metadata->'fromEpoch'=to_jsonb(${life.productEpoch}::integer)
              AND returned.metadata->'toEpoch'=to_jsonb(${life.productEpoch + 1}::integer)
              AND identity.account_return_proof_valid(returned,true)
              AND account.version>=(returned.metadata->>'toVersion')::integer
          )))`.execute(this.database)
    ).rows[0];
    const current = grant(row, life);
    return row !== undefined &&
      current !== undefined &&
      current.issuedAt <= row.now &&
      current.expiresAt > row.now
      ? current
      : undefined;
  }
  public async revoke(life: AccountControlLife, grantId: string, requestId: string): Promise<void> {
    if (!isAccountControlLife(life) || !UUID.test(grantId) || !UUID.test(requestId))
      throw unauthorized();
    await this.database.transaction().execute(async (tx) => {
      if (!(await lockLife(tx, life, true))) throw unauthorized();
      const row = (
        await sql<GrantRow>`SELECT id,actor_user_id AS "userId",occurred_at AS "issuedAt",metadata,clock_timestamp() AS now
        FROM platform.audit_logs WHERE id=${grantId}::uuid AND category='security' AND event_type=${ISSUED}
          AND actor_type='user' AND actor_user_id=${life.userId}::uuid AND actor_admin_id IS NULL
          AND subject_type='account_control' AND subject_id=id AND result_code='issued' AND metadata_schema_version=1`.execute(
          tx,
        )
      ).rows[0];
      if (grant(row, life) === undefined) throw unauthorized();
      if (await revoked(tx, life, grantId)) return;
      const at = (
        await sql<{ at: Date }>`SELECT date_trunc('milliseconds',clock_timestamp()) AS at`.execute(
          tx,
        )
      ).rows[0]!.at;
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id: randomUUID(),
          category: 'security',
          event_type: REVOKED,
          actor_type: 'user',
          actor_user_id: life.userId,
          actor_admin_id: null,
          subject_type: 'account_control',
          subject_id: grantId,
          result_code: 'revoked',
          metadata_schema_version: 1,
          metadata: {},
          request_id: requestId,
          command_id: requestId,
          occurred_at: at,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    });
  }
}
export function createPostgresAccountControls(
  database: NakhDatabase,
  key: Uint8Array,
): AccountControlSessionService {
  return new AccountControlSessionService(new PostgresAccountControlSessionStore(database), key);
}

/** Bind limited account-control authority to this transaction and its commit fences. */
export async function requireCurrentAccountControl(
  transaction: NakhDatabase,
  actorUserId: string,
  session: AccountControlActor,
): Promise<void> {
  if (
    session.kind !== 'user' ||
    session.scope !== 'account_control' ||
    session.userId !== actorUserId ||
    !(await lockLife(transaction, session, true)) ||
    (await new PostgresAccountControlSessionStore(transaction).current(
      session,
      session.controlGrantId,
    )) === undefined
  )
    throw unauthorized();
  await sql`SELECT set_config('nakh.account_control_grant',${session.controlGrantId},true)`.execute(
    transaction,
  );
}
