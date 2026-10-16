import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type {
  AccountControlActor,
  AccountDeletionLease,
  AdminCommandAttempt,
} from '@nakh/application';
import type { NakhDatabase } from '../database.js';
import { createFinalDeletionFixture } from './final-deletion-fixture.js';
import { createReportFixtureAdmin } from './report-fixture.js';
import { PostgresAccountDeletionEphemeralStore } from '../account-deletion-ephemeral-store.js';
import { PostgresAccountReturnApprovalWorkflow } from '../account-return-approval-store.js';
import { PostgresAccountControlSessionStore } from '../account-control-session-store.js';
import { createPostgresAdminSessions } from '../admin-session-store.js';

/** Full native deletion and separate approval. Provider/factor observations are
 * synthetic fixtures; no real Redis absence, operator drain or external MFA is claimed. */
export async function createAccountReturnFixture(
  database: NakhDatabase,
  options: {
    approve?: boolean;
    banned?: boolean;
    controlLifetimeSeconds?: number;
    beforeDeletion?: (userId: string) => Promise<void>;
    beforeEvidenceCheckpoint?: (lease: AccountDeletionLease) => Promise<void>;
  } = {},
): Promise<{
  userId: string;
  recordId: string;
  version: number;
  control: AccountControlActor;
}> {
  const item = await createFinalDeletionFixture(
    database,
    async (userId) => {
      await sql`UPDATE identity.guest_preview_counters SET preview_count=3,first_preview_at=clock_timestamp(),last_preview_at=clock_timestamp() WHERE user_id=${userId}::uuid`.execute(
        database,
      );
      if (options.banned)
        await sql`UPDATE identity.accounts SET state='banned',version=version+1 WHERE user_id=${userId}::uuid`.execute(
          database,
        );
      await options.beforeDeletion?.(userId);
    },
    undefined,
    options.beforeEvidenceCheckpoint,
  );
  const ephemeral = new PostgresAccountDeletionEphemeralStore(
    database,
    'm8-native-final',
    'a'.repeat(64),
  );
  await ephemeral.finish(item.lease);
  for (let n = 0; n < 6; n++) {
    const op = (await ephemeral.claimNext(item.lease)).operation!;
    await ephemeral.complete(item.lease, op.id, {
      cursor: op.stage.startsWith('queue_') ? { redisCursor: '0', pendingKeys: [] } : '0',
      more: false,
      found: 0,
    });
  }
  if (!(await ephemeral.finish(item.lease)).completed)
    throw new Error('Return fixture deletion incomplete.');
  const account = await database
    .selectFrom('identity.accounts')
    .select('version')
    .where('user_id', '=', item.userId)
    .executeTakeFirstOrThrow();
  const grant = await new PostgresAccountControlSessionStore(
    database,
    options.controlLifetimeSeconds ?? 900,
  ).issue({ userId: item.userId, productEpoch: 0 }, randomUUID());
  if (grant === undefined) throw new Error('Return fixture control unavailable.');
  if (options.approve !== false)
    await approveAccountReturnFixture(database, {
      recordId: item.recordId,
      version: account.version,
    });
  return {
    ...item,
    version: account.version,
    control: {
      kind: 'user',
      scope: 'account_control',
      userId: item.userId,
      productEpoch: 0,
      controlGrantId: grant.id,
    },
  };
}

/** Native audit/RBAC/MFA fixture only; the protected-factor provider is synthetic. */
export async function approveAccountReturnFixture(
  database: NakhDatabase,
  input: Readonly<{ recordId: string; version: number }>,
): Promise<void> {
  const id = await createReportFixtureAdmin(database);
  await database
    .insertInto('administration.admin_user_roles')
    .values({
      admin_user_id: id,
      role_code: 'super_admin',
      assigned_by_admin_id: id,
      revoked_at: null,
      revoked_by_admin_id: null,
    })
    .execute();
  const admin = await database
    .selectFrom('administration.admin_users')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  await createPostgresAdminSessions(database, {
    verify: () =>
      Promise.resolve({
        actorUserId: admin.user_id,
        telegramUserId: admin.telegram_user_id,
        proofId: randomUUID(),
        verifiedAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 240000),
      }),
  }).issue({
    actor: { kind: 'user', userId: admin.user_id },
    telegramUserId: admin.telegram_user_id,
    requestId: randomUUID(),
    proof: 'synthetic-protected-factor',
  });
  const attempt: AdminCommandAttempt = {
    logId: randomUUID(),
    adminUserId: id,
    commandId: randomUUID(),
    requestId: randomUUID(),
    requestDigest: 'b'.repeat(64),
    commandCode: 'account.approve-return',
    requiredPermission: 'approve_account_return',
    targetType: 'account_deletion',
    targetId: input.recordId,
    expectedTargetVersion: input.version,
    reasonDigest: 'c'.repeat(64),
    metadata: {},
    correlationId: randomUUID(),
  };
  if (
    (await new PostgresAccountReturnApprovalWorkflow(database).approve(attempt)).result !==
    'succeeded'
  )
    throw new Error('Return fixture approval rejected.');
}
