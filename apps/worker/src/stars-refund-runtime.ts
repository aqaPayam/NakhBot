import { createHash } from 'node:crypto';
import {
  ProcessTelegramStarsRefundHandler,
  type ProcessStarsRefundResult,
  type StarsRefundProviderResult,
} from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import {
  PostgresRefundStore,
  PostgresStarsRefundAuthorityStore,
  TelegramStarsKeys,
  type NakhDatabase,
  type StarsRefundProviderAuthority,
} from '@nakh/persistence-postgres';

const unknownOutcome = (): StarsRefundProviderResult => ({
  outcome: 'ambiguous',
  errorCode: 'provider_outcome_unknown',
});

/** No provider exception or response text escapes this fixed, bounded boundary. */
export class TelegramStarsRefundClient {
  public readonly botIdDigest: string;
  public constructor(
    private readonly botToken: string,
    private readonly request: typeof fetch = fetch,
  ) {
    const match = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(botToken);
    if (match === null || !Number.isSafeInteger(Number(match[1])))
      throw new Error('Stars refund credentials unavailable.');
    this.botIdDigest = createHash('sha256').update(match[1]!).digest('hex');
  }
  public async refund(input: StarsRefundProviderAuthority): Promise<StarsRefundProviderResult> {
    const authority = { ...input };
    if (
      !/^[1-9][0-9]{0,19}$/u.test(authority.telegramUserId) ||
      !Number.isSafeInteger(Number(authority.telegramUserId)) ||
      !/^[\x21-\x7e]{1,256}$/u.test(authority.telegramChargeId)
    )
      return { outcome: 'retryable_not_sent', errorCode: 'refund_authority_unavailable' };
    try {
      const response = await this.request(
        `https://api.telegram.org/bot${this.botToken}/refundStarPayment`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            user_id: Number(authority.telegramUserId),
            telegram_payment_charge_id: authority.telegramChargeId,
          }),
        },
      );
      const length = response.headers.get('content-length');
      if (
        !response.ok ||
        (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > 16384)) ||
        response.body === null
      ) {
        await response.body?.cancel();
        return unknownOutcome();
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          const chunk: unknown = result.value;
          if (!(chunk instanceof Uint8Array)) {
            await reader.cancel();
            return unknownOutcome();
          }
          size += chunk.length;
          if (size > 16384) {
            await reader.cancel();
            return unknownOutcome();
          }
          chunks.push(chunk);
        }
      } finally {
        reader.releaseLock();
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return typeof body === 'object' &&
        body !== null &&
        !Array.isArray(body) &&
        (body as Record<string, unknown>).ok === true &&
        (body as Record<string, unknown>).result === true
        ? { outcome: 'succeeded' }
        : unknownOutcome();
    } catch {
      return unknownOutcome();
    }
  }
}

export type StarsRefundPollResult = ProcessStarsRefundResult | Readonly<{ outcome: 'idle' }>;
export type TelegramStarsRefundRuntime = Readonly<{
  verifyCustody: () => Promise<void>;
  processNext: () => Promise<StarsRefundPollResult>;
  close: () => Promise<void>;
}>;

/** Refunds remain independent of invoice/menu admission. Only this configured
 * bot/environment's original retained receipts can authorize provider calls. */
export function createTelegramStarsRefundRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    owner: string;
    resolveSecret?: (reference: string) => string;
  }>,
): TelegramStarsRefundRuntime | undefined {
  if (!input.config.telegram.starsRefundsEnabled) return undefined;
  const secret = input.resolveSecret ?? resolveSecretReference;
  const client = new TelegramStarsRefundClient(secret(input.config.telegram.botTokenRef));
  const keys = new TelegramStarsKeys(secret(input.config.telegram.starsKeyRingRef));
  const store = new PostgresRefundStore(input.database),
    authority = new PostgresStarsRefundAuthorityStore(input.database, keys);
  const provider = Object.freeze({
      environment: input.config.environment,
      botIdDigest: client.botIdDigest,
    }),
    owner = input.owner;
  let busy = false;
  let closing = false,
    settled = Promise.resolve();
  return Object.freeze({
    verifyCustody: () => keys.verifyCustody(input.database),
    close: async (): Promise<void> => {
      closing = true;
      await settled;
    },
    processNext: async (): Promise<StarsRefundPollResult> => {
      if (busy || closing) return { outcome: 'idle' };
      busy = true;
      let finish!: () => void;
      settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        const [claimed] = await store.claimStarsRefunds({
          owner,
          leaseMs: 300000,
          limit: 1,
          provider,
        });
        if (claimed === undefined) return { outcome: 'idle' };
        const claim = Object.freeze({ ...claimed });
        return await new ProcessTelegramStarsRefundHandler(store, {
          refund: async (request): Promise<StarsRefundProviderResult> => {
            // This phase has definitely made no provider call; custody/read
            // failure may safely return to not_started for a bounded retry.
            let original: StarsRefundProviderAuthority | undefined;
            try {
              if (
                request.refundRecordId !== claim.refundRecordId ||
                request.telegramChargeId !== claim.telegramChargeId ||
                request.starsAmount !== claim.starsAmount
              )
                return { outcome: 'retryable_not_sent', errorCode: 'refund_authority_unavailable' };
              original = await authority.resolve(claim, provider);
            } catch {
              return { outcome: 'retryable_not_sent', errorCode: 'refund_authority_unavailable' };
            }
            if (original === undefined)
              return { outcome: 'retryable_not_sent', errorCode: 'refund_authority_unavailable' };
            // After this boundary, every unknown outcome stays quarantined.
            return client.refund(original);
          },
        }).execute(claim);
      } finally {
        busy = false;
        finish();
      }
    },
  });
}
