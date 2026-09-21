import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import * as formatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  CreateFundingIntentCommandSchema,
  CreateStarsInvoiceCommandSchema,
  CreditBalanceSchema,
  FeatureUnlockResultSchema,
  M4EventTypeSchema,
  SpendCreditsForActionCommandSchema,
} from './index.js';

const addFormats = formatsModule.default as unknown as (
  ajv: InstanceType<typeof Ajv>,
) => InstanceType<typeof Ajv>;
function validator(schema: object): ValidateFunction {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const userId = '10000000-0000-4000-8000-000000000000';
const fundingIntentId = '20000000-0000-4000-8000-000000000000';
const envelope = {
  commandId: '30000000-0000-4000-8000-000000000000',
  schemaVersion: 1,
  actor: { userId, kind: 'user' },
  requestId: '40000000-0000-4000-8000-000000000000',
  idempotencyKey: 'stable-command-key',
  occurredAt: '2026-09-21T00:00:00.000Z',
  locale: 'en',
};
const likedByActionToken = `v1.lb.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const chatActionToken = `v1.pa.${'a'.repeat(16)}.${'b'.repeat(16)}`;

describe('M4 billing and entitlement contracts', () => {
  it('allows packages only through Stars and locks package codes', () => {
    const validate = validator(CreateFundingIntentCommandSchema);
    const command = {
      ...envelope,
      commandType: 'billing.create-funding-intent',
      data: { funding: 'stars', target: { type: 'credit_package', packageCode: 'starter' } },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, data: { ...command.data, funding: 'credits' } })).toBe(false);
    expect(
      validate({
        ...command,
        data: { funding: 'stars', target: { type: 'credit_package', packageCode: 'custom' } },
      }),
    ).toBe(false);
  });

  it('accepts only opaque paid-action targets and rejects client prices', () => {
    const validate = validator(SpendCreditsForActionCommandSchema);
    const command = {
      ...envelope,
      commandType: 'billing.spend-credits-for-action',
      data: { target: { type: 'liked_by_profile_unlock', actionToken: likedByActionToken } },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, data: { target: { ...command.data.target, price: 1 } } })).toBe(
      false,
    );
    expect(
      validate({
        ...command,
        data: { target: { type: 'liked_by_profile_unlock', actionToken: fundingIntentId } },
      }),
    ).toBe(false);
    expect(
      validate({
        ...command,
        data: { target: { type: 'chat_unlock', actionToken: chatActionToken } },
      }),
    ).toBe(true);
  });

  it('requires a versioned funding intent to create an invoice', () => {
    const validate = validator(CreateStarsInvoiceCommandSchema);
    const command = {
      ...envelope,
      commandType: 'billing.create-stars-invoice',
      data: { fundingIntentId, expectedVersion: 1 },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, data: { fundingIntentId } })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, starsAmount: '1' } })).toBe(false);
  });

  it('keeps bigint quantities as bounded decimal strings', () => {
    const validate = validator(CreditBalanceSchema);
    expect(validate({ balance: '0', version: 1 })).toBe(true);
    expect(validate({ balance: '9007199254740993', version: 2 })).toBe(true);
    expect(validate({ balance: 10, version: 1 })).toBe(false);
    expect(validate({ balance: '-1', version: 1 })).toBe(false);
    expect(validate({ balance: '01', version: 1 })).toBe(false);
  });

  it('returns a minimal unlock without exposing funding or scope identifiers', () => {
    const validate = validator(FeatureUnlockResultSchema);
    const result = {
      featureUnlockId: fundingIntentId,
      featureType: 'chat_unlock',
      status: 'active',
      unlockedAt: envelope.occurredAt,
      replayed: false,
    };
    expect(validate(result)).toBe(true);
    expect(validate({ ...result, paymentRecordId: userId })).toBe(false);
    expect(validate({ ...result, matchId: userId })).toBe(false);
  });

  it('locks M4 event names to explicit versioned values', () => {
    const validate = validator(M4EventTypeSchema);
    expect(validate('billing.credit-increased.v1')).toBe(true);
    expect(validate('entitlement.feature-unlocked.v1')).toBe(true);
    expect(validate('billing.credit-increased')).toBe(false);
    expect(validate('billing.balance-set.v1')).toBe(false);
  });
});
