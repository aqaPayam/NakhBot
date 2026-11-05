import { randomUUID } from 'node:crypto';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import {
  PostgresCreditLedgerStore,
  trialCreditCandidates,
  type NakhDatabase,
} from '@nakh/persistence-postgres';

/** Free, noncash credits only for a native operator-delegated staging invitation.
 * Eligibility and original life are checked again under the ledger's locks. */
export function createTrialCreditRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    financialDatabase: NakhDatabase;
  }>,
): { process: () => Promise<void> } | undefined {
  if (
    input.config.environment !== 'staging' ||
    !input.config.telegram.notificationDeliveryEnabled ||
    !input.config.telegram.chatEnabled
  )
    return undefined;
  const match = /^([1-9][0-9]{0,15}):[A-Za-z0-9_-]{20,}$/u.exec(
    resolveSecretReference(input.config.telegram.botTokenRef),
  );
  if (match === null) throw Error('Private trial credit composition unavailable.');
  const audience = {
    sourceSha: input.config.release,
    environment: 'staging' as const,
    telegramBotId: match[1]!,
  };
  const ledger = new PostgresCreditLedgerStore(input.financialDatabase);
  let busy = false;
  return {
    process: async () => {
      if (busy) return;
      busy = true;
      try {
        const candidates = (await trialCreditCandidates(audience).execute(input.database)).rows;
        if (candidates.length === 0) return;
        const key = (claim: (typeof candidates)[number]): string =>
          `private-trial-initial:${claim.userId}:${claim.productEpoch}`;
        const existing = await input.financialDatabase
          .selectFrom('billing.credit_transactions')
          .select('idempotency_key')
          .where('idempotency_key', 'in', candidates.map(key))
          .execute();
        const issued = new Set(existing.map((row) => row.idempotency_key));
        for (const claim of candidates) {
          if (issued.has(key(claim))) continue;
          await ledger.append({
            transactionId: randomUUID(),
            userId: claim.userId,
            transactionType: 'admin_adjustment',
            amount: 100n,
            idempotencyKey: key(claim),
            correlationId: claim.claimId,
            expectedProductEpoch: claim.productEpoch,
            trialClaim: { id: claim.claimId, audience },
          });
        }
      } finally {
        busy = false;
      }
    },
  };
}
