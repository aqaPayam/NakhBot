import type {
  CreateFundingIntentCommand,
  CreateStarsInvoiceCommand,
  FundingIntentResult,
} from '@nakh/contracts';
import { ApplicationError, type IdGenerator } from '@nakh/domain';

export type ResolvedFundingTarget =
  | Readonly<{
      type: 'credit_package';
      packageCode: 'starter' | 'plus' | 'best_value' | 'ultimate';
    }>
  | Readonly<{ type: 'like'; targetId: string }>
  | Readonly<{ type: 'match'; targetId: string }>;

export type CreateFundingIntentWrite = Readonly<{
  intentId: string;
  userId: string;
  funding: 'credits' | 'stars';
  target: ResolvedFundingTarget;
  idempotencyKey: string;
}>;

export type StoredFundingIntent = Readonly<{
  id: string;
  funding: 'credits' | 'stars';
  requiredAmount: bigint;
  expiresAt: Date;
  replayed: boolean;
}>;

export type ProtectedInvoicePayload = Readonly<{
  cleartext: string;
  digest: string;
  ciphertext: Uint8Array;
  keyId: string;
}>;

export type PrepareStarsAttemptWrite = Readonly<{
  paymentRecordId: string;
  fundingIntentId: string;
  expectedVersion: number;
  userId: string;
  idempotencyKey: string;
  providerEnvironment: 'local' | 'test' | 'staging' | 'production';
  providerBotIdDigest: string;
  payload: ProtectedInvoicePayload;
}>;

export type StoredStarsAttempt = Readonly<{
  paymentRecordId: string;
  starsAmount: bigint;
  expiresAt: Date;
  payloadCiphertext: Uint8Array;
  payloadKeyId: string;
  replayed: boolean;
}>;

export type PreparedStarsInvoice = Readonly<{
  paymentRecordId: string;
  currency: 'XTR';
  starsAmount: bigint;
  invoicePayload: string;
  expiresAt: Date;
  replayed: boolean;
}>;

export interface PaidActionReferenceResolver {
  resolveLikedByAction(token: string, userId: string): Promise<string | undefined>;
  resolveChatUnlockAction(token: string, userId: string): Promise<string | undefined>;
}

export interface InvoicePayloadProtector {
  issue(): ProtectedInvoicePayload;
  reveal(ciphertext: Uint8Array, keyId: string): string;
}

export interface BillingFundingStore {
  createFundingIntent(write: CreateFundingIntentWrite): Promise<StoredFundingIntent>;
  prepareStarsAttempt(write: PrepareStarsAttemptWrite): Promise<StoredStarsAttempt>;
}

export class CreateFundingIntentHandler {
  public constructor(
    private readonly store: BillingFundingStore,
    private readonly references: PaidActionReferenceResolver,
    private readonly ids: IdGenerator,
  ) {}

  public async execute(command: CreateFundingIntentCommand): Promise<FundingIntentResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const target = await this.resolveTarget(command);
    const intent = await this.store.createFundingIntent({
      intentId: this.ids.uuid(),
      userId: command.actor.userId,
      funding: command.data.funding,
      target,
      idempotencyKey: command.idempotencyKey,
    });
    return {
      fundingIntentId: intent.id,
      funding: intent.funding,
      requiredAmount: intent.requiredAmount.toString(),
      status: 'pending',
      expiresAt: intent.expiresAt.toISOString(),
      replayed: intent.replayed,
    };
  }

  private async resolveTarget(command: CreateFundingIntentCommand): Promise<ResolvedFundingTarget> {
    const target = command.data.target;
    if (target.type === 'credit_package')
      return { type: 'credit_package', packageCode: target.packageCode };
    const targetId =
      target.type === 'liked_by_profile_unlock'
        ? await this.references.resolveLikedByAction(target.actionToken, command.actor.userId)
        : await this.references.resolveChatUnlockAction(target.actionToken, command.actor.userId);
    if (targetId === undefined)
      throw new ApplicationError('unlock_unavailable', 'error.billing.unlock_unavailable', 409);
    return { type: target.type === 'liked_by_profile_unlock' ? 'like' : 'match', targetId };
  }
}

export class PrepareStarsInvoiceHandler {
  public constructor(
    private readonly store: BillingFundingStore,
    private readonly payloads: InvoicePayloadProtector,
    private readonly ids: IdGenerator,
    private readonly providerEnvironment: 'local' | 'test' | 'staging' | 'production',
    private readonly providerBotIdDigest: string,
  ) {
    if (!/^[a-f0-9]{64}$/u.test(providerBotIdDigest))
      throw new Error('Provider bot identity digest is invalid.');
  }

  public async execute(command: CreateStarsInvoiceCommand): Promise<PreparedStarsInvoice> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const issued = this.payloads.issue();
    const attempt = await this.store.prepareStarsAttempt({
      paymentRecordId: this.ids.uuid(),
      fundingIntentId: command.data.fundingIntentId,
      expectedVersion: command.data.expectedVersion,
      userId: command.actor.userId,
      idempotencyKey: command.idempotencyKey,
      providerEnvironment: this.providerEnvironment,
      providerBotIdDigest: this.providerBotIdDigest,
      payload: issued,
    });
    return {
      paymentRecordId: attempt.paymentRecordId,
      currency: 'XTR',
      starsAmount: attempt.starsAmount,
      invoicePayload: attempt.replayed
        ? this.payloads.reveal(attempt.payloadCiphertext, attempt.payloadKeyId)
        : issued.cleartext,
      expiresAt: attempt.expiresAt,
      replayed: attempt.replayed,
    };
  }
}
