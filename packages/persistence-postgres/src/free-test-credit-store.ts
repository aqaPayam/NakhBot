import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type {
  FreeTestCreditStore,
  FreeTestCreditWrite,
  FreeTestCreditResult,
  UserSessionActor,
} from '@nakh/application';
import { ApplicationError, calculateCreditBalance, FREE_TEST_TOPUP_CREDITS } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { captureLaunchAudience, type LaunchAudience } from './launch-cohort-store.js';
import { requireCurrentUserSession } from './user-session-store.js';

function unavailable(): never {
  throw new ApplicationError('capability_denied', 'account.credits.unavailable', 403);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Only this original native life may read or refill its credit account. */
export class PostgresFreeTestCreditStore implements FreeTestCreditStore {
  private readonly owner: UserSessionActor;
  private readonly audience: LaunchAudience | undefined;
  public constructor(
    private readonly database: NakhDatabase,
    owner: UserSessionActor,
    audience?: LaunchAudience,
  ) {
    this.owner = Object.freeze({ ...owner });
    this.audience = audience === undefined ? undefined : captureLaunchAudience(audience);
    if (
      (this.audience !== undefined && this.audience.environment !== 'staging') ||
      owner.kind !== 'user' ||
      !UUID.test(owner.userId) ||
      !UUID.test(owner.sessionGrantId) ||
      !Number.isSafeInteger(owner.productEpoch) ||
      owner.productEpoch < 0
    )
      unavailable();
  }
  private async mode(tx: NakhDatabase): Promise<string | undefined> {
    const a = this.audience,
      o = this.owner;
    if (a === undefined) return undefined;
    return (
      (
        await sql<{
          id: string | null;
        }>`SELECT platform.current_free_credit_test_mode(${o.userId}::uuid,
      ${o.productEpoch},${a.sourceSha},${a.telegramBotId}) AS id`.execute(tx)
      ).rows[0]?.id ?? undefined
    );
  }
  public async state(): Promise<Readonly<{ balance: string; version: number; enabled: boolean }>> {
    return this.database.transaction().execute(async (tx) => {
      if (this.audience !== undefined)
        await sql`SELECT pg_advisory_xact_lock(hashtext('nakh-launch-cohort'))`.execute(tx);
      await requireCurrentUserSession(tx, this.owner.userId, this.owner);
      const identity = await tx
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', this.owner.userId)
        .executeTakeFirst();
      if (!identity || !['active', 'restricted'].includes(identity.state)) unavailable();
      const row = await tx
        .selectFrom('billing.credit_accounts')
        .select(['balance', 'version', 'product_epoch'])
        .where('user_id', '=', this.owner.userId)
        .executeTakeFirst();
      if (!row || row.product_epoch !== this.owner.productEpoch) unavailable();
      return {
        balance: row.balance,
        version: row.version,
        enabled: (await this.mode(tx)) !== undefined,
      };
    });
  }
  public async grant(input: FreeTestCreditWrite): Promise<FreeTestCreditResult> {
    const write = structuredClone(input),
      command = write.command;
    if (this.audience === undefined) unavailable();
    if (
      command.actor.kind !== 'user' ||
      command.actor.userId !== this.owner.userId ||
      command.commandType !== 'billing.grant-free-test-credits' ||
      command.schemaVersion !== 1 ||
      command.data === null ||
      typeof command.data !== 'object' ||
      Array.isArray(command.data) ||
      Object.keys(command.data).length !== 0 ||
      !UUID.test(command.commandId) ||
      !UUID.test(command.requestId) ||
      !UUID.test(write.transactionId) ||
      !UUID.test(write.eventId) ||
      typeof command.idempotencyKey !== 'string' ||
      command.idempotencyKey.length < 8 ||
      command.idempotencyKey.length > 128
    )
      unavailable();
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          userId: this.owner.userId,
          productEpoch: this.owner.productEpoch,
          sessionGrantId: this.owner.sessionGrantId,
          audience: this.audience,
          idempotencyKey: command.idempotencyKey,
          credits: '100',
        }),
      )
      .digest('hex');
    const key =
      'free-test-topup:' +
      createHash('sha256')
        .update(`${this.owner.userId}\0${this.owner.productEpoch}\0${command.idempotencyKey}`)
        .digest('hex');
    return this.database.transaction().execute(async (tx) => {
      // Same order as owner policy closure: cohort, original User/Account, ledger.
      await sql`SELECT pg_advisory_xact_lock(hashtext('nakh-launch-cohort'))`.execute(tx);
      await requireCurrentUserSession(tx, this.owner.userId, this.owner);
      const modeId = await this.mode(tx);
      if (modeId === undefined) unavailable();
      const account = await tx
        .selectFrom('billing.credit_accounts')
        .select(['balance', 'version', 'product_epoch'])
        .where('user_id', '=', this.owner.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!account || account.product_epoch !== this.owner.productEpoch) unavailable();
      const prior = await tx
        .selectFrom('billing.credit_transactions')
        .selectAll()
        .where('idempotency_key', '=', key)
        .executeTakeFirst();
      if (prior) {
        const audit = await tx
          .selectFrom('platform.audit_logs')
          .select('metadata')
          .where('id', '=', prior.id)
          .executeTakeFirst();
        const proof = (
          await sql<{
            valid: boolean;
          }>`SELECT billing.free_test_topup_proof(${prior.id}::uuid) AS valid`.execute(tx)
        ).rows[0]?.valid;
        if (
          prior.user_id !== this.owner.userId ||
          prior.product_epoch !== this.owner.productEpoch ||
          audit?.metadata.requestDigest !== digest ||
          !proof
        )
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        return { transactionId: prior.id, balanceAfter: prior.balance_after, replayed: true };
      }
      const recent = (
        await sql<{ count: string }>`SELECT count(*)::text AS count FROM (
        SELECT id FROM billing.credit_transactions WHERE user_id=${this.owner.userId}::uuid AND transaction_type='free_test_topup'
        AND created_at>clock_timestamp()-interval '1 minute' LIMIT 10) recent`.execute(tx)
      ).rows[0]!;
      if (Number(recent.count) >= 10)
        throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429);
      const now = (
        await sql<{
          now: Date;
        }>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`.execute(tx)
      ).rows[0]!.now;
      const balance = calculateCreditBalance({
        transactionType: 'free_test_topup',
        balanceBefore: BigInt(account.balance),
        amount: FREE_TEST_TOPUP_CREDITS,
      }).toString();
      await tx
        .insertInto('billing.credit_transactions')
        .values({
          id: write.transactionId,
          user_id: this.owner.userId,
          product_epoch: this.owner.productEpoch,
          credit_account_id: this.owner.userId,
          account_version: account.version + 1,
          transaction_type: 'free_test_topup',
          amount: '100',
          balance_before: account.balance,
          balance_after: balance,
          payment_record_id: null,
          pending_payment_id: null,
          feature_unlock_id: null,
          nakh_id: null,
          idempotency_key: key,
          correlation_id: command.requestId,
          created_at: now,
        })
        .execute();
      await tx
        .updateTable('billing.credit_accounts')
        .set({ balance, version: account.version + 1, updated_at: now })
        .where('user_id', '=', this.owner.userId)
        .where('version', '=', account.version)
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id: write.transactionId,
          category: 'product',
          event_type: 'billing.free-test-topup-granted.v1',
          actor_type: 'user',
          actor_user_id: this.owner.userId,
          actor_admin_id: null,
          subject_type: 'credit_transaction',
          subject_id: write.transactionId,
          result_code: 'granted',
          metadata_schema_version: 1,
          metadata: {
            modeId,
            sessionGrantId: this.owner.sessionGrantId,
            productEpoch: this.owner.productEpoch,
            credits: '100',
            requestDigest: digest,
          },
          request_id: command.requestId,
          command_id: command.commandId,
          occurred_at: now,
        })
        .execute();
      await tx
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'credit_account',
          aggregate_id: this.owner.userId,
          event_type: 'billing.credit-increased.v1',
          schema_version: 1,
          payload: {
            creditTransactionId: write.transactionId,
            amount: '100',
            balanceAfter: balance,
          },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: command.requestId,
          causation_id: command.commandId,
        })
        .execute();
      return { transactionId: write.transactionId, balanceAfter: balance, replayed: false };
    });
  }
}
