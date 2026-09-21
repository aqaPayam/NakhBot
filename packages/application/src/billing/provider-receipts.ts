export type ProviderEnvironment = 'local' | 'test' | 'staging' | 'production';

export type EncryptedProviderEvidence = Readonly<{
  digest: string;
  ciphertext: Uint8Array;
  keyId: string;
  schemaVersion: number;
}>;

export type TelegramPreCheckoutWrite = Readonly<{
  providerEventId: string;
  telegramUserId: string;
  invoicePayload: string;
  currency: string;
  totalAmount: bigint;
  providerEnvironment: ProviderEnvironment;
  providerBotIdDigest: string;
  evidence: EncryptedProviderEvidence;
}>;

export type TelegramPreCheckoutDecision = Readonly<{
  allowed: boolean;
  reasonCode?:
    | 'payment_unavailable'
    | 'payment_expired'
    | 'payer_mismatch'
    | 'currency_mismatch'
    | 'amount_mismatch'
    | 'provider_mismatch'
    | 'target_unavailable'
    | 'callback_conflict';
  replayed: boolean;
}>;

export type TelegramSuccessfulPaymentWrite = TelegramPreCheckoutWrite &
  Readonly<{
    telegramChargeId: string;
    providerChargeId?: string;
  }>;

export type TelegramPaymentReceiptResult = Readonly<{
  outcome: 'receipt_recorded' | 'replayed' | 'quarantined';
  paymentRecordId?: string;
  reasonCode?: 'payment_fact_mismatch' | 'callback_conflict' | 'charge_conflict';
}>;

export interface TelegramStarsReceiptStore {
  validatePreCheckout(write: TelegramPreCheckoutWrite): Promise<TelegramPreCheckoutDecision>;
  recordSuccessfulPayment(
    write: TelegramSuccessfulPaymentWrite,
  ): Promise<TelegramPaymentReceiptResult>;
}

/** Provider callback use case. A decision is returned only after its evidence is durable. */
export class ValidateTelegramPreCheckoutHandler {
  public constructor(private readonly store: TelegramStarsReceiptStore) {}

  public async execute(write: TelegramPreCheckoutWrite): Promise<TelegramPreCheckoutDecision> {
    return this.store.validatePreCheckout(write);
  }
}

/** Provider callback use case. The caller may acknowledge only after this method resolves. */
export class RecordTelegramSuccessfulPaymentHandler {
  public constructor(private readonly store: TelegramStarsReceiptStore) {}

  public async execute(
    write: TelegramSuccessfulPaymentWrite,
  ): Promise<TelegramPaymentReceiptResult> {
    return this.store.recordSuccessfulPayment(write);
  }
}
