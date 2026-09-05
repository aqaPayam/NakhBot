import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import * as formatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  ChangeVisibilityCommandSchema,
  ProfileChangeRequestSchema,
  RegisterTelegramIdentityCommandSchema,
  RequestProtectedProfileChangeCommandSchema,
  SaveSignupStepCommandSchema,
  UpdateProfileCommandSchema,
} from './index.js';

const addFormats = formatsModule.default as unknown as (
  ajv: InstanceType<typeof Ajv>,
) => InstanceType<typeof Ajv>;

function validator(schema: object): ValidateFunction {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const envelope = {
  commandId: '10000000-0000-4000-8000-000000000000',
  schemaVersion: 1,
  actor: { userId: '20000000-0000-4000-8000-000000000000', kind: 'user' },
  requestId: '30000000-0000-4000-8000-000000000000',
  idempotencyKey: 'stable-command-key',
  occurredAt: '2026-09-04T00:00:00.000Z',
  locale: 'en',
};

describe('M1 public contracts', () => {
  it('accepts a strict first-start command without numeric Telegram precision loss', () => {
    const validate = validator(RegisterTelegramIdentityCommandSchema);
    expect(
      validate({
        ...envelope,
        commandType: 'identity.register-telegram-identity',
        actor: { ...envelope.actor, kind: 'system' },
        data: { telegramUserId: '9223372036854775807', updateId: '123456789' },
      }),
    ).toBe(true);
  });

  it('rejects additional command and data properties', () => {
    const validate = validator(ChangeVisibilityCommandSchema);
    expect(
      validate({
        ...envelope,
        commandType: 'identity.change-visibility',
        unknown: true,
        data: { visibilityEnabled: false, expectedSettingsVersion: 1, extra: true },
      }),
    ).toBe(false);
  });

  it('validates discriminated signup values and distinct cardinalities', () => {
    const validate = validator(SaveSignupStepCommandSchema);
    expect(
      validate({
        ...envelope,
        commandType: 'identity.save-signup-step',
        data: {
          expectedDraftVersion: 1,
          value: {
            step: 'interests',
            codes: ['music', 'music', 'travel', 'books', 'sports'],
          },
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...envelope,
        commandType: 'identity.save-signup-step',
        data: { expectedDraftVersion: 1, value: { step: 'age_confirmation', accepted: false } },
      }),
    ).toBe(false);
  });

  it('allows only canonical protected Profile fields', () => {
    const validate = validator(RequestProtectedProfileChangeCommandSchema);
    expect(
      validate({
        ...envelope,
        commandType: 'profile.request-protected-change',
        data: {
          field: 'name',
          requestedValue: 'new_name',
          reason: 'because',
          expectedProfileVersion: 1,
        },
      }),
    ).toBe(false);
  });

  it('enforces the canonical protected-change reason limit', () => {
    const validate = validator(RequestProtectedProfileChangeCommandSchema);
    expect(
      validate({
        ...envelope,
        commandType: 'profile.request-protected-change',
        data: {
          field: 'birth_year',
          requestedValue: 2000,
          reason: 'x'.repeat(1025),
          expectedProfileVersion: 1,
        },
      }),
    ).toBe(false);
  });

  it('couples each protected field to its persisted scalar type', () => {
    const validate = validator(ProfileChangeRequestSchema);
    expect(
      validate({
        requestId: envelope.commandId,
        field: 'gender',
        oldValue: 2000,
        requestedValue: 1999,
        status: 'pending',
        submittedAt: envelope.occurredAt,
      }),
    ).toBe(false);
  });

  it('rejects an empty editable Profile patch', () => {
    const validate = validator(UpdateProfileCommandSchema);
    expect(
      validate({
        ...envelope,
        commandType: 'profile.update',
        data: { expectedProfileVersion: 1, patch: {} },
      }),
    ).toBe(false);
  });
});
