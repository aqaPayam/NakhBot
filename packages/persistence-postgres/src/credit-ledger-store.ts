import { ApplicationError, calculateCreditBalance, type CreditTransactionType } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

export type CreditTransactionReference = Readonly<{
  paymentRecordId?: string;
  pendingPaymentId?: string;
  featureUnlockId?: string;
  nakhId?: string;
}>;

export type AppendCreditTransactionInput = Readonly<{
  transactionId: string;
  userId: string;
  transactionType: CreditTransactionType;
  amount: bigint;
  idempotencyKey: string;
  correlationId: string;
  reference?: CreditTransactionReference;
}>;

export type CreditTransactionResult = Readonly<{
  transactionId: string;
  userId: string;
  transactionType: CreditTransactionType;
  amount: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  accountVersion: number;
  createdAt: Date;
  replayed: boolean;
}>;

export type CreditPackageRecord = Readonly<{
  id: string;
  code: 'starter' | 'plus' | 'best_value' | 'ultimate';
  titleKey: string;
  credits: bigint;
  stars: bigint;
  badgeKey?: string;
  displayOrder: number;
}>;

function sameReference(
  row: Readonly<{
    payment_record_id: string | null;
    pending_payment_id: string | null;
    feature_unlock_id: string | null;
    nakh_id: string | null;
  }>,
  reference: CreditTransactionReference | undefined,
): boolean {
  return (
    row.payment_record_id === (reference?.paymentRecordId ?? null) &&
    row.pending_payment_id === (reference?.pendingPaymentId ?? null) &&
    row.feature_unlock_id === (reference?.featureUnlockId ?? null) &&
    row.nakh_id === (reference?.nakhId ?? null)
  );
}

export class PostgresCreditLedgerStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async getBalance(userId: string): Promise<Readonly<{ balance: bigint; version: number }>> {
    const row = await this.database
      .selectFrom('billing.credit_accounts')
      .select(['balance', 'version'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined)
      throw new ApplicationError('not_found', 'error.billing.credit_account_not_found', 404);
    return { balance: BigInt(row.balance), version: row.version };
  }

  public async getActivePackages(): Promise<readonly CreditPackageRecord[]> {
    const rows = await this.database
      .selectFrom('billing.credit_packages')
      .selectAll()
      .where('is_active', '=', true)
      .orderBy('display_order', 'asc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      titleKey: row.title_key,
      credits: BigInt(row.credit_amount),
      stars: BigInt(row.stars_price),
      ...(row.badge_key === null ? {} : { badgeKey: row.badge_key }),
      displayOrder: row.display_order,
    }));
  }

  public async append(input: AppendCreditTransactionInput): Promise<CreditTransactionResult> {
    return this.database.transaction().execute(async (transaction) => {
      const account = await transaction
        .selectFrom('billing.credit_accounts')
        .select(['balance', 'version'])
        .where('user_id', '=', input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (account === undefined)
        throw new ApplicationError('not_found', 'error.billing.credit_account_not_found', 404);

      const existing = await transaction
        .selectFrom('billing.credit_transactions')
        .selectAll()
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (
          existing.user_id !== input.userId ||
          existing.transaction_type !== input.transactionType ||
          BigInt(existing.amount) !== input.amount ||
          !sameReference(existing, input.reference)
        )
          throw new ApplicationError(
            'idempotency_conflict',
            'error.billing.idempotency_conflict',
            409,
          );
        return {
          transactionId: existing.id,
          userId: existing.user_id,
          transactionType: existing.transaction_type,
          amount: BigInt(existing.amount),
          balanceBefore: BigInt(existing.balance_before),
          balanceAfter: BigInt(existing.balance_after),
          accountVersion: existing.account_version,
          createdAt: existing.created_at,
          replayed: true,
        };
      }

      const balanceBefore = BigInt(account.balance);
      const balanceAfter = calculateCreditBalance({
        transactionType: input.transactionType,
        balanceBefore,
        amount: input.amount,
      });
      const accountVersion = account.version + 1;
      const inserted = await transaction
        .insertInto('billing.credit_transactions')
        .values({
          id: input.transactionId,
          credit_account_id: input.userId,
          user_id: input.userId,
          account_version: accountVersion,
          transaction_type: input.transactionType,
          amount: input.amount.toString(),
          balance_before: balanceBefore.toString(),
          balance_after: balanceAfter.toString(),
          payment_record_id: input.reference?.paymentRecordId ?? null,
          pending_payment_id: input.reference?.pendingPaymentId ?? null,
          feature_unlock_id: input.reference?.featureUnlockId ?? null,
          nakh_id: input.reference?.nakhId ?? null,
          idempotency_key: input.idempotencyKey,
          correlation_id: input.correlationId,
        })
        .returning('created_at')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('billing.credit_accounts')
        .set({
          balance: balanceAfter.toString(),
          version: accountVersion,
          updated_at: inserted.created_at,
        })
        .where('user_id', '=', input.userId)
        .where('version', '=', account.version)
        .executeTakeFirstOrThrow();

      return {
        transactionId: input.transactionId,
        userId: input.userId,
        transactionType: input.transactionType,
        amount: input.amount,
        balanceBefore,
        balanceAfter,
        accountVersion,
        createdAt: inserted.created_at,
        replayed: false,
      };
    });
  }
}
