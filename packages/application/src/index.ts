import type {
  CreateSampleEffectCommand,
  CreateSampleEffectResult,
  DomainEvent,
} from '@nakh/contracts';
import type { Clock, IdGenerator } from '@nakh/domain';

export type CreateSampleEffectWrite = Readonly<{
  command: CreateSampleEffectCommand;
  effectId: string;
  eventId: string;
  createdAt: Date;
}>;

export interface FoundationStore {
  createSampleEffect(write: CreateSampleEffectWrite): Promise<CreateSampleEffectResult>;
}

export class CreateSampleEffectHandler {
  public constructor(
    private readonly store: FoundationStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(command: CreateSampleEffectCommand): Promise<CreateSampleEffectResult> {
    return this.store.createSampleEffect({
      command,
      effectId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      createdAt: this.clock.now(),
    });
  }
}

export interface OutboxPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export interface TelegramClientPort {
  sendText(
    input: Readonly<{ deliveryId: string; telegramUserId: string; text: string }>,
  ): Promise<void>;
}

export interface PaymentProviderPort {
  createInvoice(
    input: Readonly<{ paymentId: string; stars: number; payload: string }>,
  ): Promise<Readonly<{ invoiceUrl: string }>>;
  refund(input: Readonly<{ refundId: string; chargeId: string }>): Promise<void>;
}

export interface MediaStorePort {
  put(input: Readonly<{ key: string; body: Uint8Array; contentType: string }>): Promise<void>;
  delete(input: Readonly<{ key: string }>): Promise<void>;
  exists(input: Readonly<{ key: string }>): Promise<boolean>;
}

export type LocalizedIntent = Readonly<{
  key: string;
  variables: Readonly<Record<string, string | number | boolean>>;
  fallbackKey?: string;
}>;
