import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import * as formatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  CandidateDeliveryJobSchema,
  GetLikedByPageQuerySchema,
  LockedLikedByPageSchema,
  M3EventTypeSchema,
  MarkNotInterestedCommandSchema,
  SaveExploreFilterCommandSchema,
  SendLikeCommandSchema,
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
const envelope = {
  commandId: '30000000-0000-4000-8000-000000000000',
  schemaVersion: 1,
  actor: { userId, kind: 'user' },
  requestId: '40000000-0000-4000-8000-000000000000',
  idempotencyKey: 'stable-command-key',
  occurredAt: '2026-09-16T00:00:00.000Z',
  locale: 'en',
};

describe('M3 discovery and interaction contracts', () => {
  it('accepts a strict bounded Explore filter and rejects duplicates or unknown fields', () => {
    const validate = validator(SaveExploreFilterCommandSchema);
    const command = {
      ...envelope,
      commandType: 'discovery.save-explore-filter',
      data: {
        targetGenderOptionIds: [targetUserId],
        minAge: 20,
        maxAge: 40,
        cityId: targetUserId,
        expectedVersion: 2,
      },
    };
    expect(validate(command)).toBe(true);
    expect(validate({ ...command, extra: true })).toBe(false);
    expect(
      validate({
        ...command,
        data: { ...command.data, targetGenderOptionIds: [targetUserId, targetUserId] },
      }),
    ).toBe(false);
  });

  it('locks Like and Not Interested to typed directional commands', () => {
    expect(
      validator(SendLikeCommandSchema)({
        ...envelope,
        commandType: 'interaction.send-like',
        data: { targetUserId },
      }),
    ).toBe(true);
    expect(
      validator(MarkNotInterestedCommandSchema)({
        ...envelope,
        commandType: 'interaction.mark-not-interested',
        data: { targetUserId, source: 'unmatch' },
      }),
    ).toBe(false);
  });

  it('keeps Liked By cursors opaque and bounded', () => {
    const validate = validator(GetLikedByPageQuerySchema);
    expect(validate({ actor: envelope.actor, requestId: envelope.requestId, limit: 20 })).toBe(
      true,
    );
    expect(
      validate({
        actor: envelope.actor,
        requestId: envelope.requestId,
        limit: 20,
        cursor: 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba',
      }),
    ).toBe(true);
    expect(
      validate({
        actor: envelope.actor,
        requestId: envelope.requestId,
        limit: 20,
        cursor: 'short',
      }),
    ).toBe(false);
  });

  it('uses a minimal versioned candidate delivery job without profile data', () => {
    const validate = validator(CandidateDeliveryJobSchema);
    const job = {
      jobId: envelope.commandId,
      jobType: 'discovery.deliver-candidate.v1',
      schemaVersion: 1,
      deliveryId: targetUserId,
      occurredAt: envelope.occurredAt,
    };
    expect(validate(job)).toBe(true);
    expect(validate({ ...job, profile: { name: 'private' } })).toBe(false);
  });

  it('locks M3 event names to explicit versioned values', () => {
    const validate = validator(M3EventTypeSchema);
    expect(validate('matching.match-created.v1')).toBe(true);
    expect(validate('matching.match-created')).toBe(false);
    expect(validate('discovery.profile-exposed.v1')).toBe(false);
  });

  it('allows only privacy-reduced locked Liked By cards', () => {
    const validate = validator(LockedLikedByPageSchema);
    const card = {
      actionToken: 'v1.lb.abcdefghijklmnop.ponmlkjihgfedcba',
      blurredPhoto: {
        deliveryUrl: 'https://media.example.test/private-blur',
        expiresAt: '2026-01-01T00:01:00.000Z',
        variantType: 'blurred_preview',
        cachePolicy: 'no-store',
      },
    };
    expect(validate({ totalCount: 1, cards: [card] })).toBe(true);
    expect(validate({ totalCount: 1, cards: [{ ...card, name: 'private' }] })).toBe(false);
    expect(validate({ totalCount: 1, cards: [{ ...card, actionToken: targetUserId }] })).toBe(
      false,
    );
    expect(
      validate({
        totalCount: 1,
        cards: [{ ...card, blurredPhoto: { ...card.blurredPhoto, variantType: 'thumbnail' } }],
      }),
    ).toBe(false);
    expect(
      validate({
        totalCount: 1,
        cards: [{ ...card, blurredPhoto: { ...card.blurredPhoto, fullPhoto: 'private' } }],
      }),
    ).toBe(false);
  });
});
