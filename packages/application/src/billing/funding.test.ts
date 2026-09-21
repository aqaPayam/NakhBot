import { describe, expect, it, vi, type MockedFunction } from 'vitest';

import type { CreateFundingIntentCommand, CreateStarsInvoiceCommand } from '@nakh/contracts';

import {
  CreateFundingIntentHandler,
  PrepareStarsInvoiceHandler,
  type BillingFundingStore,
  type InvoicePayloadProtector,
  type PaidActionReferenceResolver,
} from './funding.js';

const userId = '10000000-0000-4000-8000-000000000001';
const intentId = '20000000-0000-4000-8000-000000000002';
const paymentId = '30000000-0000-4000-8000-000000000003';
const commandBase = {
  commandId: '40000000-0000-4000-8000-000000000004',
  schemaVersion: 1 as const,
  actor: { kind: 'user' as const, userId },
  requestId: '50000000-0000-4000-8000-000000000005',
  idempotencyKey: 'stable-payment-command',
  occurredAt: '2026-09-21T00:00:00.000Z',
  locale: 'en',
};

type Parts = Readonly<{
  store: BillingFundingStore;
  references: PaidActionReferenceResolver;
  payloads: InvoicePayloadProtector;
  createFundingIntent: MockedFunction<BillingFundingStore['createFundingIntent']>;
  prepareStarsAttempt: MockedFunction<BillingFundingStore['prepareStarsAttempt']>;
  resolveLikedByAction: MockedFunction<PaidActionReferenceResolver['resolveLikedByAction']>;
  reveal: MockedFunction<InvoicePayloadProtector['reveal']>;
}>;

function parts(): Parts {
  const createFundingIntent = vi
    .fn<BillingFundingStore['createFundingIntent']>()
    .mockResolvedValue({
      id: intentId,
      funding: 'stars',
      requiredAmount: 10n,
      expiresAt: new Date('2026-09-21T00:15:00.000Z'),
      replayed: false,
    });
  const prepareStarsAttempt = vi
    .fn<BillingFundingStore['prepareStarsAttempt']>()
    .mockResolvedValue({
      paymentRecordId: paymentId,
      starsAmount: 10n,
      expiresAt: new Date('2026-09-21T00:15:00.000Z'),
      payloadCiphertext: Uint8Array.from([1, 2, 3]),
      payloadKeyId: 'billing-v1',
      replayed: false,
    });
  const store: BillingFundingStore = { createFundingIntent, prepareStarsAttempt };
  const resolveLikedByAction = vi
    .fn<PaidActionReferenceResolver['resolveLikedByAction']>()
    .mockResolvedValue('60000000-0000-4000-8000-000000000006');
  const references: PaidActionReferenceResolver = {
    resolveLikedByAction,
    resolveChatUnlockAction: vi.fn().mockResolvedValue(undefined),
  };
  const reveal = vi
    .fn<InvoicePayloadProtector['reveal']>()
    .mockReturnValue('recovered-provider-payload');
  const payloads: InvoicePayloadProtector = {
    issue: vi.fn().mockReturnValue({
      cleartext: 'opaque-provider-payload',
      digest: 'a'.repeat(64),
      ciphertext: Uint8Array.from({ length: 32 }, (_, index) => index),
      keyId: 'billing-v1',
    }),
    reveal,
  };
  return {
    store,
    references,
    payloads,
    createFundingIntent,
    prepareStarsAttempt,
    resolveLikedByAction,
    reveal,
  };
}

describe('M4 funding application services', () => {
  it('passes only a package code to the store and returns its authoritative price', async () => {
    const { store, references, createFundingIntent } = parts();
    const handler = new CreateFundingIntentHandler(store, references, { uuid: () => intentId });
    const command: CreateFundingIntentCommand = {
      ...commandBase,
      commandType: 'billing.create-funding-intent',
      data: { funding: 'stars', target: { type: 'credit_package', packageCode: 'starter' } },
    };
    await expect(handler.execute(command)).resolves.toMatchObject({
      fundingIntentId: intentId,
      requiredAmount: '10',
      status: 'pending',
    });
    expect(createFundingIntent).toHaveBeenCalledWith(
      expect.objectContaining({ target: { type: 'credit_package', packageCode: 'starter' } }),
    );
  });

  it('resolves an opaque Liked By action before creating an intent', async () => {
    const { store, references, createFundingIntent, resolveLikedByAction } = parts();
    const handler = new CreateFundingIntentHandler(store, references, { uuid: () => intentId });
    const command: CreateFundingIntentCommand = {
      ...commandBase,
      commandType: 'billing.create-funding-intent',
      data: {
        funding: 'credits',
        target: {
          type: 'liked_by_profile_unlock',
          actionToken: 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba',
        },
      },
    };
    await handler.execute(command);
    expect(resolveLikedByAction).toHaveBeenCalledWith(
      'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba',
      userId,
    );
    expect(createFundingIntent.mock.calls[0]?.[0].target).toEqual({
      type: 'like',
      targetId: '60000000-0000-4000-8000-000000000006',
    });
  });

  it('prepares XTR using protected payload material and reveals only stored replay payloads', async () => {
    const { store, payloads, prepareStarsAttempt, reveal } = parts();
    const handler = new PrepareStarsInvoiceHandler(
      store,
      payloads,
      { uuid: () => paymentId },
      'test',
      'b'.repeat(64),
    );
    const command: CreateStarsInvoiceCommand = {
      ...commandBase,
      commandType: 'billing.create-stars-invoice',
      data: { fundingIntentId: intentId, expectedVersion: 1 },
    };
    await expect(handler.execute(command)).resolves.toMatchObject({
      currency: 'XTR',
      starsAmount: 10n,
      invoicePayload: 'opaque-provider-payload',
      replayed: false,
    });
    expect(reveal).not.toHaveBeenCalled();

    prepareStarsAttempt.mockResolvedValueOnce({
      paymentRecordId: paymentId,
      starsAmount: 10n,
      expiresAt: new Date('2026-09-21T00:15:00.000Z'),
      payloadCiphertext: Uint8Array.from([1, 2, 3]),
      payloadKeyId: 'billing-v1',
      replayed: true,
    });
    await expect(handler.execute(command)).resolves.toMatchObject({
      invoicePayload: 'recovered-provider-payload',
      replayed: true,
    });
  });
});
