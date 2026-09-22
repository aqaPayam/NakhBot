import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import * as formatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  AcceptNakhCommandSchema,
  CancelPendingNakhCommandSchema,
  CreateDirectNakhCommandSchema,
  CreatePendingNakhCommandSchema,
  DirectNakhResultSchema,
  EditPendingNakhCommandSchema,
  GetPendingNakhPageQuerySchema,
  M5EventTypeSchema,
  NakhActionResultSchema,
  PendingNakhPageSchema,
  PendingNakhResultSchema,
  SettlePendingNakhesCommandSchema,
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
const targetUserId = '20000000-0000-4000-8000-000000000000';
const entityId = '30000000-0000-4000-8000-000000000000';
const envelope = {
  commandId: '40000000-0000-4000-8000-000000000000',
  schemaVersion: 1,
  actor: { userId, kind: 'user' },
  requestId: '50000000-0000-4000-8000-000000000000',
  idempotencyKey: 'stable-nakh-command',
  occurredAt: '2026-09-22T00:00:00.000Z',
  locale: 'en',
};

describe('M5 Nakh contracts', () => {
  it('accepts direct creation without trusting a client price or funding proof', () => {
    const validate = validator(CreateDirectNakhCommandSchema);
    const command = {
      ...envelope,
      commandType: 'nakh.create-direct',
      data: { targetUserId, text: 'Hello 🌳' },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, data: { ...command.data, credits: 1 } })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, paymentRecordId: entityId } })).toBe(
      false,
    );
  });

  it('requires explicit auto-settle consent and applies the 240-scalar boundary', () => {
    const validate = validator(CreatePendingNakhCommandSchema);
    const command = {
      ...envelope,
      commandType: 'nakh.create-pending',
      data: { targetUserId, text: '🌳'.repeat(240), autoSettleAuthorized: true },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, data: { ...command.data, text: '🌳'.repeat(241) } })).toBe(false);
    expect(validate({ ...command, data: { targetUserId, text: 'hello' } })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, autoSettleAuthorized: false } })).toBe(
      false,
    );
  });

  it('requires optimistic versions for edit, cancel, and receiver terminal actions', () => {
    const edit = {
      ...envelope,
      commandType: 'nakh.edit-pending',
      data: { pendingNakhId: entityId, text: 'Updated', expectedVersion: 2 },
    };
    expect(validator(EditPendingNakhCommandSchema)(edit)).toBe(true);
    expect(
      validator(EditPendingNakhCommandSchema)({
        ...edit,
        data: { pendingNakhId: entityId, text: 'Updated' },
      }),
    ).toBe(false);

    const cancel = {
      ...envelope,
      commandType: 'nakh.cancel-pending',
      data: {
        pendingNakhId: entityId,
        resolution: 'converted_to_not_interested',
        expectedVersion: 2,
      },
    };
    expect(validator(CancelPendingNakhCommandSchema)(cancel)).toBe(true);
    expect(
      validator(CancelPendingNakhCommandSchema)({
        ...cancel,
        data: { ...cancel.data, resolution: 'refund' },
      }),
    ).toBe(false);

    expect(
      validator(AcceptNakhCommandSchema)({
        ...envelope,
        commandType: 'nakh.accept',
        data: { nakhId: entityId, expectedVersion: 1 },
      }),
    ).toBe(true);
  });

  it('keeps internal settlement typed and free of balances or Nakh text', () => {
    const validate = validator(SettlePendingNakhesCommandSchema);
    const command = {
      ...envelope,
      actor: { userId, kind: 'system' },
      commandType: 'nakh.settle-pending',
      data: { senderUserId: targetUserId, triggerCreditTransactionId: entityId },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, data: { ...command.data, balance: '100' } })).toBe(false);
    expect(validate({ ...command, data: { ...command.data, text: 'private' } })).toBe(false);
  });

  it('accepts only opaque bounded page cursors', () => {
    const validate = validator(GetPendingNakhPageQuerySchema);
    const query = {
      actor: envelope.actor,
      requestId: envelope.requestId,
      limit: 20,
      cursor: `v1.pn.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    };
    expect(validate(query)).toBe(true);
    expect(validate({ ...query, cursor: entityId })).toBe(false);
    expect(validate({ ...query, limit: 51 })).toBe(false);
  });

  it('returns a bounded sender-safe pending page without receiver identifiers or payment facts', () => {
    const validate = validator(PendingNakhPageSchema);
    const page = {
      totalCount: 1,
      items: [
        {
          pendingNakhId: entityId,
          targetName: 'Nakh receiver',
          text: 'Hello 🌳',
          status: 'pending_payment',
          createdAt: envelope.occurredAt,
          expiresAt: '2026-10-06T00:00:00.000Z',
          version: 1,
        },
      ],
      nextCursor: `v1.pn.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    };
    expect(validate(page)).toBe(true);
    expect(
      validate({
        ...page,
        items: [{ ...page.items[0], receiverUserId: targetUserId }],
      }),
    ).toBe(false);
    expect(validate({ ...page, paymentRecordId: entityId })).toBe(false);
  });

  it('returns minimal actor-safe creation and action results', () => {
    expect(
      validator(DirectNakhResultSchema)({
        nakhId: entityId,
        status: 'sent',
        sentAt: envelope.occurredAt,
        expiresAt: '2026-10-06T00:00:00.000Z',
        replayed: false,
      }),
    ).toBe(true);
    expect(
      validator(PendingNakhResultSchema)({
        pendingNakhId: entityId,
        status: 'pending_payment',
        expiresAt: '2026-10-06T00:00:00.000Z',
        version: 1,
        replayed: false,
      }),
    ).toBe(true);
    const action = {
      nakhId: entityId,
      status: 'accepted',
      matchId: targetUserId,
      changedAt: envelope.occurredAt,
      replayed: false,
    };
    expect(validator(NakhActionResultSchema)(action)).toBe(true);
    expect(validator(NakhActionResultSchema)({ ...action, receiverBalance: '2' })).toBe(false);
    expect(validator(NakhActionResultSchema)({ ...action, providerReceipt: 'secret' })).toBe(false);
  });

  it('locks every M5 event name to an explicit version', () => {
    const validate = validator(M5EventTypeSchema);
    for (const eventType of [
      'nakh.flow-created.v1',
      'nakh.pending-created.v1',
      'nakh.delivered.v1',
      'nakh.status-changed.v1',
      'matching.match-created.v1',
    ])
      expect(validate(eventType)).toBe(true);
    expect(validate('nakh.delivered')).toBe(false);
    expect(validate('nakh.balance-exposed.v1')).toBe(false);
  });
});
