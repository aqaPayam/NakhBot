import type { MediaStorePort, PaymentProviderPort, TelegramClientPort } from '@nakh/application';

export class FakeTelegramClient implements TelegramClientPort {
  public readonly sent: Array<
    Readonly<{ deliveryId: string; telegramUserId: string; text: string }>
  > = [];

  public sendText(
    input: Readonly<{ deliveryId: string; telegramUserId: string; text: string }>,
  ): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }
}

export class FakePaymentProvider implements PaymentProviderPort {
  public readonly invoices: Array<Readonly<{ paymentId: string; stars: number; payload: string }>> =
    [];
  public readonly refunds: Array<Readonly<{ refundId: string; chargeId: string }>> = [];

  public createInvoice(
    input: Readonly<{ paymentId: string; stars: number; payload: string }>,
  ): Promise<Readonly<{ invoiceUrl: string }>> {
    this.invoices.push(input);
    return Promise.resolve({ invoiceUrl: `https://payment.invalid/${input.paymentId}` });
  }

  public refund(input: Readonly<{ refundId: string; chargeId: string }>): Promise<void> {
    this.refunds.push(input);
    return Promise.resolve();
  }
}

export class FakeMediaStore implements MediaStorePort {
  private readonly objects = new Map<string, Uint8Array>();

  public put(
    input: Readonly<{ key: string; body: Uint8Array; contentType: string }>,
  ): Promise<void> {
    this.objects.set(input.key, input.body.slice());
    return Promise.resolve();
  }

  public delete(input: Readonly<{ key: string }>): Promise<void> {
    this.objects.delete(input.key);
    return Promise.resolve();
  }

  public exists(input: Readonly<{ key: string }>): Promise<boolean> {
    return Promise.resolve(this.objects.has(input.key));
  }
}
